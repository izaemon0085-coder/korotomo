// ころとも（β版）：家のローカル回線で、スマホからラジコン（いまは画面の中のまね）を安全に動かす
// ・/ ＝ロボットの画面（テレビやパソコン）。つなぐ番号・ブラックボックス・まねの電池は、このパソコンからだけ
// ・/control.html ＝操縦のスマホ。命令にはすべて署名がつく
// ・ともはねのゲームとして：「ともはねでログイン」したスマホでゴールすると、ゴールの回数と遊んだ回数だけを ともはね に知らせる
// 外部パッケージなし
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRobot, HttpError, HEARTBEAT_MS } from './robot.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PUBLIC = join(ROOT, 'public');
const COOKIE = 'korotomo_session';
export const TOMOHANE_URL = (process.env.TOMOHANE_URL || 'http://localhost:3000').replace(/\/+$/, '');
export const LINK_SECRET = process.env.LINK_SECRET || 'tomohane-dev-link-secret';
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 4096) throw new HttpError(413, 'リクエストが大きすぎます');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'JSON の形式が正しくありません');
  }
}
// ロボットのパソコン自身からのアクセスか（プロキシは使わない前提）
const readCookie = (req, name) => {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
};
const isSelf = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

// KOROTOMO_DATA で、遊んだ記録の置き場所を変えられる（ふだんは data/。git に入らない）
export function createApp({
  tomohaneUrl = TOMOHANE_URL, linkSecret = LINK_SECRET, fetchImpl = fetch, robotOptions = {},
  dataFile = join(process.env.KOROTOMO_DATA || join(ROOT, 'data'), 'players.json'),
} = {}) {
  // ともはねでログインした人の、ゴールの回数・遊んだ回数・自己ベスト
  const players = dataFile && existsSync(dataFile) ? JSON.parse(readFileSync(dataFile, 'utf8')) : {};
  const save = () => {
    if (!dataFile) return;
    mkdirSync(dirname(dataFile), { recursive: true });
    writeFileSync(dataFile, JSON.stringify(players, null, 2));
  };
  const report = (p) => fetchImpl(`${tomohaneUrl}/api/link/korotomo-results`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Link-Secret': linkSecret },
    body: JSON.stringify({ gameId: p.gameId, goals: p.goals, plays: p.plays }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {}); // つながらなくても、ゲームは止めない
  const robot = createRobot({
    ...robotOptions,
    onGameStart(player) {
      const p = players[player.gameId];
      if (!p) return;
      p.plays += 1;
      save();
      report(p);
    },
    onGoal(player, ms) {
      const p = players[player.gameId];
      if (!p) return {};
      p.goals = Math.min(p.goals + 1, p.plays);
      const best = p.bestMs == null || ms < p.bestMs;
      if (best) p.bestMs = ms;
      save();
      report(p);
      return { best };
    },
  });
  const sessions = new Map(); // トークン → ともはねのゲーム用の番号
  const who = (req) => players[sessions.get(readCookie(req, COOKIE))] ?? null;
  const selfOnly = (req) => {
    if (!isSelf(req)) throw new HttpError(403, 'ロボットのパソコンからだけできます');
  };
  const routes = [
    ['GET', '/api/health', () => ({ ok: true })],
    ['GET', '/api/time', () => ({ now: Date.now(), heartbeatMs: HEARTBEAT_MS })],
    ['GET', '/api/view', () => robot.view()],
    ['GET', '/api/config', () => ({ tomohaneUrl })],
    ['GET', '/api/me', ({ req }) => {
      const p = who(req);
      return p && { name: p.name, goals: p.goals, plays: p.plays, bestMs: p.bestMs ?? null };
    }],
    ['POST', '/api/pair', ({ req, body }) => {
      const p = who(req);
      return robot.pair(body.code, body.name, p && { gameId: p.gameId, name: p.name });
    }],
    ['POST', '/api/command', ({ body }) => robot.command(body)],
    // ここから下は、ロボットのパソコンからだけ
    ['POST', '/api/pairing-code', ({ req }) => { selfOnly(req); return { code: robot.newPairingCode(), seconds: 120 }; }],
    ['GET', '/api/log', ({ req }) => { selfOnly(req); return { entries: robot.log(40), check: robot.verifyLog() }; }],
    ['POST', '/api/unpair', ({ req, body }) => { selfOnly(req); robot.unpair(body.id); return { ok: true }; }],
    ['POST', '/api/battery', ({ req, body }) => { selfOnly(req); robot.setBattery(body.value); return { ok: true }; }],
  ];
  const sendJson = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  function events(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    // 位置はなめらかに動くので、0.1秒ごとに送る
    const timer = setInterval(() => res.write(`data: ${JSON.stringify(robot.view())}\n\n`), 100);
    req.on('close', () => clearInterval(timer));
  }
  // 「ともはねでログイン」：ともはねが出した通行証を、ともはねに確かめる。パスワードはここに置かない
  async function callback(req, res, url) {
    const ticket = url.searchParams.get('ticket') || '';
    if (!/^[\w-]{16,64}$/.test(ticket)) throw new HttpError(400, '通行証がありません');
    let info;
    try {
      const r = await fetchImpl(`${tomohaneUrl}/api/link/korotomo-ticket/${ticket}`, { headers: { 'X-Link-Secret': linkSecret }, signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw new Error();
      info = await r.json();
    } catch {
      throw new HttpError(401, '通行証を確かめられませんでした。ともはねからもう一度どうぞ');
    }
    if (!info?.gameId || !info?.name) throw new HttpError(401, 'ともはねからの情報が足りません');
    players[info.gameId] ??= { gameId: info.gameId, goals: 0, plays: 0, bestMs: null };
    players[info.gameId].name = String(info.name).slice(0, 40);
    save();
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, info.gameId);
    res.writeHead(302, { 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}`, Location: '/control.html' });
    res.end();
  }

  async function serveStatic(pathname, res) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { throw new HttpError(400, 'URL が正しくありません'); }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = resolve(PUBLIC, `.${rel}`);
    if (!file.startsWith(PUBLIC + sep)) throw new HttpError(403, 'Forbidden');
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      throw new HttpError(404, 'Not Found');
    }
  }
  const handler = async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/auth/callback' && req.method === 'GET') return await callback(req, res, url);
      if (url.pathname.startsWith('/api/')) {
        const origin = req.headers.origin;
        if (req.method !== 'GET' && origin && origin !== 'null') {
          let host = null;
          try { host = new URL(origin).host; } catch { /* noop */ }
          if (host !== req.headers.host) throw new HttpError(403, 'ほかのページからは操作できません');
        }
        if (url.pathname === '/api/events' && req.method === 'GET') return events(req, res);
        const route = routes.find(([m, p]) => m === req.method && p === url.pathname);
        if (!route) throw new HttpError(404, 'API が見つかりません');
        const body = req.method === 'POST' ? await readJson(req) : {};
        return sendJson(res, 200, await route[2]({ req, body }));
      }
      if (req.method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
      return await serveStatic(url.pathname, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      return sendJson(res, status, { error: status === 500 ? 'サーバーエラーが発生しました' : err.message });
    }
  };
  handler.robot = robot;
  return handler;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT) || 3700;
  const app = createApp();
  setInterval(() => app.robot.tick(50), 50); // ロボットの「心臓」（ESP32 の loop にあたる）
  if (!process.env.LINK_SECRET) console.warn('⚠️ LINK_SECRET が未設定です（開発用の値を使います）。本番では ともはね と同じ値を設定してください');
  http.createServer(app).listen(port, () => console.log(`ころとも（β版）起動: http://localhost:${port}/  操縦: http://<このパソコン>:${port}/control.html`));
}

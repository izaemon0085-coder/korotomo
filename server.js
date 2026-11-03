// ころとも（β版）：家のローカル回線で、スマホからラジコン（いまは画面の中のまね）を安全に動かす
// ・/ ＝ロボットの画面（テレビやパソコン）。つなぐ番号・ブラックボックス・まねの電池は、このパソコンからだけ
// ・/control.html ＝操縦のスマホ。命令にはすべて署名がつく
// 外部パッケージなし
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRobot, HttpError, HEARTBEAT_MS } from './robot.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PUBLIC = join(ROOT, 'public');
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
const isSelf = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

export function createApp({ robot = createRobot() } = {}) {
  const selfOnly = (req) => {
    if (!isSelf(req)) throw new HttpError(403, 'ロボットのパソコンからだけできます');
  };
  const routes = [
    ['GET', '/api/health', () => ({ ok: true })],
    ['GET', '/api/time', () => ({ now: Date.now(), heartbeatMs: HEARTBEAT_MS })],
    ['GET', '/api/view', () => robot.view()],
    ['POST', '/api/pair', ({ body }) => robot.pair(body.code, body.name)],
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
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
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
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT) || 3700;
  const robot = createRobot();
  setInterval(() => robot.tick(50), 50); // ロボットの「心臓」（ESP32 の loop にあたる）
  http.createServer(createApp({ robot })).listen(port, () => console.log(`ころとも（β版）起動: http://localhost:${port}/  操縦: http://<このパソコン>:${port}/control.html`));
}

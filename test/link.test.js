import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.js';
import { hmacHex, signText } from '../public/hmac.js';

let server;
let base;
let app;
const reported = [];
const fakeTomohane = async (url, opts = {}) => {
  const u = new URL(url);
  if (opts.headers?.['X-Link-Secret'] !== 'test-secret') return { ok: false, json: async () => ({}) };
  if (u.pathname === '/api/link/korotomo-ticket/good-ticket-1234567890') return { ok: true, json: async () => ({ gameId: 'k_abc', name: 'さいとう', ageGroup: 'child' }) };
  if (u.pathname === '/api/link/korotomo-results') { reported.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; }
  return { ok: false, json: async () => ({}) };
};
before(async () => {
  app = createApp({ tomohaneUrl: 'http://tomohane.test', linkSecret: 'test-secret', fetchImpl: fakeTomohane, dataFile: null });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

test('ともはねでログイン → 操縦の画面へ → ゲームを始めると、遊んだ回数だけ ともはね に', async () => {
  const cb = await fetch(`${base}/auth/callback?ticket=good-ticket-1234567890`, { redirect: 'manual' });
  assert.equal(cb.headers.get('location'), '/control.html');
  const cookie = cb.headers.get('set-cookie').split(';')[0];
  assert.equal((await (await fetch(`${base}/api/me`, { headers: { Cookie: cookie } })).json()).name, 'さいとう');
  const post = async (p, b, h = {}) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(b) })).json();
  const { code } = await post('/api/pairing-code', {}); // テストはこのパソコンから
  const d = await post('/api/pair', { code, name: 'スマホ' }, { Cookie: cookie });
  const m = { deviceId: d.deviceId, seq: 1, at: Date.now(), cmd: { type: 'game' } };
  m.mac = hmacHex(d.secret, signText(m));
  await post('/api/command', m);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(reported.at(-1), { gameId: 'k_abc', goals: 0, plays: 1 });
  assert.equal(app.robot.view().game.player, 'さいとう');
});

test('ともはねの通行証がまちがっていたら入れない', async () => {
  const cb = await fetch(`${base}/auth/callback?ticket=bad-ticket-12345678901`, { redirect: 'manual' });
  assert.equal(cb.status, 401);
});

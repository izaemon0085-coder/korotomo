// 操縦のスマホ：押しているあいだ動く。0.5秒ごとに「生きてるよ」の合図。命令にはすべて署名
import { hmacHex, signText } from '/hmac.js';

const $ = (s) => document.querySelector(s);
const KEY = 'korotomo-device';
let dev = null;
try { dev = JSON.parse(localStorage.getItem(KEY)); } catch { dev = null; }
let seq = Number(dev?.seq) || 0;
let offset = 0; // ロボットの時計とのずれ
let held = null; // 押している向き
let beatMs = 500;

async function call(path, body) {
  const res = await fetch(`/api/${path}`, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `エラー (${res.status})`), { status: res.status });
  return data;
}
async function send(cmd) {
  if (!dev) return null;
  seq = Math.max(seq + 1, Date.now()); // 番号は時刻ベース（ページを開き直しても前より大きい）
  const msg = { deviceId: dev.deviceId, seq, at: Date.now() + offset, cmd };
  msg.mac = hmacHex(dev.secret, signText(msg));
  try {
    const r = await call('command', msg);
    $('#error').textContent = '';
    return r;
  } catch (e) {
    if (e.status === 401 && /つながっていない/.test(e.message)) forget();
    else if (cmd.type !== 'beat') $('#error').textContent = e.message;
    return null;
  }
}
function forget() {
  try { localStorage.removeItem(KEY); } catch { /* noop */ }
  dev = null;
  show();
}
function show() {
  $('#pair').hidden = Boolean(dev);
  $('#ctl').hidden = !dev;
  $('#stop').hidden = !dev;
  if (dev) $('#me').textContent = dev.name;
}

// つなぐ
$('#pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const d = await call('pair', { code: f.get('code'), name: f.get('name') });
    dev = d;
    try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* 保存できなくても、この画面のあいだは使える */ }
    show();
  } catch (err) { $('#error').textContent = err.message; }
});
$('#forget').addEventListener('click', () => { if (confirm('このスマホの登録を消しますか？')) forget(); });

// 止める：押した瞬間に送る（指をはなすのを待たない）。念のため3回
$('#stop').addEventListener('pointerdown', async (e) => {
  e.preventDefault();
  held = null;
  navigator.vibrate?.(150);
  for (let i = 0; i < 3; i++) if (await send({ type: 'stop' })) break;
});
// キーボード（Enter・スペース）で押したときも止める
$('#stop').addEventListener('click', (e) => { if (e.detail === 0) { held = null; send({ type: 'stop' }); } });
$('#release').addEventListener('click', () => send({ type: 'release' }));
$('#game').addEventListener('click', () => send({ type: 'game' }));
$('#unlock').addEventListener('click', async () => {
  const r = await send({ type: 'limit', max: 60 });
  if (r?.waiting) $('#agree').textContent = 'もう1台のスマホで、30秒以内に同じボタンを押してください。';
  if (r?.agreed) $('#agree').textContent = '2台そろいました。上限60、10分だけです。';
});

// 押しているあいだ動く。指をはなしたら速さ0
const DIRS = { f: [1, 0], b: [-1, 0], l: [0.6, -60], r: [0.6, 60] };
function drive() {
  const sp = Number($('#speed').value);
  if (!held) return send({ type: 'drive', speed: 0, turn: 0 });
  const [k, turn] = DIRS[held];
  return send({ type: 'drive', speed: Math.round(sp * k), turn });
}
for (const b of document.querySelectorAll('#pad button')) {
  const down = (e) => { e.preventDefault(); held = b.dataset.dir; b.classList.add('pressed'); drive(); };
  const up = () => { if (held === b.dataset.dir) { held = null; drive(); } b.classList.remove('pressed'); };
  b.addEventListener('pointerdown', down);
  b.addEventListener('pointerup', up);
  b.addEventListener('pointerleave', up);
  b.addEventListener('pointercancel', up);
}
// 画面を離れたら、すぐ速さ0（合図も止まるので、ロボットも自分で止まる）
document.addEventListener('visibilitychange', () => { if (document.hidden && held) { held = null; drive(); } });

// 合図：押しているあいだは動く命令が合図になる。そうでないときは「beat」
setInterval(() => { if (dev) (held ? drive() : send({ type: 'beat' })); }, beatMs);

// ロボットの様子
const es = new EventSource('/api/events');
let last = 0;
let gameWas = false;
es.onmessage = (e) => {
  const v = JSON.parse(e.data);
  last = Date.now();
  $('#stopped').hidden = !v.estop;
  $('#max').textContent = `${v.max}${v.unlockLeft ? `（あと${Math.ceil(v.unlockLeft / 60)}分）` : ''}`;
  $('#game').textContent = v.game ? `⭐ ゲーム中 ${(v.game.elapsed / 1000).toFixed(0)}秒・星 ${v.game.stars.filter((s) => s.got).length}/3（押すとやり直し）` : '⭐ ゲームスタート（星を3つ集める）';
  if (Boolean(v.game) !== gameWas) loadMe(); // 始まったとき・終わったときに記録を読みなおす
  gameWas = Boolean(v.game);
  if (v.waitingAgree && dev && v.waitingAgree.name !== dev.name) $('#agree').textContent = `${v.waitingAgree.name} が上限 ${v.waitingAgree.max} を求めています。同意するなら「上限を60に」を。`;
};
setInterval(() => { $('#lost').hidden = Date.now() - last < 2000; }, 500);

// ともはね：ログインしていれば名前と記録。スマホの名前の欄にも入れておく
function tomohaneUrl(path, base) {
  const u = new URL(path, base);
  if (['localhost', '127.0.0.1'].includes(u.hostname) && !['localhost', '127.0.0.1'].includes(location.hostname)) u.hostname = location.hostname;
  return u.href;
}
async function loadMe() {
  try {
    const [cfg, me] = await Promise.all([call('config'), call('me')]);
    $('#tomohane-login').href = tomohaneUrl('/api/link/korotomo-start', cfg.tomohaneUrl);
    $('#tomohane-back').href = tomohaneUrl('/', cfg.tomohaneUrl);
    $('#tomohane-me').hidden = !me;
    $('#tomohane-guest').hidden = Boolean(me);
    if (me) {
      $('#tomohane-me').textContent = `ともはねの ${me.name} さん：ゴール ${me.goals}回（${me.plays}回あそんだ）${me.bestMs != null ? `・自己ベスト ${(me.bestMs / 1000).toFixed(1)}秒` : ''}`;
      const nameInput = document.querySelector('#pair-form [name="name"]');
      if (!nameInput.value) nameInput.value = `${me.name}のスマホ`.slice(0, 20);
    }
  } catch { /* ともはねがなくても遊べる */ }
}
loadMe();

try {
  const t = await call('time');
  offset = t.now - Date.now();
  beatMs = t.heartbeatMs;
} catch { /* noop */ }
show();

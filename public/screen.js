// ロボットの画面（テレビやパソコン）：部屋の中のロボット、状態、キャラのひとこと、つなぐ番号、ブラックボックス
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = (t) => new Date(t).toLocaleTimeString('ja-JP');
const robotImg = new Image();
robotImg.src = '/avatars/kuruma.svg';
const trail = [];

async function api(path, body) {
  const res = await fetch(`/api/${path}`, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
  return data;
}

function draw(v) {
  const c = $('#room');
  const g = c.getContext('2d');
  const W = c.width;
  const toPx = (u) => ((u + 1) / 2) * (W - 80) + 40;
  g.clearRect(0, 0, W, W);
  trail.push([v.x, v.y]);
  if (trail.length > 300) trail.shift();
  g.strokeStyle = 'rgba(46,111,158,.35)';
  g.lineWidth = 4;
  g.beginPath();
  trail.forEach(([x, y], i) => (i ? g.lineTo(toPx(x), toPx(y)) : g.moveTo(toPx(x), toPx(y))));
  g.stroke();
  // ゲームの星
  if (v.game) {
    g.font = '40px system-ui';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const s of v.game.stars) {
      g.globalAlpha = s.got ? 0.2 : 1;
      g.fillText('⭐', toPx(s.x), toPx(s.y));
    }
    g.globalAlpha = 1;
    g.font = 'bold 26px system-ui';
    g.textAlign = 'left';
    g.fillStyle = '#2a2622';
    g.fillText(`${v.game.player ? `${v.game.player} さん　` : ''}${(v.game.elapsed / 1000).toFixed(1)}秒　星 ${v.game.stars.filter((s) => s.got).length}/3`, 20, 26);
  }
  g.save();
  g.translate(toPx(v.x), toPx(v.y));
  g.rotate(v.heading);
  if (v.estop) { g.fillStyle = 'rgba(198,47,47,.25)'; g.beginPath(); g.arc(0, 0, 48, 0, Math.PI * 2); g.fill(); }
  g.drawImage(robotImg, -32, -32, 64, 64);
  g.fillStyle = '#2e6f9e';
  g.beginPath(); g.moveTo(40, 0); g.lineTo(28, -8); g.lineTo(28, 8); g.fill(); // 前の向き
  g.restore();
}

let lastLines = '';
function render(v) {
  draw(v);
  const st = $('#state');
  const lost = v.devices.length && !v.devices.some((d) => d.alive);
  st.textContent = v.estop ? '止めた' : lost ? '合図なし' : v.speed || v.turn ? '動いている' : 'まっている';
  st.className = `num ${v.estop ? 'state-stop' : 'state-ok'}`;
  $('#speed').textContent = `${v.speed} ／ ${v.actual}`;
  $('#max').textContent = `${v.max}${v.unlockLeft ? `（あと${Math.ceil(v.unlockLeft / 60)}分）` : ''}`;
  const key = JSON.stringify(v.lines);
  if (key !== lastLines) {
    lastLines = key;
    $('#lines').innerHTML = v.lines.map((l) => `<li class="line"><img src="/avatars/${esc(l.agent)}.svg" alt=""><p>${esc(l.text)}</p></li>`).join('') || '<li class="line"><img src="/avatars/kuruma.svg" alt=""><p>やあ。スマホとつないでね。止めるボタンは、いつでも効くよ。</p></li>';
    loadLog();
  }
  $('#devices').innerHTML = v.devices.map((d) => `<li><span class="dot ${d.alive ? 'alive' : ''}"></span>${esc(d.name)}<button type="button" class="btn ghost" data-unpair="${esc(d.id)}">はずす</button></li>`).join('');
}

async function loadLog() {
  try {
    const { entries, check } = await api('log');
    $('#check').innerHTML = check.ok ? `<span class="check-ok">✔ 鎖はつながっている（${check.count}件）</span>` : `<span class="check-ng">✖ ${check.at}件目で鎖が切れている</span>`;
    $('#log').innerHTML = entries.map((e) => `<li>${time(e.at)}　<strong>${esc(e.who)}</strong>：${esc(e.what)} → ${esc(e.result)} <span class="hash">${esc(e.hash.slice(0, 10))}…</span></li>`).join('') || '<li class="muted">まだ記録はありません</li>';
  } catch (e) {
    $('#check').textContent = e.message;
  }
}

$('#new-code').addEventListener('click', async () => {
  try {
    const { code } = await api('pairing-code', {});
    $('#code').textContent = code;
    setTimeout(() => { if ($('#code').textContent === code) $('#code').textContent = '－－－－－－'; }, 120000);
  } catch (e) { $('#error').textContent = e.message; }
});
$('#devices').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-unpair]');
  if (b && confirm('このスマホを はずしますか？')) await api('unpair', { id: b.dataset.unpair }).catch((err) => { $('#error').textContent = err.message; });
});
$('#battery').addEventListener('change', (e) => api('battery', { value: Number(e.target.value) / 100 }).catch(() => {}));
$('#control-url').textContent = `${location.hostname === 'localhost' ? '<このパソコンのアドレス>' : location.hostname}:${location.port}/control.html`;

const es = new EventSource('/api/events');
es.onmessage = (e) => render(JSON.parse(e.data));
loadLog();

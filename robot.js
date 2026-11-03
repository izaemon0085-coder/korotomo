// ころとも（β版）の頭脳：安全の3つのしくみ＋2人の同意＋ブラックボックス＋いつもの動きと比べる
// ・止めるは、いつでも効く（ほかの命令より先。止めたら「解除」するまで動かない）
// ・合図（心拍）が途切れたら、自分で止まる
// ・命令には署名（HMAC）。番号が前より大きく、時刻が5秒以内のものだけ通す（同じ命令の使い回しを防ぐ）
// ・速さの上限を上げるのは、2台のスマホがそろったときだけ（10分で元にもどる）
// ・だれが・いつ・何を命じたかを、あとで書きかえられない記録（ハッシュの鎖）に残す
// β版のロボットは画面の中の「まね」。ESP32 にも同じきまりを入れる（firmware/）
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { hmacHex, signText } from './public/hmac.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const HEARTBEAT_MS = 500; // スマホが合図を送る間かく
export const HEARTBEAT_LOST_MS = 1500; // 3回とどかなければ止まる
export const BASE_MAX = 30; // ふだんの速さの上限（％）
export const UNLOCK_MAX = 80; // 2人の同意で上げられる上限
export const UNLOCK_MS = 10 * 60 * 1000;
const AGREE_MS = 30 * 1000; // 2人目が同意するまでの時間
const MAX_SKEW_MS = 5000;
// ゲーム：部屋の中の星を3つ集めたらゴール（3分まで）
export const STAR_R = 0.12;
export const GAME_MS = 3 * 60 * 1000;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function createRobot({ now = () => Date.now(), random = Math.random, onGameStart = () => {}, onGoal = () => ({}) } = {}) {
  const devices = new Map(); // deviceId → { id, name, secret, lastSeq, lastBeat }
  let pairing = null; // { code, until }
  let game = null; // { stars, startedAt, player, deviceName }
  const log = [];
  const lines = [];
  const listeners = new Set();
  const r = {
    speed: 0, turn: 0, // 命じられた値
    actual: 0, // 実際に出ている速さ（まねの物理）
    x: 0, y: 0, heading: 0,
    estop: false, estopReason: null,
    max: BASE_MAX, unlockUntil: 0, unlockRequest: null,
    driver: null, // いま動かしているスマホ（このスマホの合図が途切れたら止まる）
    battery: 1, // まね：1＝元気、下がると遅くなる
    baseline: null, slowTicks: 0, anomaly: false,
  };
  const emit = () => listeners.forEach((fn) => fn());
  const talk = (agent, text) => {
    lines.unshift({ agent, text, at: now() });
    lines.length = Math.min(lines.length, 8);
  };

  // ---- ブラックボックス（つながった記録） ----
  function record(who, what, result) {
    const prev = log.length ? log[log.length - 1].hash : '0'.repeat(64);
    const entry = { n: log.length + 1, at: now(), who, what, result, prev };
    entry.hash = sha(JSON.stringify([entry.n, entry.at, who, what, result, prev]));
    log.push(entry);
    if (log.length > 5000) log.splice(0, log.length - 5000); // β版はメモリの中だけ
    return entry;
  }
  function verifyLog(entries = log) {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (i > 0 && e.prev !== entries[i - 1].hash) return { ok: false, at: e.n };
      if (sha(JSON.stringify([e.n, e.at, e.who, e.what, e.result, e.prev])) !== e.hash) return { ok: false, at: e.n };
    }
    return { ok: true, count: entries.length };
  }

  // ---- スマホをつなぐ（ロボットの画面に出る6けたの番号。1回だけ・2分まで） ----
  function newPairingCode() {
    pairing = { code: String(randomInt(0, 1000000)).padStart(6, '0'), until: now() + 120000 };
    return pairing.code;
  }
  function pair(code, name, player = null) {
    const nm = String(name ?? '').trim().slice(0, 20);
    if (!nm) throw new HttpError(400, 'スマホの名前を入れてください');
    if (!pairing || now() > pairing.until || String(code) !== pairing.code) throw new HttpError(403, '番号がちがうか、時間切れです（ロボットの画面で新しい番号を）');
    pairing = null; // 1回だけ
    const id = `d_${randomBytes(6).toString('hex')}`;
    const secret = randomBytes(24).toString('base64url');
    devices.set(id, { id, name: nm, secret, lastSeq: 0, lastBeat: 0, player }); // player＝ともはねでログインした人（ゲームの記録用）
    record(nm, 'スマホをつないだ', 'ok');
    talk('kuruma', `${nm} とつながったよ。よろしくね！`);
    emit();
    return { deviceId: id, secret, name: nm };
  }
  function unpair(id) {
    const d = devices.get(id);
    if (!d) return;
    devices.delete(id);
    record(d.name, 'スマホをはずした', 'ok');
    emit();
  }

  // ---- 署名を確かめる ----
  function verify(msg) {
    const d = devices.get(msg?.deviceId);
    if (!d) throw new HttpError(401, 'つながっていないスマホです');
    const { seq, at, cmd, mac } = msg;
    if (!Number.isInteger(seq) || !Number.isFinite(at) || typeof cmd?.type !== 'string' || typeof mac !== 'string') throw new HttpError(400, '命令の形がちがいます');
    const want = Buffer.from(hmacHex(d.secret, signText(msg)));
    const got = Buffer.from(mac);
    if (want.length !== got.length || !timingSafeEqual(want, got)) {
      record(d.name, cmd.type, '署名がちがう → 受けとらない');
      throw new HttpError(401, '署名がちがいます');
    }
    if (seq <= d.lastSeq) throw new HttpError(409, '古い命令です（使い回しは受けとらない）');
    if (Math.abs(now() - at) > MAX_SKEW_MS) throw new HttpError(409, '時刻がずれています（5秒以内の命令だけ）');
    d.lastSeq = seq;
    return d;
  }

  // ---- 命令 ----
  function command(msg) {
    const d = verify(msg);
    const { cmd } = msg;
    // 止めるは、いつでも、ほかの命令より先に
    if (cmd.type === 'stop') {
      r.estop = true;
      r.estopReason = `${d.name} が止めた`;
      r.speed = 0; r.turn = 0;
      record(d.name, '止める', '止まった');
      talk('fukurou', `ほう、${d.name} が止めましたな。安全を確かめてから「解除」してくだされ。`);
      emit();
      return { ok: true, estop: true };
    }
    if (cmd.type === 'beat') {
      d.lastBeat = now();
      return { ok: true };
    }
    d.lastBeat = now(); // 命令も「生きてる」合図になる
    if (cmd.type === 'release') {
      if (!r.estop) return { ok: true };
      r.estop = false;
      r.estopReason = null;
      record(d.name, '解除', '動ける（速さ0から）');
      talk('kuruma', 'ふう。また動けるよ。ゆっくり行こうね。');
      emit();
      return { ok: true };
    }
    if (cmd.type === 'game') {
      // 星を3つ、ロボットから少しはなれた場所に置く
      const stars = [];
      while (stars.length < 3) {
        const s = { x: (random() * 2 - 1) * 0.8, y: (random() * 2 - 1) * 0.8, got: false };
        if (Math.hypot(s.x - r.x, s.y - r.y) > 0.4 && stars.every((o) => Math.hypot(o.x - s.x, o.y - s.y) > 0.3)) stars.push(s);
      }
      game = { stars, startedAt: now(), player: d.player, deviceName: d.name };
      record(d.name, 'ゲームスタート', '星を3つ');
      talk('kuruma', `ゲームスタート！ 星を3つ集めてね。あわてず、ゆっくりでいいよ。`);
      if (d.player) onGameStart(d.player);
      emit();
      return { ok: true };
    }
    if (cmd.type === 'drive') {
      if (r.estop) {
        record(d.name, '動かす', '止まっているので受けとらない');
        throw new HttpError(423, '止まっています。安全を確かめて「解除」してください');
      }
      const speed = clamp(Math.round(Number(cmd.speed) || 0), -100, 100);
      const turn = clamp(Math.round(Number(cmd.turn) || 0), -100, 100);
      r.speed = clamp(speed, -r.max, r.max); // 上限をこえた分は切る
      r.turn = turn;
      r.driver = r.speed || r.turn ? d.id : null;
      if (Math.abs(speed) > r.max) record(d.name, `動かす ${speed}`, `上限 ${r.max} に下げた`);
      else if (speed !== 0 || turn !== 0) record(d.name, `動かす ${speed}/${turn}`, 'ok');
      emit();
      return { ok: true, speed: r.speed, turn: r.turn, max: r.max };
    }
    if (cmd.type === 'limit') {
      const want = clamp(Math.round(Number(cmd.max) || 0), 10, UNLOCK_MAX);
      if (want <= r.max) { // 下げるのは1人でよい
        r.max = want;
        r.speed = clamp(r.speed, -want, want);
        record(d.name, `上限を ${want} に下げる`, 'ok');
        emit();
        return { ok: true, max: r.max };
      }
      const req = r.unlockRequest;
      if (req && now() - req.at < AGREE_MS && req.max === want && req.deviceId !== d.id) {
        r.max = want;
        r.unlockUntil = now() + UNLOCK_MS;
        r.unlockRequest = null;
        record(`${req.name}＋${d.name}`, `上限を ${want} に上げる`, '2人の同意 → 10分だけ');
        talk('fukurou', `ほう、${req.name} と ${d.name} の2人がそろいましたな。上限 ${want}、10分だけですぞ。`);
        emit();
        return { ok: true, max: r.max, agreed: true };
      }
      r.unlockRequest = { deviceId: d.id, name: d.name, max: want, at: now() };
      record(d.name, `上限を ${want} に上げたい`, 'もう1台の同意を待つ（30秒）');
      talk('fukurou', `${d.name} が上限 ${want} を求めていますぞ。もう1台のスマホで30秒以内に同意を。`);
      emit();
      return { ok: true, max: r.max, waiting: true };
    }
    throw new HttpError(400, '知らない命令です');
  }

  // ---- 時間がすすむ（まねの物理と、見張り）。ESP32 では loop() にあたる ----
  function tick(dt = 50) {
    const t = now();
    // 合図が途切れたら、自分で止まる（見るのは、いま動かしているスマホの合図。ほかのスマホが元気でも止まる）
    const driver = devices.get(r.driver);
    if ((r.speed !== 0 || r.turn !== 0) && (!driver || t - driver.lastBeat >= HEARTBEAT_LOST_MS)) {
      r.speed = 0; r.turn = 0; r.driver = null;
      record('ロボット', '合図が途切れた', '自分で止まった');
      talk('kuruma', 'スマホの合図が来なくなったから、ぼく、自分で止まったよ。');
      emit();
    }
    // 上限の時間切れ
    if (r.unlockUntil && t > r.unlockUntil) {
      r.max = BASE_MAX;
      r.unlockUntil = 0;
      r.speed = clamp(r.speed, -BASE_MAX, BASE_MAX);
      record('ロボット', '上限の時間切れ', `上限 ${BASE_MAX} にもどした`);
      emit();
    }
    // まねの物理：実際の速さは、命じた速さ×電池の元気さに近づいていく
    const target = r.speed * r.battery;
    r.actual += (target - r.actual) * Math.min(1, dt / 300);
    r.heading += (r.turn / 100) * (Math.abs(r.actual) / 100) * (dt / 1000) * 5;
    r.x += Math.cos(r.heading) * r.actual * (dt / 1000) * 0.008;
    r.y += Math.sin(r.heading) * r.actual * (dt / 1000) * 0.008;
    const R = 1;
    if (Math.abs(r.x) > R || Math.abs(r.y) > R) { // 部屋のかべ：はね返らず、止まる
      r.x = clamp(r.x, -R, R); r.y = clamp(r.y, -R, R);
      r.actual = 0;
    }
    // ゲーム：星にふれたら集める。3つでゴール。3分すぎたらおしまい
    if (game) {
      for (const s of game.stars) {
        if (!s.got && Math.hypot(s.x - r.x, s.y - r.y) < STAR_R) {
          s.got = true;
          talk('kuruma', `星、ゲット！ あと${game.stars.filter((x) => !x.got).length}つ。`);
          emit();
        }
      }
      const ms = t - game.startedAt;
      if (game.stars.every((x) => x.got)) {
        const result = (game.player && onGoal(game.player, ms)) || {};
        record(game.deviceName, 'ゴール', `${(ms / 1000).toFixed(1)}秒`);
        talk('usagi', `ゴール！ ${(ms / 1000).toFixed(1)}秒${result.best ? '、自己ベスト！' : ''} ${game.player ? `${game.player.name}さん、` : ''}おめでとう ♪`);
        game = null;
        emit();
      } else if (ms > GAME_MS) {
        record(game.deviceName, '時間切れ', '3分');
        talk('kuruma', '3分たったから、ここまで。また遊ぼうね！');
        game = null;
        emit();
      }
    }
    // いつもの動きと比べる（ゴーストエージェントと同じ考え）：命じた速さに対して、どれだけ出ているか
    if (Math.abs(r.speed) >= 10 && Math.abs(r.actual) > 0 && Math.abs(r.actual - target) < 2) {
      const ratio = r.actual / r.speed;
      if (r.baseline === null) r.baseline = ratio;
      else if (ratio > r.baseline * 0.7) r.baseline = r.baseline * 0.98 + ratio * 0.02; // ゆっくり「いつも」を覚える
      r.slowTicks = ratio < r.baseline * 0.7 ? r.slowTicks + 1 : 0;
      if (r.slowTicks === 20 && !r.anomaly) {
        r.anomaly = true;
        record('ロボット', 'いつもより遅い', `いつもの ${Math.round((ratio / r.baseline) * 100)}%`);
        talk('yamaneko', `いつもの動きより ${Math.round((1 - ratio / r.baseline) * 100)}% 遅い。電池が弱っているか、車輪に何かからまっているかもしれない。止めて見てみよう。`);
        emit();
      }
      if (ratio > r.baseline * 0.9 && r.anomaly) r.anomaly = false;
    }
  }

  function view() {
    const t = now();
    return {
      speed: r.speed, turn: r.turn, actual: Math.round(r.actual), x: r.x, y: r.y, heading: r.heading,
      estop: r.estop, estopReason: r.estopReason, max: r.max,
      unlockLeft: r.unlockUntil ? Math.max(0, Math.round((r.unlockUntil - t) / 1000)) : 0,
      waitingAgree: r.unlockRequest && t - r.unlockRequest.at < AGREE_MS ? { name: r.unlockRequest.name, max: r.unlockRequest.max } : null,
      battery: r.battery, anomaly: r.anomaly,
      game: game ? { stars: game.stars, elapsed: t - game.startedAt, player: game.player?.name ?? null } : null,
      devices: [...devices.values()].map((d) => ({ id: d.id, name: d.name, alive: t - d.lastBeat < HEARTBEAT_LOST_MS })),
      lines: lines.slice(0, 5),
    };
  }

  return {
    newPairingCode, pair, unpair, command, tick, view, record, verifyLog,
    log: (n = 50) => log.slice(-n).reverse(),
    allLog: () => log,
    setBattery(v) { r.battery = clamp(Number(v) || 0, 0.2, 1); emit(); }, // まねのため
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

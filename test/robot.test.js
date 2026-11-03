import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRobot, BASE_MAX, HEARTBEAT_LOST_MS, UNLOCK_MS } from '../robot.js';
import { hmacHex, signText } from '../public/hmac.js';

function setup() {
  let t = 1_800_000_000_000;
  const robot = createRobot({ now: () => t });
  const phone = (name) => {
    const d = robot.pair(robot.newPairingCode(), name);
    let seq = 0;
    return {
      ...d,
      send(cmd, over = {}) {
        const msg = { deviceId: d.deviceId, seq: ++seq, at: t, cmd, ...over };
        msg.mac = over.mac ?? hmacHex(d.secret, signText(msg));
        return robot.command(msg);
      },
    };
  };
  return { robot, phone, step: (ms) => { for (let i = 0; i < ms; i += 50) { t += 50; robot.tick(50); } }, at: () => t };
}

test('つなぐ番号は1回だけ・2分まで', () => {
  const { robot, step } = setup();
  const code = robot.newPairingCode();
  robot.pair(code, 'スマホA');
  assert.throws(() => robot.pair(code, 'スマホB'), /番号がちがうか/);
  const c2 = robot.newPairingCode();
  step(121000);
  assert.throws(() => robot.pair(c2, 'スマホB'), /時間切れ/);
});

test('署名：ちがう署名・使い回し・古い時刻は受けとらない', () => {
  const { robot, phone } = setup();
  const a = phone('スマホA');
  assert.throws(() => a.send({ type: 'drive', speed: 20 }, { mac: '0'.repeat(64) }), /署名がちがいます/);
  a.send({ type: 'drive', speed: 20 });
  assert.throws(() => a.send({ type: 'drive', speed: 20 }, { seq: 1 }), /使い回し/);
  assert.throws(() => a.send({ type: 'drive', speed: 20 }, { at: 0 }), /時刻がずれて/);
  assert.match(robot.log(5).map((e) => e.result).join(), /署名がちがう/);
});

test('止めるは、いつでも効く。解除するまで動かない', () => {
  const { robot, phone } = setup();
  const a = phone('スマホA');
  a.send({ type: 'drive', speed: 25, turn: 10 });
  a.send({ type: 'stop' });
  assert.equal(robot.view().speed, 0);
  assert.throws(() => a.send({ type: 'drive', speed: 10 }), /解除/);
  a.send({ type: 'release' });
  assert.equal(robot.view().speed, 0, '解除しても速さ0から');
  assert.equal(a.send({ type: 'drive', speed: 10 }).speed, 10);
});

test('合図が途切れたら、自分で止まる', () => {
  const { robot, phone, step } = setup();
  const a = phone('スマホA');
  a.send({ type: 'drive', speed: 20 });
  step(1000);
  assert.equal(robot.view().speed, 20);
  step(HEARTBEAT_LOST_MS);
  assert.equal(robot.view().speed, 0);
  assert.ok(robot.view().lines.some((l) => /自分で止まった/.test(l.text)));
  assert.match(robot.log(3).map((e) => e.result).join(), /自分で止まった/);
});

test('動かしているスマホの合図が途切れたら止まる（ほかのスマホが元気でも）', () => {
  const { robot, phone, step } = setup();
  const a = phone('スマホA');
  const b = phone('スマホB');
  a.send({ type: 'drive', speed: 20 });
  for (let i = 0; i < 4; i++) { step(500); b.send({ type: 'beat' }); }
  assert.equal(robot.view().speed, 0);
});

test('速さの上限：こえた分は切る。上げるのは2台そろったときだけ・10分で元にもどる', () => {
  const { robot, phone, step } = setup();
  const a = phone('スマホA');
  const b = phone('スマホB');
  assert.equal(a.send({ type: 'drive', speed: 90 }).speed, BASE_MAX);
  assert.equal(a.send({ type: 'limit', max: 60 }).waiting, true);
  assert.equal(a.send({ type: 'limit', max: 60 }).waiting, true, '同じスマホ2回ではだめ');
  assert.equal(b.send({ type: 'limit', max: 60 }).agreed, true);
  assert.equal(a.send({ type: 'drive', speed: 90 }).speed, 60);
  for (let i = 0; i < UNLOCK_MS / 1000 + 2; i++) { step(1000); a.send({ type: 'beat' }); }
  assert.equal(robot.view().max, BASE_MAX);
  assert.ok(Math.abs(robot.view().speed) <= BASE_MAX);
  assert.equal(a.send({ type: 'limit', max: 20 }).max, 20, '下げるのは1人でよい');
});

test('ブラックボックス：書きかえると、鎖が切れて分かる', () => {
  const { robot, phone } = setup();
  const a = phone('スマホA');
  a.send({ type: 'drive', speed: 20 });
  a.send({ type: 'stop' });
  assert.equal(robot.verifyLog().ok, true);
  const copy = robot.allLog().map((e) => ({ ...e }));
  copy[1].result = 'なにもなかった';
  assert.equal(robot.verifyLog(copy).ok, false);
});

test('いつもの動きと比べる：電池が弱るとヤマネコが気づく', () => {
  const { robot, phone, step } = setup();
  const a = phone('スマホA');
  a.send({ type: 'drive', speed: 30, turn: 100 }); // 部屋のかべに当たらないよう、円をえがいて走る
  for (let i = 0; i < 6; i++) { step(500); a.send({ type: 'beat' }); }
  robot.setBattery(0.5);
  for (let i = 0; i < 8; i++) { step(500); a.send({ type: 'beat' }); }
  assert.equal(robot.view().anomaly, true);
  assert.ok(robot.view().lines.some((l) => l.agent === 'yamaneko' && /遅い/.test(l.text)));
});

test('ゲーム：星を3つ集めたらゴール。ゴールはともはねの人の記録に', () => {
  let t = 1_800_000_000_000;
  const goals = [];
  const seq = [0.9, 0.5, 0.1, 0.5, 0.5, 0.9]; // 星の場所を決める
  let i = 0;
  const robot = createRobot({ now: () => t, random: () => seq[i++ % seq.length], onGameStart: () => {}, onGoal: (p, ms) => { goals.push([p.name, ms]); return { best: true }; } });
  const d = robot.pair(robot.newPairingCode(), 'スマホ', { gameId: 'k_1', name: 'さいとう' });
  let n = 0;
  const send = (cmd) => {
    const m = { deviceId: d.deviceId, seq: ++n, at: t, cmd };
    m.mac = hmacHex(d.secret, signText(m));
    return robot.command(m);
  };
  send({ type: 'game' });
  const stars = robot.view().game.stars;
  assert.equal(stars.length, 3);
  // 星のところへ行ったことにする（まねの位置を動かす代わりに、星をロボットの位置に寄せて確かめる）
  for (const s of stars) { s.x = robot.view().x; s.y = robot.view().y; }
  t += 12_345;
  robot.tick(50);
  assert.equal(robot.view().game, null);
  assert.deepEqual(goals, [['さいとう', 12_345]]);
  assert.ok(robot.view().lines.some((l) => l.agent === 'usagi' && /ゴール！ 12\.3秒、自己ベスト/.test(l.text)));
});

test('ゲーム：3分すぎたらおしまい（ゴールにはならない）', () => {
  let t = 1_800_000_000_000;
  const robot = createRobot({ now: () => t });
  const d = robot.pair(robot.newPairingCode(), 'スマホ');
  const m = { deviceId: d.deviceId, seq: 1, at: t, cmd: { type: 'game' } };
  m.mac = hmacHex(d.secret, signText(m));
  robot.command(m);
  t += 3 * 60 * 1000 + 1;
  robot.tick(50);
  assert.equal(robot.view().game, null);
  assert.match(robot.log(1)[0].what, /時間切れ/);
});

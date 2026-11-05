// EP03 饥饿游戏 · 场景：整期是同一局饥饿游戏的第一人称实况（出生台 → 丰饶角 → 树林 → 峡谷 → 遭遇战 → 闪电之星 → 夜里垫高躲着 → 死亡竞赛 → 胜利）。
// 动作全部来自 motion.js 的逐 tick 模拟：这里只写“谁在什么时候想做什么”（走到哪、看哪、搭路、开箱、打人），不摆镜头关键帧。
// 时间都锚在旁白的字上（wordTime / L），换了配音画面自动对齐；配音出来之前用 tools/fake_timeline.py 估的时间轴。
// 动作样片（第一版的 demo 场景）在提交 b663586 里。
import * as THREE from 'three';
import { W, H, TL, L, wordTime, clamp, lerp, E, prog, env, hash2, rng } from './util.js';
import { Stage, mixPreset, tree, Voxels, buildVoxelMesh, scatterDeco, decoMesh } from './world.js';
import { makePlayer, makeChest, Bursts, Motes } from './entities.js';
import { blockMesh, itemMesh } from './voxel.js';
import * as O from './overlay.js';
import * as HUD from './hud.js';
import { once, at } from './kit.js';
import { Sim, sample, placeCamera, swingAt, heldAt, limbs, yawTo } from './motion.js';

export const SCENES = {};

// =================================================================== 地图
// 中间丰饶角（5×5 的台子 + 一圈 8 只箱子），24 个出生台围一圈（半径 11），外面是起伏的草地和树林；西北的树林里有一道峡谷。
const PEDESTALS = 24, PED_R = 11;
const ped = i => { const a = i / PEDESTALS * Math.PI * 2 + Math.PI / 2; return [Math.round(Math.cos(a) * PED_R), Math.round(Math.sin(a) * PED_R), a]; };
// 我走的路线（种树时避开；峡谷在 R3 和 R4 之间）
const R1 = [[0.5, 11.5], [0.5, 4.9]];                                                  // 出生台 → 丰饶角正南的箱子
const R2 = [[-2.2, 5.4], [-4.9, 2.5], [-7, -2], [-11, -6], [-14.4, -9.4]];              // → 树林里的箱子
const WOODS_CHEST = [-16, -11];
const R3 = [[-14.6, -13.5], [-13.6, -18.5], [-12.5, -24.6]];                           // → 峡谷边
const RAVINE = { z0: -27, z1: -26, x0: -22, x1: 6 };
const R4 = [[-12.5, -30], [-11, -33.5]];                                                // 过了峡谷 → 林间空地（遭遇战）
const CLEARING = [-9, -36];
const BLITZ_CHEST = [-4, -41];
const R5 = [[-6.5, -38.5], [-3.5, -39.3]];                                              // → 闪电之星的箱子
const PILLAR = [-0.5, -35.5];
const ENEMY_PATH = [[8, -44], [2, -40], [-5, -37]];
const PASSER_PATH = [[-12, -30.5], [-5, -33], [2, -34], [9, -31]];
const ALL_PATHS = [R1, R2, R3, R4, R5, ENEMY_PATH, PASSER_PATH, [[-11, -33.5], [-3.5, -39.3], PILLAR]];
function segDist(x, z, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1;
  const u = clamp(((x - a[0]) * dx + (z - a[1]) * dz) / L2);
  return Math.hypot(x - (a[0] + dx * u), z - (a[1] + dz * u));
}
const nearPath = (x, z, d) => ALL_PATHS.some(P => P.some((p, i) => i > 0 && segDist(x, z, P[i - 1], p) < d));
function vnoise(x, z, cell, seed) {
  const gx = Math.floor(x / cell), gz = Math.floor(z / cell), fx = x / cell - gx, fz = z / cell - gz;
  const s = u => u * u * (3 - 2 * u), a = hash2(gx + seed, gz), b = hash2(gx + 1 + seed, gz), c = hash2(gx + seed, gz + 1), d = hash2(gx + 1 + seed, gz + 1);
  return lerp(lerp(a, b, s(fx)), lerp(c, d, s(fx)), s(fz));
}
// 地面高度：中间一圈是平的，往外慢慢起伏（坡都是一格一格的，走过去会自动跳上去）；空地和垫高的地方是平的
function heightAt(x, z) {
  if (z >= RAVINE.z0 && z <= RAVINE.z1 && x >= RAVINE.x0 && x <= RAVINE.x1) return -5;
  const r = Math.hypot(x, z);
  if (r < 15) return 0;
  let h = (vnoise(x, z, 15, 31) - 0.42) * 4.2 + (vnoise(x, z, 7, 77) - 0.5) * 1.2;
  h *= clamp((r - 15) / 10);
  const flat = Math.max(1 - Math.hypot(x - CLEARING[0], z - CLEARING[1]) / 9, 1 - Math.hypot(x - PILLAR[0], z - PILLAR[1]) / 6, 0);
  return Math.round(lerp(h, 1, clamp(flat * 1.6)));
}
const groundY = (x, z) => heightAt(Math.floor(x), Math.floor(z)) + 1;

function hgWorld() {
  return once('hg', () => {
    const st = new Stage({ preset: 'cine_day', focus: [0, 0, 0], shadowSpan: 40, clouds: true });
    st.scene.add(st.camera);
    const v = new Voxels(), R0 = 50;
    for (let x = -R0; x <= R0; x++) for (let z = -R0; z <= R0; z++) {
      if (Math.hypot(x, z) > R0) continue;
      const h = heightAt(x, z);
      for (let y = h; y >= Math.min(h, -2) - 3; y--) v.set(x, y, z, y === h ? (h === -5 ? 'stone' : 'grass') : y > h - 3 ? 'dirt' : 'stone');
    }
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) v.set(x, 0, z, Math.abs(x) === 2 || Math.abs(z) === 2 ? 'stone_dark' : 'sandstone');
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) v.set(x, 1, z, 'sandstone');
    v.set(0, 2, 0, 'gold');
    for (let i = 0; i < PEDESTALS; i++) { const [x, z] = ped(i); v.set(x, 1, z, 'stone_dark'); }
    const R = rng(4242), trees = [];
    for (let k = 0; k < 260; k++) {
      const a = R() * Math.PI * 2, r = 16 + R() * 32, x = Math.round(Math.cos(a) * r), z = Math.round(Math.sin(a) * r);
      if (Math.hypot(x, z) > R0 - 3 || (z >= RAVINE.z0 - 3 && z <= RAVINE.z1 + 3 && x >= RAVINE.x0 - 3 && x <= RAVINE.x1 + 3)) continue;
      if (nearPath(x + 0.5, z + 0.5, 3.4) || Math.hypot(x - CLEARING[0], z - CLEARING[1]) < 7 || Math.hypot(x - PILLAR[0], z - PILLAR[1]) < 6) continue;
      if (trees.some(([tx, tz]) => Math.hypot(tx - x, tz - z) < 3.6)) continue;
      trees.push([x, z]); tree(v, x, heightAt(x, z) + 1, z, 900 + k, 4 + (k % 3 === 0 ? 1 : 0));
    }
    st.add(buildVoxelMesh(v));
    const deco = scatterDeco(v, 0, 0, 46, 11, 0.12, (x, z) => Math.hypot(x, z) < 13 || nearPath(x + 0.5, z + 0.5, 1.0));
    if (deco && deco.length) st.add(decoMesh(deco));
    // 箱子：丰饶角一圈 8 只 + 树林里一只 + 闪电之星那只
    const chests = {}, chestCells = new Set();
    const addChest = (key, x, z, ry) => { const c = makeChest(); const y = heightAt(x, z) + 1; at(c, x + 0.5, y, z + 0.5, ry); st.add(c); chests[key] = c; chestCells.add(`${x},${y},${z}`); };
    for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2 + Math.PI / 2, x = Math.round(Math.cos(a) * 3), z = Math.round(Math.sin(a) * 3); addChest('mid' + i, x, z, Math.atan2(x, z)); }
    addChest('woods', ...WOODS_CHEST, Math.PI / 4);
    addChest('blitz', ...BLITZ_CHEST, 0);
    const fx = new Bursts(1600); st.add(fx.mesh);
    const motes = new Motes(220, [[-40, 0, -45], [30, 14, 25]], { color: '#fff6e0', size: 0.04, opacity: 0.3, seed: 9 }); st.add(motes);
    return { st, v, chests, chestCells, placed: new Map(), fx, motes };
  });
}

// =================================================================== 时间点（全部锚在旁白上）
function mt() {
  return once('mt', () => ({
    tCount: [wordTime('H04', '三'), wordTime('H04', '二'), wordTime('H04', '一')], tRun: wordTime('H04', '跑'),
    tOpenMid: wordTime('H06', '丰饶角') - 0.25, tLeave: L('H07').start + 0.35,
    tWoods: wordTime('H08', '搜箱子') - 0.15, tToRavine: L('H09').start + 0.4, tBridge: L('H11').start, tToClear: L('H13').start - 0.4,
    tEnemy: L('H14').start, tBlitz: wordTime('H17', '某个箱子') - 0.3, tStar: wordTime('H17', '闪电之星'),
    tNight: L('H19').start - 0.6, tPillar: wordTime('H19', '躲起来') - 0.4,
    tDawn: L('H25').start - 0.4, tTp: wordTime('H25', '传回中间') + 0.1,
    tLast: wordTime('H28', '最后一个') - 0.2, tWin: wordTime('H29', '赢了') - 0.35,
    tEnd: L('H31').end,
  }));
}

// =================================================================== 模拟：我 + 其他玩家
const SKINS = ['steve', 'alex', 'steve_hoodie', 'alex_blue', 'steve_red', 'steve_white', 'steve_suit'];
function match() {
  return once('match', () => {
    const S = hgWorld(), T = mt();
    const sim = new Sim({ solid: (x, y, z) => { const b = S.v.get(x, y, z); return (!!b && b !== 'leaves') || S.chestCells.has(`${x},${y},${z}`); } }, TL.duration + 1);
    const agents = [];
    const add = (o, vis = [-1, Infinity], skin = 'steve') => { const a = sim.add(o); a.vis = vis; a.skin = skin; agents.push(a); return a; };
    // ---------------- 我
    const me = sim.add({ name: 'me', pos: [0.5, 2, 11.5], yaw: 0, pitch: -0.06 });
    const midChest = [0.5, 1.4, 3.5];
    me.look(0.4, { yaw: -0.85, pitch: -0.04, w: 3 }).look(wordTime('H01', '中间') - 0.3, { at: [0.5, 1.2, 0.5], w: 3.5 });
    me.look(L('H02').start + 0.6, { yaw: 0.95, pitch: -0.03, w: 2.6 }).look(L('H03').start + 0.8, { yaw: -0.5, pitch: -0.02, w: 2.6 });
    me.look(L('H04').start, { at: [0.5, 1.0, 3.5], w: 4 });
    me.goto(T.tRun, R1.slice(1), 'sprint', { look: { path: -0.22, w: 6 } });
    me.look(T.tRun + 2.6, { at: () => { const a = sim.agents.find(x => x.name === 'p14'); return [a.x, a.y + 1.4, a.z]; }, w: 3.2 });
    me.look(T.tRun + 7.2, { yaw: -1.2, pitch: -0.05, w: 2.4 });
    me.act(T.tOpenMid, 'openMid', { look: { at: midChest, w: 6 }, dur: 0.3 });
    me.wait(0, L('H07').start - 0.1);
    me.goto(T.tLeave, R2, 'sprint', { look: { path: -0.05, w: 5 }, hold: 'sword' });
    me.act(T.tWoods, 'openWoods', { look: { at: [WOODS_CHEST[0] + 0.5, groundY(...WOODS_CHEST) + 0.4, WOODS_CHEST[1] + 0.5], w: 6 }, dur: 1.4 });
    me.goto(T.tToRavine, R3, 'walk', { look: { path: -0.06, w: 4 } });
    me.look(L('H10').start, { yaw: 0.35, pitch: -0.75, w: 2.4 }).look(L('H10').end - 0.6, { yaw: -0.25, pitch: -0.18, w: 2.2 });
    me.bridge(T.tBridge, [0, -1], 2, { block: 'planks', hold: 'planks' });
    me.look(L('H12').start + 1.2, { yaw: 0.45, pitch: -0.1, w: 2 }).look(L('H13').start - 0.6, { yaw: -0.2, pitch: -0.05, w: 2 });
    me.goto(T.tToClear, R4, 'walk', { look: { path: -0.05, w: 4 }, hold: 'sword' });
    // ---------------- 遭遇战：一个人从东边树林里冲出来
    const foe = add({ name: 'foe', pos: [ENEMY_PATH[0][0] + 0.5, groundY(...ENEMY_PATH[0]), ENEMY_PATH[0][1] + 0.5], yaw: -1.2 }, [T.tEnemy - 2.5, Infinity], 'steve_red');
    foe.goto(T.tEnemy - 2.4, ENEMY_PATH.slice(1), 'sprint', { look: { path: -0.05 } });
    foe.look(T.tEnemy - 0.4, { at: me, w: 6 });
    foe.chase(T.tEnemy + 0.2, me, { dist: 2.2, strafe: 0.5, phase: 1.3 });
    me.look(T.tEnemy - 0.15, { at: foe, w: 6.5, vmax: 3.2 });
    me.chase(T.tEnemy + 0.35, foe, { dist: 2.3, strafe: 0.45 });
    const hits = [[1.0, me, foe], [1.65, foe, me], [2.35, me, foe], [3.05, foe, me], [3.6, me, foe], [4.3, me, foe]].map(([dt, a, b]) => [T.tEnemy + dt, a, b]);
    hits.forEach(([t, a, b]) => { a.swing(t - 0.05, 'attack'); b.hurtBy(t, a, { power: b === me ? 5.5 : 7.4 }); });
    const tKill1 = hits[hits.length - 1][0];
    foe.die(tKill1);
    me.goto(tKill1 + 1.0, [[-8, -37.5], ...R5], 'walk', { look: { path: -0.08, w: 4 } });
    me.look(L('H16').start + 1.5, { yaw: -1.5, pitch: -0.05, w: 2 }).look(L('H16').end - 0.2, { yaw: 0.9, pitch: -0.08, w: 2 });
    me.act(T.tBlitz, 'openBlitz', { look: { at: [BLITZ_CHEST[0] + 0.5, groundY(...BLITZ_CHEST) + 0.4, BLITZ_CHEST[1] + 0.5], w: 6 }, dur: 0.3 });
    me.wait(0, L('H18').start + 0.2);
    // ---------------- 夜里：走到空地中间，原地垫高三格，在上面待着
    me.goto(L('H18').start + 0.5, [[-2.2, -37.5], PILLAR], 'walk', { look: { path: -0.1, w: 3.5 } });
    me.pillar(T.tPillar, 3, { block: 'planks', hold: 'planks' });
    const moonYaw = yawTo(0, 0, -0.5, -0.866) + 0.05;
    me.look(L('H20').start + 0.4, { yaw: moonYaw, pitch: 0.42, w: 1.8 });
    me.look(L('H21').start + 1.2, { yaw: moonYaw + 1.3, pitch: -0.12, w: 1.6 });
    const passer = add({ name: 'passer', pos: [PASSER_PATH[0][0] + 0.5, groundY(...PASSER_PATH[0]), PASSER_PATH[0][1] + 0.5], yaw: 1.4 }, [L('H22').start - 1.5, L('H23').start + 3], 'alex_blue');
    passer.goto(L('H22').start - 1.4, PASSER_PATH.slice(1), 'sneak', { look: { path: -0.15 } });
    me.look(L('H22').start, { at: () => [passer.x, passer.y + 1.2, passer.z], w: 2.4 });
    me.look(L('H23').start + 0.8, { yaw: moonYaw - 0.4, pitch: 0.25, w: 1.6 });
    me.look(L('H24B').start + 0.3, { at: [0.5, 2, 0.5], w: 1.6 });
    // ---------------- 死亡竞赛：所有人传回出生台，剩下四个人
    const P = i => { const [x, z] = ped(i); return [x + 0.5, 2, z + 0.5]; };
    me.teleport(T.tTp, P(0), 0); me.hold(T.tTp + 1.2, 'sword');
    me.look(T.tTp, { yaw: 0, pitch: -0.05, w: 5 });
    const fin = add({ name: 'fin', pos: P(12), yaw: Math.PI }, [T.tTp, Infinity], 'steve_suit');
    const d1 = add({ name: 'd1', pos: P(6), yaw: -Math.PI / 2 }, [T.tTp, Infinity], 'alex');
    const d2 = add({ name: 'd2', pos: P(18), yaw: Math.PI / 2 }, [T.tTp, Infinity], 'steve_hoodie');
    const tGo = T.tTp + 1.6;
    [fin, d1, d2].forEach(a => a.look(T.tTp, { at: [0.5, 1.6, 0.5], w: 4 }));
    d1.chase(tGo, d2, { dist: 2.2, phase: 0.4 }); d2.chase(tGo, d1, { dist: 2.2, phase: 2.0 });
    d1.look(tGo, { at: d2, w: 5 }); d2.look(tGo, { at: d1, w: 5 });
    const tD1 = L('H27').start + 1.5;
    [[-3.0, d2, d1], [-2.1, d1, d2], [-1.2, d2, d1], [-0.4, d2, d1]].forEach(([dt, a, b]) => { a.swing(tD1 + dt - 0.05); b.hurtBy(tD1 + dt, a); });
    d1.die(tD1 - 0.4);
    fin.goto(tGo, [[0.5, -5]], 'walk', { look: { path: -0.05 } });
    fin.chase(tD1 + 0.2, d2, { dist: 2.2, phase: 1.0 }); fin.look(tD1, { at: d2, w: 5 });
    d2.look(tD1 + 0.2, { at: fin, w: 6 }); d2.chase(tD1 + 0.2, fin, { dist: 2.2, phase: 0.2 });
    const tD2 = T.tLast - 1.2;
    [[-2.4, fin, d2], [-1.6, d2, fin], [-0.8, fin, d2], [0, fin, d2]].forEach(([dt, a, b]) => { a.swing(tD2 + dt - 0.05); b.hurtBy(tD2 + dt, a); });
    d2.die(tD2);
    me.goto(tGo, [[0.5, 6.5]], 'walk', { look: { path: -0.02, w: 3 } });
    me.look(tGo + 1.5, { at: () => [(d1.x + d2.x) / 2, 1.8, (d1.z + d2.z) / 2], w: 2.2 });
    // 最后一个：他冲过来，我迎上去
    fin.look(tD2 + 0.3, { at: me, w: 6 }); fin.chase(tD2 + 0.4, me, { dist: 2.2, phase: 2.4 });
    me.look(tD2 + 0.3, { at: fin, w: 5, vmax: 3.2 }); me.chase(T.tLast - 0.2, fin, { dist: 2.3, strafe: 0.45 });
    const finalHits = [[-2.1, fin, me], [-1.45, me, fin], [-0.75, fin, me], [-0.2, me, fin], [0.35, me, fin]].map(([dt, a, b]) => [T.tWin + dt, a, b]);
    finalHits.forEach(([t, a, b]) => { a.swing(t - 0.05, 'attack'); b.hurtBy(t, a, { power: b === me ? 5.5 : 7.6 }); });
    fin.die(T.tWin + 0.35);
    // 赢了：退开几步，抬头看烟花，再回头看着丰饶角
    me.goto(T.tWin + 1.0, [[2.5, 5.5], [3.5, 8.5]], 'walk', { look: { path: -0.05, w: 3 } });
    me.look(T.tWin + 3.0, { yaw: -0.15, pitch: 0.55, w: 1.6 });
    me.look(L('H30').start + 1.6, { at: [0.5, 2.0, 0.5], w: 1.3 });
    // ---------------- 开局的其他人（出生台上 → 一半冲中间，一半往外跑；陆续被淘汰）
    const crowd = [];
    [2, 4, 5, 7, 8, 10, 13, 14, 16, 17, 19, 20, 22, 23].forEach((i, k) => {
      const [x, z, a] = ped(i);
      const o = add({ name: 'p' + i, pos: [x + 0.5, 2, z + 0.5], yaw: yawTo(x, z, 0, 0) }, [-1, L('H09').start], SKINS[k % SKINS.length]);
      o.look(0, { at: [0.5, 1.6, 0.5], w: 3 });
      o.look(L('H02').start + 1 + (k % 5) * 0.7, { yaw: yawTo(x, z, 0, 0) + 0.6 * Math.sin(k * 1.7), pitch: 0, w: 2 });
      o.look(L('H04').start, { at: [0.5, 1.4, 0.5], w: 4 });
      const go = T.tRun + 0.05 * (k % 4);
      if (k % 2 === 0) {
        o.goto(go, [[Math.cos(a) * 4.7 + 0.5, Math.sin(a) * 4.7 + 0.5]], 'sprint', { look: { path: -0.15 } });
        o.act(go + 2.2, 'open', { look: { at: [0.5, 1.2, 0.5], w: 6 }, dur: 1.2 });
        o.goto(0, [[Math.cos(a + 0.5) * 8, Math.sin(a + 0.5) * 8], [Math.cos(a + 0.8) * 34, Math.sin(a + 0.8) * 34]], 'sprint', { look: { path: -0.05 } });
      } else o.goto(go, [[Math.cos(a) * 36, Math.sin(a) * 36]], 'sprint', { look: { path: -0.03 } });
      crowd.push(o);
    });
    // 丰饶角上的第一场架：p14 把 p16 打倒
    const a14 = crowd.find(o => o.name === 'p14'), a16 = crowd.find(o => o.name === 'p16');
    const tFight0 = T.tRun + 4.6;
    a16.tasks = []; a14.tasks = [];
    a16.goto(T.tRun, [[ped(16)[0] * 0.42 + 0.5, ped(16)[1] * 0.42 + 0.5]], 'sprint', { look: { path: -0.1 } });
    a14.goto(T.tRun, [[ped(14)[0] * 0.42 + 0.5, ped(14)[1] * 0.42 + 0.5]], 'sprint', { look: { path: -0.1 } });
    a14.chase(tFight0 - 1.2, a16, { dist: 2.0 }); a16.chase(tFight0 - 1.2, a14, { dist: 2.0, phase: 1.4 });
    a14.look(tFight0 - 1.4, { at: a16, w: 6 }); a16.look(tFight0 - 1.4, { at: a14, w: 6 });
    [[0, a14, a16], [0.6, a16, a14], [1.2, a14, a16], [1.8, a14, a16]].forEach(([dt, a, b]) => { a.swing(tFight0 + dt - 0.05); b.hurtBy(tFight0 + dt, a); });
    a16.die(tFight0 + 1.8);
    sim.run();
    return { sim, me, agents, foe, fin, d1, d2, passer, a16, tKill1, tD1, tD2, tFight0 };
  });
}

// =================================================================== 第一人称的手（照原版 ItemInHandRenderer 的变换）
function makeHand() {
  const PX = 0.9 / 16;
  const pl = makePlayer({ skin: { shirt: '#3a7bd5', seed: 2 } });
  const arm = new THREE.Mesh(pl.armR.children[0].geometry, pl.armR.children[0].material);
  const root = new THREE.Group(), sway = new THREE.Group(), equip = new THREE.Group(), swing = new THREE.Group(), grip = new THREE.Group();
  root.add(sway); sway.add(equip); equip.add(swing); swing.add(grip);
  grip.add(arm); arm.position.set(0, -6 * PX, 0);
  const hand = new THREE.Group(); hand.position.set(0, -11 * PX, -1 * PX); grip.add(hand);
  const items = { planks: blockMesh('planks', 0.3), sword: itemMesh('sword', 'sword_iron', 0.62) };
  let cur = null;
  return {
    group: root,
    update(s, sw, held, bv) {
      if (held.item !== cur) {
        if (cur && items[cur]) hand.remove(items[cur]);
        cur = held.item;
        const m = cur && items[cur];
        if (m) {
          if (cur === 'planks') { m.position.set(-0.02, -0.06, -0.02); m.rotation.set(0.45, 0.8, 0.15); }
          else { m.position.set(0, -0.08, -0.06); m.rotation.set(-Math.PI / 2 - 0.4, Math.PI / 2 - 0.2, 0.15); }
          hand.add(m);
        }
      }
      sway.rotation.set((s.pitch - s.armPitch) * 0.16, -(s.yaw - s.armYaw) * 0.16, 0);
      sway.position.set(bv.x * 0.6, bv.y * 0.6, 0);
      equip.position.set(0.5, -0.56 - 0.6 * (1 - held.equip), -0.62);
      const p = sw ?? 0, a = Math.sin(Math.sqrt(p) * Math.PI), b = Math.sin(p * p * Math.PI);
      swing.position.set(-0.22 * a, 0.11 * Math.sin(Math.sqrt(p) * Math.PI * 2), -0.11 * Math.sin(p * Math.PI));
      swing.rotation.set(-a * 0.77, -b * 0.35, -a * 0.35);
      grip.rotation.set(1.95, 0.42, 0.05);
    },
  };
}

// 别的玩家：姿势从模拟里取；被打中时红一下（原版 10 tick）；死了往侧面倒下、冒烟消失
function posePlayer(P, a, t) {
  const s = sample(a, t), l = limbs(s), sw = swingAt(a, t);
  at(P, s.x, s.y, s.z, Math.PI - s.body);
  P.legR.rotation.set(l.legR, 0, 0); P.legL.rotation.set(l.legL, 0, 0);
  P.armR.rotation.set(l.armR, 0, 0.05); P.armL.rotation.set(l.armL, 0, -0.05);
  if (sw !== null) { const k = Math.sin(Math.sqrt(sw) * Math.PI); P.armR.rotation.x = -1.6 * k - 0.2; P.armR.rotation.y = -0.4 * k; }
  let d = s.yaw - s.body; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
  P.head.rotation.set(-s.pitch, -d, 0);
  P.body.position.y = 0; P.body.rotation.set(0, 0, 0);
  const hurt = a.kicks.some(k => t >= k.t && t < k.t + 0.5) || (t >= a.deadAt);
  P.material.color.set(hurt ? '#ff8080' : '#ffffff');
  if (t >= a.deadAt) { const k = E.inCubic(clamp((t - a.deadAt) / 0.5)); P.body.rotation.z = k * Math.PI / 2; P.body.position.y = k * 0.1; }
  P.group.visible = t >= a.vis[0] && t < a.vis[1] && t < a.deadAt + 1.0;
}

// =================================================================== 每一帧
function skyMarks() {
  return once('sky', () => {
    const T = mt();
    return [['cine_day', 0], ['cine_day', L('H17').start], ['cine_gold', L('H18').start + 1], ['cine_moon', T.tNight + 2.5], ['cine_moon', T.tDawn], ['cine_dawn', T.tDawn + 2.5], ['cine_morning', T.tTp + 0.5]];
  });
}
function skyAt(t) {
  const m = skyMarks();
  for (let i = 0; i < m.length - 1; i++) if (t < m[i + 1][1]) return m[i][0] === m[i + 1][0] ? m[i][0] : mixPreset(m[i][0], m[i + 1][0], E.inOutSine(prog(t, m[i][1], m[i + 1][1] - m[i][1])));
  return m[m.length - 1][0];
}
// 箱子开着没有：事件时间 → 盖子打开，过一会儿关上
const lid = (t, t0, t1) => E.outCubic(prog(t, t0, 0.25)) * (1 - prog(t, t1, 0.25));
function matchFrame(t) {
  const S = hgWorld(), M = match(), T = mt(), st = S.st;
  st.setPreset(skyAt(t));
  S.motes.update(t);
  if (!S.burst) {
    // 死掉的人冒一团白烟；赢了放烟花
    M.agents.forEach((a, k) => { if (a.deadAt < Infinity) { const s = sample(a, a.deadAt + 0.95); S.fx.add(a.deadAt + 0.95, [s.x, s.y + 0.6, s.z], { n: 40, speed: 1.2, gravity: -0.6, size: 0.12, colors: ['#ffffff', '#dddddd', '#bbbbbb'], seed: 31 + k, life: 1.0, up: 0.6 }); } });
    for (let k = 0; k < 8; k++) { const tt = T.tWin + 2.6 + k * 0.6, a = k * 2.1; S.fx.add(tt, [Math.cos(a) * 7 - 1, 10.5 + (k % 3) * 1.6, Math.sin(a) * 4 - 6], { n: 160, speed: 6, gravity: 2.5, size: 0.26, colors: [['#ff5555', '#ffff55'], ['#55ffff', '#ffffff'], ['#ff55ff', '#ffaa00']][k % 3], seed: 200 + k, life: 1.8 }); }
    S.burst = true;
  }
  S.fx.update(t);
  // 放下的方块：在右键的那一帧出现（原版没有缩放动画）
  for (const e of M.sim.events) {
    if (e.kind !== 'place') continue;
    const key = `${e.x},${e.y},${e.z}`;
    let m = S.placed.get(key);
    if (!m) { m = blockMesh(e.block, 1); m.position.set(e.x + 0.5, e.y + 0.5, e.z + 0.5); m.castShadow = m.receiveShadow = true; st.add(m); S.placed.set(key, m); }
    m.visible = t >= e.t && t < T.tTp;
  }
  // 箱子
  const me = M.me, ev = n => me.when(n);
  S.chests.mid0.setOpen(lid(t, ev('openMid'), L('H07').start));
  S.chests.woods.setOpen(lid(t, ev('openWoods'), ev('openWoods') + 1.2));
  S.chests.blitz.setOpen(lid(t, ev('openBlitz'), L('H18').start + 0.1));
  for (let i = 1; i < 8; i++) S.chests['mid' + i].setOpen(t > T.tRun + 2.4 + i * 0.3 && t < T.tTp ? 1 : 0);
  // 别的玩家
  if (!S.models) S.models = M.agents.map(a => { const P = makePlayer({ classic: a.skin }); st.add(P); return P; });
  M.agents.forEach((a, k) => posePlayer(S.models[k], a, t));
  (S.coverFill || []).forEach(P => { P.group.visible = false; }); if (S.coverMe) S.coverMe.group.visible = false;
  // 我：相机 = 眼睛
  const s = sample(me, t);
  const hs = Math.hypot(s.vx, s.vz), sprintK = clamp((hs - 4.4) / 1.0);
  const fov = 70 * (1 + 0.09 * sprintK);
  if (Math.abs(st.camera.fov - fov) > 1e-3) { st.camera.fov = fov; st.camera.updateProjectionMatrix(); }
  // 被打中：原版的受伤镜头（往一边歪一下，0.5 秒回正）
  let roll = 0;
  for (const k of me.kicks) if (t >= k.t && t < k.t + 0.5) { const u = 1 - (t - k.t) / 0.5; roll = -Math.sin(u * u * u * u * Math.PI) * 0.24; }
  const bv = placeCamera(st.camera, s, { roll });
  st.focus.set(s.x, s.y, s.z); st.placeSun();
  if (!S.hand) { S.hand = makeHand(); st.camera.add(S.hand.group); }
  S.hand.update(s, swingAt(me, t), heldAt(me, t), bv);
  return st;
}

// =================================================================== 2D：物品栏、记分板、聊天、进度、卡片、箱子界面
const hotbarXY = i => [Math.round((W - 546) / 2) + 3 + i * 60 + 30, H - 66 - 6 + 33];
function cursor(g, x, y) {
  g.save(); g.translate(Math.round(x), Math.round(y)); g.scale(2.4, 2.4);
  g.beginPath(); g.moveTo(0, 0); g.lineTo(0, 13); g.lineTo(3, 10); g.lineTo(5.5, 15); g.lineTo(7.5, 14); g.lineTo(5, 9); g.lineTo(9, 9); g.closePath();
  g.fillStyle = '#ffffff'; g.fill(); g.lineWidth = 1; g.strokeStyle = '#000000'; g.stroke();
  g.restore();
}
const GUI = { s: 5, w: 176, h: 78 };
function guiBox(g, x, y, w, h, s) {
  g.fillStyle = '#000000';
  g.fillRect(x + s, y, w - 2 * s, s); g.fillRect(x + s, y + h - s, w - 2 * s, s); g.fillRect(x, y + s, s, h - 2 * s); g.fillRect(x + w - s, y + s, s, h - 2 * s);
  g.fillStyle = '#c6c6c6'; g.fillRect(x + s, y + s, w - 2 * s, h - 2 * s);
  g.fillStyle = '#ffffff'; g.fillRect(x + s, y + s, w - 3 * s, 2 * s); g.fillRect(x + s, y + s, 2 * s, h - 3 * s);
  g.fillStyle = '#555555'; g.fillRect(x + 2 * s, y + h - 3 * s, w - 3 * s, 2 * s); g.fillRect(x + w - 3 * s, y + 2 * s, 2 * s, h - 3 * s);
}
function slotXY(c, r) { const s = GUI.s, x0 = Math.round(W / 2 - GUI.w * s / 2), y0 = Math.round(H / 2 - 40 - GUI.h * s / 2); return [x0 + (7 + 18 * c) * s, y0 + (17 + 18 * r) * s]; }
function chestGui(g, title, items) {
  const s = GUI.s, x0 = Math.round(W / 2 - GUI.w * s / 2), y0 = Math.round(H / 2 - 40 - GUI.h * s / 2);
  g.fillStyle = 'rgba(16,16,16,0.52)'; g.fillRect(0, 0, W, H);
  guiBox(g, x0, y0, GUI.w * s, GUI.h * s, s);
  HUD.mcText(g, title, x0 + 8 * s, y0 + 13 * s, { size: 36, color: '#404040', shadow: false });
  for (let r = 0; r < 3; r++) for (let c = 0; c < 9; c++) {
    const [x, y] = slotXY(c, r);
    g.fillStyle = '#373737'; g.fillRect(x, y, 18 * s, 18 * s);
    g.fillStyle = '#ffffff'; g.fillRect(x + s, y + s, 17 * s, 17 * s);
    g.fillStyle = '#8b8b8b'; g.fillRect(x + s, y + s, 16 * s, 16 * s);
  }
  items.forEach(([c, r, icon, n]) => {
    const [x, y] = slotXY(c, r);
    O.pixelIcon(g, icon, x + 9 * s, y + 9 * s, 16 * s);
    if (n > 1) HUD.mcText(g, String(n), x + 17 * s, y + 17 * s, { size: 30, align: 'right' });
  });
}
// 一只箱子的界面：打开 → 鼠标一件件拿东西 → 东西飞进物品栏 → 关上
// box: { title, items: [[列, 行, 图标, 数量, 去物品栏第几格 | null]], t0（打开）, t1（关上）, picks（每件拿走的时间） }
const PICK_FLY = 0.3;
function chestScene(g, t, box, hot) {
  if (t < box.t0 + 0.12 || t >= box.t1) return false;
  const left = box.items.filter((it, k) => it[4] === null || t < box.picks[k]);
  chestGui(g, box.title, left);
  hot();
  box.items.forEach(([c, r, icon, , to], k) => {
    if (to === null) return;
    const k1 = prog(t, box.picks[k], PICK_FLY); if (k1 <= 0 || k1 >= 1) return;
    const [sx, sy] = slotXY(c, r), [tx, ty] = hotbarXY(to), u = E.inOutCubic(k1);
    O.pixelIcon(g, icon, lerp(sx + 45, tx, u), lerp(sy + 45, ty, u) - 60 * Math.sin(Math.PI * u), lerp(80, 48, u));
  });
  const order = box.items.map((it, k) => k).filter(k => box.items[k][4] !== null);
  const nx = order.find(k => t < box.picks[k]);
  if (nx !== undefined) {
    const i = order.indexOf(nx), prev = i ? order[i - 1] : null, k0 = prev === null ? box.t0 + 0.15 : box.picks[prev];
    const [cx, cy] = slotXY(box.items[nx][0], box.items[nx][1]), [px, py] = prev === null ? [W / 2 + 120, H / 2 + 60] : slotXY(box.items[prev][0], box.items[prev][1]);
    const u = E.inOutCubic(prog(t, k0, Math.max(0.1, box.picks[nx] - k0 - 0.05)));
    cursor(g, lerp(px + 45, cx + 45, u), lerp(py + 45, cy + 45, u));
  }
  return true;
}
function boxes() {
  return once('boxes', () => {
    const M = match(), me = M.me, T = mt();
    const o1 = me.when('openMid'), o2 = me.when('openWoods'), o3 = me.when('openBlitz');
    return {
      mid: { title: '箱子', t0: o1, t1: L('H07').start - 0.05, items: [[2, 0, 'sprite:sword:sword_iron', 1, 0], [5, 1, 'tile:planks', 32, 1], [7, 2, 'sprite:ingot:ingot_iron', 2, null], [0, 2, 'sprite:gem:gem_diamond', 1, null]], picks: [o1 + 0.75, o1 + 1.25, 0, 0] },
      woods: { title: '箱子', t0: o2, t1: o2 + 1.35, items: [[4, 1, 'sprite:apple:apple', 3, 2], [1, 0, 'sprite:stick:stick_kb', 2, null]], picks: [o2 + 0.7, 0] },
      blitz: { title: '箱子', t0: o3, t1: L('H18').start + 0.1, items: [[4, 1, 'sprite:star:star', 1, 3], [7, 0, 'sprite:apple:apple', 1, null], [1, 2, 'sprite:ingot:ingot_gold', 3, null]], picks: [Math.max(o3 + 0.9, T.tStar - 0.2), 0, 0] },
    };
  });
}
// 物品栏：东西飞进来以后才出现；木板随放下的方块减少
function slotsAt(t) {
  const M = match(), B = boxes();
  const got = (b, k) => t >= B[b].picks[k] + PICK_FLY;
  const used = M.sim.events.filter(e => e.kind === 'place' && e.who === 'me' && e.t <= t).length;
  return [got('mid', 0) ? { icon: 'sprite:sword:sword_iron', n: 1 } : null, got('mid', 1) ? { icon: 'tile:planks', n: 32 - used } : null,
    got('woods', 0) ? { icon: 'sprite:apple:apple', n: 3 } : null, got('blitz', 0) ? { icon: 'sprite:star:star', n: 1 } : null];
}
function selAt(t) { const h = heldAt(match().me, t); return h.item === 'sword' ? 0 : h.item === 'planks' ? 1 : 8; }
function hearts(t) {
  const me = match().me, T = mt();
  const n = me.kicks.filter(k => t >= k.t && (t < T.tTp || k.t >= T.tTp)).length;
  return 10 - 1.5 * n;
}
function leftAt(t) {
  const T = mt(), M = match();
  if (t < T.tRun) return 24;
  if (t < T.tTp) { const steps = [[T.tRun + 3, 23], [M.tFight0 + 1.8, 22], [L('H08').start, 19], [L('H10').start, 16], [L('H13').start, 13], [M.tKill1, 12], [L('H17').start, 10], [L('H19').start, 8], [L('H22').start, 6], [L('H24B').start, 4]]; let n = 24; for (const [tt, v] of steps) if (t >= tt) n = v; return n; }
  return t < M.tD1 ? 4 : t < M.tD2 ? 3 : t < T.tWin + 0.35 ? 2 : 1;
}
function killsAt(t) { const M = match(), T = mt(); return (t >= M.tKill1 ? 1 : 0) + (t >= T.tWin + 0.35 ? 1 : 0); }
// 原版样式的进度提示（右上角）
function toast(g, t, t0, title, line, icon, o = {}) {
  const dur = o.dur ?? 4.2, k = E.outCubic(prog(t, t0, 0.35)) * (1 - E.inOutSine(prog(t, t0 + dur - 0.4, 0.4)));
  if (k <= 0) return;
  const w = 540, h = 104, x = W - 24 - w * k, y = 26;
  g.save();
  g.fillStyle = 'rgba(33,33,33,0.96)'; g.fillRect(x, y, w, h);
  g.fillStyle = '#555555'; g.fillRect(x, y, w, 4); g.fillRect(x, y + h - 4, w, 4); g.fillRect(x, y, 4, h); g.fillRect(x + w - 4, y, 4, h);
  O.pixelIcon(g, icon, x + 56, y + h / 2, 56);
  HUD.mcText(g, title, x + 104, y + 42, { size: 28, color: o.color || '#ffff55' });
  HUD.mcText(g, line, x + 104, y + 82, { size: 28, color: '#ffffff' });
  g.restore();
}
// 左上角的小卡片：一行小字（来源）+ 一行大字
function card(g, t, t0, t1, kicker, text, o = {}) {
  const a = env(t, t0, t1, 0.35, 0.35);
  if (a <= 0) return;
  const x = 40, y = o.y ?? 40;
  O.setFont(g, o.size || 34, O.FONT.serif, 600);
  const w = Math.max(g.measureText(text).width, O.measure(g, kicker, 20, O.FONT.sans, 700) * 1.25) + 64;
  g.save(); g.globalAlpha = a;
  g.fillStyle = 'rgba(8,10,16,0.72)'; g.fillRect(x, y, w, 112);
  g.fillStyle = O.COL.brass; g.fillRect(x, y, 4, 112);
  O.kicker(g, kicker, x + 28, y + 38, 1, { align: 'left', size: 20, spacing: 4, color: O.COL.brass });
  O.txt(g, text, x + 28, y + 86, { size: o.size || 34, family: O.FONT.serif, weight: 600, color: O.COL.bone, shadow: false });
  g.restore();
}
// 改名：Hunger Games 划掉，下面写 Survival Games
function renameCard(g, t, t0, t1) {
  const a = env(t, t0, t1, 0.4, 0.4); if (a <= 0) return;
  const cx = W / 2, y = 330, strike = E.inOutCubic(prog(t, t0 + 0.9, 0.5)), k2 = E.outCubic(prog(t, t0 + 1.5, 0.6));
  g.save(); g.globalAlpha = a;
  O.scrim(g, cx, y + 60, 620, 200, 0.9);
  O.txt(g, 'Hunger Games', cx, y, { size: 84, family: O.FONT.serif, weight: 900, align: 'center', color: O.COL.bone, alpha: 1 - 0.45 * strike });
  O.setFont(g, 84, O.FONT.serif, 900); const w = g.measureText('Hunger Games').width;
  g.fillStyle = '#ff5555'; g.fillRect(cx - w / 2 - 10, y - 30, (w + 20) * strike, 7);
  O.txt(g, 'Survival Games', cx, y + 120, { size: 84, family: O.FONT.serif, weight: 900, align: 'center', color: O.COL.brass, alpha: k2 });
  O.kicker(g, '据说是因为电影名字的版权', cx, y + 190, k2, { size: 24, spacing: 6, color: O.COL.bone });
  g.restore();
}
// 两个日期：2012.03.23 电影上映 / 2017.03.23 绝地求生抢先体验
function datesCard(g, t, t0, t1) {
  const a = env(t, t0, t1, 0.4, 0.4); if (a <= 0) return;
  const k2 = E.outCubic(prog(t, t0 + 0.8, 0.6));
  g.save(); g.globalAlpha = a;
  O.scrim(g, W / 2, 420, 900, 230, 0.9);
  [[W / 2 - 260, '2012.03.23', '电影《饥饿游戏》北美上映', 1], [W / 2 + 260, '2017.03.23', '《绝地求生》开启抢先体验', k2]].forEach(([x, d, cap, k]) => {
    O.txt(g, d, x, 400, { size: 72, family: O.FONT.serif, weight: 900, align: 'center', color: O.COL.bone, alpha: k });
    O.kicker(g, cap, x, 460, k, { size: 24, spacing: 4, color: O.COL.brass });
  });
  O.kicker(g, '同一天 · 隔了五年（巧合）', W / 2, 540, E.outCubic(prog(t, t0 + 1.6, 0.6)), { size: 26, spacing: 8, color: O.COL.bone });
  g.restore();
}
// 同一部电影，两条路
function branchCard(g, t, t0, t1) {
  const a = env(t, t0, t1, 0.4, 0.4); if (a <= 0) return;
  const k1 = E.inOutCubic(prog(t, t0 + 0.4, 0.8)), k2 = E.inOutCubic(prog(t, t0 + 1.4, 0.8));
  const x0 = W / 2 - 560, y0 = 420, xa = W / 2 + 10;
  g.save(); g.globalAlpha = a;
  O.scrim(g, W / 2, 420, 1000, 300, 0.92);
  O.txt(g, '《饥饿游戏》', x0, y0 + 14, { size: 54, family: O.FONT.serif, weight: 900, color: O.COL.bone });
  O.kicker(g, '电影 · 2012', x0 + 150, y0 + 60, 1, { size: 20, spacing: 4, color: O.COL.brass });
  g.strokeStyle = O.COL.brass; g.lineWidth = 3;
  const line = (y, k) => { if (k <= 0) return; g.beginPath(); g.moveTo(x0 + 330, y0); g.lineTo(x0 + 360, y0); g.lineTo(x0 + 360, y); g.lineTo(x0 + 360 + (xa - x0 - 380) * k, y); g.stroke(); };
  line(y0 - 90, k1); line(y0 + 90, k2);
  O.txt(g, '我的世界的饥饿游戏', xa, y0 - 76, { size: 44, family: O.FONT.serif, weight: 900, color: O.COL.bone, alpha: k1 });
  O.kicker(g, '2012 · 服务器上的小游戏', xa + 200, y0 - 26, k1, { size: 20, spacing: 4, color: O.COL.brass });
  O.txt(g, '大逃杀模组 → 绝地求生', xa, y0 + 104, { size: 44, family: O.FONT.serif, weight: 900, color: O.COL.bone, alpha: k2 });
  O.kicker(g, '2013 · 2017', xa + 220, y0 + 154, k2, { size: 20, spacing: 4, color: O.COL.brass });
  g.restore();
}
function hudOverlay(g, t) {
  const T = mt(), B = boxes();
  const hot = () => HUD.hotbar(g, slotsAt(t), selAt(t), { hearts: hearts(t), xp: 0.1 + 0.6 * prog(t, T.tRun, T.tEnd - T.tRun), level: killsAt(t) * 3 });
  const inGui = ['mid', 'woods', 'blitz'].some(k => t >= B[k].t0 + 0.12 && t < B[k].t1);
  if (!inGui) { HUD.crosshair(g, 0.9); hot(); }
  HUD.scoreboard(g, '饥饿游戏', [], [['剩余玩家：', leftAt(t)], ['击杀：', killsAt(t)], ['阶段：', t < T.tRun ? '准备' : t < T.tTp ? '搜刮' : '死亡竞赛']], { alpha: 0.95 });
  ['mid', 'woods', 'blitz'].forEach(k => chestScene(g, t, B[k], hot));
}
function chatMsgs() {
  return once('chat', () => {
    const T = mt(), M = match();
    const die = (who, by, tt) => ({ t: tt, parts: [[who, '#ffff55'], [' 被 ', '#aaaaaa'], [by, '#ff5555'], [' 杀死了', '#aaaaaa']] });
    return [
      { t: T.tRun - 0.1, parts: [['[饥饿游戏] ', '#ffff55'], ['游戏开始！祝你好运。', '#ffffff']] },
      die('Notch_Fan', 'Kiwi', M.tFight0 + 1.85),
      { t: L('H08').start + 1, parts: [['<小明> ', '#55ffff'], ['中间的箱子被搬空了', '#ffffff']] },
      die('Bread', 'Moss', L('H10').start + 0.5),
      die('Kiwi', '你', M.tKill1 + 0.1),
      { t: L('H19').start + 0.3, parts: [['[饥饿游戏] ', '#ffff55'], ['天黑了，箱子已经补满。', '#ffffff']] },
      { t: T.tTp - 0.2, parts: [['[饥饿游戏] ', '#ffff55'], ['只剩 4 人，死亡竞赛开始！', '#ff5555']] },
      die('Moss', 'Rex', M.tD1 + 0.05), die('Pine', 'Rex', M.tD2 + 0.05),
      die('Rex', '你', T.tWin + 0.4),
    ];
  });
}
function matchOverlay(g, t) {
  const T = mt(), M = match();
  // 倒数（原版 /title）
  T.tCount.forEach((t0, i) => { const t1 = T.tCount[i + 1] ?? T.tRun; if (t >= t0 - 0.05 && t < t1 + 0.1) HUD.title(g, t, t0, t1 + 0.1, String(3 - i), null, { size: 200, color: ['#55ff55', '#ffff55', '#ff5555'][i] }); });
  if (t >= T.tRun - 0.05 && t < T.tRun + 3.2) HUD.title(g, t, T.tRun, T.tRun + 3.2, '饥饿游戏', '我的世界小游戏起源 · 第三期', { size: 120, color: '#ffffff', subColor: '#ffff55' });
  hudOverlay(g, t);
  HUD.chat(g, t, chatMsgs(), { x: 24, bottom: HUD.HUD_TOP - 150, size: 26, width: 660 });
  // 被打中：屏幕红一下
  for (const k of M.me.kicks) if (t >= k.t && t < k.t + 0.35) { g.fillStyle = `rgba(255,0,0,${0.22 * (1 - (t - k.t) / 0.35)})`; g.fillRect(0, 0, W, H); }
  // 进度达成
  [[L('H03').start + 0.3, '进度达成！', '我的世界的饥饿游戏 · 2012', 'tile:grass_side'],
   [L('H09').start + 0.2, '进度达成！', 'MCSG · 2012', 'sprite:sword:sword_iron'],
   [L('H16').start + 0.2, '进度达成！', '闪电饥饿游戏 · 2013', 'sprite:star:star'],
   [L('H18').start + 0.3, '进度达成！', '来到国内 · 2017', 'tile:lantern'],
   [L('H22').start + 1.2, '进度达成！', '绝地求生 · 2017', 'sprite:chest:chest_iron'],
   [L('H27').start + 0.3, '进度达成！', 'MC Championship · 2019', 'sprite:coin:coin'],
  ].forEach(([t0, a, b, icon]) => toast(g, t, t0, a, b, icon));
  // 卡片
  card(g, t, L('H02').start + 0.2, L('H03').start, '电影 · 2012.03.23 北美上映', '《饥饿游戏》：24 个人，只有一个能活着出来');
  card(g, t, L('H03').start + 0.3, L('H04').start, '2012 年春', '我的世界的服务器，办起了自己的饥饿游戏');
  card(g, t, L('H06').start + 0.3, L('H07').end, '原著里的说法', '丰饶角（Cornucopia）：竞技场中心的物资堆');
  card(g, t, L('H09').start + 0.3, L('H10').start, 'MCSG · 2012.04 · 按管理员的回忆', '早期自动运行的饥饿游戏服务器之一');
  card(g, t, L('H10').start + 0.2, L('H11').start, 'MCSG 的第一张地图 · 据说只造了几天', 'Survival Games 1');
  renameCard(g, t, L('H12').start + 0.2, L('H13').end);
  card(g, t, L('H16').start + 0.4, L('H17').start, 'HYPIXEL · 2013.06', 'Blitz Survival Games · 中国版叫闪电饥饿游戏');
  card(g, t, L('H17').start + 0.3, L('H18').start, '闪电之星', '开局几分钟后，出现在某个箱子里');
  card(g, t, L('H18').start + 0.4, L('H18').end + 0.4, '我的世界中国版 · 2017.08', '不限号测试时，闪电饥饿游戏上线');
  card(g, t, L('H21').start + 0.3, L('H22').end, 'BRENDAN GREENE · 2013 · ARMA 2 模组', 'DayZ: Battle Royale · 他说一开始想做成《饥饿游戏》那样', { size: 30 });
  datesCard(g, t, L('H23').start + 0.2, L('H23').end + 0.3);
  branchCard(g, t, L('H24').start + 0.2, L('H24B').end + 0.4);
  card(g, t, L('H26').start + 0.3, L('H27').start, 'MCGAMER（MCSG）', '后来因为资金不够，关了服');
  card(g, t, L('H27').start + 0.3, L('H27').end + 0.3, 'MC CHAMPIONSHIP · 2019 起', '比赛项目之一：Survival Games');
  if (t >= L('H11').start && t < L('H12').start) O.filmText(g, t, wordTime('H11', 'Survival'), L('H12').start, 'Survival Games？', W / 2, 420, { size: 96, weight: 900, spacing: 4, spread: 10, fout: 0.3 });
  if (t >= L('H13').start && t < L('H14').start) O.filmText(g, t, wordTime('H13', '饥饿游戏') - 0.1, L('H14').start, '饥饿游戏', W / 2, 440, { size: 120, weight: 900, spacing: 16, spread: 20, fout: 0.3, color: O.COL.brass });
  // 传送：白光一闪
  if (t >= T.tTp - 0.4 && t < T.tTp + 0.6) { const k = t < T.tTp ? prog(t, T.tTp - 0.4, 0.4) : 1 - prog(t, T.tTp, 0.6); g.fillStyle = `rgba(255,255,255,${k})`; g.fillRect(0, 0, W, H); }
  // 胜利
  if (t >= T.tWin + 0.4 && t < L('H30').start + 1) HUD.title(g, t, T.tWin + 0.4, L('H30').start + 1, '胜利！', '你是最后一个活下来的人', { size: 150, color: '#ffff55' });
  // 结尾：问题 + 黑场
  card(g, t, L('H31').start + 0.2, T.tEnd + 1.6, '评论区见', '开局：冲中间抢箱子，还是掉头就跑？', { size: 38 });
  const tb = T.tEnd + 0.6;
  if (t >= tb) {
    g.fillStyle = `rgba(0,0,0,${prog(t, tb, 0.8)})`; g.fillRect(0, 0, W, H);
    O.kicker(g, '我的世界小游戏起源 · 第三期 · 饥饿游戏', W / 2, H / 2 - 10, env(t, tb + 0.5, TL.duration + 1, 0.6, 0.3), { size: 30, spacing: 12, color: O.COL.brass, family: O.FONT.serif, weight: 600 });
    O.kicker(g, '下期见', W / 2, H / 2 + 50, env(t, tb + 0.9, TL.duration + 1, 0.6, 0.3), { size: 24, spacing: 14, color: O.COL.bone, family: O.FONT.serif, weight: 600 });
  }
}
// 音效、配乐提示点
function matchCues() {
  const M = match(), T = mt(), out = [];
  for (const e of M.sim.events) if (e.kind === 'place' && e.who === 'me') out.push({ t: e.t, sfx: 'place' });
  for (const a of [M.me, ...M.agents]) for (const k of a.kicks) out.push({ t: k.t, sfx: 'hit' });
  ['openMid', 'openWoods', 'openBlitz'].forEach(n => out.push({ t: M.me.when(n), sfx: 'chest' }));
  T.tCount.forEach(t => out.push({ t, sfx: 'count' })); out.push({ t: T.tRun, sfx: 'ding' });
  out.push({ t: T.tTp, sfx: 'whoosh' }, { t: T.tWin + 0.4, sfx: 'confetti' });
  [['open', 0], ['light', T.tRun], ['melody', L('H08').start], ['mid', T.tEnemy - 0.5], ['melody', L('H16').start], ['soft', T.tNight], ['build', T.tTp], ['finale', T.tWin + 0.3], ['soft', L('H31').start]].forEach(([name, t]) => out.push({ t, sfx: 'score', name }));
  return out.filter(c => isFinite(c.t)).sort((a, b) => a.t - b.t);
}
const subLift = () => H - HUD.HUD_TOP + 8;
for (const s of TL.scenes) SCENES[s.id] = { trans: 'cut', bars: () => 0, subLift, frame: matchFrame, overlay: matchOverlay, cues: s.id === TL.scenes[0].id ? matchCues : () => [], tone: false, glow: 0.12, satGuard: false, look: () => 'contrast(1.04)' };

// 检查用
window.__camProbe = t => { const s = sample(match().me, t); return [s.x, s.y + s.eye, s.z, s.yaw, s.pitch]; };
window.__simEvents = () => match().sim.events.map(e => [e.t.toFixed(2), e.kind, e.x, e.y, e.z, e.who]);
window.__T = () => mt();

// =================================================================== 封面（16:9 和 4:3）
// 开局前一刻的俯瞰：24 个出生台围着丰饶角，每个台子上站着一个人；左边（4:3 是上面）压暗写片名。
// window.__coverCam = { pos, target, fov } 可以临时换取景（挑构图时用）
function coverStage() {
  const S = hgWorld(), M = match(), st = S.st;
  st.setPreset('cine_morning');
  if (!S.models) S.models = M.agents.map(a => { const P = makePlayer({ classic: a.skin }); st.add(P); return P; });
  M.agents.forEach((a, k) => posePlayer(S.models[k], a, 20));
  // 封面上我也站在出生台上（正南那个）
  if (!S.coverMe) { S.coverMe = makePlayer({ skin: { shirt: '#3a7bd5', seed: 2 } }); st.add(S.coverMe); }
  at(S.coverMe, 0.5, 2, 11.5, Math.PI); S.coverMe.pose({ look: [0, 0] }); S.coverMe.group.visible = true;
  // 空着的出生台上也站上人（封面上 24 个台子都是满的）
  if (!S.coverFill) {
    const used = new Set(M.agents.filter(a => a.vis[0] < 20 && 20 < a.vis[1]).map(a => `${Math.floor(a.rec.x[0])},${Math.floor(a.rec.z[0])}`));
    S.coverFill = [];
    for (let i = 1; i < PEDESTALS; i++) { const [x, z] = ped(i); if (used.has(`${x},${z}`)) continue; const P = makePlayer({ classic: SKINS[i % SKINS.length] }); at(P, x + 0.5, 2, z + 0.5, Math.atan2(-x, -z)); P.pose({ look: [0.3 * Math.sin(i), 0] }); st.add(P); S.coverFill.push(P); }
  }
  S.coverFill.forEach(P => { P.group.visible = true; });
  Object.values(S.chests).forEach(c => c.setOpen(0));
  if (S.hand) S.hand.group.visible = false;
  for (const m of S.placed.values()) m.visible = false;
  st.focus.set(0, 0, 0); st.placeSun();
  return st;
}
const coverLook = (st, pos, target, fov) => { const o = window.__coverCam; st.camera.rotation.order = 'XYZ'; return o && o.pos ? st.look(o.pos, o.target, o.fov) : st.look(pos, target, fov); };
const coverBase = { bars: () => 0, satGuard: false, glow: 0.18, tone: false, look: () => 'saturate(1.12) brightness(1.03)' };
SCENES.__cover = {
  ...coverBase,
  frame() { const st = coverStage(); coverLook(st, [11, 13.5, 14.5], [-6.5, -1, -3], 42); return st; },
  overlay(g) {
    const gr = g.createLinearGradient(0, 0, W * 0.7, 0);
    gr.addColorStop(0, 'rgba(6,12,24,0.8)'); gr.addColorStop(0.6, 'rgba(6,12,24,0.4)'); gr.addColorStop(1, 'rgba(6,12,24,0)');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    O.kicker(g, '我的世界小游戏起源 · 第三期', 118, 330, 1, { align: 'left', size: 40, spacing: 8, color: O.COL.brass, family: O.FONT.serif, weight: 600 });
    O.txt(g, '饥饿游戏', 104, 590, { size: 250, family: O.FONT.serif, weight: 900, color: O.COL.bone, spacing: 12, shadowBlur: 40, shadowColor: 'rgba(0,0,0,0.6)' });
    O.txt(g, '到底是从哪来的？', 116, 740, { size: 104, family: O.FONT.serif, weight: 900, color: O.COL.bone, spacing: 6, shadowBlur: 30, shadowColor: 'rgba(0,0,0,0.6)' });
  },
};
SCENES.__cover43 = {
  ...coverBase,
  frame() { const st = coverStage(); coverLook(st, [8, 20, 26], [0.5, -1, -2], 44); return st; },
  overlay(g) {
    const gr = g.createLinearGradient(0, 0, 0, H * 0.62);
    gr.addColorStop(0, 'rgba(6,12,24,0.82)'); gr.addColorStop(0.65, 'rgba(6,12,24,0.42)'); gr.addColorStop(1, 'rgba(6,12,24,0)');
    g.fillStyle = gr; g.fillRect(0, 0, W, H * 0.62);
    O.kicker(g, '我的世界小游戏起源 · 第三期', W / 2, 130, 1, { size: 42, spacing: 8, color: O.COL.brass, family: O.FONT.serif, weight: 600 });
    O.txt(g, '饥饿游戏', W / 2, 372, { size: 236, family: O.FONT.serif, weight: 900, color: O.COL.bone, spacing: 14, align: 'center', shadowBlur: 40, shadowColor: 'rgba(0,0,0,0.65)' });
    O.txt(g, '到底是从哪来的？', W / 2, 510, { size: 96, family: O.FONT.serif, weight: 900, color: O.COL.bone, spacing: 6, align: 'center', shadowBlur: 30, shadowColor: 'rgba(0,0,0,0.6)' });
  },
};

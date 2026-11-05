// EP04 空岛生存 · 场景：整期是同一局空岛生存的第一人称实况
// （两条规矩 → 撸树、做工作台 → 开箱：岩浆和冰 → 刷石机 → 搭圆石扩岛 → 延时：小岛长成家 → 远处的 OneBlock → 商标 → 回到最早那座 L 形小岛）。
// 动作全部来自 motion.js 的逐 tick 模拟（走路、挖方块、放方块、蹲着搭路），这里只写“想做什么”；时间锚在旁白的字上（wordTime / L）。
import * as THREE from 'three';
import { W, H, TL, L, wordTime, clamp, lerp, E, prog, env, rng } from './util.js';
import { Stage, mixPreset, Voxels, buildVoxelMesh, mistLayer } from './world.js';
import { makePlayer, makeChest, Bursts, Motes } from './entities.js';
import { blockMesh, itemMesh } from './voxel.js';
import * as O from './overlay.js';
import * as HUD from './hud.js';
import { once, at } from './kit.js';
import { Sim, sample, placeCamera, swingAt, heldAt } from './motion.js';

export const SCENES = {};

// =================================================================== 地图：原版那座 L 形小岛（长边 6 格、短边 3 格、宽 3 格，三层厚），悬在虚空里
// 长边 x 0..5、z 0..2；短边 x 0..2、z 3..5；草在 y = 0（站在 y = 1）
const L_CELLS = (() => { const c = []; for (let x = 0; x < 6; x++) for (let z = 0; z < 3; z++) c.push([x, z]); for (let x = 0; x < 3; x++) for (let z = 3; z < 6; z++) c.push([x, z]); return c; })();
const TRUNK = [1, 4];                  // 树干那一列
const LOGS = [1, 2, 3, 4].map(y => [TRUNK[0], y, TRUNK[1]]);
const CHEST = [5, 1, 0];
const GEN = { lava: [2, 0, 1], cobble: [3, 0, 1], water: [4, 0, 1] };   // 刷石机：一排三个坑，岩浆、出圆石的格子、水
const TABLE = [0, 1, 0];
const BRIDGE_N = 4;                    // 往东搭 4 格圆石
const ONEBLOCK = [4, 3, 12];         // 远处虚空里的 OneBlock
function leafCells() {
  const out = [], r = rng(31), [x0, z0] = TRUNK, top = 5;
  for (let dy = -2; dy <= 1; dy++) {
    const rad = dy >= 0 ? 1 : 2;
    for (let dx = -rad; dx <= rad; dx++) for (let dz = -rad; dz <= rad; dz++) {
      if (Math.abs(dx) === rad && Math.abs(dz) === rad && (r() < 0.6 || dy === 1)) continue;
      if (dx === 0 && dz === 0 && dy < 0) continue;
      out.push([x0 + dx, top + dy - 1 + 1, z0 + dz]);
    }
  }
  return out;
}
// 延时那一段长出来的东西：圆石平台、小房子、农田（按顺序一块块出现）
function baseBlocks() {
  return once('baseBlocks', () => {
    const out = [];
    // 圆石平台：东边 x 6..11、z -2..4
    for (let r = 0; r < 7; r++) for (let x = 6; x <= 11; x++) { const z = [1, 0, 2, -1, 3, -2, 4][r]; if (!(z === 2 && x <= 5 + BRIDGE_N)) out.push([x, 0, z, 'cobble']); }
    // 农田：x 7..10、z 3..4，上面种小麦
    for (let x = 7; x <= 10; x++) for (const z of [3, 4]) out.push([x, 0, z, 'farmland']);
    for (let x = 7; x <= 10; x++) for (const z of [3, 4]) out.push([x, 1, z, 'wheat']);
    // 小房子：x 8..11、z -2..0，墙两格高（木板），中间留门
    for (let y = 1; y <= 2; y++) for (let x = 8; x <= 11; x++) for (let z = -2; z <= 0; z++) {
      const edge = x === 8 || x === 11 || z === -2 || z === 0;
      if (!edge || (x === 9 && z === 0)) continue;
      out.push([x, y, z, y === 1 ? 'cobble' : 'planks']);
    }
    for (let x = 8; x <= 11; x++) for (let z = -2; z <= 0; z++) out.push([x, 3, z, 'planks']);
    return out;
  });
}

function skyWorld() {
  return once('sky', () => {
    const st = new Stage({ preset: 'cine_morning', focus: [3, 0, 2], shadowSpan: 22, clouds: true, cloudY: 40 });
    st.scene.add(st.camera);
    const v = new Voxels();
    for (const [x, z] of L_CELLS) { v.set(x, 0, z, 'grass'); v.set(x, -1, z, 'dirt'); v.set(x, -2, z, 'dirt'); }
    // 刷石机的三个坑单独做成方块（要被挖掉）；其余的岛是一整块网格
    const cut = new Set(Object.values(GEN).map(c => c.join(',')));
    const vv = new Voxels(); for (const [x, z] of L_CELLS) for (const y of [0, -1, -2]) { const k = `${x},${y},${z}`; if (!cut.has(k)) vv.set(x, y, z, v.get(x, y, z)); }
    st.add(buildVoxelMesh(vv));
    const blocks = {};
    const block = (key, type, [x, y, z]) => { const m = blockMesh(type, 1); m.position.set(x + 0.5, y + 0.5, z + 0.5); st.add(m); blocks[key] = m; return m; };
    Object.values(GEN).forEach(c => block('g' + c.join(','), 'grass', c));
    LOGS.forEach(c => block('log' + c[1], 'log', c));
    const leaves = leafCells().map((c, i) => { const m = blockMesh('leaves', 1); m.position.set(c[0] + 0.5, c[1] + 0.5, c[2] + 0.5); st.add(m); return m; });
    const chest = makeChest(); at(chest, CHEST[0] + 0.5, 1, CHEST[2] + 0.5, Math.PI); st.add(chest);
    // 刷石机：岩浆、水、圆石（水和岩浆是半透明 / 发光的矮方块）
    const liquid = (color, emissive, op) => new THREE.MeshLambertMaterial({ color, emissive: emissive || '#000000', transparent: op < 1, opacity: op });
    const lavaM = new THREE.Mesh(new THREE.BoxGeometry(1, 0.88, 1), liquid('#f07a18', '#c04010', 1));
    const lavaFlow = new THREE.Mesh(new THREE.BoxGeometry(1, 0.5, 1), liquid('#f07a18', '#c04010', 1));
    const waterM = new THREE.Mesh(new THREE.BoxGeometry(1, 0.88, 1), liquid('#3f76e4', null, 0.78));
    const iceM = blockMesh('ice', 1);
    const cobbleM = blockMesh('cobble', 1);
    [lavaM, lavaFlow, waterM, iceM, cobbleM].forEach(m => { st.add(m); m.visible = false; });
    const lavaLight = new THREE.PointLight('#ff8a3a', 0, 6, 1.6); lavaLight.position.set(GEN.lava[0] + 0.5, 1.2, GEN.lava[2] + 0.5); st.add(lavaLight);
    // 延时：长出来的方块
    // 小麦：两片交叉的面片（像原版的作物），不是方块
    const wheatTex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 16; const g2 = c.getContext('2d'), r = rng(5);
      for (let x = 1; x < 16; x += 2) { const h = 9 + Math.floor(r() * 6); g2.fillStyle = '#8fae3a'; g2.fillRect(x, 16 - h + 4, 1, h - 4); g2.fillStyle = r() < 0.5 ? '#d8b544' : '#c9a23a'; g2.fillRect(x, 16 - h, 1, 4); }
      const tx = new THREE.CanvasTexture(c); tx.magFilter = tx.minFilter = THREE.NearestFilter; tx.colorSpace = THREE.SRGBColorSpace; return tx;
    })();
    const wheatMat = new THREE.MeshLambertMaterial({ map: wheatTex, alphaTest: 0.5, side: THREE.DoubleSide });
    const wheatMesh = () => { const gq = new THREE.Group(); for (const a of [Math.PI / 4, -Math.PI / 4]) { const p = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1), wheatMat); p.rotation.y = a; gq.add(p); } return gq; };
    const grow = baseBlocks().map(([x, y, z, type]) => { const m = type === 'wheat' ? wheatMesh() : blockMesh(type, 1); m.position.set(x + 0.5, y + 0.5, z + 0.5); m.visible = false; st.add(m); return m; });
    // 远处的 OneBlock：一个方块悬在虚空里，挖掉一种、刷新出下一种
    const oneTypes = ['grass', 'dirt', 'log', 'cobble', 'planks', 'sand_like', 'leaves', 'stone'];
    const one = ['grass', 'dirt', 'log', 'cobble', 'planks', 'stone', 'leaves', 'gold'].map(type => { const m = blockMesh(type, 1); m.position.set(ONEBLOCK[0] + 0.5, ONEBLOCK[1] + 0.5, ONEBLOCK[2] + 0.5); m.visible = false; st.add(m); return m; });
    const fx = new Bursts(900); st.add(fx.mesh);
    const motes = new Motes(160, [[-20, -6, -20], [24, 12, 24]], { color: '#fff6e0', size: 0.04, opacity: 0.3, seed: 9 }); st.add(motes);
    const mists = [mistLayer({ y: -9, color: '#ffffff', opacity: 0.22 }), mistLayer({ y: -16, color: '#86a8d6', opacity: 0.6, repeat: 3, speed: 0.002 })];
    mists.forEach(m => st.add(m));
    return { st, v, blocks, leaves, chest, lavaM, lavaFlow, waterM, iceM, cobbleM, lavaLight, grow, one, fx, motes, mists, placed: new Map(), drops: new Map() };
  });
}

// =================================================================== 时间点（锚在旁白上）
function mt() {
  return once('mt', () => ({
    tLogs: wordTime('K04', '撸树') - 0.3, tCraft: wordTime('K04', '木板做成') - 0.2, tTable: wordTime('K04', '工作台') + 0.3,
    tChest: L('K07').start + 0.1, tDig: L('K08').start - 0.2, tGen: L('K09').start + 0.2,
    tExpand: L('K10').start, tBridge: L('K10').start + 2.0,
    tLapse0: L('K14').start - 0.2, tLapse1: L('K16').end + 0.2,
    tOne: L('K17').start - 0.3, tMark: L('K19').start, tEnd: L('K25').end,
  }));
}

// =================================================================== 模拟
function match() {
  return once('match', () => {
    const S = skyWorld(), T = mt();
    // 延时里长出来的平台、房子也算实心（我只在延时以后才走上去；小麦不挡路）
    const baseSolid = new Set(baseBlocks().filter(b => b[3] !== 'wheat').map(b => b.slice(0, 3).join(',')));
    const solid = (x, y, z) => { const k = `${x},${y},${z}`; if (LOGS.some(c => c.join(',') === k)) return true; if (CHEST.join(',') === k) return true; return !!S.v.get(x, y, z) || baseSolid.has(k); };
    const sim = new Sim({ solid }, TL.duration + 1);
    const me = sim.add({ name: 'me', pos: [3.5, 1, 1.5], yaw: -Math.PI / 2, pitch: -0.1 });
    // 开局：看看四周，走到岛边往下看一眼虚空，再看树和箱子
    me.look(0.4, { yaw: -2.2, pitch: -0.05, w: 2.5 });
    me.look(wordTime('K01', '跳下去') - 0.6, { yaw: Math.PI, pitch: -0.95, w: 2.4 });
    me.goto(wordTime('K01', '跳下去') - 0.8, [[3.5, 2.55]], 'sneak', { look: null });
    me.look(wordTime('K01', '搭桥') - 0.4, { yaw: Math.PI / 2 + 0.3, pitch: -0.15, w: 2.2 });
    me.look(L('K02').start + 0.4, { at: [TRUNK[0] + 0.5, 3.2, TRUNK[1] + 0.5], w: 2.4 });
    me.look(L('K03').start + 1.2, { yaw: -0.6, pitch: 0.05, w: 1.8 });
    // 撸树：走到树干旁边，从下往上挖四段原木
    me.goto(T.tLogs - 1.6, [[2.5, 2.6], [1.5, 2.6]], 'walk', { look: { path: -0.15, w: 4 } });
    LOGS.forEach((c, i) => me.mine(i ? 0 : T.tLogs, c, { dur: 0.75 }));
    me.wait(0, T.tCraft);
    me.act(T.tCraft, 'craft', { swing: null, dur: 1.9 });
    me.placeAt(0, TABLE, 'craft', { hold: 'craft' });
    // 开箱：岩浆桶和冰
    me.goto(T.tChest - 1.4, [[3.5, 1.5], [4.5, 1.5]], 'walk', { look: { path: -0.2, w: 4 } });
    me.act(T.tChest, 'openChest', { look: { at: [CHEST[0] + 0.5, 1.4, CHEST[2] + 0.5], w: 6 }, dur: 2.0 });
    // 刷石机：退到南边一排，挖三个坑，倒岩浆、放冰
    me.goto(0, [[3.5, 2.55]], 'walk', { look: { path: -0.3, w: 4 }, hold: null });
    me.mine(T.tDig, GEN.lava, { dur: 0.45 }); me.mine(0, GEN.cobble, { dur: 0.45 }); me.mine(0, GEN.water, { dur: 0.45 });
    me.placeAt(0, GEN.lava, 'lava', { hold: 'bucket_lava' });
    me.placeAt(0, GEN.water, 'ice', { hold: 'ice' });
    me.look(T.tGen - 0.6, { at: [GEN.cobble[0] + 0.5, 0.6, GEN.cobble[2] + 0.5], w: 3 });
    // 出了圆石：挖两次（每次挖完岩浆又流过来，又是一块）
    me.mine(T.tGen + 1.2, GEN.cobble, { dur: 0.7, hold: null });
    me.mine(T.tGen + 3.4, GEN.cobble, { dur: 0.7 });
    // 扩岛：走到东头，转身蹲着往后搭 4 格圆石
    me.goto(T.tExpand + 0.3, [[5.5, 2.5]], 'walk', { look: { path: -0.2, w: 4 } });
    me.bridge(T.tBridge, [1, 0], BRIDGE_N, { block: 'cobble', hold: 'cobble', open: true });
    // 搭完：回头看看身后的小岛和刷石机
    me.look(T.tBridge + 4.4, { yaw: -Math.PI / 2 + 0.25, pitch: -0.22, w: 2 });
    me.look(L('K12').start + 0.5, { yaw: -Math.PI / 2 - 0.35, pitch: -0.3, w: 1.4 });
    // 延时：站在桥头，看着岛一点点长大
    me.look(T.tLapse0 - 0.4, { yaw: Math.PI / 2 + 0.15, pitch: -0.3, w: 1.6 });
    me.look(L('K15').start + 1.5, { yaw: Math.PI / 2 - 0.55, pitch: -0.25, w: 1.2 });
    me.look(L('K16').start, { yaw: Math.PI / 2 + 0.6, pitch: -0.28, w: 1.2 });
    // OneBlock：转身看虚空远处那一个方块
    const oneAt = [ONEBLOCK[0] + 0.5, ONEBLOCK[1] + 0.5, ONEBLOCK[2] + 0.5];
    me.look(T.tOne, { at: oneAt, w: 2.0 });
    // 商标：在长大的岛上走一走
    me.goto(T.tMark + 0.6, [[11.3, 2.5]], 'walk', { look: { path: -0.08, w: 2.6 } });
    me.look(L('K19').start + 1.8, { yaw: -Math.PI / 2 - 0.25, pitch: -0.2, w: 1.4 });
    me.look(L('K21').start + 0.5, { yaw: -Math.PI / 2 + 0.2, pitch: -0.12, w: 1.2 });
    // 结尾：回头看最早那座 L 形小岛
    me.goto(L('K23').start, [[7.6, 2.5]], 'walk', { look: { path: -0.1, w: 2.4 } });
    me.look(L('K24').start - 0.3, { at: [1.5, 0.6, 2.5], w: 1.6 });
    sim.run();
    return { sim, me };
  });
}

// =================================================================== 第一人称的手（原版 ItemInHandRenderer 的变换）
function makeHand() {
  const PX = 0.9 / 16;
  const pl = makePlayer({ skin: { shirt: '#3a7bd5', seed: 2 } });
  const arm = new THREE.Mesh(pl.armR.children[0].geometry, pl.armR.children[0].material);
  const root = new THREE.Group(), sway = new THREE.Group(), equip = new THREE.Group(), swing = new THREE.Group(), grip = new THREE.Group();
  root.add(sway); sway.add(equip); equip.add(swing); swing.add(grip);
  grip.add(arm); arm.position.set(0, -6 * PX, 0);
  const hand = new THREE.Group(); hand.position.set(0, -11 * PX, -1 * PX); grip.add(hand);
  const items = { cobble: blockMesh('cobble', 0.3), craft: blockMesh('craft', 0.3), ice: blockMesh('ice', 0.3), log: blockMesh('log', 0.3), bucket_lava: itemMesh('bucket', 'bucket_lava', 0.55) };
  let cur = null;
  return {
    group: root,
    update(s, sw, held, bv) {
      if (held.item !== cur) {
        if (cur && items[cur]) hand.remove(items[cur]);
        cur = held.item;
        const m = cur && items[cur];
        if (m) {
          if (cur === 'bucket_lava') { m.position.set(0, -0.06, -0.06); m.rotation.set(-Math.PI / 2 - 0.2, Math.PI / 2 - 0.3, 0.1); }
          else { m.position.set(-0.02, -0.06, -0.02); m.rotation.set(0.45, 0.8, 0.15); }
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

// =================================================================== 每一帧
function skyMarks() {
  return once('skyMarks', () => {
    const T = mt();
    // 延时那一段：天色快速走两轮（早 → 午 → 黄昏 → 夜 → 早）
    const a = T.tLapse0, b = T.tLapse1, d = (b - a) / 8;
    return [['cine_morning', 0], ['cine_day', L('K07').start], ['cine_day', a],
      ['cine_gold', a + d], ['cine_moon', a + 2 * d], ['cine_morning', a + 3 * d], ['cine_day', a + 4 * d], ['cine_gold', a + 5 * d], ['cine_moon', a + 6 * d], ['cine_morning', a + 7 * d], ['cine_day', b],
      ['cine_day', L('K21').start], ['cine_gold', L('K23').start]];
  });
}
function skyAt(t) {
  const m = skyMarks();
  for (let i = 0; i < m.length - 1; i++) if (t < m[i + 1][1]) return m[i][0] === m[i + 1][0] ? m[i][0] : mixPreset(m[i][0], m[i + 1][0], E.inOutSine(prog(t, m[i][1], m[i + 1][1] - m[i][1])));
  return m[m.length - 1][0];
}
const ev = (kind, cell) => match().sim.events.filter(e => e.kind === kind && (!cell || (e.x === cell[0] && e.y === cell[1] && e.z === cell[2])));
// 刷石机的状态：岩浆、冰 / 水、中间那格的圆石（每次挖掉，岩浆流过来 0.9 秒后又是一块）
function genState(t) {
  return once('gen', () => {
    const lavaT = ev('place', GEN.lava)[0]?.t ?? Infinity, iceT = ev('place', GEN.water)[0]?.t ?? Infinity;
    const waterT = iceT + 1.6;                                     // 冰化成水
    const first = Math.max(lavaT, waterT) + 0.6;                    // 岩浆流过去碰到水 → 第一块圆石
    const breaks = ev('break', GEN.cobble).map(e => e.t).filter(x => x > first);
    const spans = []; let s0 = first;
    for (const b of breaks) { spans.push([s0, b]); s0 = b + 0.9; }
    spans.push([s0, Infinity]);
    return { lavaT, iceT, waterT, first, spans, breaks };
  });
}
function matchFrame(t) {
  const S = skyWorld(), M = match(), T = mt(), st = S.st, G = genState();
  st.setPreset(skyAt(t));
  S.motes.update(t); S.mists.forEach(m => m.update(t));
  S.fx.update(t);
  const me = M.me;
  // 挖掉的方块：碎的那一刻消失，冒一点碎屑
  if (!S.burst) {
    for (const e of ev('break')) S.fx.add(e.t, [e.x + 0.5, e.y + 0.5, e.z + 0.5], { n: 18, speed: 1.6, gravity: 9, size: 0.07, colors: e.y > 0 ? ['#6c5136', '#8a6a44'] : e.x === GEN.cobble[0] && e.t > G.first ? ['#7a7a7e', '#9a9a9e'] : ['#7b5536', '#5f963f'], seed: Math.round(e.t * 10), life: 0.6 });
    S.burst = true;
  }
  for (const [key, m] of Object.entries(S.blocks)) {
    const [x, y, z] = key.startsWith('log') ? LOGS[+key.slice(3) - 1] : key.slice(1).split(',').map(Number);
    const br = ev('break', [x, y, z])[0];
    m.visible = !br || t < br.t;
  }
  // 树叶：原木全挖完以后，一片片慢慢消失（原版的树叶腐烂）
  const lastLog = Math.max(...LOGS.map(c => ev('break', c)[0]?.t ?? Infinity));
  S.leaves.forEach((m, i) => { m.visible = !(t > lastLog + 0.6 + ((i * 37) % S.leaves.length) * 0.09); });
  // 放下的方块（工作台、扩岛的圆石）
  for (const e of ev('place')) {
    if (['lava', 'ice'].includes(e.block)) continue;
    const key = `${e.x},${e.y},${e.z}`;
    let m = S.placed.get(key);
    if (!m) { m = blockMesh(e.block, 1); m.position.set(e.x + 0.5, e.y + 0.5, e.z + 0.5); st.add(m); S.placed.set(key, m); }
    m.visible = t >= e.t;
  }
  // 刷石机
  S.lavaM.visible = t >= G.lavaT; S.lavaM.position.set(GEN.lava[0] + 0.5, 0.44, GEN.lava[2] + 0.5);
  S.lavaLight.intensity = t >= G.lavaT ? 2.2 + 0.3 * Math.sin(t * 5) : 0;
  S.iceM.visible = t >= G.iceT && t < G.waterT; S.iceM.position.set(GEN.water[0] + 0.5, 0.5, GEN.water[2] + 0.5);
  S.waterM.visible = t >= G.waterT; S.waterM.position.set(GEN.water[0] + 0.5, 0.44, GEN.water[2] + 0.5);
  const cob = G.spans.some(([a, b]) => t >= a && t < b);
  S.cobbleM.visible = cob; S.cobbleM.position.set(GEN.cobble[0] + 0.5, 0.5, GEN.cobble[2] + 0.5);
  // 岩浆往中间流的那一下（矮一点的岩浆，出圆石前 0.5 秒）
  const flowing = G.spans.some(([a]) => t >= a - 0.5 && t < a);
  S.lavaFlow.visible = flowing; S.lavaFlow.position.set(GEN.cobble[0] + 0.5, 0.25, GEN.cobble[2] + 0.5);
  if (!S.genFx) { G.spans.forEach(([a], i) => S.fx.add(a, [GEN.cobble[0] + 0.5, 0.95, GEN.cobble[2] + 0.5], { n: 14, speed: 0.6, gravity: -1.5, size: 0.09, colors: ['#dddddd', '#bbbbbb'], seed: 400 + i, life: 0.8 })); S.genFx = true; }
  // 箱子
  const oc = me.when('openChest');
  S.chest.setOpen(E.outCubic(prog(t, oc, 0.25)) * (1 - prog(t, oc + 1.9, 0.25)));
  // 延时：一块块长出来
  const bb = S.grow, n = bb.length, a = T.tLapse0 + 0.5, b = T.tLapse1 - 0.6;
  bb.forEach((m, i) => { const ti = a + (b - a) * (i / n); m.visible = t >= ti; if (t >= ti && t < ti + 0.15) m.scale.setScalar(1); });
  // OneBlock：每 0.8 秒换一种（挖掉 → 刷新）
  const ok = t >= T.tOne - 1 ? Math.floor((t - T.tOne + 1) / 0.8) : 0;
  S.one.forEach((m, i) => { m.visible = t >= T.tOne - 1 && t < L('K19').start && i === ok % S.one.length; });
  if (S.coverMe) S.coverMe.group.visible = false;
  // 我：相机 = 眼睛
  const s = sample(me, t);
  const bv = placeCamera(st.camera, s);
  if (st.camera.fov !== 70) { st.camera.fov = 70; st.camera.updateProjectionMatrix(); }
  st.focus.set(s.x, s.y, s.z); st.placeSun();
  if (!S.hand) { S.hand = makeHand(); st.camera.add(S.hand.group); }
  S.hand.update(s, swingAt(me, t), heldAt(me, t), bv);
  return st;
}

// =================================================================== 2D：物品栏、裂纹、合成、箱子、进度、卡片
const hotbarXY = i => [Math.round((W - 546) / 2) + 3 + i * 60 + 30, H - 66 - 6 + 33];
const GUI = { s: 5, w: 176, h: 78 };
function guiBox(g, x, y, w, h, s) {
  g.fillStyle = '#000000';
  g.fillRect(x + s, y, w - 2 * s, s); g.fillRect(x + s, y + h - s, w - 2 * s, s); g.fillRect(x, y + s, s, h - 2 * s); g.fillRect(x + w - s, y + s, s, h - 2 * s);
  g.fillStyle = '#c6c6c6'; g.fillRect(x + s, y + s, w - 2 * s, h - 2 * s);
  g.fillStyle = '#ffffff'; g.fillRect(x + s, y + s, w - 3 * s, 2 * s); g.fillRect(x + s, y + s, 2 * s, h - 3 * s);
  g.fillStyle = '#555555'; g.fillRect(x + 2 * s, y + h - 3 * s, w - 3 * s, 2 * s); g.fillRect(x + w - 3 * s, y + 2 * s, 2 * s, h - 3 * s);
}
function slot(g, x, y, s) { g.fillStyle = '#373737'; g.fillRect(x, y, 18 * s, 18 * s); g.fillStyle = '#ffffff'; g.fillRect(x + s, y + s, 17 * s, 17 * s); g.fillStyle = '#8b8b8b'; g.fillRect(x + s, y + s, 16 * s, 16 * s); }
function cursor(g, x, y) {
  g.save(); g.translate(Math.round(x), Math.round(y)); g.scale(2.4, 2.4);
  g.beginPath(); g.moveTo(0, 0); g.lineTo(0, 13); g.lineTo(3, 10); g.lineTo(5.5, 15); g.lineTo(7.5, 14); g.lineTo(5, 9); g.lineTo(9, 9); g.closePath();
  g.fillStyle = '#ffffff'; g.fill(); g.lineWidth = 1; g.strokeStyle = '#000000'; g.stroke();
  g.restore();
}
// 合成：背包里的 2×2 合成格。先放原木 → 出木板；再放 4 块木板 → 出工作台
function craftGui(g, t, t0, dur) {
  const k = (t - t0) / dur; if (k < 0 || k > 1) return false;
  const s = GUI.s, w = 176 * s, h = 84 * s, x0 = Math.round(W / 2 - w / 2), y0 = Math.round(H / 2 - 40 - h / 2);
  g.fillStyle = 'rgba(16,16,16,0.52)'; g.fillRect(0, 0, W, H);
  guiBox(g, x0, y0, w, h, s);
  HUD.mcText(g, '合成', x0 + 88 * s, y0 + 13 * s, { size: 36, color: '#404040', shadow: false });
  const gx = x0 + 52 * s, gy = y0 + 22 * s, ox = x0 + 128 * s, oy = y0 + 31 * s;
  for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) slot(g, gx + c * 18 * s, gy + r * 18 * s, s);
  slot(g, ox, oy, s);
  g.fillStyle = '#8b8b8b'; g.beginPath(); g.moveTo(gx + 40 * s, oy + 9 * s - 4 * s); g.lineTo(gx + 60 * s, oy + 9 * s); g.lineTo(gx + 40 * s, oy + 9 * s + 4 * s); g.closePath(); g.fill();
  const icon = (spec, x, y, n) => { O.pixelIcon(g, spec, x + 9 * s, y + 9 * s, 16 * s); if (n > 1) HUD.mcText(g, String(n), x + 17 * s, y + 17 * s, { size: 30, align: 'right' }); };
  if (k < 0.45) { icon('tile:log_side', gx, gy, 1); if (k > 0.18) icon('tile:planks', ox, oy, 4); }
  else { for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) icon('tile:planks', gx + c * 18 * s, gy + r * 18 * s, 1); if (k > 0.65) icon('tile:craft_side', ox, oy, 1); }
  const cx = k < 0.18 ? lerp(W / 2 + 200, gx + 9 * s, E.inOutCubic(k / 0.18)) : k < 0.45 ? ox + 9 * s : k < 0.65 ? gx + 27 * s : ox + 9 * s;
  const cy = k < 0.18 ? lerp(H / 2 + 120, gy + 9 * s, E.inOutCubic(k / 0.18)) : k < 0.45 ? oy + 9 * s : k < 0.65 ? gy + 27 * s : oy + 9 * s;
  cursor(g, cx, cy);
  return true;
}
// 箱子界面：岩浆桶、冰（各自飞进物品栏）
function chestGui(g, t, t0, t1, hot) {
  if (t < t0 + 0.12 || t >= t1) return false;
  const s = GUI.s, x0 = Math.round(W / 2 - GUI.w * s / 2), y0 = Math.round(H / 2 - 40 - GUI.h * s / 2);
  g.fillStyle = 'rgba(16,16,16,0.52)'; g.fillRect(0, 0, W, H);
  guiBox(g, x0, y0, GUI.w * s, GUI.h * s, s);
  HUD.mcText(g, '箱子', x0 + 8 * s, y0 + 13 * s, { size: 36, color: '#404040', shadow: false });
  const sx = (c, r) => [x0 + (7 + 18 * c) * s, y0 + (17 + 18 * r) * s];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 9; c++) slot(g, ...sx(c, r), s);
  const items = [[3, 1, 'sprite:bucket:bucket_lava', 2, t0 + 0.8], [5, 1, 'tile:ice', 3, t0 + 1.3]];
  items.forEach(([c, r, icon, to, tp]) => {
    const [x, y] = sx(c, r);
    if (t < tp) O.pixelIcon(g, icon, x + 9 * s, y + 9 * s, 16 * s);
  });
  hot();
  items.forEach(([c, r, icon, to, tp]) => {
    const k1 = prog(t, tp, 0.3); if (k1 <= 0 || k1 >= 1) return;
    const [x, y] = sx(c, r), [tx, ty] = hotbarXY(to), u = E.inOutCubic(k1);
    O.pixelIcon(g, icon, lerp(x + 45, tx, u), lerp(y + 45, ty, u) - 60 * Math.sin(Math.PI * u), lerp(80, 48, u));
  });
  const nx = items.find(it => t < it[4]);
  if (nx) { const [x, y] = sx(nx[0], nx[1]); cursor(g, x + 45, y + 45); }
  return true;
}
// 物品栏（按事件算数量）
function slotsAt(t) {
  const M = match(), me = M.me, T = mt();
  const logs = ev('break').filter(e => e.y >= 1 && e.x === TRUNK[0] && e.z === TRUNK[1] && e.t <= t).length;
  const crafted = t >= me.when('craft') + 1.9;
  const table = ev('place').some(e => e.block === 'craft' && e.t <= t);
  const oc = me.when('openChest');
  const G = genState();
  const cobbleGot = G.breaks.filter(b => b <= t).length + (t >= T.tExpand ? 30 : 0);   // 延时里刷了一堆圆石
  const cobbleUsed = ev('place').filter(e => e.block === 'cobble' && e.t <= t).length;
  const lavaUsed = ev('place', GEN.lava).some(e => e.t <= t), iceUsed = ev('place', GEN.water).some(e => e.t <= t);
  const grassGot = ev('break').filter(e => e.y === 0 && e.t <= t).length;
  return [
    crafted ? null : logs ? { icon: 'tile:log_side', n: logs } : null,
    crafted ? { icon: 'tile:planks', n: 12 } : null,
    t >= oc + 1.1 ? { icon: lavaUsed ? 'sprite:bucket:bucket' : 'sprite:bucket:bucket_lava', n: 1 } : null,
    t >= oc + 1.6 && !iceUsed ? { icon: 'tile:ice', n: 1 } : null,
    cobbleGot - cobbleUsed > 0 ? { icon: 'tile:cobble', n: cobbleGot - cobbleUsed } : null,
    grassGot ? { icon: 'tile:dirt', n: grassGot } : null,
    crafted && !table ? { icon: 'tile:craft_side', n: 1 } : null,
  ];
}
function selAt(t) { const h = heldAt(match().me, t).item; return { craft: 6, bucket_lava: 2, ice: 3, cobble: 4 }[h] ?? 8; }
// 挖方块时的裂纹（原版 10 段；这里在方块的屏幕位置上画一个裂纹框）
function cracks(g, t, st) {
  for (const e of ev('mine')) {
    if (t < e.t || t > e.t + e.dur) continue;
    const k = (t - e.t) / e.dur, v = new THREE.Vector3(e.x + 0.5, e.y + 0.5, e.z + 0.5).project(st.camera);
    if (v.z > 1) continue;
    const x = (v.x + 1) / 2 * W, y = (1 - v.y) / 2 * H, dist = st.camera.position.distanceTo(new THREE.Vector3(e.x + 0.5, e.y + 0.5, e.z + 0.5));
    const size = 560 / Math.max(1.2, dist), stage = Math.min(9, Math.floor(k * 10)), r = rng(e.x * 31 + e.y * 7 + e.z);
    g.save(); g.strokeStyle = 'rgba(20,12,8,0.75)'; g.lineWidth = Math.max(2, size / 70);
    for (let i = 0; i <= stage; i++) {
      let px = x + (r() - 0.5) * size * 0.5, py = y + (r() - 0.5) * size * 0.5;
      g.beginPath(); g.moveTo(px, py);
      for (let s2 = 0; s2 < 4; s2++) { px += (r() - 0.5) * size * 0.28; py += (r() - 0.5) * size * 0.28; g.lineTo(px, py); }
      g.stroke();
    }
    g.restore();
  }
}
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
// 原版地图说明的两条规矩（像一页书）
function rulesCard(g, t, t0, t1) {
  const a = env(t, t0, t1, 0.4, 0.4); if (a <= 0) return;
  const k1 = E.outCubic(prog(t, wordTime('K01', '不要故意') - 0.1, 0.4)), k2 = E.outCubic(prog(t, wordTime('K01', '不要搭桥') - 0.1, 0.4));
  g.save(); g.globalAlpha = a;
  O.scrim(g, W / 2, 330, 760, 200, 0.9);
  O.kicker(g, 'SKYBLOCK · 地图说明 · 规矩', W / 2, 250, 1, { size: 22, spacing: 8, color: O.COL.brass });
  O.txt(g, '1. 不要故意跳下去回血', W / 2, 330, { size: 52, family: O.FONT.serif, weight: 900, align: 'center', color: O.COL.bone, alpha: k1 });
  O.txt(g, '2. 不要搭桥去别的地方', W / 2, 410, { size: 52, family: O.FONT.serif, weight: 900, align: 'center', color: O.COL.bone, alpha: k2 });
  g.restore();
}
// 商标裁定：一页文件
function rulingCard(g, t, t0, t1) {
  const a = env(t, t0, t1, 0.4, 0.4); if (a <= 0) return;
  const k = E.outCubic(prog(t, t0 + 0.6, 0.6));
  g.save(); g.globalAlpha = a;
  const w = 760, h = 300, x = W / 2 - w / 2, y = 190;
  g.fillStyle = 'rgba(244,240,230,0.96)'; g.fillRect(x, y, w, h);
  g.fillStyle = '#1d2a44'; g.fillRect(x, y, w, 10);
  O.txt(g, 'USPTO · TTAB · 2026.05.11', x + 40, y + 66, { size: 26, family: O.FONT.sans, weight: 700, color: '#1d2a44', shadow: false });
  O.txt(g, '“SKYBLOCK”：只是描述，不能注册', x + 40, y + 150, { size: 46, family: O.FONT.serif, weight: 900, color: '#1a1a1a', shadow: false, alpha: k });
  O.txt(g, '描述的是“天上由方块组成的岛”这一类地图', x + 40, y + 214, { size: 28, family: O.FONT.serif, weight: 600, color: '#444444', shadow: false, alpha: k });
  g.restore();
}
function matchOverlay(g, t, s, st) {
  const T = mt(), me = match().me;
  const hot = () => HUD.hotbar(g, slotsAt(t), selAt(t), { xp: 0.05 + 0.5 * prog(t, 0, T.tEnd) });
  const craftOn = t >= me.when('craft') && t < me.when('craft') + 1.9, oc = me.when('openChest');
  const chestOn = t >= oc + 0.12 && t < oc + 1.95;
  if (!craftOn && !chestOn) { cracks(g, t, st); HUD.crosshair(g, 0.9); hot(); }
  if (craftOn) { craftGui(g, t, me.when('craft'), 1.9); hot(); }
  chestGui(g, t, oc, oc + 1.95, hot);
  HUD.scoreboard(g, '空岛生存', [], [['岛的大小：', `${Math.round(lerp(27, 120, prog(t, T.tExpand, T.tLapse1 - T.tExpand)))} 格`], ['天数：', 1 + Math.floor(5 * prog(t, T.tLapse0, T.tLapse1 - T.tLapse0))]], { alpha: 0.95 });
  // 进度达成
  [[L('K03').start + 0.6, '进度达成！', '空岛生存 · 2011', 'tile:grass_side'],
   [me.when('craft') + 2.0, '进度达成！', '工作台', 'tile:craft_side'],
   [genState().first + 0.2, '进度达成！', '刷石机', 'tile:cobble'],
   [L('K11').start + 0.3, '进度达成！', 'skyblock.net · 2012', 'sprite:coin:coin'],
   [L('K13').start + 0.3, '进度达成！', 'ASkyBlock 插件 · 2014', 'sprite:scroll:scroll'],
   [L('K15').start + 0.3, '进度达成！', 'Hypixel SkyBlock · 2019', 'sprite:sword:sword_iron'],
   [L('K18').start + 0.3, '进度达成！', 'OneBlock', 'tile:grass_side'],
  ].forEach(([t0, a, b, icon]) => toast(g, t, t0, a, b, icon));
  // 卡片
  rulesCard(g, t, L('K01').start + 0.2, L('K02').end + 0.3);
  card(g, t, L('K03').start + 0.4, L('K04').start, 'MINECRAFT FORUM · 2011.09', 'Noobcrew 发布地图 Skyblock（空岛生存）');
  card(g, t, L('K06').start + 0.2, L('K07').start, 'SKYBLOCK · 2011.10', '已经出到 2.0 版');
  card(g, t, L('K11').start + 0.4, L('K12').start, 'SKYBLOCK.NET · 2012', 'Noobcrew 开了自己的空岛服务器');
  card(g, t, L('K13').start + 0.3, L('K13').end + 0.4, 'ASKYBLOCK · TASTYBENTO · 2014.09', '服务器上，每人一座自己的岛');
  card(g, t, L('K15').start + 0.4, L('K16').start, 'HYPIXEL SKYBLOCK · 2019.06', '技能、经济、副本：像一款角色扮演游戏');
  card(g, t, L('K18').start + 0.3, L('K18').end + 0.4, 'ONEBLOCK · IJAMINECRAFT', '开局只有一个方块，挖掉还会刷新');
  card(g, t, L('K19').start + 0.4, L('K20').start, 'MINEVERSE（NOOBCREW）· 2019.11', '申请注册“SkyBlock”商标');
  card(g, t, L('K20').start + 0.3, L('K21').start, '异议方', '微软，以及一些我的世界市场的作者');
  rulingCard(g, t, L('K21').start + 0.2, L('K22').start + 0.3);
  card(g, t, L('K22').start + 0.2, L('K23').start, '2026.05.12', 'Noobcrew 撤下原版地图的下载');
  card(g, t, L('K25').start + 0.2, T.tEnd + 1.6, '评论区见', '你的空岛，第一件做的东西是什么？', { size: 38 });
  const tb = T.tEnd + 0.6;
  if (t >= tb) {
    g.fillStyle = `rgba(0,0,0,${prog(t, tb, 0.8)})`; g.fillRect(0, 0, W, H);
    O.kicker(g, '我的世界小游戏起源 · 第四期 · 空岛生存', W / 2, H / 2 - 10, env(t, tb + 0.5, TL.duration + 1, 0.6, 0.3), { size: 30, spacing: 12, color: O.COL.brass, family: O.FONT.serif, weight: 600 });
    O.kicker(g, '下期见', W / 2, H / 2 + 50, env(t, tb + 0.9, TL.duration + 1, 0.6, 0.3), { size: 24, spacing: 14, color: O.COL.bone, family: O.FONT.serif, weight: 600 });
  }
}
function matchCues() {
  const M = match(), T = mt(), out = [];
  for (const e of M.sim.events) {
    if (e.kind === 'break') out.push({ t: e.t, sfx: 'pop' });
    if (e.kind === 'place') out.push({ t: e.t, sfx: 'place' });
  }
  const me = M.me;
  out.push({ t: me.when('openChest'), sfx: 'chest' }, { t: me.when('craft') + 1.2, sfx: 'click' });
  genState().spans.forEach(([a]) => out.push({ t: a, sfx: 'snuff' }));
  [['soft', 0], ['light', L('K04').start], ['melody', L('K07').start], ['mid', L('K10').start], ['sparkle', T.tLapse0], ['light', L('K17').start], ['soft', L('K19').start], ['finale', L('K23').start]].forEach(([name, t]) => out.push({ t, sfx: 'score', name }));
  return out.filter(c => isFinite(c.t)).sort((a, b) => a.t - b.t);
}
const subLift = () => H - HUD.HUD_TOP + 8;
for (const s of TL.scenes) SCENES[s.id] = { trans: 'cut', bars: () => 0, subLift, frame: matchFrame, overlay: matchOverlay, cues: s.id === TL.scenes[0].id ? matchCues : () => [], tone: false, glow: 0.12, satGuard: false, look: () => 'contrast(1.04)' };

// 检查用
window.__camProbe = t => { const s = sample(match().me, t); return [s.x, s.y + s.eye, s.z, s.yaw, s.pitch]; };
window.__simEvents = () => match().sim.events.map(e => [e.t.toFixed(2), e.kind, e.x, e.y, e.z, e.who, e.block || '']);
window.__T = () => mt();

// =================================================================== 封面（16:9 和 4:3）：长大的空岛悬在虚空里，最早那座 L 形小岛还在中间；岛上站着一个人
function coverStage() {
  const st = matchFrame(150);
  const S = skyWorld();
  st.setPreset('cine_morning');
  if (S.hand) S.hand.group.visible = false;
  if (!S.coverMe) { S.coverMe = makePlayer({ skin: { shirt: '#3a7bd5', seed: 2 } }); st.add(S.coverMe); }
  S.coverMe.group.visible = true; at(S.coverMe, 4.5, 1, 2.5, -Math.PI / 2 - 0.4); S.coverMe.pose({ look: [0.3, 0.1] });
  S.one.forEach(m => { m.visible = false; });
  st.focus.set(5, 0, 1); st.placeSun();
  return st;
}
const coverLook = (st, pos, target, fov) => { const o = window.__coverCam; st.camera.rotation.order = 'XYZ'; return o && o.pos ? st.look(o.pos, o.target, o.fov) : st.look(pos, target, fov); };
const coverBase = { bars: () => 0, satGuard: false, glow: 0.18, tone: false, look: () => 'saturate(1.12) brightness(1.03)' };
SCENES.__cover = {
  ...coverBase,
  frame() { const st = coverStage(); coverLook(st, [5, 9, 23], [-4.5, 3.5, 0], 40); return st; },
  overlay(g) {
    const gr = g.createLinearGradient(0, 0, W * 0.7, 0);
    gr.addColorStop(0, 'rgba(6,12,24,0.78)'); gr.addColorStop(0.6, 'rgba(6,12,24,0.38)'); gr.addColorStop(1, 'rgba(6,12,24,0)');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    O.kicker(g, '我的世界小游戏起源 · 第四期', 118, 330, 1, { align: 'left', size: 40, spacing: 8, color: O.COL.brass, family: O.FONT.serif, weight: 600 });
    O.txt(g, '空岛生存', 104, 590, { size: 250, family: O.FONT.serif, weight: 900, color: O.COL.bone, spacing: 12, shadowBlur: 40, shadowColor: 'rgba(0,0,0,0.6)' });
    O.txt(g, '一座小岛，怎么火了十五年？', 116, 740, { size: 84, family: O.FONT.serif, weight: 900, color: O.COL.bone, spacing: 4, shadowBlur: 30, shadowColor: 'rgba(0,0,0,0.6)' });
  },
};
SCENES.__cover43 = {
  ...coverBase,
  frame() { const st = coverStage(); coverLook(st, [5, 9, 23], [5, 4.5, 0], 40); return st; },
  overlay(g) {
    const gr = g.createLinearGradient(0, 0, 0, H * 0.6);
    gr.addColorStop(0, 'rgba(6,12,24,0.82)'); gr.addColorStop(0.65, 'rgba(6,12,24,0.4)'); gr.addColorStop(1, 'rgba(6,12,24,0)');
    g.fillStyle = gr; g.fillRect(0, 0, W, H * 0.6);
    O.kicker(g, '我的世界小游戏起源 · 第四期', W / 2, 130, 1, { size: 42, spacing: 8, color: O.COL.brass, family: O.FONT.serif, weight: 600 });
    O.txt(g, '空岛生存', W / 2, 372, { size: 236, family: O.FONT.serif, weight: 900, color: O.COL.bone, spacing: 14, align: 'center', shadowBlur: 40, shadowColor: 'rgba(0,0,0,0.65)' });
    O.txt(g, '一座小岛，怎么火了十五年？', W / 2, 500, { size: 80, family: O.FONT.serif, weight: 900, color: O.COL.bone, spacing: 4, align: 'center', shadowBlur: 30, shadowColor: 'rgba(0,0,0,0.6)' });
  },
};

// 程序生成的 16×16 方块纹理图集、人物皮肤和物品像素图（全部原创，未使用任何游戏素材）。
import * as THREE from 'three';
import { rng, hash2, clamp } from './util.js';

const CELL = 32, PAD = 8, TS = 16, COLS = 16;

const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const pick = (r, list) => list[Math.floor(r() * list.length) % list.length];
const P = list => list.map(hex);

// ---------------------------------------------------------------- 方块绘制函数：返回 16×16 的 [r,g,b,a] 数组
function paint(seed, fn) {
  const r = rng(seed);
  const px = [];
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) px.push(fn(x, y, r));
  return px;
}
const GRASS = P(['#5f963f', '#66a044', '#6ca748', '#73ae4d', '#63993f']);
const DIRT = P(['#7b5536', '#866040', '#8e6744', '#714d31', '#936c48']);
const noiseOf = (pal, extra = []) => (x, y, r) => {
  for (const [p, c] of extra) if (r() < p) return c;
  return mul(pick(r, pal), 0.97 + r() * 0.06);
};

function grassTop() { return paint(11, noiseOf(GRASS, [[0.05, hex('#558a38')], [0.025, hex('#7fbd56')]])); }
function dirt() { return paint(12, noiseOf(DIRT, [[0.04, hex('#a7845c')], [0.05, hex('#5d3f28')]])); }
function grassSide() {
  const d = dirt();
  return paint(13, (x, y, r) => {
    const drip = 3 + Math.floor(hash2(x, 3) * 2.4) + (hash2(x, 9) < 0.25 ? 2 : 0);
    if (y < drip) return mul(pick(r, GRASS), y === drip - 1 ? 0.86 : 1);
    return d[y * TS + x];
  });
}
function stone(seed = 14, base = ['#7f7f81', '#88888a', '#909093', '#78787b']) {
  const pal = P(base), cr = new Set(), r0 = rng(seed + 100);
  for (let k = 0; k < 5; k++) {
    let x = Math.floor(r0() * 16), y = Math.floor(r0() * 16);
    for (let s = 0; s < 4 + r0() * 4; s++) { cr.add(x + ',' + y); x = (x + (r0() < 0.6 ? 1 : 0) + 16) % 16; y = (y + (r0() < 0.5 ? 1 : -1) + 16) % 16; }
  }
  return paint(seed, (x, y, r) => (cr.has(x + ',' + y) ? mul(pal[0], 0.82) : mul(pick(r, pal), 0.97 + r() * 0.06)));
}
function planks(seed = 15, base = ['#b08a57', '#a98352', '#b5905c'], dark = '#7f603a') {
  const pal = P(base), dk = hex(dark), seams = [3, 11, 6, 13].map((v, i) => (v + i * 5) % 16);
  return paint(seed, (x, y, r) => {
    const row = y >> 2;
    if (y % 4 === 3) return mul(dk, 0.95 + r() * 0.08);
    if (x === seams[row]) return mul(dk, 1.05);
    const c = mul(pick(r, pal), 0.96 + r() * 0.06);
    return r() < 0.12 ? mul(c, 0.9) : c;
  });
}
function logSide() {
  const pal = P(['#6c5136', '#5d452e', '#77593b', '#664b31']);
  const col = Array.from({ length: 16 }, (_, i) => pal[Math.floor(hash2(i, 77) * pal.length)]);
  return paint(16, (x, y, r) => mul(col[x], 0.9 + r() * 0.16 - (x % 5 === 0 ? 0.12 : 0)));
}
function logTop() {
  return paint(17, (x, y, r) => {
    const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
    if (d > 6.5) return mul(hex('#5d452e'), 0.9 + r() * 0.15);
    return mul(Math.floor(d) % 2 ? hex('#b8945f') : hex('#a5814f'), 0.96 + r() * 0.06);
  });
}
function leaves() {
  const pal = P(['#3c8a2d', '#469834', '#357b27', '#2e6c22', '#4fa23b']);
  return paint(18, (x, y, r) => (r() < 0.2 ? [0, 0, 0, 0] : [...mul(pick(r, pal), 0.95 + r() * 0.1), 255]));
}
function wool(c) {
  const b = hex(c);
  return paint(19 + b[0], (x, y, r) => {
    let k = 1;
    if ((x + y) % 4 === 0) k = 0.9; else if ((x - y + 16) % 4 === 0) k = 1.05;
    return mul(b, k * (0.97 + r() * 0.06));
  });
}
function bevel(base, hi, lo, deco) {
  const b = hex(base), h = hex(hi), l = hex(lo);
  return paint(base.length * 31 + b[1], (x, y, r) => {
    if (x === 0 || y === 0) return h;
    if (x === 15 || y === 15) return l;
    const d = deco ? deco(x, y, r) : null;
    return d || mul(b, 0.97 + r() * 0.05);
  });
}
function obsidian() { return paint(21, noiseOf(P(['#17121f', '#211a2f', '#2a2140']), [[0.07, hex('#5b3d8a')]])); }
function endStone() { return paint(22, noiseOf(P(['#e2e0a6', '#dad795', '#e8e6b4']), [[0.08, hex('#bdb97c')]])); }
function sandstone(top) {
  return paint(23 + (top ? 1 : 0), (x, y, r) => {
    if (top) return mul(hex('#e3d5a3'), 0.97 + r() * 0.05);
    const band = y < 4 ? '#e9dcab' : y > 11 ? '#d2c08a' : '#dccd98';
    return mul(hex(y === 4 || y === 11 ? '#cdbb85' : band), 0.97 + r() * 0.05);
  });
}
function bricks() {
  return paint(25, (x, y, r) => {
    const row = y >> 2, mortar = y % 4 === 3 || (x + (row % 2) * 4) % 8 === 7;
    return mortar ? mul(hex('#c2b6a8'), 0.95 + r() * 0.08) : mul(pick(r, P(['#9c5640', '#a65d45', '#8f4f3a'])), 0.96 + r() * 0.06);
  });
}
function craftTop() {
  const p = planks(26);
  return paint(26, (x, y) => ((x === 0 || x === 15 || y === 0 || y === 15) ? hex('#5e4426') : (x === 5 || x === 10 || y === 5 || y === 10) ? hex('#6e5030') : p[y * 16 + x]));
}
function craftSide() {
  const p = planks(27);
  return paint(27, (x, y) => {
    if (y < 2) return hex('#5e4426');
    if (y >= 4 && y <= 9 && x >= 2 && x <= 4) return hex('#9aa3ad');           // 锯片
    if (y >= 4 && y <= 5 && x >= 9 && x <= 13) return hex('#8e8e8e');           // 锤头
    if (y >= 6 && y <= 12 && x === 11) return hex('#6b4a2b');                   // 锤柄
    if (y >= 10 && y <= 12 && x >= 2 && x <= 4) return hex('#6b4a2b');
    return p[y * 16 + x];
  });
}
function glass() {
  return paint(28, (x, y) => ((x === 0 || y === 0 || x === 15 || y === 15) ? [220, 240, 255, 255] : (x === y + 3 || x === y + 4) ? [255, 255, 255, 110] : [200, 228, 255, 36]));
}
function lantern() {
  return paint(29, (x, y, r) => {
    if (y < 2 || y > 13) return hex('#c99a2a');
    if (x < 2 || x > 13) return hex('#d6a531');
    const d = Math.hypot(x - 7.5, y - 7.5);
    return mul(hex('#e2402c'), 1.05 + (d < 4 ? 0.25 : 0) + r() * 0.05);
  });
}
function glow(c) { const b = hex(c); return paint(30, (x, y, r) => mul(b, 0.95 + r() * 0.08)); }
function snow() { return paint(31, noiseOf(P(['#f3f6fa', '#e8eef6', '#f8fbff']))); }
function clay() { return paint(32, noiseOf(P(['#a96b4e', '#a3654a', '#b07253']))); }
function darkPlanks() { return planks(33, ['#5a3f26', '#53391f', '#61452a'], '#3a2816'); }

const TEAM_HEX = { red: '#c8423b', blue: '#3c6fd1', green: '#4caf3f', yellow: '#e2bd35', white: '#e9ecec', purple: '#8b4fd1', orange: '#e0843a', black: '#2a2a30', gray: '#7d7d82', cyan: '#2fb5b5', pink: '#e58fb0' };
export const TEAM = Object.fromEntries(Object.entries(TEAM_HEX).map(([k, v]) => [k, new THREE.Color(v)]));
export const TEAM_CSS = TEAM_HEX;

const TILE_DEFS = {
  grass_top: grassTop, grass_side: grassSide, dirt, stone: () => stone(), planks: () => planks(),
  log_side: logSide, log_top: logTop, leaves, obsidian, end_stone: endStone,
  sandstone_top: () => sandstone(true), sandstone_side: () => sandstone(false), bricks,
  iron: () => bevel('#d6d6d8', '#f4f4f6', '#a2a2a6', (x, y) => ((y === 5 || y === 10) && x > 2 && x < 13 ? hex('#c4c4c8') : null)),
  gold: () => bevel('#f2c63e', '#fff0a0', '#c0901a', (x, y) => (x === y + 2 || x === y + 3 ? hex('#ffe070') : null)),
  diamond: () => bevel('#5fded5', '#c9fff9', '#2aa69c', (x, y) => ((x + y) % 6 === 0 ? hex('#8ff0e8') : null)),
  emerald: () => bevel('#35c66a', '#a9f6c2', '#1c8f47', (x, y) => (Math.abs(x - 7.5) + Math.abs(y - 7.5) < 5 ? hex('#4fe08a') : null)),
  copper: () => bevel('#c46a3c', '#f0a070', '#8a4220', (x, y) => ((x * 3 + y) % 7 === 0 ? hex('#d88050') : null)),
  craft_top: craftTop, craft_side: craftSide, glass, lantern, snow, clay, dark_planks: darkPlanks,
  glow_white: () => glow('#fff4d0'), glow_gold: () => glow('#ffd36a'), stone_dark: () => stone(34, ['#5b5b60', '#636369', '#55555a']),
};
for (const [name, c] of Object.entries(TEAM_HEX)) TILE_DEFS['wool_' + name] = () => wool(c);

// 方块类型 → 各面使用的贴图
const BLOCKS = {
  grass: { top: 'grass_top', side: 'grass_side', bottom: 'dirt' },
  log: { top: 'log_top', side: 'log_side', bottom: 'log_top' },
  sandstone: { top: 'sandstone_top', side: 'sandstone_side', bottom: 'sandstone_top' },
  craft: { top: 'craft_top', side: 'craft_side', bottom: 'planks' },
};
export function blockFaces(type) { return BLOCKS[type] || { top: type, side: type, bottom: type }; }
export const CUTOUT = new Set(['leaves', 'glass']);
export const EMISSIVE = new Set(['lantern', 'glow_white', 'glow_gold']);

// ---------------------------------------------------------------- 图集
export const TILE_INDEX = {};
export const TILE_PIXELS = {};
let atlasCanvas = null;
export let atlas = null;
export let ATLAS_W = 0, ATLAS_H = 0;

export function buildAtlas() {
  const names = Object.keys(TILE_DEFS);
  const rows = Math.ceil(names.length / COLS);
  ATLAS_W = COLS * CELL; ATLAS_H = Math.max(1, rows) * CELL;
  atlasCanvas = document.createElement('canvas');
  atlasCanvas.width = ATLAS_W; atlasCanvas.height = ATLAS_H;
  const g = atlasCanvas.getContext('2d');
  const img = g.createImageData(ATLAS_W, ATLAS_H);
  names.forEach((name, i) => {
    const px = TILE_DEFS[name]();
    TILE_PIXELS[name] = px;
    TILE_INDEX[name] = i;
    const cx = (i % COLS) * CELL, cy = Math.floor(i / COLS) * CELL;
    // 边缘外扩：贴图四周复制边缘像素，避免 mipmap 采样串色
    for (let y = -PAD; y < TS + PAD; y++) for (let x = -PAD; x < TS + PAD; x++) {
      const sx = clamp(x, 0, TS - 1), sy = clamp(y, 0, TS - 1);
      const p = px[sy * TS + sx];
      const o = ((cy + PAD + y) * ATLAS_W + (cx + PAD + x)) * 4;
      img.data[o] = clamp(p[0], 0, 255); img.data[o + 1] = clamp(p[1], 0, 255); img.data[o + 2] = clamp(p[2], 0, 255);
      img.data[o + 3] = p.length > 3 ? p[3] : 255;
    }
  });
  g.putImageData(img, 0, 0);
  atlas = new THREE.CanvasTexture(atlasCanvas);
  atlas.flipY = false;
  atlas.magFilter = THREE.NearestFilter;
  atlas.minFilter = THREE.NearestMipmapLinearFilter;
  atlas.generateMipmaps = true;
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 4;
  return atlas;
}
export function tileUV(name) {
  const i = TILE_INDEX[name];
  if (i === undefined) throw new Error('unknown tile ' + name);
  const x = (i % COLS) * CELL + PAD, y = Math.floor(i / COLS) * CELL + PAD;
  return [x / ATLAS_W, y / ATLAS_H, (x + TS) / ATLAS_W, (y + TS) / ATLAS_H];
}
// 给 2D 叠加层用的单张贴图画布
const _tileCanvas = {};
export function tileCanvas(name) {
  if (_tileCanvas[name]) return _tileCanvas[name];
  const c = document.createElement('canvas'); c.width = c.height = TS;
  const g = c.getContext('2d'); const img = g.createImageData(TS, TS);
  TILE_PIXELS[name].forEach((p, i) => { img.data[i * 4] = p[0]; img.data[i * 4 + 1] = p[1]; img.data[i * 4 + 2] = p[2]; img.data[i * 4 + 3] = p.length > 3 ? p[3] : 255; });
  g.putImageData(img, 0, 0);
  return (_tileCanvas[name] = c);
}

// ---------------------------------------------------------------- 人物皮肤（64×64，经典分块布局）
const SKIN_TONES = ['#e8b894', '#d9a27c', '#c68b62', '#f1c9a6', '#b67a52'];
const HAIR = ['#3b2a1f', '#5a3a22', '#1f1b18', '#7a4a26', '#c49a5a', '#2b2f3a'];
// 经典“盒子展开”布局：顶/底/右/前/左/后
export function boxRects(u, v, w, h, d) {
  return {
    top: [u + d, v, w, d], bottom: [u + d + w, v, w, d],
    right: [u, v + d, d, h], front: [u + d, v + d, w, h], left: [u + d + w, v + d, d, h], back: [u + 2 * d + w, v + d, w, h],
  };
}
export const SKIN_PARTS = {
  head: [0, 0, 8, 8, 8], body: [16, 16, 8, 12, 4], armR: [40, 16, 4, 12, 4], armL: [32, 48, 4, 12, 4], legR: [0, 16, 4, 12, 4], legL: [16, 48, 4, 12, 4],
};
const _skins = new Map();
export function makeSkin(o = {}) {
  const key = JSON.stringify(o);
  if (_skins.has(key)) return _skins.get(key);
  const r = rng(o.seed || 1);
  const skin = hex(o.skin || SKIN_TONES[Math.floor(r() * SKIN_TONES.length)]);
  const hair = hex(o.hair || HAIR[Math.floor(r() * HAIR.length)]);
  const shirt = hex(o.shirt || TEAM_HEX.red);
  const pants = hex(o.pants || '#353a56');
  const shoes = hex(o.shoes || '#2a2626');
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const put = (x, y, col, k = 1) => { const n = 0.96 + r() * 0.07; g.fillStyle = `rgb(${clamp(col[0] * k * n, 0, 255) | 0},${clamp(col[1] * k * n, 0, 255) | 0},${clamp(col[2] * k * n, 0, 255) | 0})`; g.fillRect(x, y, 1, 1); };
  const fill = (rect, fn) => { const [x0, y0, w, h] = rect; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = fn(x, y, w, h); if (v) put(x0 + x, y0 + y, v[0], v[1] ?? 1); } };
  // 头
  const head = boxRects(...SKIN_PARTS.head);
  const robe = o.robe ? hex(o.robe) : null;
  fill(head.top, () => [o.hat ? hex(o.hat) : hair]);
  fill(head.bottom, () => [skin, 0.85]);
  for (const side of ['right', 'left', 'back']) fill(head[side], (x, y) => (y < (side === 'back' ? 5 : 2) || (o.hat && y < 3) ? [o.hat && y < 3 ? hex(o.hat) : hair] : [skin, 0.92]));
  fill(head.front, (x, y) => {
    if (o.hat && y < 2) return [hex(o.hat)];
    if (y === 0 || (y === 1 && (x < 2 || x > 5 || o.fringe))) return [hair];
    if (y === 2 && (x === 1 || x === 2 || x === 5 || x === 6)) return [hair, 0.9];      // 眉毛
    if (y === 3) { if (x === 1 || x === 6) return [[245, 245, 245]]; if (x === 2 || x === 5) return [hex(o.eye || '#3a4a7a')]; }
    if (y === 5 && (x === 3 || x === 4)) return [skin, 0.88];                          // 鼻子阴影
    if (o.beard && y >= 5) return [hex(o.beard)];
    if (y === 6 && x >= 2 && x <= 5) return [x === 2 || x === 5 ? skin : hex('#9a5a48'), x === 2 || x === 5 ? 0.9 : 1];
    return [skin];
  });
  // 身体
  const body = boxRects(...SKIN_PARTS.body);
  for (const [side, k] of [['front', 1], ['back', 0.92], ['right', 0.85], ['left', 0.85], ['top', 1.05], ['bottom', 0.8]]) {
    fill(body[side], (x, y, w) => {
      const base = robe || shirt;
      if (!robe && side === 'front' && y < 2 && x >= 3 && x <= 4) return [skin];                // 领口
      if (!robe && (side === 'front' || side === 'back') && y === 9) return [base, 0.75];        // 腰带线
      if (robe && side === 'front' && x >= 2 && x <= 5 && y >= 2) return [hex(o.apron || '#d9c9a6')];
      return [base, k * (y > 9 ? 0.92 : 1)];
    });
  }
  // 手臂
  for (const part of ['armR', 'armL']) {
    const a = boxRects(...SKIN_PARTS[part]);
    for (const [side, k] of [['front', 1], ['back', 0.9], ['right', 0.85], ['left', 0.85], ['top', 1], ['bottom', 0.8]]) {
      fill(a[side], (x, y) => {
        if (side === 'top') return [robe || shirt];
        if (side === 'bottom') return [skin, 0.8];
        return y < (robe ? 9 : 4) ? [robe || shirt, k] : [skin, k * (y > 10 ? 0.92 : 1)];
      });
    }
  }
  // 腿
  for (const part of ['legR', 'legL']) {
    const l = boxRects(...SKIN_PARTS[part]);
    for (const [side, k] of [['front', 1], ['back', 0.9], ['right', 0.85], ['left', 0.85], ['top', 1], ['bottom', 0.8]]) {
      fill(l[side], (x, y) => (robe && y < 9 ? [robe, k * 0.92] : y >= 10 ? [shoes, k] : [pants, k * (y === 0 ? 0.9 : 1)]));
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapLinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  const out = { tex, canvas: c };
  _skins.set(key, out);
  return out;
}

// ---------------------------------------------------------------- 经典默认皮肤风格（自己画的像素图，照着“史蒂夫 / 亚历克斯”的配色和五官布局）
// 脸（8×8）：H 头发 h 头发亮 S 皮肤 s 皮肤暗 W 眼白 E 瞳孔 N 鼻子 M 嘴 / 胡茬
const FACES = {
  steve: ['HHhHHhHH', 'HHHHHHHH', 'HSSSSSSH', 'SWESSEWS', 'SSSNNSSS', 'SSMSSMSS', 'SSMMMMSS', 'SSSSSSSS'],
  alex: ['HHHHHHHH', 'HHHHHhHH', 'HHSSSSSS', 'HWESSEWS', 'HSSSSSSS', 'SSSSSSSS', 'SSSMMSSS', 'SSSSSSSS'],
};
export const CLASSIC = {
  steve: { face: 'steve', skin: '#b4836a', skinD: '#9c6c55', hair: '#2e1e12', hair2: '#41291a', eye: '#4b3f8c', nose: '#8a5a44', mouth: '#5a3524', shirt: '#00a3a3', shirtD: '#008585', pants: '#3a3896', pantsD: '#2c2a74', shoes: '#575757', sleeve: 4 },
  alex: { face: 'alex', skin: '#f0c4a0', skinD: '#d9a985', hair: '#cc6620', hair2: '#e5843a', eye: '#2f6b35', nose: '#e0ae8a', mouth: '#c4836a', shirt: '#5e9a3a', shirtD: '#4b7f2c', pants: '#6a4a2a', pantsD: '#55391f', shoes: '#4a4a4a', sleeve: 5, long: true },
};
// 服务器里常见的几种“换了衣服的史蒂夫”
const VARIANTS = {
  steve_hoodie: { base: 'steve', shirt: '#2b2d33', shirtD: '#1f2026', pants: '#33363d', pantsD: '#26282e', sleeve: 12 },
  steve_white: { base: 'steve', shirt: '#e8e6e0', shirtD: '#c9c6bd', hair: '#5a3a1e', hair2: '#6e4826' },
  steve_red: { base: 'steve', shirt: '#9e2b25', shirtD: '#7e211c', hair: '#1c1712', hair2: '#2a2219' },
  alex_blue: { base: 'alex', shirt: '#3f5f9e', shirtD: '#31497c', hair: '#3a2416', hair2: '#4c301d' },
  steve_suit: { base: 'steve', shirt: '#3d3f46', shirtD: '#2e3036', pants: '#2a2b30', pantsD: '#202125', sleeve: 12, skin: '#d9a07c', skinD: '#c08a68' },
};
export const SKIN_KINDS = ['steve', 'alex', ...Object.keys(VARIANTS)];
export function classicSkin(kind = 'steve') {
  const key = 'classic:' + kind;
  if (_skins.has(key)) return _skins.get(key);
  const v = VARIANTS[kind], C = { ...CLASSIC[v ? v.base : kind], ...(v || {}) };
  const r = rng(kind.length * 31 + 7);
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const put = (x, y, hexc, k = 1) => { const col = hex(hexc), n = k * (0.97 + r() * 0.06); g.fillStyle = `rgb(${clamp(col[0] * n, 0, 255) | 0},${clamp(col[1] * n, 0, 255) | 0},${clamp(col[2] * n, 0, 255) | 0})`; g.fillRect(x, y, 1, 1); };
  const fill = (rect, fn) => { const [x0, y0, w, h] = rect; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const col = fn(x, y, w, h); if (col) put(x0 + x, y0 + y, col[0], col[1] ?? 1); } };
  const code = { H: C.hair, h: C.hair2, S: C.skin, s: C.skinD, W: '#f4f4f4', E: C.eye, N: C.nose, M: C.mouth };
  const head = boxRects(...SKIN_PARTS.head);
  fill(head.front, (x, y) => [code[FACES[C.face][y][x]]]);
  fill(head.top, (x, y) => [(x + y) % 3 ? C.hair : C.hair2]);
  fill(head.bottom, () => [C.skinD]);
  fill(head.back, (x, y) => [y < (C.long ? 8 : 6) ? ((x * 3 + y) % 4 ? C.hair : C.hair2) : C.skinD]);
  for (const side of ['right', 'left']) fill(head[side], (x, y) => {
    if (C.long) return [y < 7 || (side === 'right' ? x < 5 : x > 2) ? (y % 3 ? C.hair : C.hair2) : C.skin];
    return [y < 2 || (y < 4 && (side === 'right' ? x < 2 : x > 5)) ? C.hair : y === 4 && (side === 'right' ? x === 5 : x === 2) ? C.skinD : C.skin];
  });
  const body = boxRects(...SKIN_PARTS.body);
  for (const [side, k] of [['front', 1], ['back', 0.92], ['right', 0.86], ['left', 0.86], ['top', 1.05], ['bottom', 0.8]]) {
    fill(body[side], (x, y) => {
      if (side === 'front' && y === 0 && x >= 3 && x <= 4 && C.sleeve < 12) return [C.skin];               // 领口
      if (C.long && side === 'back' && y < 5 && x >= 2 && x <= 5) return [C.hair];                         // 亚历克斯的马尾
      return [y >= 10 ? C.pants : (y === 9 || x === 0 || x === 7 ? C.shirtD : C.shirt), k];
    });
  }
  for (const part of ['armR', 'armL']) {
    const a = boxRects(...SKIN_PARTS[part]);
    for (const [side, k] of [['front', 1], ['back', 0.9], ['right', 0.86], ['left', 0.86], ['top', 1], ['bottom', 0.8]]) {
      fill(a[side], (x, y) => {
        if (side === 'top') return [C.shirt];
        if (side === 'bottom') return [C.skinD];
        return y < C.sleeve ? [y === C.sleeve - 1 ? C.shirtD : C.shirt, k] : [C.skin, k * (y > 10 ? 0.93 : 1)];
      });
    }
  }
  for (const part of ['legR', 'legL']) {
    const l = boxRects(...SKIN_PARTS[part]);
    for (const [side, k] of [['front', 1], ['back', 0.9], ['right', 0.86], ['left', 0.86], ['top', 1], ['bottom', 0.8]]) {
      fill(l[side], (x, y) => [y >= 10 ? C.shoes : (x === 0 && side === 'front') || y === 9 ? C.pantsD : C.pants, k]);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false; tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestMipmapLinearFilter; tex.colorSpace = THREE.SRGBColorSpace;
  const out = { tex, canvas: c };
  _skins.set(key, out);
  return out;
}
// 染色皮革（起床战争里各队的护甲）
const _leather = new Map();
export function leatherTexture(color) {
  if (_leather.has(color)) return _leather.get(color);
  const c = document.createElement('canvas'); c.width = c.height = 16;
  const g = c.getContext('2d'), r = rng(hex(color)[0] + 3), b = hex(color);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const edge = x === 0 || y === 0 || x === 15 || y === 15, k = (edge ? 0.72 : 1) * (0.9 + r() * 0.16);
    g.fillStyle = `rgb(${clamp(b[0] * k, 0, 255) | 0},${clamp(b[1] * k, 0, 255) | 0},${clamp(b[2] * k, 0, 255) | 0})`; g.fillRect(x, y, 1, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter; tex.colorSpace = THREE.SRGBColorSpace;
  _leather.set(color, tex);
  return tex;
}

// ---------------------------------------------------------------- 物品像素图（16×16，用于立体“掉落物”和 2D 图标）
const SPR = {
  ingot: ['................', '................', '................', '................', '................', '......aaaaaaa...', '.....awwlllllla.', '....alllllllla..', '...allllllllla..', '..aaaaaaaaaaa...', '..ddddddddddd...', '................', '................', '................', '................', '................'],
  gem: ['................', '................', '.....aaaaaa.....', '....awwlllla....', '...awllllllla...', '..aaaaaaaaaaaa..', '..alllllllllla..', '...alllllllla...', '....alllllla....', '.....alllla.....', '......alla......', '.......aa.......', '................', '................', '................', '................'],
  sword: ['..............aa', '.............awa', '............awla', '...........awla.', '..........awla..', '.........awla...', '........awla....', '..g....awla.....', '..gg..awla......', '...ggawla.......', '....ggla........', '....kgg.........', '...kkkgg........', '..kkk..gg.......', '.kkk............', '.kk.............'],
  pickaxe: ['...aaaaaaaa.....', '..awwwwwwwwa....', '.awwaaaaaawwa...', 'awwa..kk..awwa..', 'aa...kk.....aa..', '.....kk.........', '....kk..........', '....kk..........', '...kk...........', '...kk...........', '..kk............', '..kk............', '.kk.............', '.kk.............', 'kk..............', 'k...............'],
  chest: ['................', '...aaa....aaa...', '..alla....alla..', '..allaaaaaalla..', '..alllllllllla..', '..alllllllllla..', '...alllllllla...', '...allwwwwlla...', '...alllllllla...', '...alllllllla...', '...aaaaaaaaaa...', '................', '................', '................', '................', '................'],
  heart: ['................', '................', '...aaa...aaa....', '..awlla.allla...', '.awlllllllllla..', '.alllllllllllla.', '.alllllllllllla.', '..alllllllllla..', '...alllllllla...', '....alllllla....', '.....alllla.....', '......alla......', '.......aa.......', '................', '................', '................'],
  stick: ['................', '.............a..', '............al..', '...........agk..', '..........agka..', '.........alka...', '........agka....', '.......alka.....', '......alka......', '.....alka.......', '....alka........', '...alka.........', '...lka..........', '...ka...........', '...a............', '................'],
  scroll: ['................', '................', '................', '..ad........da..', '..adaaaaaaaada..', '..adwwwwwwwwda..', '..adwllllllwda..', '..adwwwwwwwwda..', '..adwllllllwda..', '..adwrrwwwwwda..', '..adwwrwwwwwda..', '..adaaaaaaaada..', '..ad........da..', '................', '................', '................'],
  coin: ['................', '................', '.....aaaaaa.....', '....awwlllla....', '...awllllllla...', '...allldlllla...', '...allldlllla...', '...allldlllla...', '...allldlllla...', '....alllllla....', '.....aaaaaa.....', '................', '................', '................', '................', '................'],
};
// EP03 新增：苹果、弓、下界之星（闪电之星）——用代码画 16×16 像素
(() => {
  const grid = f => Array.from({ length: 16 }, (_, y) => Array.from({ length: 16 }, (_, x) => f(x, y) || '.').join(''));
  SPR.apple = grid((x, y) => {
    if ((x === 8 && (y === 2 || y === 3)) ) return 'k';
    if (x === 9 && y === 3 || x === 10 && y === 2) return 'g';
    const d = Math.hypot((x - 7.5) / 5.6, (y - 9) / 5.2);
    if (d > 1) return null;
    if (d > 0.84) return 'a';
    if (x < 6 && y < 8 && d < 0.6) return 'w';
    return y > 11 ? 'd' : 'l';
  });
  SPR.bow = grid((x, y) => {
    // 弓背：从左下到右上的一道弧；弓弦：两端之间的直线
    const u = (x - y + 15) / 30, v = (x + y - 15) / 2;    // u 沿弓长，v 垂直于弓长
    const arc = 3.2 * Math.sin(Math.PI * Math.min(1, Math.max(0, (x + (15 - y)) / 28)));
    if (x + y >= 13 && x + y <= 17 && x > 1 && y > 1 && x < 14 && y < 14) return 's';
    const off = (15 - x - y) / Math.SQRT2;                  // 离对角线（弓弦）的距离，往左上为正
    const along = (x - y) / Math.SQRT2;
    if (Math.abs(along) <= 9.2 && Math.abs(off - 1.2 - arc) < 0.75 && off > 0) return Math.abs(along) < 1.2 ? 'g' : 'k';
    return null;
  });
  SPR.star = grid((x, y) => {
    const dx = Math.abs(x - 7.5), dy = Math.abs(y - 7.5);
    if (dx + dy < 2.2) return 'w';
    if ((dx < 0.6 && dy < 6.6) || (dy < 0.6 && dx < 6.6)) return dx + dy < 4 ? 'w' : 'l';
    if (Math.abs(dx - dy) < 0.6 && dx < 3.6) return 'l';
    if (dx + dy < 3.6) return 'a';
    return null;
  });
})();
export const SPRITE_PAL = {
  ingot_iron: { a: '#4a4a4e', w: '#ffffff', l: '#d8d8dc', d: '#8a8a90' },
  ingot_gold: { a: '#6a4a06', w: '#fff6c0', l: '#ffd84a', d: '#b8860b' },
  ingot_bronze: { a: '#4a200c', w: '#f0b080', l: '#c8703a', d: '#8a4520' },
  gem_diamond: { a: '#12615b', w: '#e8fffd', l: '#5fe8de' },
  gem_emerald: { a: '#0b4d20', w: '#d9ffe6', l: '#2fd36a' },
  sword_iron: { a: '#2a2a36', w: '#ffffff', l: '#c8d3db', g: '#c9a227', k: '#6b4a2b' },
  sword_diamond: { a: '#12615b', w: '#e8fffd', l: '#5fe8de', g: '#c9a227', k: '#6b4a2b' },
  pickaxe_iron: { a: '#3a3a44', w: '#d8dde2', k: '#7a5230' },
  pickaxe_diamond: { a: '#1d4f4b', w: '#7fe9df', k: '#7a5230' },
  chest_iron: { a: '#2a2f36', l: '#b8c2ca', w: '#eef4f8' },
  heart: { a: '#4a0a0a', l: '#e0262e', w: '#ffb3b3' },
  heart_empty: { a: '#141414', l: '#3a3a3a', w: '#555555' },
  coin: { a: '#7a5208', l: '#f2c23a', w: '#fff3c0', d: '#b8860b' },
  stick_kb: { a: '#2e1c0c', l: '#b07a3e', k: '#7a4f24', g: '#d08bff' },
  scroll: { a: '#4a3a1e', d: '#9a7a3e', w: '#fff8e0', l: '#c8b88a', r: '#d23a3a' },
  apple: { a: '#5a0c0c', l: '#e0262e', d: '#a8141c', w: '#ffb3a8', k: '#5b3a1a', g: '#3f9b2f' },
  bow: { k: '#7a5230', g: '#3a2a1a', s: '#e8e8e8' },
  star: { a: '#8a8aa8', l: '#d8d8f0', w: '#ffffff' },
};
export function spritePixels(shape, palName) {
  const pal = SPRITE_PAL[palName || shape];
  const rows = SPR[shape];
  const out = [];
  rows.forEach((row, y) => [...row].forEach((ch, x) => { if (pal[ch]) out.push({ x, y, color: new THREE.Color(pal[ch]), css: pal[ch] }); }));
  return out;
}
const _spriteCanvas = {};
export function spriteCanvas(shape, palName) {
  const key = shape + ':' + (palName || shape);
  if (_spriteCanvas[key]) return _spriteCanvas[key];
  const c = document.createElement('canvas'); c.width = c.height = 16;
  const g = c.getContext('2d');
  for (const p of spritePixels(shape, palName)) { g.fillStyle = p.css; g.fillRect(p.x, p.y, 1, 1); }
  return (_spriteCanvas[key] = c);
}

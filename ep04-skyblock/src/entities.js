// 场景里的“演员”：人物、床、掉落物、粒子、方块拼字。全部按时间 t 摆姿势。
import * as THREE from 'three';
import { makeSkin, classicSkin, leatherTexture, boxRects, SKIN_PARTS, tileUV, TEAM, TEAM_CSS } from './textures.js';
import { itemMesh, blockGeometry, voxelMaterials } from './voxel.js';
import { rng, clamp, hash, E, prog } from './util.js';

// BoxGeometry 的六个面依次是 +x、-x、+y、-y、+z、-z，每个面四个顶点：左上、右上、左下、右下
function setBoxUV(geo, rects, texW, texH) {
  const order = ['left', 'right', 'top', 'bottom', 'front', 'back'];
  const uv = geo.attributes.uv;
  const inset = 0.02;
  order.forEach((face, f) => {
    const [x, y, w, h] = rects[face];
    const x0 = (x + inset) / texW, x1 = (x + w - inset) / texW, y0 = (y + inset) / texH, y1 = (y + h - inset) / texH;
    const q = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]];
    for (let i = 0; i < 4; i++) uv.setXY(f * 4 + i, q[i][0], q[i][1]);
  });
  uv.needsUpdate = true;
}

// ---------------------------------------------------------------- 人物
const PX = 0.9 / 16;
// o.classic：'steve' / 'alex' / 变体（经典默认皮肤风格）；o.armor：队伍颜色的皮革胸甲 + 护腿
export function makePlayer(o = {}) {
  const skin = o.classic ? classicSkin(o.classic) : makeSkin(o.skin || { shirt: TEAM_CSS[o.team || 'red'], seed: o.seed || 1 });
  const mat = new THREE.MeshLambertMaterial({ map: skin.tex });
  const part = (name, w, h, d) => {
    const g = new THREE.BoxGeometry(w * PX, h * PX, d * PX);
    setBoxUV(g, boxRects(...SKIN_PARTS[name]), 64, 64);
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true; m.receiveShadow = true;
    return m;
  };
  const root = new THREE.Group();
  const body = new THREE.Group(); root.add(body);              // 整体（可倾斜、躺下）
  const pivot = (x, y, z, mesh, oy) => { const p = new THREE.Group(); p.position.set(x * PX, y * PX, z * PX); mesh.position.y = oy * PX; p.add(mesh); body.add(p); return p; };
  const torso = part('body', 8, 12, 4); torso.position.y = 18 * PX; body.add(torso);
  const head = pivot(0, 24, 0, part('head', 8, 8, 8), 4);
  const armR = pivot(-6, 22, 0, part('armR', 4, 12, 4), -4);
  const armL = pivot(6, 22, 0, part('armL', 4, 12, 4), -4);
  const legR = pivot(-2, 12, 0, part('legR', 4, 12, 4), -6);
  const legL = pivot(2, 12, 0, part('legL', 4, 12, 4), -6);
  const shells = [];
  if (o.armor) {
    // 护甲比身体大一圈（原版的第二层）；空岛战争里开箱子换上的铁甲也用它（浅灰色）
    const am = new THREE.MeshLambertMaterial({ map: leatherTexture(TEAM_CSS[o.armor] || o.armor) });
    const shell = (w, h, d, x, y, z, parent) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w * PX, h * PX, d * PX), am); m.position.set(x * PX, y * PX, z * PX); m.castShadow = true; parent.add(m); shells.push(m); return m; };
    shell(9, 12.6, 5, 0, 18, 0, body);
    shell(5, 6, 5, 0, -2.5, 0, armR); shell(5, 6, 5, 0, -2.5, 0, armL);
    shell(4.8, 9, 4.8, 0, -4.2, 0, legR); shell(4.8, 9, 4.8, 0, -4.2, 0, legL);
  }
  let held = null;
  const api = {
    group: root, head, armR, armL, legR, legL, body, material: mat,
    // 穿上 / 脱下护甲（k: 0..1，穿上的一瞬间护甲从 1.25 倍收到 1 倍）
    showArmor(k) { shells.forEach(m => { m.visible = k > 0.01; m.scale.setScalar(1 + 0.25 * (1 - k)); }); return api; },
    hold(mesh) { if (held) armR.remove(held); held = mesh; if (mesh) { mesh.position.set(0, -10 * PX, 3 * PX); mesh.rotation.set(-Math.PI / 2.2, Math.PI / 2, 0); armR.add(mesh); } },
    // walk: 步伐相位（弧度）；swing: 0..1 挥动相位；look: [偏航, 俯仰]
    // lean：身体前倾（跑步时用）
    pose({ walk = 0, walkAmt = 0, swing = null, look = [0, 0], wave = 0, lie = 0, cheer = 0, lean = 0 } = {}) {
      const s = Math.sin(walk) * 0.75 * walkAmt;
      legR.rotation.x = s; legL.rotation.x = -s;
      armR.rotation.set(-s * 0.8, 0, 0.05); armL.rotation.set(s * 0.8, 0, -0.05);
      if (swing !== null) {
        const k = Math.sin(swing * Math.PI * 2);
        armR.rotation.x = -1.9 + k * 0.75;
        armR.rotation.y = -0.3;
      }
      if (wave) { armL.rotation.z = -2.6 + Math.sin(wave) * 0.35; }
      if (cheer) { armR.rotation.z = 2.6 * cheer; armL.rotation.z = -2.6 * cheer; armR.rotation.x = armL.rotation.x = 0; }
      head.rotation.set(look[1] - lean, look[0], 0);
      body.rotation.x = -lie * Math.PI / 2 + lean;
      body.position.y = lie * 0.68;
      body.position.y += Math.abs(Math.sin(walk)) * 0.04 * walkAmt;
      return api;
    },
  };
  return api.pose();
}

// ---------------------------------------------------------------- 第一人称手臂（挂在相机上，相机要先加进场景）
// 右臂 + 手持物品；update({ swing, bob }) 摆姿势：swing 0..1 是一次挥动，bob 是走路相位
export function makeFPV(o = {}) {
  const skin = makeSkin(o.skin || { shirt: TEAM_CSS[o.team || 'blue'], seed: o.seed || 2 });
  const mat = new THREE.MeshLambertMaterial({ map: skin.tex });
  const geo = new THREE.BoxGeometry(4 * PX, 12 * PX, 4 * PX);
  setBoxUV(geo, boxRects(...SKIN_PARTS.armR), 64, 64);
  const arm = new THREE.Mesh(geo, mat);
  const rig = new THREE.Group(), shoulder = new THREE.Group(), hand = new THREE.Group();
  rig.add(shoulder); shoulder.add(arm); shoulder.add(hand);
  arm.position.y = -6 * PX;
  hand.position.set(0, -11 * PX, -1 * PX);
  const B = { x: 0.46, y: -0.56, z: -0.38, rx: 1.9, ry: 0.42, rz: 0, ...(o.base || {}) };
  let held = null;
  const api = {
    group: rig, material: mat,
    // kind：'sword' 剑/镐（竖着握），'block' 方块
    hold(mesh, kind = 'sword') {
      if (held) hand.remove(held);
      held = mesh;
      if (!mesh) return api;
      if (kind === 'block') { mesh.position.set(-0.02, -0.06, -0.02); mesh.rotation.set(0.45, 0.8, 0.15); }
      else { mesh.position.set(0.0, -0.08, -0.06); mesh.rotation.set(-Math.PI / 2 - 0.4, Math.PI / 2 - 0.2, 0.15); }
      hand.add(mesh);
      return api;
    },
    update({ swing = null, bob = 0, bobAmt = 0, lower = 0 } = {}) {
      let x = B.x + Math.sin(bob) * 0.012 * bobAmt, y = B.y - Math.abs(Math.cos(bob)) * 0.016 * bobAmt - lower * 0.5;
      let z = B.z, rx = B.rx, ry = B.ry, rz = B.rz;
      if (swing !== null) {
        const k = Math.sin(clamp(swing) * Math.PI);
        x -= 0.1 * k; y += 0.04 * k; z -= 0.12 * k;
        rx -= 0.55 * k; ry += 0.3 * k; rz -= 0.2 * k;
      }
      rig.position.set(x, y, z);
      shoulder.rotation.set(rx, ry, rz);
      return api;
    },
  };
  return api.update();
}

// 原版样式的村民：长脑袋、大鼻子、一字眉、袍子、双手抱在胸前
export function makeVillager(o = {}) {
  const skinC = o.skin || '#c29c88', robe = o.robe || '#8a6340', robeD = o.robeD || '#6e4c2e';
  const C = h => new THREE.Color(h);
  const tex = (w, h, fn) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'), r = rng(w * 7 + h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const col = fn(x, y), k = 0.95 + r() * 0.08; const cc = C(col); g.fillStyle = `rgb(${(cc.r * 255 * k) | 0},${(cc.g * 255 * k) | 0},${(cc.b * 255 * k) | 0})`; g.fillRect(x, y, 1, 1); }
    const t = new THREE.CanvasTexture(c); t.magFilter = THREE.NearestFilter; t.colorSpace = THREE.SRGBColorSpace; return t;
  };
  const face = tex(8, 10, (x, y) => (y === 3 && x >= 1 && x <= 6 ? '#3b2a1e' : y === 4 && (x === 2 || x === 5) ? '#2f6b35' : y === 4 && (x === 1 || x === 6) ? '#f0f0f0' : skinC));
  const skinT = tex(8, 10, () => skinC), robeT = tex(8, 16, (x, y) => (y === 0 || x === 0 || x === 7 ? robeD : robe));
  const lam = t => new THREE.MeshLambertMaterial({ map: t });
  const sk = lam(skinT), rb = lam(robeT);
  const root = new THREE.Group(), body = new THREE.Group(); root.add(body);
  const box = (w, h, d, x, y, z, mats, parent = body) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w * PX, h * PX, d * PX), mats); m.position.set(x * PX, y * PX, z * PX); m.castShadow = m.receiveShadow = true; parent.add(m); return m; };
  const headPivot = new THREE.Group(); headPivot.position.set(0, 24 * PX, 0); body.add(headPivot);
  box(8, 10, 8, 0, 5, 0, [sk, sk, sk, sk, lam(face), sk], headPivot);
  box(2, 4, 2, 0, 2, 5, sk, headPivot);                       // 鼻子
  box(8, 12, 6, 0, 18, 0, rb);                                 // 上身
  box(8.4, 7, 6.4, 0, 9.5, 0, rb);                             // 袍子下摆
  box(4, 6, 4, -2, 3, 0, lam(tex(4, 6, () => '#4a3424')));     // 脚
  box(4, 6, 4, 2, 3, 0, lam(tex(4, 6, () => '#4a3424')));
  const arms = new THREE.Group(); arms.position.set(0, 19 * PX, 3.2 * PX); arms.rotation.x = -0.75; body.add(arms);
  box(8, 4, 4, 0, 0, 0, rb, arms);                             // 抱在胸前的手臂
  box(4, 4, 4, -4.6, 1.5, -1.2, rb, arms); box(4, 4, 4, 4.6, 1.5, -1.2, rb, arms);
  box(4, 4, 4, 0, -0.2, 0.3, sk, arms);                        // 露出来的手
  const api = { group: root, pose({ look = [0, 0] } = {}) { headPivot.rotation.set(look[1], look[0], 0); return api; } };
  return api;
}

export function makeMerchant(seed = 3, robe = '#7a5230', hat = '#3a2a1a') {
  return makePlayer({ skin: { robe, hat, apron: '#d9c9a6', beard: '#c9c9c9', seed, skin: '#d9a27c', hair: '#c9c9c9', eye: '#3a6a3a' } });
}

// ---------------------------------------------------------------- 贴图盒子（床、方块零件）
function atlasBox(w, h, d, tiles) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const order = ['side', 'side', 'top', 'bottom', 'side', 'side'];
  order.forEach((k, f) => {
    const [u0, v0, u1, v1] = tileUV(tiles[k] || tiles.side);
    const q = [[u0, v0], [u1, v0], [u0, v1], [u1, v1]];
    for (let i = 0; i < 4; i++) uv.setXY(f * 4 + i, q[i][0], q[i][1]);
  });
  return g;
}
let _bedMat = null;
function bedMat() { return _bedMat || (_bedMat = new THREE.MeshLambertMaterial({ map: voxelMaterials().opaque.map })); }

// 裂纹贴图（越来越多的黑色裂缝）
function crackTexture(stage) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const r = rng(77);
  g.fillStyle = 'rgba(25,12,10,0.85)';
  for (let k = 0; k < stage * 7; k++) {
    let x = 8 + r() * 48, y = 8 + r() * 48;
    for (let s = 0; s < 8; s++) { g.fillRect(Math.round(x), Math.round(y), 3, 3); x += (r() - 0.5) * 9; y += (r() - 0.5) * 9; }
  }
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const CRACKS = [];
export function makeBed(team = 'red') {
  const grp = new THREE.Group();
  const m = bedMat();
  const add = (geo, x, y, z) => { const mesh = new THREE.Mesh(geo, m); mesh.position.set(x, y, z); mesh.castShadow = mesh.receiveShadow = true; grp.add(mesh); return mesh; };
  for (const [x, z] of [[0.1, 0.1], [1.9, 0.1], [0.1, 0.9], [1.9, 0.9]]) add(atlasBox(0.18, 0.2, 0.18, { side: 'dark_planks' }), x, 0.1, z);
  add(atlasBox(2, 0.14, 1, { side: 'planks', top: 'planks', bottom: 'planks' }), 1, 0.26, 0.5);
  add(atlasBox(2, 0.24, 1, { side: 'wool_' + team, top: 'wool_' + team, bottom: 'planks' }), 1, 0.45, 0.5);
  add(atlasBox(1.38, 0.05, 1.02, { side: 'wool_' + team, top: 'wool_' + team }), 1.31, 0.59, 0.5);   // 被子边
  add(atlasBox(0.5, 0.1, 0.82, { side: 'wool_white', top: 'wool_white' }), 0.32, 0.62, 0.5);         // 枕头
  // 床头板
  add(atlasBox(0.12, 0.42, 1, { side: 'dark_planks', top: 'dark_planks' }), 0.0, 0.42, 0.5);
  if (!CRACKS.length) for (let s = 1; s <= 5; s++) CRACKS.push(new THREE.MeshBasicMaterial({ map: crackTexture(s), transparent: true, depthWrite: false }));
  const crack = new THREE.Mesh(new THREE.PlaneGeometry(1.96, 0.98), CRACKS[0]);
  crack.rotation.x = -Math.PI / 2; crack.position.set(1, 0.625, 0.5); crack.visible = false; grp.add(crack);
  // 原点移到床的中心（x 方向两格长，床头在 -x 一端）
  for (const c of grp.children) { c.position.x -= 1; c.position.z -= 0.5; }
  return {
    group: grp,
    setCrack(k) { crack.visible = k > 0.02; crack.material = CRACKS[Math.min(4, Math.floor(k * 5))]; },
  };
}

// ---------------------------------------------------------------- 箱子（空岛战争开局要开的那种）：箱体 + 以后沿为轴翻开的盖子 + 铁扣
// 照原版的比例：14×10×14 的箱体，14×5×14 的盖子；贴图是自己画的木纹，不是原版素材
function woodFace(w, h, o = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), r = rng(w * 31 + h * 7 + (o.seed || 0));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
    const seam = !edge && (o.top ? x % 5 === 2 : y % 4 === 3);
    const base = o.inside ? [58, 38, 20] : edge ? [74, 48, 24] : seam ? [128, 86, 42] : [168, 114, 56];
    const k = 0.9 + r() * 0.18;
    g.fillStyle = `rgb(${clamp(base[0] * k, 0, 255) | 0},${clamp(base[1] * k, 0, 255) | 0},${clamp(base[2] * k, 0, 255) | 0})`;
    g.fillRect(x, y, 1, 1);
  }
  const t = new THREE.CanvasTexture(c); t.magFilter = THREE.NearestFilter; t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshLambertMaterial({ map: t });
}
let _chestMats = null;
export function makeChest(scale = 1) {
  if (!_chestMats) {
    const side = woodFace(14, 10), top = woodFace(14, 14, { top: true }), inner = woodFace(14, 14, { inside: true });
    const lidSide = woodFace(14, 5, { seed: 3 }), lidTop = woodFace(14, 14, { top: true, seed: 5 });
    _chestMats = {
      base: [side, side, inner, top, side, side], lid: [lidSide, lidSide, lidTop, inner, lidSide, lidSide],
      latch: new THREE.MeshLambertMaterial({ color: '#c9ccd1' }),
    };
  }
  const S = scale / 16, grp = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(14 * S, 10 * S, 14 * S), _chestMats.base);
  base.position.y = 5 * S; grp.add(base);
  const hinge = new THREE.Group(); hinge.position.set(0, 10 * S, -7 * S); grp.add(hinge);
  const lid = new THREE.Mesh(new THREE.BoxGeometry(14 * S, 5 * S, 14 * S), _chestMats.lid);
  lid.position.set(0, 2.5 * S, 7 * S); hinge.add(lid);
  const latch = new THREE.Mesh(new THREE.BoxGeometry(2 * S, 4 * S, 1 * S), _chestMats.latch);
  latch.position.set(0, 0.5 * S, 14.5 * S); hinge.add(latch);
  grp.traverse(m => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
  return {
    group: grp,
    // k: 0 关着，1 完全打开（盖子往后翻约 80°）
    setOpen(k) { hinge.rotation.x = -1.4 * clamp(k); },
  };
}

// ---------------------------------------------------------------- 开局的玻璃笼：3×3 的玻璃地板、两层高的四壁、玻璃顶，人站在正中间
// （x, y, z）是笼子地板这一格的最小角；返回网格组，碎的时候整个隐藏，再放一团玻璃碎片
export function makeCage(Voxels, buildVoxelMesh, x, y, z) {
  const v = new Voxels();
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    v.set(x + dx, y, z + dz, 'glass'); v.set(x + dx, y + 3, z + dz, 'glass');
    if (dx || dz) { v.set(x + dx, y + 1, z + dz, 'glass'); v.set(x + dx, y + 2, z + dz, 'glass'); }
  }
  return buildVoxelMesh(v, { ao: false });
}

// ---------------------------------------------------------------- 掉落物（旋转、上下浮动）
export function makeItem(shape, pal, size = 0.55) {
  const g = new THREE.Group();
  const m = itemMesh(shape, pal, size);
  g.add(m);
  return {
    group: g,
    update(t, phase = 0) { m.rotation.y = t * 1.6 + phase; m.position.y = 0.12 + Math.sin(t * 2.2 + phase) * 0.08; },
  };
}

// ---------------------------------------------------------------- 粒子：一次性爆裂，位置由经过时间算出
const _pGeo = new THREE.BoxGeometry(1, 1, 1);
const _pMat = new THREE.MeshLambertMaterial({ vertexColors: false });
export class Bursts {
  constructor(max = 600) {
    this.mesh = new THREE.InstancedMesh(_pGeo, _pMat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.max = max;
    this.list = [];
    this.mesh.setColorAt(0, new THREE.Color());
  }
  // 登记一次爆裂：t0 时刻、位置、颜色列表
  add(t0, pos, o = {}) { this.list.push({ t0, pos: pos.clone ? pos.clone() : new THREE.Vector3(...pos), o }); return this; }
  update(t) {
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3(), Eu = new THREE.Euler();
    const col = new THREE.Color();
    let n = 0;
    for (const b of this.list) {
      const dt = t - b.t0, o = b.o, life = o.life || 1.6;
      if (dt < 0 || dt > life) continue;
      const r = rng(o.seed || 1);
      const N = o.n || 40;
      for (let i = 0; i < N && n < this.max; i++) {
        const th = r() * Math.PI * 2, up = (o.up ?? 0.7) + r() * (o.upVar ?? 0.8);
        const sp = (o.speed || 4) * (0.4 + r() * 0.8);
        const v = [Math.cos(th) * sp * (o.spread ?? 1), up * sp, Math.sin(th) * sp * (o.spread ?? 1)];
        const g = o.gravity ?? 14;
        P.set(b.pos.x + v[0] * dt, b.pos.y + v[1] * dt - 0.5 * g * dt * dt, b.pos.z + v[2] * dt);
        if (o.floor !== undefined && P.y < o.floor) P.y = o.floor;
        const size = (o.size || 0.12) * (0.6 + r() * 0.8) * (1 - Math.pow(dt / life, 3));
        Eu.set(r() * 6 + dt * 6 * r(), r() * 6 + dt * 5, r() * 6);
        Q.setFromEuler(Eu); S.setScalar(Math.max(0.0001, size));
        M.compose(P, Q, S);
        this.mesh.setMatrixAt(n, M);
        const cols = o.colors || ['#c8423b'];
        col.set(cols[Math.floor(r() * cols.length)]);
        this.mesh.setColorAt(n, col);
        n++;
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- 方块拼字：文字逐像素变成方块，从空中飞入
export function voxelText(str, o = {}) {
  const font = o.font || '12px FP';
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  g.font = font;
  const w = Math.ceil(g.measureText(str).width) + 4, h = o.h || 16;
  c.width = w; c.height = h;
  g.font = font; g.textBaseline = 'top'; g.fillStyle = '#fff';
  g.fillText(str, 2, o.dy ?? 1);
  const d = g.getImageData(0, 0, w, h).data;
  const cells = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 140) cells.push([x, y]);
  const { geometry, material } = blockGeometry(o.block || 'gold');
  const mesh = new THREE.InstancedMesh(geometry, material, cells.length);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  const size = o.size || 0.5, cx = w / 2, cy = h / 2;
  const r = rng(o.seed || 9);
  const from = cells.map(() => [(r() - 0.5) * 30, 12 + r() * 14, (r() - 0.5) * 16 - 6, r() * 6, r() * 6]);
  const order = cells.map(([x]) => x / w);
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), Eu = new THREE.Euler(), P = new THREE.Vector3(), S = new THREE.Vector3();
  return {
    mesh, count: cells.length, width: w * size, height: h * size,
    // k0: 开始飞入的时间；dur: 单个方块飞行时长；spread: 从左到右的错开时长
    update(t, t0, dur = 0.9, spread = 0.8) {
      cells.forEach(([x, y], i) => {
        const k = E.outCubic(prog(t, t0 + order[i] * spread + hash(i) * 0.15, dur));
        const tx = (x - cx) * size, ty = (cy - y) * size, tz = 0;
        const f = from[i];
        P.set(tx + f[0] * (1 - k), ty + f[1] * (1 - k), tz + f[2] * (1 - k));
        Eu.set(f[3] * (1 - k), f[4] * (1 - k), 0); Q.setFromEuler(Eu);
        S.setScalar(size * (k <= 0 ? 0.0001 : 0.98));
        M.compose(P, Q, S);
        mesh.setMatrixAt(i, M);
      });
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}

// 龙蛋：小方块拼成的椭球，带紫色斑点
export function dragonEgg(scale = 1) {
  const pts = [];
  const R = 6;
  for (let y = 0; y <= 15; y++) for (let x = -R; x <= R; x++) for (let z = -R; z <= R; z++) {
    const yy = (y - 6) / (y < 6 ? 6 : 9.5);
    const rr = Math.sqrt((x * x + z * z)) / R;
    if (rr * rr + yy * yy <= 1) pts.push([x, y, z]);
  }
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshLambertMaterial();
  const mesh = new THREE.InstancedMesh(geo, mat, pts.length);
  const M = new THREE.Matrix4(), col = new THREE.Color();
  pts.forEach(([x, y, z], i) => {
    M.makeTranslation(x, y, z); mesh.setMatrixAt(i, M);
    const sp = hash(i * 7 + 3);
    col.set(sp < 0.07 ? '#b45cff' : sp < 0.15 ? '#3a2a55' : '#120c1c');
    mesh.setColorAt(i, col);
  });
  mesh.scale.setScalar(scale / 16);
  mesh.castShadow = true;
  return mesh;
}

export { TEAM };

// ---------------------------------------------------------------- 光晕、光柱
let _glowTex = null;
function glowTexture() {
  if (_glowTex) return _glowTex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.55)'); gr.addColorStop(0.6, 'rgba(255,255,255,0.12)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  _glowTex = new THREE.CanvasTexture(c); _glowTex.colorSpace = THREE.SRGBColorSpace;
  return _glowTex;
}
export function makeGlow(color = '#ffd36a', size = 2, opacity = 0.8) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false }));
  s.scale.setScalar(size);
  return s;
}
export function makeBeam(color = '#ffe08a', height = 30, radius = 0.45) {
  const g = new THREE.CylinderGeometry(radius, radius, height, 16, 1, true);
  g.translate(0, height / 2, 0);
  const col = [], pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) { const k = 1 - pos.getY(i) / height; col.push(k, k, k); }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, vertexColors: true, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false }));
  return m;
}

// ---------------------------------------------------------------- 空气里的浮尘：被灯光照到的小亮点，慢慢飘
export class Motes {
  // box: [[x0, y0, z0], [x1, y1, z1]]
  constructor(n = 240, box = [[-10, 0, -10], [10, 6, 10]], o = {}) {
    const r = rng(o.seed || 5);
    this.p = Array.from({ length: n }, () => [lerpR(r, box[0][0], box[1][0]), lerpR(r, box[0][1], box[1][1]), lerpR(r, box[0][2], box[1][2]), r() * 6.28, 0.04 + r() * 0.1]);
    this.box = box;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ map: glowTexture(), color: o.color || '#ffd9a8', size: o.size || 0.07, sizeAttenuation: true, transparent: true, opacity: o.opacity ?? 0.75, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.points.frustumCulled = false;
    this.mesh = this.points;
  }
  update(t) {
    const a = this.points.geometry.attributes.position, [b0, b1] = this.box, h = b1[1] - b0[1];
    this.p.forEach(([x, y, z, ph, vy], i) => {
      const yy = b0[1] + ((y - b0[1] + t * vy) % h + h) % h;
      a.setXYZ(i, x + Math.sin(t * 0.21 + ph) * 0.5, yy, z + Math.cos(t * 0.17 + ph * 1.3) * 0.5);
    });
    a.needsUpdate = true;
  }
}
const lerpR = (r, a, b) => a + (b - a) * r();

// ---------------------------------------------------------------- 人群：把一个人物烘焙成一个几何体，再用实例化批量摆放
const _crowdGeo = new Map();
// team 可以是队伍名，也可以直接给衣服颜色（'#3b4049'）
function bakedPerson(team, seed) {
  const key = team + ':' + seed;
  if (_crowdGeo.has(key)) return _crowdGeo.get(key);
  const p = team.startsWith('#') ? makePlayer({ skin: { shirt: team, seed, pants: ['#2b2f3a', '#3a3530', '#262a30', '#45403a'][seed % 4] } })
    : team.includes('steve') || team.includes('alex') ? makePlayer({ classic: team }) : makePlayer({ team, seed });
  p.pose({ walk: 0.6, walkAmt: 0.25 });
  p.group.updateMatrixWorld(true);
  const geos = [];
  let mat = null;
  p.group.traverse(o => { if (o.isMesh) { const g = o.geometry.clone(); g.applyMatrix4(o.matrixWorld); geos.push(g); mat = o.material; } });
  // 手动合并（位置、法线、UV、索引）
  const pos = [], nor = [], uv = [], idx = [];
  for (const g of geos) {
    const b = pos.length / 3;
    pos.push(...g.attributes.position.array); nor.push(...g.attributes.normal.array); uv.push(...g.attributes.uv.array);
    for (const i of g.index.array) idx.push(b + i);
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  merged.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  merged.setIndex(idx);
  const out = { geo: merged, mat };
  _crowdGeo.set(key, out);
  return out;
}
// spots: [[x, y, z, rotY, team], ...]
export function makeCrowd(spots, seedBase = 1) {
  const group = new THREE.Group();
  const byTeam = {};
  spots.forEach((s, i) => { (byTeam[s[4]] || (byTeam[s[4]] = [])).push([...s, i]); });
  const meshes = [];
  for (const [team, list] of Object.entries(byTeam)) {
    const { geo, mat } = bakedPerson(team, seedBase + (team.startsWith('#') ? parseInt(team.slice(1), 16) % 97 : team.length));
    const m = new THREE.InstancedMesh(geo, mat, list.length);
    m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
    m.userData.list = list;
    meshes.push(m); group.add(m);
  }
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), S = new THREE.Vector3(1, 1, 1), Y = new THREE.Vector3(0, 1, 0);
  return {
    group,
    // visible(i) 返回 0..1：用来做人群逐个出现 / 消失
    update(t, visible = () => 1, bounce = 0.05) {
      for (const m of meshes) {
        m.userData.list.forEach(([x, y, z, ry, team, i], j) => {
          const v = visible(i);
          P.set(x, y + Math.abs(Math.sin(t * 3 + i)) * bounce, z);
          Q.setFromAxisAngle(Y, ry + Math.sin(t * 0.8 + i) * 0.15);
          S.setScalar(Math.max(0.0001, v));
          M.compose(P, Q, S); m.setMatrixAt(j, M);
        });
        m.instanceMatrix.needsUpdate = true;
      }
    },
  };
}

// ---------------------------------------------------------------- 罗布乐思风格的圆润床（与方块风格形成对比）
export function makeSmoothBed(o = {}) {
  const grp = new THREE.Group();
  const red = new THREE.MeshStandardMaterial({ color: '#e5483d', roughness: 0.35, metalness: 0.05 });
  const white = new THREE.MeshStandardMaterial({ color: '#f4f4f4', roughness: 0.4 });
  const wood = new THREE.MeshStandardMaterial({ color: '#8a5a3a', roughness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: '#1d1d22', roughness: 0.3 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 1.3, 8, 16), red); body.rotation.z = Math.PI / 2; body.position.y = 0.75; grp.add(body);
  const pillow = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.5, 6, 12), white); pillow.rotation.x = Math.PI / 2; pillow.position.set(-0.75, 1.05, 0); grp.add(pillow);
  if (o.eyes !== false) for (const z of [-0.18, 0.18]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), white); eye.position.set(0.95, 0.95, z); grp.add(eye);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 8), dark); pupil.position.set(1.04, 0.95, z); grp.add(pupil);
  }
  const legs = [];
  for (const [x, z] of [[-0.6, -0.25], [0.6, 0.25], [-0.6, 0.25], [0.6, -0.25]]) {
    const l = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.35, 4, 8), wood); l.position.set(x, 0.25, z); grp.add(l); legs.push(l);
  }
  grp.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return {
    group: grp,
    walk(phase) { legs.forEach((l, i) => { l.rotation.z = Math.sin(phase + (i % 2) * Math.PI) * 0.6; }); body.position.y = 0.75 + Math.abs(Math.sin(phase)) * 0.06; },
  };
}

// ---------------------------------------------------------------- 方块奖杯
export function makeTrophy() {
  const s = 1 / 4;
  const parts = [];
  const add = (x0, y0, z0, x1, y1, z1, type) => { for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) parts.push([x, y, z, type]); };
  add(-3, 0, -3, 3, 0, 3, 'dark_planks'); add(-2, 1, -2, 2, 1, 2, 'gold'); add(-1, 2, -1, 1, 4, 1, 'gold');
  add(-4, 5, -4, 4, 5, 4, 'gold'); add(-4, 6, -4, 4, 9, -4, 'gold'); add(-4, 6, 4, 4, 9, 4, 'gold'); add(-4, 6, -3, -4, 9, 3, 'gold'); add(4, 6, -3, 4, 9, 3, 'gold');
  add(-6, 7, -1, -5, 8, 1, 'gold'); add(5, 7, -1, 6, 8, 1, 'gold');
  const grp = new THREE.Group();
  const by = {};
  parts.forEach(p => (by[p[3]] || (by[p[3]] = [])).push(p));
  for (const [type, list] of Object.entries(by)) {
    const { geometry, material } = blockGeometry(type);
    const m = new THREE.InstancedMesh(geometry, material, list.length);
    const M = new THREE.Matrix4();
    list.forEach(([x, y, z], i) => { M.makeScale(s, s, s).setPosition(x * s, y * s + s / 2, z * s); m.setMatrixAt(i, M); });
    m.castShadow = true; m.receiveShadow = true;
    grp.add(m);
  }
  return grp;
}

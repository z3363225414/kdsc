// 体素网格：只生成外露的面，并按顶点计算环境光遮蔽（方块交界处自然变暗）。
import * as THREE from 'three';
import { atlas, tileUV, blockFaces, CUTOUT, EMISSIVE, spritePixels } from './textures.js';

const K = (x, y, z) => ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);

export class Voxels {
  constructor() { this.m = new Map(); }
  set(x, y, z, type) { this.m.set(K(x, y, z), [x, y, z, type]); return this; }
  get(x, y, z) { const v = this.m.get(K(x, y, z)); return v ? v[3] : null; }
  del(x, y, z) { this.m.delete(K(x, y, z)); }
  fill(x0, y0, z0, x1, y1, z1, type) { for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) this.set(x, y, z, type); return this; }
  *[Symbol.iterator]() { yield* this.m.values(); }
  get size() { return this.m.size; }
}

// 面：法线、四个角（左下、右下、右上、左上，从外面看逆时针）、贴图类别
const FACES = [
  { n: [1, 0, 0], c: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], t: 'side' },
  { n: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], t: 'side' },
  { n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], t: 'side' },
  { n: [0, 0, -1], c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], t: 'side' },
  { n: [0, 1, 0], c: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], t: 'top' },
  { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], t: 'bottom' },
];
const AO_CURVE = [0.48, 0.66, 0.83, 1.0];

const MATS = {};
export function voxelMaterials() {
  if (MATS.opaque) return MATS;
  MATS.opaque = new THREE.MeshLambertMaterial({ map: atlas, vertexColors: true });
  MATS.cutout = new THREE.MeshLambertMaterial({ map: atlas, vertexColors: true, alphaTest: 0.5, side: THREE.DoubleSide });
  MATS.glass = new THREE.MeshLambertMaterial({ map: atlas, vertexColors: true, transparent: true, depthWrite: false });
  MATS.emissive = new THREE.MeshBasicMaterial({ map: atlas, vertexColors: true, toneMapped: false });
  return MATS;
}

function bucketOf(type) {
  if (EMISSIVE.has(type)) return 'emissive';
  if (type === 'glass') return 'glass';
  if (CUTOUT.has(type)) return 'cutout';
  return 'opaque';
}

// 把体素集合变成网格（可选 shadow / ao 开关）
export function buildVoxelMesh(vox, o = {}) {
  const solid = (x, y, z) => { const t = vox.get(x, y, z); return t && !CUTOUT.has(t) && t !== 'glass' ? t : null; };
  const occl = (x, y, z) => (vox.get(x, y, z) && vox.get(x, y, z) !== 'glass' ? 1 : 0);
  const buckets = {};
  const B = k => (buckets[k] || (buckets[k] = { pos: [], nor: [], uv: [], col: [], idx: [] }));
  const tint = o.tint || {};
  for (const [x, y, z, type] of vox) {
    const faces = blockFaces(type);
    const bk = B(bucketOf(type));
    for (const f of FACES) {
      const nx = x + f.n[0], ny = y + f.n[1], nz = z + f.n[2];
      const nt = vox.get(nx, ny, nz);
      if (nt) {
        if (solid(nx, ny, nz)) continue;
        if (nt === type && type === 'glass') continue;
      }
      const [u0, v0, u1, v1] = tileUV(faces[f.t]);
      const uvs = [[u0, v1], [u1, v1], [u1, v0], [u0, v0]];
      const base = bk.pos.length / 3;
      const ao = [];
      // 切线方向：找出法线以外的两个轴
      const axes = [0, 1, 2].filter(a => f.n[a] === 0);
      const tc = tint[type];
      f.c.forEach((c, i) => {
        bk.pos.push(x + c[0], y + c[1], z + c[2]);
        bk.nor.push(...f.n);
        bk.uv.push(...uvs[i]);
        let lvl = 3;
        if (o.ao !== false && !EMISSIVE.has(type)) {
          const p = [nx, ny, nz];
          const s1 = [0, 0, 0], s2 = [0, 0, 0];
          s1[axes[0]] = c[axes[0]] ? 1 : -1;
          s2[axes[1]] = c[axes[1]] ? 1 : -1;
          const a = occl(p[0] + s1[0], p[1] + s1[1], p[2] + s1[2]);
          const b = occl(p[0] + s2[0], p[1] + s2[1], p[2] + s2[2]);
          const d = occl(p[0] + s1[0] + s2[0], p[1] + s1[1] + s2[1], p[2] + s1[2] + s2[2]);
          lvl = a && b ? 0 : 3 - (a + b + d);
        }
        ao.push(lvl);
        const k = AO_CURVE[lvl];
        bk.col.push(k * (tc ? tc[0] : 1), k * (tc ? tc[1] : 1), k * (tc ? tc[2] : 1));
      });
      // 按 AO 选择对角线，避免明暗方向错误
      if (ao[0] + ao[2] >= ao[1] + ao[3]) bk.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else bk.idx.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
    }
  }
  const mats = voxelMaterials();
  const group = new THREE.Group();
  for (const [k, b] of Object.entries(buckets)) {
    if (!b.idx.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
    g.setIndex(b.idx);
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, mats[k]);
    mesh.castShadow = o.castShadow !== false && k !== 'glass' && k !== 'emissive';
    mesh.receiveShadow = o.receiveShadow !== false && k !== 'emissive';
    group.add(mesh);
  }
  return group;
}

// ---------------------------------------------------------------- 像素物品立体化（每个像素一个小方块）
const _spriteGeo = {};
export function spriteGeometry(shape, palName) {
  const key = shape + ':' + palName;
  if (_spriteGeo[key]) return _spriteGeo[key];
  const px = spritePixels(shape, palName);
  const has = new Set(px.map(p => p.x + ',' + p.y));
  const pos = [], nor = [], col = [], idx = [];
  const d = 1 / 16, depth = 1.5 / 16;
  const quad = (pts, n, c) => {
    const b = pos.length / 3;
    for (const p of pts) { pos.push(...p); nor.push(...n); col.push(c.r, c.g, c.b); }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  for (const p of px) {
    const x0 = p.x * d - 0.5, x1 = x0 + d, y1 = 0.5 - p.y * d, y0 = y1 - d, z0 = -depth / 2, z1 = depth / 2;
    const c = p.color, cs = p.color.clone().multiplyScalar(0.78);
    quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], c);
    quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], c);
    if (!has.has(p.x + 1 + ',' + p.y)) quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], cs);
    if (!has.has(p.x - 1 + ',' + p.y)) quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], cs);
    if (!has.has(p.x + ',' + (p.y - 1))) quad([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], cs);
    if (!has.has(p.x + ',' + (p.y + 1))) quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], cs);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return (_spriteGeo[key] = g);
}
const itemMat = new THREE.MeshLambertMaterial({ vertexColors: true });
export function itemMesh(shape, palName, size = 0.6) {
  const m = new THREE.Mesh(spriteGeometry(shape, palName), itemMat);
  m.scale.setScalar(size);
  m.castShadow = true;
  return m;
}

// 单个带贴图的方块（用于掉落、飞行中的方块）
const _cubeGeo = {};
export function blockGeometry(type) {
  if (_cubeGeo[type]) return _cubeGeo[type];
  const v = new Voxels().set(0, 0, 0, type);
  const grp = buildVoxelMesh(v, { ao: false });
  const g = grp.children[0].geometry;
  g.translate(-0.5, -0.5, -0.5);
  return (_cubeGeo[type] = { geometry: g, material: grp.children[0].material });
}
export function blockMesh(type, size = 1) {
  const { geometry, material } = blockGeometry(type);
  const m = new THREE.Mesh(geometry, material);
  m.scale.setScalar(size);
  m.castShadow = m.receiveShadow = true;
  return m;
}

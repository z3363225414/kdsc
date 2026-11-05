// 舞台：渲染器、天空、光照预设、雾、云，以及浮岛 / 树 / 花草等生成器。
import * as THREE from 'three';
import { W, H, rng, hash2, hash3, lerp, clamp } from './util.js';
import { Voxels, buildVoxelMesh } from './voxel.js';

export let renderer = null;
export function createRenderer() {
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}

// ---------------------------------------------------------------- 光照预设
const C = h => new THREE.Color(h);
export const PRESETS = {
  // 鲜亮的白天：饱和的蓝天、强一点的阳光、远一点的雾
  bright: { top: '#2a6fe0', horizon: '#a8d4ff', bottom: '#6d93c8', sun: [0.5, 0.75, 0.42], sunColor: '#fff4e0', sunI: 3.0, hemiSky: '#d8ecff', hemiGround: '#7a6648', hemiI: 1.3, fogNear: 90, fogFar: 340, stars: 0, glow: 0.4, exposure: 1.05, disc: 1 },
  day: { top: '#3f78cf', horizon: '#b9d6f3', bottom: '#5d7fa8', sun: [0.55, 0.78, 0.3], sunColor: '#fff1d8', sunI: 2.6, hemiSky: '#d2e6ff', hemiGround: '#6b5a45', hemiI: 1.15, fogNear: 60, fogFar: 260, stars: 0, glow: 0.35, exposure: 1.0, disc: 1 },
  golden: { top: '#1f4c9a', horizon: '#ffb36e', bottom: '#4a3d66', sun: [0.85, 0.22, 0.35], sunColor: '#ffbf80', sunI: 3.0, hemiSky: '#ffd8b4', hemiGround: '#4a3a4a', hemiI: 0.95, fogNear: 50, fogFar: 230, stars: 0, glow: 0.9, exposure: 1.0, disc: 1 },
  dusk: { top: '#151a46', horizon: '#c86b62', bottom: '#241d40', sun: [0.9, 0.06, 0.25], sunColor: '#ff8f6a', sunI: 1.7, hemiSky: '#9a86c8', hemiGround: '#2a2030', hemiI: 0.85, fogNear: 45, fogFar: 210, stars: 0.35, glow: 1.0, exposure: 1.05, disc: 1 },
  night: { top: '#050c2c', horizon: '#2a4278', bottom: '#070b1c', sun: [-0.4, 0.7, 0.45], sunColor: '#bccfff', sunI: 2.5, hemiSky: '#8fa3e0', hemiGround: '#1a1a28', hemiI: 1.3, fogNear: 60, fogFar: 280, stars: 1, glow: 0.2, exposure: 1.45, disc: 0 },
  red: { top: '#1c0507', horizon: '#9e3a1e', bottom: '#120304', sun: [0.6, 0.35, 0.5], sunColor: '#ffb27a', sunI: 1.9, hemiSky: '#ff9a7a', hemiGround: '#2a0a08', hemiI: 0.8, fogNear: 40, fogFar: 200, stars: 0.4, glow: 0.7, exposure: 1.05, disc: 0 },
  studio: { top: '#0d1020', horizon: '#232a46', bottom: '#07080f', sun: [0.4, 0.8, 0.5], sunColor: '#ffffff', sunI: 2.2, hemiSky: '#9fb4ff', hemiGround: '#1a1a24', hemiI: 0.9, fogNear: 50, fogFar: 240, stars: 0.5, glow: 0, exposure: 1.0, disc: 0 },
  mint: { top: '#0f3a3a', horizon: '#5aa49a', bottom: '#0b2224', sun: [0.5, 0.7, 0.4], sunColor: '#fff2d6', sunI: 2.2, hemiSky: '#c8f0e8', hemiGround: '#1a2a28', hemiI: 1.0, fogNear: 50, fogFar: 230, stars: 0, glow: 0.3, exposure: 1.0, disc: 0 },
  violet: { top: '#120c2c', horizon: '#6a4aa0', bottom: '#0b0818', sun: [0.4, 0.6, 0.6], sunColor: '#e6d6ff', sunI: 2.0, hemiSky: '#b8a0ff', hemiGround: '#1a1028', hemiI: 0.9, fogNear: 45, fogFar: 220, stars: 0.7, glow: 0.4, exposure: 1.05, disc: 0 },
  // 电影感：深夜。月光从画面深处打过来（逆光），镜头这一侧补一点冷色的天光，青灰色的雾把远处吃掉，暖光来自灯笼
  cine_night: { top: '#050a14', horizon: '#22313d', bottom: '#05070b', sun: [-0.3, 0.55, -0.78], sunColor: '#a8c2dc', sunI: 1.3, hemiSky: '#6a84a0', hemiGround: '#14161a', hemiI: 0.85, fogNear: 14, fogFar: 95, stars: 0.75, glow: 0.35, exposure: 1.45, disc: 0, fill: [0.2, 0.5, 1], fillColor: '#6f88a8', fillI: 0.45 },
  // 电影感：黄昏逆光。太阳压在画面深处的地平线上，影子朝镜头拉长；镜头一侧补蓝紫色的天光，人物不至于全黑
  // 电影感：月夜。方形的月亮挂在画面里，岛是逆光剪影
  cine_moon: { top: '#050913', horizon: '#1f2d3e', bottom: '#05070b', sun: [-0.5, 0.16, -0.866], sunColor: '#c9d8f2', sunI: 1.25, hemiSky: '#6a84a0', hemiGround: '#14161a', hemiI: 0.8, fogNear: 16, fogFar: 110, stars: 0.85, glow: 0.4, exposure: 1.3, disc: 1, square: true, fill: [0.3, 0.5, 1], fillColor: '#6f88a8', fillI: 0.4 },
  // 电影感：屋里的夜（天光几乎照不进来，主要靠窗口的月光和桌上的灯）
  cine_room: { top: '#050a14', horizon: '#22313d', bottom: '#05070b', sun: [-0.25, 0.5, -0.83], sunColor: '#9fbad8', sunI: 2.2, hemiSky: '#56708c', hemiGround: '#14120f', hemiI: 0.28, fogNear: 30, fogFar: 140, stars: 0.75, glow: 0.35, exposure: 1.5, disc: 0, fill: [0.3, 0.5, 1], fillColor: '#6f88a8', fillI: 0.12 },
  // 电影感：日出（低低的暖光从窗口斜射进来）
  cine_dawn: { top: '#2a4a78', horizon: '#f0a070', bottom: '#2a2430', sun: [-0.2, 0.14, -0.97], sunColor: '#ffb478', sunI: 3.0, hemiSky: '#a8b8d8', hemiGround: '#3a2e26', hemiI: 0.42, fogNear: 30, fogFar: 160, stars: 0, glow: 1.2, exposure: 1.2, disc: 1, fill: [0.3, 0.5, 1], fillColor: '#b8c0d8', fillI: 0.2 },
  // 电影感：黄昏侧光（太阳在画面右侧低处，两座对峙的岛一边亮一边暗）
  cine_side: { top: '#121a30', horizon: '#c98a5e', bottom: '#1a1420', sun: [1, 0.14, -0.3], sunColor: '#ffb070', sunI: 2.4, hemiSky: '#7c8aae', hemiGround: '#251a18', hemiI: 0.95, fogNear: 30, fogFar: 170, stars: 0.1, glow: 1.0, exposure: 1.1, disc: 1, fill: [-0.6, 0.4, 1], fillColor: '#8e9ac4', fillI: 0.55 },
  // 电影感：末地一样的紫色夜（EggWars 的龙蛋）
  cine_end: { top: '#06030d', horizon: '#2b2042', bottom: '#05030a', sun: [-0.3, 0.5, -0.8], sunColor: '#c8b4ff', sunI: 1.4, hemiSky: '#7a6aa8', hemiGround: '#141018', hemiI: 0.8, fogNear: 18, fogFar: 110, stars: 0.9, glow: 0.4, exposure: 1.35, disc: 0, fill: [0.3, 0.5, 1], fillColor: '#7a6aa8', fillI: 0.45 },
  // 电影感：金色的下午（Hypixel 段，故事走向“全世界”，画面第一次亮起来）
  cine_gold: { top: '#2d4f7c', horizon: '#e8b47e', bottom: '#3a3040', sun: [0.6, 0.35, -0.7], sunColor: '#ffd09a', sunI: 2.6, hemiSky: '#b8c8e0', hemiGround: '#3a3026', hemiI: 1.0, fogNear: 45, fogFar: 230, stars: 0, glow: 0.8, exposure: 1.08, disc: 1, fill: [-0.4, 0.5, 1], fillColor: '#b0bcd8', fillI: 0.45 },
  cine_dusk: { top: '#0f1830', horizon: '#d8814c', bottom: '#191321', sun: [-0.1, 0.09, -1], sunColor: '#ffab68', sunI: 2.6, hemiSky: '#8090b4', hemiGround: '#2a1d1a', hemiI: 1.0, fogNear: 30, fogFar: 170, stars: 0, glow: 1.4, exposure: 1.12, disc: 1, fill: [0.35, 0.45, 1], fillColor: '#9aa6d0', fillI: 0.7 },
  // 电影感：虚空（原版 Skyblock 那座孤零零的小岛：脚下什么都没有，只有星星和方形的月亮）
  cine_void: { top: '#050b1a', horizon: '#1a2640', bottom: '#020308', sun: [0.62, 0.5, 0.6], sunColor: '#c9d7f2', sunI: 2.0, hemiSky: '#7c8fb0', hemiGround: '#0d0e16', hemiI: 0.95, fogNear: 45, fogFar: 200, stars: 1, glow: 0.2, exposure: 1.5, disc: 0, fill: [-0.7, 0.3, 0.6], fillColor: '#8095bd', fillI: 0.55 },
  // 电影感：清晨顺光（结尾：太阳在镜头这一侧，暖色的天边，岛和人都看得清）
  cine_morning: { top: '#3d6cab', horizon: '#f0c290', bottom: '#5c5672', sun: [0.4, 0.32, 0.86], sunColor: '#ffd6a6', sunI: 2.6, hemiSky: '#c9d5ee', hemiGround: '#4c3e32', hemiI: 1.0, fogNear: 50, fogFar: 240, stars: 0, glow: 0.5, exposure: 1.08, disc: 1, fill: [-0.5, 0.4, -0.7], fillColor: '#a2b2d8', fillI: 0.45 },
  // 电影感：晴天正午（冷开场的一局起床战争，明快）
  cine_day: { top: '#2a6fd6', horizon: '#9ccaf2', bottom: '#6aa0dc', sun: [0.7, 0.65, -0.3], sunColor: '#fff3df', sunI: 2.8, hemiSky: '#cfe4ff', hemiGround: '#6b5a45', hemiI: 1.2, fogNear: 70, fogFar: 320, stars: 0, glow: 0.3, exposure: 1.0, disc: 1, fill: [-0.7, 0.4, 0.4], fillColor: '#d8e4f6', fillI: 0.4 },
};
export function mixPreset(a, b, k) {
  const A = typeof a === 'string' ? PRESETS[a] : a, B = typeof b === 'string' ? PRESETS[b] : b;
  const out = {};
  for (const key of Object.keys(A)) {
    const va = A[key], vb = B[key];
    if (vb === undefined) out[key] = va;
    else if (typeof va === 'number') out[key] = lerp(va, vb, k);
    else if (Array.isArray(va)) out[key] = va.map((v, i) => lerp(v, vb[i], k));
    else out[key] = '#' + C(va).lerp(C(vb), k).getHexString();
  }
  return out;
}

// ---------------------------------------------------------------- 天空
const SKY_VS = `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w; }`;
const SKY_FS = `
uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom; uniform vec3 sunDir; uniform vec3 sunColor; uniform float glow; uniform float disc; uniform float square;
varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = h > 0.0 ? mix(horizon, top, pow(clamp(h,0.0,1.0), 0.42)) : mix(horizon, bottom, pow(clamp(-h,0.0,1.0), 0.3));
  vec3 sd = normalize(sunDir);
  float s = max(dot(d, sd), 0.0);
  col += sunColor * (glow * (pow(s, 6.0) * 0.35 + pow(s, 48.0) * 0.6));
  if (square > 0.5) {
    // 方形的日 / 月（原版就是方的）
    vec3 t1 = normalize(cross(sd, vec3(0.0, 1.0, 0.0))), t2 = cross(t1, sd);
    float m = max(abs(dot(d, t1)), abs(dot(d, t2)));
    col += sunColor * disc * (1.0 - smoothstep(0.036, 0.038, m)) * step(0.0, dot(d, sd)) * 3.0;
  } else col += sunColor * disc * smoothstep(0.9975, 0.9988, s) * 4.0;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function makeStars(n = 1400, seed = 4) {
  const r = rng(seed), pos = [], size = [];
  for (let i = 0; i < n; i++) {
    const u = r() * 2 - 1, th = r() * Math.PI * 2, rad = Math.sqrt(1 - u * u);
    const y = Math.abs(u) * 0.95 + 0.05;
    pos.push(Math.cos(th) * rad * 380, y * 380, Math.sin(th) * rad * 380);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 1, fog: false, depthWrite: false });
  const p = new THREE.Points(g, m); p.renderOrder = -1;
  return p;
}

function makeClouds(seed = 1, y = 46, span = 220, cell = 9) {
  const r = rng(seed);
  const geo = new THREE.BoxGeometry(cell, 2.4, cell);
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.82, emissive: 0x444a55 });
  const cells = [];
  for (let x = -span; x < span; x += cell) for (let z = -span; z < span; z += cell) {
    const n = hash2(Math.floor(x / (cell * 3)) + seed, Math.floor(z / (cell * 2))) * 0.6 + hash2(x + 7, z + seed) * 0.4;
    if (n > 0.66) cells.push([x, z]);
  }
  const mesh = new THREE.InstancedMesh(geo, mat, cells.length);
  const M = new THREE.Matrix4();
  cells.forEach(([x, z], i) => { M.makeTranslation(x, y + (r() < 0.2 ? 1 : 0), z); mesh.setMatrixAt(i, M); });
  mesh.receiveShadow = false; mesh.castShadow = false;
  return mesh;
}

// 云海：浮岛下面几层缓慢漂移的雾（无缝平铺的柔边噪声贴图）
let _mistTex = null;
function mistTexture() {
  if (_mistTex) return _mistTex;
  const N = 256, c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d'), r = rng(808);
  for (let i = 0; i < 150; i++) {
    const x = r() * N, y = r() * N, rad = 14 + r() * 50, a = 0.05 + r() * 0.12;
    for (const dx of [-N, 0, N]) for (const dy of [-N, 0, N]) {
      const gr = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, rad);
      gr.addColorStop(0, `rgba(255,255,255,${a})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(x + dx - rad, y + dy - rad, rad * 2, rad * 2);
    }
  }
  _mistTex = new THREE.CanvasTexture(c);
  _mistTex.wrapS = _mistTex.wrapT = THREE.RepeatWrapping; _mistTex.colorSpace = THREE.SRGBColorSpace;
  return _mistTex;
}
export function mistLayer(o = {}) {
  const tex = mistTexture().clone(); tex.needsUpdate = true;
  tex.repeat.set(o.repeat || 5, o.repeat || 5);
  const size = o.size || 520;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: tex, color: o.color || '#ffffff', transparent: true, opacity: o.opacity ?? 0.8, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.set(o.x || 0, o.y ?? -10, o.z || 0);
  m.renderOrder = 1;
  const sp = o.speed ?? 0.003;
  return { mesh: m, update(t) { tex.offset.set(t * sp, t * sp * 0.6); } };
}

// ---------------------------------------------------------------- 舞台
export class Stage {
  constructor(o = {}) {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(o.fov || 36, W / H, 0.1, 900);
    this.skyU = { top: { value: C('#000') }, horizon: { value: C('#000') }, bottom: { value: C('#000') }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunColor: { value: C('#fff') }, glow: { value: 0 }, disc: { value: 1 }, square: { value: 0 } };
    const sky = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), new THREE.ShaderMaterial({ uniforms: this.skyU, vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, fog: false }));
    sky.renderOrder = -2; sky.frustumCulled = false;
    this.sky = sky; this.scene.add(sky);
    this.stars = makeStars(); this.scene.add(this.stars);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1); this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(o.shadowSize || 2048, o.shadowSize || 2048);
    this.sun.shadow.bias = -0.0004; this.sun.shadow.normalBias = 0.03; this.sun.shadow.radius = 3;
    this.scene.add(this.sun); this.scene.add(this.sun.target);
    // 补光：不投影，从镜头这一侧打过来（逆光场景里让人物不至于一片黑）
    this.fill = new THREE.DirectionalLight(0xffffff, 0); this.scene.add(this.fill); this.scene.add(this.fill.target);
    this.scene.fog = new THREE.Fog(0x000000, 50, 250);
    this.focus = new THREE.Vector3(...(o.focus || [0, 0, 0]));
    this.shadowSpan = o.shadowSpan || 30;
    if (o.clouds !== false) { this.clouds = makeClouds(o.cloudSeed || 1, o.cloudY || 46); this.scene.add(this.clouds); }
    this.setPreset(o.preset || 'day');
  }
  setPreset(p, t = 0) {
    const P = typeof p === 'string' ? PRESETS[p] : p;
    this.preset = P;
    this.skyU.top.value.set(P.top); this.skyU.horizon.value.set(P.horizon); this.skyU.bottom.value.set(P.bottom);
    const sd = new THREE.Vector3(...P.sun).normalize();
    this.skyU.sunDir.value.copy(sd); this.skyU.sunColor.value.set(P.sunColor); this.skyU.glow.value = P.glow; this.skyU.disc.value = P.disc;
    this.skyU.square.value = P.square ? 1 : 0;
    this.fill.intensity = P.fillI || 0;
    if (P.fill) { this.fill.color.set(P.fillColor || '#ffffff'); this.fill.position.copy(this.focus).addScaledVector(new THREE.Vector3(...P.fill).normalize(), 60); this.fill.target.position.copy(this.focus); }
    this.hemi.color.set(P.hemiSky); this.hemi.groundColor.set(P.hemiGround); this.hemi.intensity = P.hemiI;
    this.sun.color.set(P.sunColor); this.sun.intensity = P.sunI;
    this.scene.fog.color.set(P.horizon); this.scene.fog.near = P.fogNear; this.scene.fog.far = P.fogFar;
    this.stars.material.opacity = P.stars; this.stars.visible = P.stars > 0.01;
    this.exposure = P.exposure;
    this.placeSun();
    return this;
  }
  placeSun() {
    const sd = new THREE.Vector3(...this.preset.sun).normalize();
    // 平行光阴影框跟着关注点走
    this.sun.position.copy(this.focus).addScaledVector(sd, 80);
    this.sun.target.position.copy(this.focus);
    const s = this.shadowSpan, cam = this.sun.shadow.camera;
    cam.left = -s; cam.right = s; cam.top = s; cam.bottom = -s; cam.near = 1; cam.far = 200;
    cam.updateProjectionMatrix();
  }
  look(pos, target, fov) {
    this.camera.position.set(...pos);
    this.camera.lookAt(...target);
    if (fov && this.camera.fov !== fov) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
    return this;
  }
  tick(t) {
    if (this.clouds) this.clouds.position.x = (t * 1.2) % 27;
    this.sky.position.copy(this.camera.position);
    this.stars.position.copy(this.camera.position);
  }
  add(...objs) { for (const o of objs) this.scene.add(o.group || o.mesh || o); return this; }
}

// ---------------------------------------------------------------- 地形生成
// 漂浮岛：顶层草，下面两层泥土，再往下石头逐层收窄
export function island(vox, cx, cy, cz, r, seed, o = {}) {
  const depth = o.depth || Math.max(3, Math.round(r * 1.1));
  const top = o.top || 'grass', mid = o.mid || 'dirt', bot = o.bottom || 'stone';
  for (let dy = 0; dy >= -depth; dy--) {
    const k = -dy / (depth + 0.5);
    const rr = r * (1 - k * k * 0.85 - k * 0.15) + 0.4;
    for (let x = Math.floor(cx - r - 2); x <= Math.ceil(cx + r + 2); x++) for (let z = Math.floor(cz - r - 2); z <= Math.ceil(cz + r + 2); z++) {
      const dx = x + 0.5 - cx, dz = z + 0.5 - cz;
      const n = (hash3(x + seed, dy * 3, z) - 0.5) * (dy === 0 ? 0.9 : 1.6);
      if (Math.hypot(dx, dz) + n > rr) continue;
      vox.set(x, cy + dy, z, dy === 0 ? top : dy > -3 ? mid : bot);
    }
  }
  return vox;
}
export function tree(vox, x, y, z, seed = 1, h = 4) {
  const r = rng(seed);
  for (let i = 0; i < h; i++) vox.set(x, y + i, z, 'log');
  const ty = y + h;
  for (let dy = -2; dy <= 1; dy++) {
    const rad = dy >= 0 ? 1 : 2;
    for (let dx = -rad; dx <= rad; dx++) for (let dz = -rad; dz <= rad; dz++) {
      if (Math.abs(dx) === rad && Math.abs(dz) === rad && (r() < 0.6 || dy === 1)) continue;
      if (dx === 0 && dz === 0 && dy < 0) continue;
      vox.set(x + dx, ty + dy, z + dz, 'leaves');
    }
  }
  return vox;
}
// 顶面高度（找某一列最高的方块）
export function topY(vox, x, z, from = 30, to = -30) {
  for (let y = from; y >= to; y--) if (vox.get(x, y, z)) return y;
  return null;
}

// 花草：交叉面片
let _decoTex = null;
function decoTexture() {
  if (_decoTex) return _decoTex;
  const c = document.createElement('canvas'); c.width = 64; c.height = 16;
  const g = c.getContext('2d');
  const r = rng(5);
  const px = (x, y, col) => { g.fillStyle = col; g.fillRect(x, y, 1, 1); };
  // 0: 草丛
  for (let x = 1; x < 15; x++) { const h = 5 + Math.floor(r() * 9); for (let y = 15; y > 15 - h; y--) if (r() < 0.8) px(x, y, ['#4f8f36', '#5fa043', '#3f7a2c'][Math.floor(r() * 3)]); }
  // 1..3: 红、黄、蓝花
  [['#d8322c', '#ff6a5a'], ['#f2c62e', '#fff08a'], ['#4f6fe0', '#9ab0ff']].forEach(([a, b], i) => {
    const ox = 16 * (i + 1);
    for (let y = 8; y < 16; y++) px(ox + 7, y, '#3f7a2c');
    px(ox + 6, 11, '#4f8f36'); px(ox + 8, 12, '#4f8f36');
    for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1]]) px(ox + 7 + dx, 5 + dy, dx === 0 && dy === 0 ? b : a);
  });
  _decoTex = new THREE.CanvasTexture(c);
  _decoTex.magFilter = THREE.NearestFilter; _decoTex.minFilter = THREE.NearestFilter; _decoTex.colorSpace = THREE.SRGBColorSpace; _decoTex.flipY = false;
  return _decoTex;
}
// items: [[x, y, z, kind(0 草 / 1-3 花)], ...]，y 为方块顶面高度
export function decoMesh(items) {
  const pos = [], uv = [], nor = [], idx = [];
  for (const [x, y, z, kind] of items) {
    const u0 = kind / 4, u1 = (kind + 1) / 4, s = 0.42, hgt = 0.9;
    for (const a of [Math.PI / 4, -Math.PI / 4]) {
      const dx = Math.cos(a) * s, dz = Math.sin(a) * s, b = pos.length / 3;
      const cx = x + 0.5, cz = z + 0.5;
      pos.push(cx - dx, y, cz - dz, cx + dx, y, cz + dz, cx + dx, y + hgt, cz + dz, cx - dx, y + hgt, cz - dz);
      uv.push(u0, 1, u1, 1, u1, 0, u0, 0);
      for (let i = 0; i < 4; i++) nor.push(0, 1, 0);
      // 正反两面各一份、法线都朝上（双面材质会把背面法线翻成朝下，草会发黑）
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3, b, b + 2, b + 1, b, b + 3, b + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: decoTexture(), alphaTest: 0.5 }));
  m.receiveShadow = true;
  return m;
}
// 在岛的草地上随机撒花草（避开指定格子）
export function scatterDeco(vox, cx, cz, r, seed, density = 0.18, avoid = () => false) {
  const out = [], R = rng(seed);
  for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) {
    if (avoid(x, z) || R() > density) continue;
    const y = topY(vox, x, z, 20, -20);
    if (y === null || vox.get(x, y, z) !== 'grass' || vox.get(x, y + 1, z)) continue;
    out.push([x, y + 1, z, R() < 0.6 ? 0 : 1 + Math.floor(R() * 3)]);
  }
  return out;
}

export { Voxels, buildVoxelMesh, clamp };

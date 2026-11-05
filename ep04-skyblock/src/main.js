// 主循环：3D 舞台渲染 → 2D 合成（调色、叠加层、转场、宽银幕黑边、字幕）。
import { W, H, TL, prog } from './util.js';
import { buildAtlas } from './textures.js';
import { createRenderer } from './world.js';
import * as O from './overlay.js';
import { SCENES } from './scenes.js';

const cv = document.getElementById('c');
const g = cv.getContext('2d');
let renderer = null;
const BAR = 138;      // 2.39:1 宽银幕黑边（上下各 138px）
const DIP = 0.35;     // 黑场过渡的半宽
const DIS = 0.45;     // 叠化的半宽
const TW = 0.2;       // 甩镜的半宽
// 底片感：饱和度略降、反差略提；暗部抬一点偏青，亮部偏暖（见 tone）
const LOOK = 'saturate(0.86) contrast(1.1)';
const GRADE = { grain: 0.035, vignette: 0.42 };
// 饱和度守门：每帧先按本场的滤镜把 3D 画面缩成一小张，量两个数——
//   彩度：每个像素 max−min 的平均（大片晴天草地、黄昏会偏高，雾里的俯视会偏低）
//   亮部饱和度：按亮度加权的 HSV 饱和度（深蓝的虚空、夜景整片偏色时偏高）
// 彩度压回 [lo, hi]、亮部饱和度不超过 sMax，算出这一帧额外的 saturate() 倍数（限制在 kMin–kMax）。
// 只看这一帧本身，所以 renderAt(t) 仍是纯函数；画面是慢慢变的，倍数也跟着慢慢变，不会跳。
const SAT = { lo: 0.125, hi: 0.17, sMax: 0.56, kMin: 0.7, kMax: 1.45 };
const NO_SUB = new Set(['T01']);

const canvas2 = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
// 便宜的模糊：缩到 1/8 再放大
let small = null;
function blurred(src) {
  small = small || canvas2(W / 8, H / 8);
  const s = small.getContext('2d');
  s.imageSmoothingEnabled = true;
  s.drawImage(src, 0, 0, W / 8, H / 8);
  g.imageSmoothingEnabled = true;
  g.drawImage(small, 0, 0, W, H);
}
// 甩镜：同一帧沿水平方向错开叠几层，越靠近切点拖影越长
function smear(src, k, dir) {
  g.drawImage(src, 0, 0, W, H);
  const n = 6, amp = 140 * k * k * dir;
  g.globalAlpha = 0.24;
  for (let i = 1; i <= n; i++) g.drawImage(src, (i / n) * amp, 0, W, H);
  g.globalAlpha = 1;
}
// 分离色调：滤色一层深青（暗部被抬起、偏青），正片叠底一层暖白（亮部偏暖）
function tone(o = {}) {
  g.save();
  g.globalCompositeOperation = 'screen'; g.fillStyle = o.lift || '#0b151a'; g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'multiply'; g.fillStyle = o.gain || '#fff0e0'; g.fillRect(0, 0, W, H);
  g.restore();
}
// 柔光：只留亮部、糊开、染成暖色，再用“滤色”叠回去（胶片的高光溢出）
let glowC = null;
function glow(src, a, tint = '#ffcf9e') {
  if (a <= 0) return;
  glowC = glowC || canvas2(W / 4, H / 4);
  const s = glowC.getContext('2d');
  s.filter = 'brightness(0.85) contrast(3.2) blur(6px)';
  s.clearRect(0, 0, W / 4, H / 4);
  s.drawImage(src, 0, 0, W / 4, H / 4);
  s.filter = 'none';
  s.globalCompositeOperation = 'multiply'; s.fillStyle = tint; s.fillRect(0, 0, W / 4, H / 4);
  s.globalCompositeOperation = 'source-over';
  g.save(); g.globalCompositeOperation = 'screen'; g.globalAlpha = a; g.imageSmoothingEnabled = true;
  g.drawImage(glowC, 0, 0, W, H);
  g.restore();
}
let ovC = null, bufC = null;
let probe = null, lastSat = 1;
function satGuard(src, filter, band) {
  probe = probe || canvas2(64, 27);
  const p = probe.getContext('2d', { willReadFrequently: true });
  p.filter = filter || 'none'; p.clearRect(0, 0, 64, 27);
  const y0 = band ? BAR : 0;
  p.drawImage(src, 0, y0, W, H - 2 * y0, 0, 0, 64, 27);
  p.filter = 'none';
  const d = p.getImageData(0, 0, 64, 27).data;
  let c = 0, sw = 0, w = 0;
  for (let i = 0; i < d.length; i += 4) {
    const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
    c += mx - mn;
    if (mx > 0) { const v = mx / 255, wt = v * Math.sqrt(v); sw += wt * (mx - mn) / mx; w += wt; }
  }
  c /= (d.length / 4) * 255;
  const sat = w > 0 ? sw / w : 0;
  let k = Math.min(SAT.hi, Math.max(SAT.lo, c)) / Math.max(c, 1e-3);
  if (sat * k > SAT.sMax) k = SAT.sMax / Math.max(sat, 1e-3);
  return Math.min(SAT.kMax, Math.max(SAT.kMin, k));
}

const barsOf = (sc, t) => BAR * (sc && sc.bars ? sc.bars(t) : 1);

function drawSubtitle(t, bar, lift) {
  let cur = null;
  for (let i = 0; i < TL.lines.length; i++) {
    const ln = TL.lines[i], nx = TL.lines[i + 1];
    const until = Math.min(ln.end + 0.35, nx ? nx.start - 0.02 : ln.end + 0.6);
    if (t >= ln.start - 0.06 && t < until) { cur = { ln, until }; break; }
  }
  if (!cur || NO_SUB.has(cur.ln.id)) return;
  const a = Math.min(prog(t, cur.ln.start - 0.06, 0.12), 1 - prog(t, cur.until - 0.12, 0.12));
  O.subtitle(g, cur.ln.sub, a, lift, bar);
}

// 所有转场点：场景交界（默认黑场）+ 场景内切镜（默认硬切，不加效果）
function transitions() {
  const out = [];
  TL.scenes.forEach((s, i) => {
    const sc = SCENES[s.id];
    if (i > 0) out.push({ t: s.start, style: (sc && sc.trans) || 'dip', dir: i % 2 ? 1 : -1, a: i - 1, b: i });
    if (sc && sc.cuts) sc.cuts().forEach((c, j) => {
      const x = typeof c === 'number' ? { t: c } : c;
      out.push({ t: x.t, style: x.style || sc.cutStyle || 'cut', dir: (i + j) % 2 ? -1 : 1 });
    });
  });
  return out;
}
function transitionAt(t) {
  const r = { whip: 0, dir: 1, dip: 0, flash: 0, dissolve: null };
  for (const b of transitions()) {
    const d = Math.abs(t - b.t);
    if (b.style === 'dip') { if (d < DIP) r.dip = Math.max(r.dip, 1 - d / DIP); }
    else if (b.style === 'dissolve') { if (d < DIS && b.a !== undefined) r.dissolve = { a: b.a, b: b.b, k: (t - b.t + DIS) / (2 * DIS) }; }
    else if (b.style === 'whip' && d < TW) {
      const k = 1 - d / TW;
      if (k > r.whip) { r.whip = k; r.dir = b.dir; }
      r.flash = Math.max(r.flash, 1 - d / 0.07);
    }
  }
  return r;
}

// 画一个场景的完整画面（3D + 调色 + 叠加层），结果在 g 上
function compose(sc, s, t, whip = 0, dir = 1) {
  const stage = sc.frame(t, s);
  stage.tick(Math.max(0, t));
  renderer.toneMappingExposure = stage.exposure;
  // 有完整黑边时只光栅化中间那一条（软件渲染，能省下约四分之一的时间）
  const band = barsOf(sc, t) >= BAR - 0.5;
  renderer.setScissorTest(false);
  if (band) { renderer.clear(); renderer.setScissor(0, BAR, W, H - 2 * BAR); renderer.setScissorTest(true); }
  renderer.render(stage.scene, stage.camera);
  renderer.setScissorTest(false);
  const src = renderer.domElement;
  g.imageSmoothingEnabled = true;
  const f = `${sc.film === false ? '' : LOOK} ${(sc.look && sc.look(t)) || ''}`.trim();
  const ks = sc.film === false || sc.satGuard === false ? 1 : satGuard(src, f, band);
  g.filter = `${f} saturate(${ks.toFixed(3)})`.trim();
  lastSat = ks;
  if (sc.blur && sc.blur(t) > 0) blurred(src);
  else if (whip > 0.02) smear(src, whip, dir);
  else g.drawImage(src, 0, 0, W, H);
  g.filter = 'none';
  if (sc.tone !== false && sc.film !== false) tone(sc.tone);
  glow(src, sc.glow ?? 0.2, sc.glowTint);
  // 叠加层先画到离屏画布，转场时整体淡一点
  ovC = ovC || canvas2(W, H);
  const o = ovC.getContext('2d');
  o.setTransform(1, 0, 0, 1, 0, 0); o.globalAlpha = 1; o.filter = 'none'; o.clearRect(0, 0, W, H);
  o.save(); sc.overlay(o, t, s, stage); o.restore();
  g.globalAlpha = 1 - 0.85 * whip;
  g.drawImage(ovC, 0, 0);
  g.globalAlpha = 1;
  if (sc.post) sc.post(g, t, s);
}

export const satOf = () => lastSat;
export function renderAt(t) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.filter = 'none';
  // 封面：t = -1 是 16:9 版，t = -2 是 4:3 版（画在中间 1440 宽里，导出时再裁）
  if (t < 0) { compose(t <= -2 ? SCENES.__cover43 : SCENES.__cover, null, t); O.grade(g, 0, { grain: 0, vignette: GRADE.vignette }); return; }
  let i = TL.scenes.findIndex(s => t >= s.start && t < s.end);
  if (i < 0) i = TL.scenes.length - 1;
  const s = TL.scenes[i], sc = SCENES[s.id];
  const tr = transitionAt(t);
  if (tr.dissolve) {
    // 叠化：先画上一场，存起来；再画下一场，把上一场按比例盖回去
    const A = TL.scenes[tr.dissolve.a], B = TL.scenes[tr.dissolve.b];
    compose(SCENES[A.id], A, t);
    bufC = bufC || canvas2(W, H);
    bufC.getContext('2d').drawImage(cv, 0, 0);
    compose(SCENES[B.id], B, t);
    g.globalAlpha = 1 - tr.dissolve.k; g.drawImage(bufC, 0, 0); g.globalAlpha = 1;
  } else compose(sc, s, t, tr.whip, tr.dir);
  O.grade(g, t, GRADE);
  if (tr.flash > 0) { g.fillStyle = `rgba(255,255,255,${0.4 * tr.flash})`; g.fillRect(0, 0, W, H); }
  O.fadeBlack(g, tr.dip);
  // 宽银幕黑边 + 黑边里的小字
  const bar = barsOf(sc, t);
  if (bar > 0.5) { g.fillStyle = '#000'; g.fillRect(0, 0, W, bar); g.fillRect(0, H - bar, W, bar); }
  if (sc.label) { const lb = sc.label(t); if (lb) O.barLabels(g, bar, lb.a ?? 1, lb.left, lb.right); }
  drawSubtitle(t, bar, sc.subLift ? sc.subLift(t) : 0);
}

function collectCues() {
  const out = [];
  for (const s of TL.scenes) {
    const sc = SCENES[s.id];
    if (sc && sc.cues) for (const c of sc.cues(s)) out.push({ ...c, scene: s.id });
  }
  return out.sort((a, b) => a.t - b.t);
}

async function init() {
  await Promise.all([
    document.fonts.load('48px FP', '起床战争'),
    document.fonts.load('500 48px NotoSC', '起床战争'), document.fonts.load('700 48px NotoSC', '起床战争'), document.fonts.load('900 48px NotoSC', '起床战争'),
    document.fonts.load('600 48px NotoSerif', '起床战争'), document.fonts.load('900 48px NotoSerif', '起床战争'),
  ]);
  await document.fonts.ready;
  buildAtlas();
  renderer = createRenderer();
}

window.__ready = init();
window.renderAt = renderAt;
window.__sat = satOf;
window.collectCues = collectCues;

// ---------------------------------------------------------------- 浏览器预览（带声音）
if (!/[?&]render\b/.test(location.search)) {
  const audio = document.getElementById('audio');
  const btn = document.getElementById('play');
  const seek = document.getElementById('seek');
  const tlab = document.getElementById('time');
  let clock0 = null, offset = 0, playing = false, hasAudio = true;
  audio.addEventListener('error', () => { hasAudio = false; });
  const now = () => (hasAudio ? audio.currentTime : playing ? offset + (performance.now() - clock0) / 1000 : offset);
  const mmss = x => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
  btn.onclick = () => {
    playing = !playing;
    if (playing) { clock0 = performance.now(); if (hasAudio) audio.play().catch(() => { hasAudio = false; }); }
    else { offset = now(); if (hasAudio) audio.pause(); }
    btn.textContent = playing ? '❚❚ 暂停' : '▶ 播放';
  };
  seek.oninput = () => { const x = seek.value / 1000 * TL.duration; offset = x; clock0 = performance.now(); if (hasAudio) audio.currentTime = x; };
  window.__ready.then(() => {
    const loop = () => {
      const t = Math.min(now(), TL.duration - 0.001);
      renderAt(t);
      seek.value = Math.round(t / TL.duration * 1000);
      tlab.textContent = `${mmss(t)} / ${mmss(TL.duration)}`;
      requestAnimationFrame(loop);
    };
    loop();
  });
} else {
  document.body.classList.add('render');
}

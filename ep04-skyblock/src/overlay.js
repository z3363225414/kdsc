// 2D 叠加层设计系统：字体、卡片、标注、印章、字幕、调色。
import { W, H, clamp, lerp, prog, E, env, hash, rng } from './util.js';
import { spriteCanvas, tileCanvas } from './textures.js';

// 标题用宋体（思源宋体），正文用黑体（思源黑体），游戏界面用像素体
export const FONT = { title: 'NotoSerif', serif: 'NotoSerif', sans: 'NotoSC', pixel: 'FP' };
export const COL = {
  ink: '#0d0f14', paper: '#f6f1e6', gold: '#ffd24d', goldDeep: '#d99a1e', red: '#ef4b4b', blue: '#4b8df8',
  green: '#3fd28a', purple: '#a98bff', cyan: '#5fe8de', mute: '#aab1c3', white: '#ffffff',
  // 电影感配色：暖白正文、低饱和的旧金色强调
  bone: '#efeae0', dim: 'rgba(239,234,224,0.62)', brass: '#cfae74',
};

export function setFont(g, size, family = FONT.sans, weight = 700) {
  g.font = `${family === FONT.pixel ? '' : weight + ' '}${size}px ${family}`;
}
export function measure(g, str, size, family = FONT.sans, weight = 700) { setFont(g, size, family, weight); return g.measureText(str).width; }

// 通用文字：支持描边、阴影、发光、字距
export function txt(g, str, x, y, o = {}) {
  const size = o.size || 40;
  g.save();
  setFont(g, size, o.family || FONT.sans, o.weight || 700);
  g.textAlign = o.align || 'left';
  g.textBaseline = o.baseline || 'alphabetic';
  if (o.spacing) g.letterSpacing = o.spacing + 'px';
  if (o.blur > 0.05) g.filter = `blur(${o.blur.toFixed(2)}px)`;
  g.globalAlpha *= o.alpha ?? 1;
  if (o.glow) { g.shadowColor = o.glow; g.shadowBlur = o.glowBlur || 24; }
  else if (o.shadow !== false) { g.shadowColor = o.shadowColor || 'rgba(0,0,0,0.45)'; g.shadowBlur = o.shadowBlur ?? 12; g.shadowOffsetY = o.shadowY ?? 3; }
  if (o.stroke) { g.lineJoin = 'round'; g.lineWidth = o.strokeW || 6; g.strokeStyle = o.stroke; g.strokeText(str, x, y); g.shadowColor = 'transparent'; }
  g.fillStyle = o.color || '#fff';
  if (o.gradient) {
    const gr = g.createLinearGradient(0, y - size * 0.9, 0, y + size * 0.1);
    o.gradient.forEach((c, i) => gr.addColorStop(i / (o.gradient.length - 1), c));
    g.fillStyle = gr;
  }
  g.fillText(str, x, y);
  g.restore();
}

export function rrect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
// 深色毛玻璃面板
export function glass(g, x, y, w, h, o = {}) {
  g.save();
  g.globalAlpha *= o.alpha ?? 1;
  g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 30; g.shadowOffsetY = 10;
  rrect(g, x, y, w, h, o.r ?? 18);
  g.fillStyle = o.fill || 'rgba(14,16,24,0.72)';
  g.fill();
  g.shadowColor = 'transparent';
  const gr = g.createLinearGradient(0, y, 0, y + h);
  gr.addColorStop(0, 'rgba(255,255,255,0.10)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.02)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fill();
  g.lineWidth = 1.5; g.strokeStyle = o.border || 'rgba(255,255,255,0.14)'; g.stroke();
  if (o.accent) { g.save(); g.clip(); g.fillStyle = o.accent; g.fillRect(x, y, 6, h); g.restore(); }
  g.restore();
}
// 胶囊标签
export function chip(g, x, y, str, o = {}) {
  const size = o.size || 26, padX = size * 0.75, h = size * 1.75;
  const w = measure(g, str, size, FONT.sans, 700) + padX * 2 + (o.icon ? size * 1.3 : 0);
  const x0 = o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w : x;
  g.save();
  g.globalAlpha *= o.alpha ?? 1;
  rrect(g, x0, y - h / 2, w, h, h / 2);
  g.fillStyle = o.bg || 'rgba(14,16,24,0.78)'; g.fill();
  g.lineWidth = 1.5; g.strokeStyle = o.border || 'rgba(255,255,255,0.16)'; g.stroke();
  let tx = x0 + padX;
  if (o.icon) { pixelIcon(g, o.icon, tx + size * 0.45, y, size * 1.05); tx += size * 1.3; }
  txt(g, str, tx, y + size * 0.36, { size, color: o.color || '#fff', shadow: false });
  g.restore();
  return w;
}
// 像素图标：'sprite:形状:调色板' 或 'tile:贴图名'
export function pixelIcon(g, spec, cx, cy, size, alpha = 1) {
  const [kind, a, b] = spec.split(':');
  const c = kind === 'tile' ? tileCanvas(a) : spriteCanvas(a, b);
  g.save();
  g.globalAlpha *= alpha;
  g.imageSmoothingEnabled = false;
  g.drawImage(c, Math.round(cx - size / 2), Math.round(cy - size / 2), Math.round(size), Math.round(size));
  g.restore();
}

// 入场：带遮罩的上滑
export function reveal(g, t, t0, x, y, w, h, fn, o = {}) {
  const k = E.outQuart(prog(t, t0, o.dur || 0.55));
  const out = o.t1 !== undefined ? E.inCubic(prog(t, o.t1 - 0.35, 0.35)) : 0;
  if (k <= 0 || out >= 1) return;
  g.save();
  g.beginPath(); g.rect(x, y, w, h); g.clip();
  g.globalAlpha *= (1 - out);
  g.translate(0, (1 - k) * h * 0.6 + out * -20);
  fn();
  g.restore();
}

// 章节卡：左下角大年份 + 标题
export function chapter(g, t, t0, t1, o) {
  const a = env(t, t0, t1, 0.4, 0.5);
  if (a <= 0) return;
  const x = o.x ?? 110, y = o.y ?? 760;
  const k = E.outQuart(prog(t, t0, 0.8));
  g.save();
  g.globalAlpha = a;
  // 年份：描边空心大字
  txt(g, o.year, x - 8 + (1 - k) * -60, y - 70, { size: 230, family: FONT.title, color: 'rgba(255,210,77,0.0)', stroke: 'rgba(255,210,77,0.9)', strokeW: 3, shadow: false });
  // 标题条
  g.fillStyle = COL.gold; g.fillRect(x, y - 30, 70 * k, 6);
  txt(g, o.title, x, y + 50, { size: 72, weight: 900, color: '#fff', shadowBlur: 20, alpha: prog(t, t0 + 0.15, 0.4) });
  if (o.kicker) txt(g, o.kicker, x + 2, y + 104, { size: 30, weight: 500, color: COL.mute, alpha: prog(t, t0 + 0.3, 0.4), spacing: 2 });
  g.restore();
}

// 日期卡：小标题 + 像素体大日期
export function dateCard(g, t, t0, x, y, date, caption, o = {}) {
  const a = o.t1 !== undefined ? env(t, t0, o.t1, 0.3, 0.4) : clamp((t - t0) / 0.3);
  if (a <= 0) return;
  const k = E.outBack(prog(t, t0, 0.5));
  const align = o.align || 'left';
  g.save();
  g.globalAlpha = a;
  txt(g, caption, x, y - 78, { size: 28, weight: 700, color: o.accent || COL.gold, spacing: 4, align, shadow: false });
  g.translate(x, y); g.scale(0.85 + 0.15 * k, 0.85 + 0.15 * k); g.translate(-x, -y);
  txt(g, date, x, y, { size: o.size || 96, family: FONT.pixel, color: '#fff7dd', glow: 'rgba(255,200,80,0.55)', glowBlur: 30, align });
  const w = measure(g, date, o.size || 96, FONT.pixel);
  const lx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  g.fillStyle = o.accent || COL.gold; g.fillRect(lx, y + 22, w * E.outCubic(prog(t, t0 + 0.2, 0.6)), 4);
  g.restore();
}

// 指向 3D 物体的标注：锚点 + 折线 + 标签
export function callout(g, t, t0, ax, ay, str, o = {}) {
  const a = o.t1 !== undefined ? env(t, t0, o.t1, 0.25, 0.3) : clamp((t - t0) / 0.25);
  if (a <= 0) return;
  const dx = o.dx ?? 120, dy = o.dy ?? -110;
  const k = E.outCubic(prog(t, t0, 0.45));
  const ex = ax + dx * k, ey = ay + dy * k;
  g.save();
  g.globalAlpha = a;
  g.strokeStyle = o.color || '#fff'; g.lineWidth = 2.5;
  g.beginPath(); g.moveTo(ax, ay); g.lineTo(ex, ey); g.lineTo(ex + (dx >= 0 ? 30 : -30) * k, ey); g.stroke();
  g.fillStyle = o.color || '#fff';
  g.beginPath(); g.arc(ax, ay, 7, 0, Math.PI * 2); g.fill();
  g.globalAlpha = a * 0.35; g.beginPath(); g.arc(ax, ay, 7 + 10 * (0.5 + 0.5 * Math.sin(t * 5)), 0, Math.PI * 2); g.fill();
  g.globalAlpha = a;
  const size = o.size || 32;
  const w = measure(g, str, size) + 40 + (o.icon ? size * 1.4 : 0), h = size * 1.9;
  const lx = clamp(dx >= 0 ? ex + 30 * k : ex - 30 * k - w, 24, W - 24 - w);
  glass(g, lx, ey - h / 2, w, h, { r: 14, alpha: k, accent: o.color });
  let tx = lx + 22;
  if (o.icon) { pixelIcon(g, o.icon, tx + size * 0.5, ey, size * 1.1, k); tx += size * 1.4; }
  txt(g, str, tx, ey + size * 0.36, { size, color: '#fff', alpha: k, shadow: false });
  g.restore();
}

// 印章：描边圆角框 + 文字，砸下来时带轻微旋转
export function stamp(g, t, t0, x, y, str, o = {}) {
  if (t < t0) return;
  const k = E.outBack(prog(t, t0, 0.32));
  const a = o.t1 !== undefined ? env(t, t0, o.t1, 0.08, 0.3) : clamp((t - t0) / 0.08);
  const size = o.size || 56, col = o.color || COL.red;
  const w = measure(g, str, size, FONT.sans, 900) + size * 1.1, h = size * 1.7;
  g.save();
  g.globalAlpha = a;
  g.translate(x, y); g.rotate(o.rot ?? -0.06); g.scale(lerp(1.8, 1, k), lerp(1.8, 1, k));
  rrect(g, -w / 2, -h / 2, w, h, 14);
  g.fillStyle = o.fill || 'rgba(10,10,14,0.55)'; g.fill();
  g.lineWidth = 6; g.strokeStyle = col; g.stroke();
  rrect(g, -w / 2 + 9, -h / 2 + 9, w - 18, h - 18, 8); g.lineWidth = 2; g.stroke();
  txt(g, str, 0, size * 0.36, { size, weight: 900, color: col, align: 'center', shadow: false });
  g.restore();
}

// 居中大字（可带副标题）
export function statement(g, t, t0, t1, str, o = {}) {
  const a = env(t, t0, t1, 0.35, 0.35);
  if (a <= 0) return;
  const k = E.outQuart(prog(t, t0, 0.7));
  const size = o.size || 96;
  g.save();
  g.globalAlpha = a;
  txt(g, str, o.x ?? W / 2, (o.y ?? H / 2) + (1 - k) * 30, { size, family: o.family || FONT.sans, weight: o.weight || 900, color: o.color || '#fff', align: 'center', shadowBlur: 30, shadowColor: 'rgba(0,0,0,0.55)', gradient: o.gradient });
  if (o.sub) txt(g, o.sub, o.x ?? W / 2, (o.y ?? H / 2) + size * 0.75 + (1 - k) * 30, { size: o.subSize || 36, weight: 500, color: o.subColor || COL.mute, align: 'center', alpha: prog(t, t0 + 0.25, 0.4) });
  g.restore();
}

// 冲击大字：放大砸下来 + 落地抖一下（综艺字幕的那种）
export function punch(g, t, t0, t1, str, o = {}) {
  const a = Math.min(prog(t, t0, 0.08), 1 - prog(t, t1 - 0.25, 0.25));
  if (a <= 0) return;
  const k = E.outBack(prog(t, t0, 0.32));
  const land = t - t0 - 0.2, sh = land > 0 && land < 0.25 ? (1 - land / 0.25) * 9 : 0;
  const f = Math.floor(t * 60);
  const size = o.size || 150, x = (o.x ?? W / 2) + (hash(f) - 0.5) * sh, y = (o.y ?? H * 0.45) + (hash(f + 5) - 0.5) * sh;
  g.save();
  g.globalAlpha = a;
  g.translate(x, y); g.rotate(o.rot ?? -0.04); g.scale(lerp(1.9, 1, k), lerp(1.9, 1, k));
  txt(g, str, 0, size * 0.35, { size, family: o.family || FONT.title, align: 'center', stroke: o.stroke || '#1a0f00', strokeW: o.strokeW || size * 0.12,
    gradient: o.gradient || ['#fff7c2', '#ffd24d', '#ff9a1e'], shadowColor: 'rgba(0,0,0,0.6)', shadowBlur: 24, shadowY: 8 });
  if (o.sub) txt(g, o.sub, 0, size * 0.35 + 70, { size: 40, weight: 900, align: 'center', color: '#fff', stroke: 'rgba(0,0,0,0.85)', strokeW: 8, alpha: prog(t, t0 + 0.25, 0.3) });
  g.restore();
}

export const fmt = n => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// ---------------------------------------------------------------- 电影感排版
// 标题字：从模糊、字距松散慢慢收拢到清晰（不弹、不晃）
export function filmText(g, t, t0, t1, str, x, y, o = {}) {
  const fin = o.fin ?? 0.9, fout = o.fout ?? 0.5;
  const a = env(t, t0, t1, fin, fout);
  if (a <= 0) return;
  const k = E.outCubic(prog(t, t0, fin * 1.5));
  const sp = (o.spacing ?? 4) + (1 - k) * (o.spread ?? 16);
  const align = o.align || 'center';
  txt(g, str, x + (align === 'center' ? sp / 2 : 0), y + (1 - k) * (o.rise ?? 12), {
    size: o.size || 120, family: o.family || FONT.serif, weight: o.weight || 900, align, spacing: sp,
    color: o.color || COL.bone, alpha: a * (o.alpha ?? 1), blur: (1 - k) * (o.blurIn ?? 10),
    glow: o.glow, glowBlur: o.glowBlur, shadowColor: 'rgba(0,0,0,0.55)', shadowBlur: 28, shadowY: 0,
  });
}
// 字后面压一团柔和的暗影，复杂画面上也读得清
export function scrim(g, x, y, rx, ry, a) {
  if (a <= 0) return;
  g.save();
  g.translate(x, y); g.scale(1, ry / rx);
  const gr = g.createRadialGradient(0, 0, 0, 0, 0, rx);
  gr.addColorStop(0, `rgba(0,0,0,${0.5 * a})`); gr.addColorStop(0.6, `rgba(0,0,0,${0.28 * a})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(-rx, -rx, rx * 2, rx * 2);
  g.restore();
}
// 小号字距拉开的英文/提示字
export function kicker(g, str, x, y, a, o = {}) {
  if (a <= 0) return;
  const sp = o.spacing ?? 10;
  txt(g, str, x + ((o.align || 'center') === 'center' ? sp / 2 : 0), y, { size: o.size || 22, family: o.family || FONT.sans, weight: o.weight || 500, spacing: sp, align: o.align || 'center', color: o.color || COL.dim, alpha: a, shadow: false });
}
// 细线：从中间向两边画开
export function rule(g, x, y, w, k, a = 1, color = COL.dim) {
  if (k <= 0 || a <= 0) return;
  g.save(); g.globalAlpha *= a; g.fillStyle = color; g.fillRect(x - w / 2 * k, y, w * k, 1.5); g.restore();
}
// 宽银幕上黑边里的小字（左：栏目，右：提示）
export function barLabels(g, bar, a, left, right) {
  if (a <= 0 || bar < 60) return;
  const y = bar / 2 + 8;
  if (left) txt(g, left, 64, y, { size: 21, weight: 500, color: COL.dim, spacing: 4, shadow: false, alpha: a });
  if (right) txt(g, right, W - 64, y, { size: 21, weight: 500, color: COL.dim, spacing: 4, shadow: false, align: 'right', alpha: a });
}

// ---------------------------------------------------------------- 字幕
const SUB = { size: 46, max: 1560 };
export function wrapSub(g, str, size = SUB.size, max = SUB.max) {
  if (measure(g, str, size, FONT.sans, 500) <= max) return [str];
  const chars = [...str], n = chars.length, mid = n / 2;
  const fits = i => measure(g, chars.slice(0, i).join('').trim(), size, FONT.sans, 500) <= max && measure(g, chars.slice(i).join('').trim(), size, FONT.sans, 500) <= max && Math.min(i, n - i) >= n * 0.3;
  const P = '，。；：、！？）”';
  const kinds = [
    i => P.includes(chars[i - 1]) && !P.includes(chars[i]),
    i => chars[i - 1] === ' ' || chars[i] === ' ',
    i => !/[A-Za-z0-9.]/.test(chars[i - 1] + chars[i]) && !P.includes(chars[i]) && chars[i - 1] !== '“',
  ];
  for (const ok of kinds) {
    let best = -1;
    for (let i = 2; i < n - 1; i++) if (ok(i) && fits(i) && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
    if (best > 0) return [chars.slice(0, best).join('').trim(), chars.slice(best).join('').trim()];
  }
  return [chars.slice(0, Math.ceil(mid)).join(''), chars.slice(Math.ceil(mid)).join('')];
}
// bar：下黑边高度。有黑边时字幕放进黑边里（干净、不挡画面）；没有时压在画面底部
export function subtitle(g, str, alpha, lift = 0, bar = 0) {
  if (bar >= 100) {
    let size = 40, rows = wrapSub(g, str, size, 1720);
    if (rows.length > 1) { size = 34; rows = wrapSub(g, str, size, 1720); }
    const lh = size * 1.32, base = H - bar / 2 + size * 0.36 - (rows.length - 1) * lh / 2;
    rows.forEach((r, i) => txt(g, r, W / 2 + 0.5, base + i * lh, { size, weight: 500, color: COL.bone, align: 'center', spacing: 1, alpha, shadow: false }));
    return;
  }
  const rows = wrapSub(g, str);
  const lh = 64, base = H - 64 - lift - (rows.length - 1) * lh;
  g.save();
  // 底部渐暗，保证任何画面上都读得清
  const gr = g.createLinearGradient(0, H - 260, 0, H);
  gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, `rgba(0,0,0,${0.55 * alpha})`);
  g.fillStyle = gr; g.fillRect(0, H - 260, W, 260);
  rows.forEach((r, i) => txt(g, r, W / 2, base + i * lh, { size: SUB.size, weight: 700, color: '#ffffff', align: 'center', stroke: 'rgba(10,10,14,0.85)', strokeW: 7, alpha }));
  g.restore();
}

// ---------------------------------------------------------------- HUD 与调色
export function seriesBadge(g, alpha = 1) {
  g.save();
  g.globalAlpha = alpha;
  glass(g, 40, 36, 382, 56, { r: 28, fill: 'rgba(12,14,20,0.55)' });
  pixelIcon(g, 'tile:wool_red', 76, 64, 26);
  txt(g, '我的世界小游戏起源', 102, 74, { size: 26, weight: 700, color: '#fff', shadow: false });
  txt(g, 'EP01', 352, 74, { size: 26, family: FONT.pixel, color: COL.gold, shadow: false });
  g.restore();
}
export function yearBar(g, year, alpha = 1, span = [2011, 2021]) {
  const x0 = 1300, x1 = 1840, y = 64;
  g.save();
  g.globalAlpha = alpha;
  g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
  const xm = lerp(x0, x1, (clamp(year, span[0], span[1]) - span[0]) / (span[1] - span[0]));
  g.strokeStyle = COL.gold; g.lineWidth = 3; g.beginPath(); g.moveTo(x0, y); g.lineTo(xm, y); g.stroke();
  for (let yr = span[0]; yr <= span[1]; yr++) {
    const x = lerp(x0, x1, (yr - span[0]) / (span[1] - span[0]));
    g.fillStyle = yr <= year ? COL.gold : 'rgba(255,255,255,0.5)';
    g.fillRect(x - 1.5, y - 6, 3, 12);
  }
  g.fillStyle = COL.gold; g.shadowColor = 'rgba(255,200,80,0.8)'; g.shadowBlur = 16;
  g.beginPath(); g.arc(xm, y, 8, 0, Math.PI * 2); g.fill();
  g.shadowBlur = 0;
  txt(g, String(Math.round(year)), xm, y - 20, { size: 26, family: FONT.pixel, color: COL.gold, align: 'center', shadow: false });
  txt(g, String(span[0]), x0, y + 34, { size: 20, family: FONT.pixel, color: 'rgba(255,255,255,0.6)', align: 'center', shadow: false });
  txt(g, String(span[1]), x1, y + 34, { size: 20, family: FONT.pixel, color: 'rgba(255,255,255,0.6)', align: 'center', shadow: false });
  g.restore();
}
let _grain = null;
function grainCanvas() {
  if (_grain) return _grain;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'); const img = g.createImageData(256, 256);
  const r = rng(99);
  for (let i = 0; i < img.data.length; i += 4) { const v = r() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
  g.putImageData(img, 0, 0);
  return (_grain = c);
}
export function grade(g, t, o = {}) {
  // 暗角
  const vg = g.createRadialGradient(W / 2, H / 2, H * 0.42, W / 2, H / 2, H * 1.02);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, `rgba(0,0,0,${o.vignette ?? 0.42})`);
  g.fillStyle = vg; g.fillRect(0, 0, W, H);
  // 胶片颗粒
  g.save();
  g.globalAlpha = o.grain ?? 0.045;
  g.globalCompositeOperation = 'overlay';
  const f = Math.floor(t * 24);
  const ox = Math.floor(hash(f) * 256), oy = Math.floor(hash(f + 7) * 256);
  const pat = g.createPattern(grainCanvas(), 'repeat');
  g.translate(-ox, -oy); g.fillStyle = pat; g.fillRect(0, 0, W + 256, H + 256);
  g.restore();
}
export function fadeBlack(g, a) { if (a <= 0) return; g.fillStyle = `rgba(0,0,0,${clamp(a)})`; g.fillRect(0, 0, W, H); }

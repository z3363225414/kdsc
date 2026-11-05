// 场景共用的工具：镜头、摆放、出场、道具、叠加层小部件。
import * as THREE from 'three';
import { W, H, L, track, prog, clamp, lerp, E, env, hash } from './util.js';
import { makeGlow, makeBed } from './entities.js';
import { itemMesh } from './voxel.js';
import * as O from './overlay.js';

const memo = {};
export const once = (k, f) => memo[k] || (memo[k] = f());
export const peek = k => memo[k];
const _v = new THREE.Vector3();
export function project(st, x, y, z) { _v.set(x, y, z).project(st.camera); return [(_v.x + 1) / 2 * W, (1 - _v.y) / 2 * H]; }
export function shot(st, t, keys, ease) { const k = track(t, keys, ease); st.look([k[0], k[1], k[2]], [k[3], k[4], k[5]], k[6]); }
export function orbit(st, c, r, h, a, fov = 36) { st.look([c[0] + Math.sin(a) * r, c[1] + h, c[2] + Math.cos(a) * r], c, fov); }
export function at(obj, x, y, z, ry = 0) { const g = obj.group || obj; g.position.set(x, y, z); g.rotation.y = ry; return obj; }
export function scaleIn(obj, k, base = 1) { const g = obj.group || obj; g.scale.setScalar(Math.max(0.0001, k * base)); g.visible = k > 0.002; }
export function shake(st, t, t0, amp, dur) {
  const k = 1 - prog(t, t0, dur);
  if (t < t0 || k <= 0) return;
  const f = Math.floor(t * 60);
  st.camera.position.x += (hash(f) - 0.5) * amp * k;
  st.camera.position.y += (hash(f + 3) - 0.5) * amp * k;
}
export function walkPath(p, t, t0, t1, a, b, y = 1, speed = 10) {
  const k = clamp((t - t0) / (t1 - t0));
  p.group.position.set(lerp(a[0], b[0], k), y, lerp(a[1], b[1], k));
  p.group.rotation.y = Math.atan2(b[0] - a[0], b[1] - a[1]);
  p.pose({ walk: t * speed, walkAmt: k > 0 && k < 1 ? 1 : 0 });
  return k;
}
export function lamp(st, x, y, z, color = '#ffb070', i = 14, d = 11) {
  const l = new THREE.PointLight(color, i, d, 1.5); l.position.set(x, y, z); st.add(l);
  const gl = makeGlow(color, 3.2, 0.75); gl.position.set(x, y, z); st.add(gl);
  return l;
}
// 从方块上方循环弹出的物品
export function popper(st, shape, pal, x, y, z, n = 3, size = 0.42) {
  const items = Array.from({ length: n }, () => { const m = itemMesh(shape, pal, size); st.add(m); return m; });
  return {
    update(t, period = 1.4, on = true) {
      items.forEach((m, i) => {
        const ph = ((t + i * period / n) % period) / period;
        m.visible = on;
        m.position.set(x, y + 0.25 + ph * 1.3, z);
        m.rotation.y = t * 2.4 + i;
        m.scale.setScalar(size * Math.sin(ph * Math.PI) + 0.0001);
      });
    },
  };
}
// 场景内切镜：在切点前后各 0.22s 黑场过渡
export const cuts = (...ids) => () => ids.map(id => L(id).start - 0.08);
export function phase(t, list) { let cur = list[0][1]; for (const [t0, name] of list) if (t >= t0) cur = name; return cur; }
export function dim(g, a) { if (a > 0) { g.fillStyle = `rgba(4,6,12,${a})`; g.fillRect(0, 0, W, H); } }
// 亮天空上压一层顶部渐暗，让日期卡片和人名条看得清
export function topScrim(g, a, h = 560) {
  if (a <= 0) return;
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, `rgba(6,10,22,${0.62 * a})`); gr.addColorStop(1, 'rgba(6,10,22,0)');
  g.fillStyle = gr; g.fillRect(0, 0, W, h);
}
export function lowerThird(g, t, t0, t1, title, sub, o = {}) {
  const x = o.x ?? 110, y = o.y ?? 210;
  O.reveal(g, t, t0, x - 20, y - 70, 1200, 190, () => {
    g.fillStyle = o.color || O.COL.gold; g.fillRect(x, y - 52, 6, 112);
    O.txt(g, title, x + 26, y, { size: o.size || 56, weight: 900, color: '#fff', shadowBlur: 18 });
    if (sub) O.txt(g, sub, x + 28, y + 50, { size: 30, weight: 500, color: '#dfe4ef', shadowBlur: 12 });
  }, { t1 });
}
export function titleLockup(g, t, t0, t1, big, small, o = {}) {
  const a = env(t, t0, t1, 0.35, 0.4);
  if (a <= 0) return;
  const k = E.outQuart(prog(t, t0, 0.9));
  const y = o.y ?? 300;
  g.save();
  g.globalAlpha = a;
  g.translate(W / 2, y); g.scale(lerp(1.12, 1, k), lerp(1.12, 1, k)); g.translate(-W / 2, -y);
  O.txt(g, big, W / 2, y, { size: o.size || 220, family: O.FONT.title, align: 'center', gradient: ['#fff3c2', '#ffd24d', '#e8961c'], glow: 'rgba(255,170,40,0.55)', glowBlur: 40 });
  if (small) O.txt(g, small, W / 2, y + 78, { size: 34, weight: 700, color: '#fff6dc', align: 'center', spacing: 18, alpha: prog(t, t0 + 0.3, 0.4) });
  g.restore();
}


// ---------------------------------------------------------------- 电影感的信息卡
// 日期栏：左侧一条细竖线 + 小字（版本 / 出处）+ 宋体大日期 + 一句说明
export function dateline(g, t, t0, t1, o) {
  const a = env(t, t0, t1, 0.6, 0.5);
  if (a <= 0) return;
  const x = o.x ?? 150, y = o.y ?? 470, k = E.outCubic(prog(t, t0, 0.9));
  g.save();
  g.globalAlpha = a;
  // 左侧压暗，复杂画面上也读得清
  const gr = g.createLinearGradient(0, 0, 980, 0);
  gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.25)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 138, 980, H - 276);
  g.fillStyle = O.COL.brass; g.fillRect(x - 28, y - 120, 2, 190 * k);
  O.kicker(g, o.kicker || '', x, y - 92, 1, { align: 'left', size: 22, spacing: 6, color: O.COL.brass });
  O.filmText(g, t, t0 + 0.1, t1, o.date, x, y + 8, { align: 'left', size: o.size || 104, weight: 600, spacing: 4, spread: 10, fin: 0.8 });
  if (o.caption) O.filmText(g, t, t0 + 0.35, t1, o.caption, x + 2, y + 62, { align: 'left', size: 30, family: O.FONT.sans, weight: 500, spacing: 2, spread: 4, fin: 0.7, blurIn: 4, rise: 6 });
  g.restore();
}
// 指向画面里某一点的细标注：小圆环 + 斜线 + 横线，线上方是标签
export function pin(g, t, t0, t1, ax, ay, label, sub, o = {}) {
  const a = env(t, t0, t1, 0.4, 0.4);
  if (a <= 0) return;
  const k = E.inOutCubic(prog(t, t0, 0.7));
  const dx = o.dx ?? 140, dy = o.dy ?? -120, len = o.len ?? 220, dir = dx >= 0 ? 1 : -1;
  g.save();
  g.globalAlpha = a;
  g.strokeStyle = O.COL.bone; g.lineWidth = 1.5;
  g.beginPath(); g.arc(ax, ay, 6, 0, Math.PI * 2); g.stroke();
  const k1 = clamp(k * 2), k2 = clamp(k * 2 - 1);
  g.beginPath(); g.moveTo(ax + dx * 0.05, ay + dy * 0.05); g.lineTo(ax + dx * k1, ay + dy * k1);
  if (k2 > 0) g.lineTo(ax + dx + dir * len * k2, ay + dy);
  g.stroke();
  const lx = dir > 0 ? ax + dx + 4 : ax + dx - len - 4;
  O.filmText(g, t, t0 + 0.45, t1, label, lx, ay + dy - 14, { align: 'left', size: o.size || 38, weight: 600, spacing: 3, spread: 6, fin: 0.6, blurIn: 5, rise: 6 });
  if (sub) O.kicker(g, sub, lx, ay + dy + 30, prog(t, t0 + 0.7, 0.5) * (1 - prog(t, t1 - 0.4, 0.4)), { align: 'left', size: 18, spacing: 5 });
  g.restore();
}

// 引文卡：深色半透明底 + 细边 + 左侧强调色竖条；上面一行小字标签，下面宋体正文（按宽度自动换行）
export function quoteCard(g, t, t0, t1, x, y, w, label, text, o = {}) {
  const a = env(t, t0, t1, 0.5, 0.4);
  if (a <= 0) return;
  const k = E.outCubic(prog(t, t0, 0.7));
  const size = o.size || 44, lh = size * 1.45;
  O.setFont(g, size, O.FONT.serif, 600);
  const rows = [];
  let cur = '';
  for (const ch of [...text]) {
    if (cur && g.measureText(cur + ch).width > w - 90 && !'，。、？！）”'.includes(ch)) { rows.push(cur); cur = ch; } else cur += ch;
  }
  if (cur) rows.push(cur);
  const h = 84 + rows.length * lh;
  g.save();
  g.globalAlpha = a; g.translate(0, (1 - k) * 18);
  g.fillStyle = 'rgba(10,12,16,0.76)'; g.fillRect(x, y, w, h);
  g.strokeStyle = 'rgba(239,234,224,0.18)'; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  g.fillStyle = o.accent || O.COL.brass; g.fillRect(x, y, 3, h);
  O.kicker(g, label, x + 44, y + 46, 1, { align: 'left', size: 20, spacing: 5, color: o.accent || O.COL.brass });
  rows.forEach((r, i) => O.txt(g, r, x + 44, y + 64 + (i + 0.78) * lh, { size, family: O.FONT.serif, weight: 600, color: O.COL.bone, shadow: false }));
  if (o.note) O.kicker(g, o.note, x + w, y + h + 40, 1, { align: 'right', size: 20, spacing: 2, family: O.FONT.sans });
  g.restore();
}

// 横向切片错位（故障感）
export function glitch(g, t) {
  const f = Math.floor(t * 20);
  if (hash(f) < 0.45) return;
  const cv = g.canvas;
  for (let i = 0; i < 6; i++) {
    const y = Math.floor(hash(f * 7 + i) * H), h = 10 + Math.floor(hash(f * 13 + i) * 60), dx = (hash(f * 3 + i) - 0.5) * 80;
    g.drawImage(cv, 0, y, W, h, dx, y, W, h);
  }
  g.fillStyle = 'rgba(255,40,40,0.12)'; g.fillRect(0, 0, W, H);
}

// MC 风格的游戏界面（按原版布局重新绘制，不是截图）：
// 物品栏、血量、经验条、准星、记分板、聊天栏、标题、断线界面、死亡界面。
import { W, H, clamp, prog, E } from './util.js';
import { tileCanvas } from './textures.js';
import { pixelIcon, FONT } from './overlay.js';

const G = 3;                       // GUI 缩放：界面上的一个像素 = 3 个屏幕像素
const P = n => n * G;

// 文字阴影：原版是同色压暗到 1/4
function shade(c) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
  if (!m) return 'rgba(0,0,0,0.75)';
  const [r, gg, b] = [m[1], m[2], m[3]].map(h => Math.round(parseInt(h, 16) / 4));
  return `rgb(${r},${gg},${b})`;
}
// MC 文字：像素字体 + 右下阴影；str 可以是 [['文字', '#色'], ...] 分段着色
export function mcText(g, str, x, y, o = {}) {
  const size = o.size || 24;
  const parts = Array.isArray(str) ? str : [[str, o.color || '#ffffff']];
  g.save();
  g.font = `${size}px ${FONT.pixel}`;
  g.textBaseline = 'alphabetic';
  g.globalAlpha *= o.alpha ?? 1;
  const w = parts.reduce((s, [t]) => s + g.measureText(t).width, 0);
  let cx = o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w : x;
  const sh = Math.max(2, Math.round(size / 12));
  for (const [t, c] of parts) {
    if (o.shadow !== false) { g.fillStyle = shade(c); g.fillText(t, cx + sh, y + sh); }
    g.fillStyle = c; g.fillText(t, cx, y);
    cx += g.measureText(t).width;
  }
  g.restore();
  return w;
}

// 像素勾 / 叉（字体里没有这两个符号）
const MARK = {
  yes: ['......#', '.....##', '#...##.', '##.##..', '.###...', '..#....'],
  no: ['#....#', '##..##', '.####.', '..##..', '.####.', '##..##', '#....#'],
};
function mark(g, kind, x, y, color, s = G) {
  g.fillStyle = color;
  MARK[kind].forEach((row, j) => [...row].forEach((ch, i) => { if (ch === '#') g.fillRect(x + i * s, y + j * s, s, s); }));
}

// ---------------------------------------------------------------- 物品栏 + 血量 + 经验条
// slots: [{ icon: 'tile:wool_red' | 'sprite:sword:sword_iron', n }]，sel：选中格
export function hotbar(g, slots, sel = 0, o = {}) {
  const s = P(20), w = P(182), h = P(22);
  const x0 = Math.round((W - w) / 2), y0 = H - h - P(2);
  g.save();
  g.globalAlpha *= o.alpha ?? 1;
  g.fillStyle = 'rgba(16,16,16,0.62)'; g.fillRect(x0, y0, w, h);
  g.fillStyle = 'rgba(150,150,150,0.85)';
  g.fillRect(x0, y0, w, G); g.fillRect(x0, y0 + h - G, w, G);
  for (let i = 0; i <= 9; i++) g.fillRect(x0 + P(1) + i * s - (i === 9 ? G : 0), y0, G, h);
  slots.forEach((it, i) => {
    if (!it) return;
    const cx = x0 + P(1) + i * s + s / 2, cy = y0 + h / 2;
    pixelIcon(g, it.icon, cx, cy, P(16));
    if (it.n > 1) mcText(g, String(it.n), cx + P(9), cy + P(8), { size: 24, align: 'right' });
  });
  // 选中框
  const xs = x0 + sel * s - G;
  g.strokeStyle = '#f2f2f2'; g.lineWidth = P(1);
  g.strokeRect(xs + P(0.5), y0 - P(1) + P(0.5), P(24) - P(1), P(24) - P(1));
  // 经验条
  const xpY = y0 - P(7);
  g.fillStyle = 'rgba(0,0,0,0.75)'; g.fillRect(x0, xpY, w, P(5));
  g.fillStyle = '#80ff20'; g.fillRect(x0 + G, xpY + G, (w - 2 * G) * clamp(o.xp ?? 0.35), P(3));
  if (o.level) mcText(g, String(o.level), W / 2, xpY - G, { size: 24, color: '#80ff20', align: 'center' });
  // 血量（10 颗心）
  const hearts = o.hearts ?? 10, hy = xpY - P(11);
  for (let i = 0; i < 10; i++) {
    const hx = x0 + i * P(8) + P(4.5);
    pixelIcon(g, 'sprite:heart:heart_empty', hx, hy + P(4.5), P(11));
    const f = clamp(hearts - i);
    if (f > 0.75) pixelIcon(g, 'sprite:heart:heart', hx, hy + P(4.5), P(11));
    else if (f > 0.25) { g.save(); g.beginPath(); g.rect(hx - P(5.5), hy - P(1), P(5.5), P(12)); g.clip(); pixelIcon(g, 'sprite:heart:heart', hx, hy + P(4.5), P(11)); g.restore(); }
  }
  // 护甲
  if (o.armor) for (let i = 0; i < 10; i++) pixelIcon(g, 'sprite:chest:chest_iron', x0 + w - i * P(8) - P(4.5), hy + P(4.5), P(11), i < o.armor ? 1 : 0.25);
  g.restore();
}
// 物品栏顶部的 y（字幕要避开）
export const HUD_TOP = H - P(22) - P(2) - P(7) - P(11) - P(4);

// 准星
export function crosshair(g, alpha = 1) {
  g.save();
  g.globalAlpha *= alpha;
  g.fillStyle = 'rgba(0,0,0,0.45)';
  g.fillRect(W / 2 - P(4.5) - 1, H / 2 - G / 2 - 1, P(9) + 2, G + 2); g.fillRect(W / 2 - G / 2 - 1, H / 2 - P(4.5) - 1, G + 2, P(9) + 2);
  g.fillStyle = 'rgba(255,255,255,0.92)';
  g.fillRect(W / 2 - P(4.5), H / 2 - G / 2, P(9), G); g.fillRect(W / 2 - G / 2, H / 2 - P(4.5), G, P(9));
  g.restore();
}

// ---------------------------------------------------------------- 记分板（右侧）
// teams: [{ name: '红队', color: '#ff5555', state: 'yes' | 'no' | 数字 }]
export function scoreboard(g, title, teams, stats = [], o = {}) {
  const lh = 30, wBox = 300, n = teams.length + stats.length + 2;
  const hBox = n * lh + 16, x0 = W - wBox - 24, y0 = Math.round(H / 2 - hBox / 2) - 40;
  g.save();
  g.globalAlpha *= o.alpha ?? 1;
  g.fillStyle = 'rgba(0,0,0,0.42)'; g.fillRect(x0, y0, wBox, lh + 8);
  g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(x0, y0 + lh + 8, wBox, hBox - lh - 8);
  mcText(g, title, x0 + wBox / 2, y0 + lh - 2, { color: '#ffff55', align: 'center' });
  let y = y0 + lh * 2 + 10;
  teams.forEach(tm => {
    g.fillStyle = tm.color; g.fillRect(x0 + 12, y - 19, 18, 18);
    mcText(g, tm.name, x0 + 40, y, { color: '#ffffff' });
    if (tm.state === 'yes') mark(g, 'yes', x0 + wBox - 36, y - 18, '#55ff55');
    else if (tm.state === 'no') mark(g, 'no', x0 + wBox - 34, y - 20, '#ff5555');
    else mcText(g, String(tm.state), x0 + wBox - 14, y, { color: '#ffff55', align: 'right' });
    y += lh;
  });
  y += lh * 0.4;
  stats.forEach(([k, v]) => { mcText(g, [[k, '#ffffff'], [String(v), '#55ff55']], x0 + 12, y); y += lh; });
  g.restore();
}

// ---------------------------------------------------------------- 聊天栏（左下）
// msgs: [{ t, parts: [['文字','#色'], ...] }]，新消息从下往上顶
export function chat(g, t, msgs, o = {}) {
  const size = o.size || 24, lh = Math.round(size * 1.33), x0 = o.x ?? 12, base = o.bottom ?? 770;
  const shown = msgs.filter(m => t >= m.t && t < m.t + (m.life ?? 6));
  g.save();
  shown.slice().reverse().forEach((m, i) => {
    const a = Math.min(prog(t, m.t, 0.15), 1 - prog(t, m.t + (m.life ?? 6) - 0.6, 0.6));
    const y = base - i * lh;
    g.globalAlpha = a * (o.alpha ?? 1);
    g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(x0, y - lh + 4, o.width || 760, lh);
    mcText(g, m.parts, x0 + 8, y - Math.round(size / 6), { size });
  });
  g.restore();
}

// ---------------------------------------------------------------- 屏幕中央的大标题（/title）
export function title(g, t, t0, t1, main, sub, o = {}) {
  const a = Math.min(prog(t, t0, 0.12), 1 - prog(t, t1 - 0.4, 0.4));
  if (a <= 0) return;
  const k = E.outBack(prog(t, t0, 0.35));
  g.save();
  g.globalAlpha = a;
  g.translate(W / 2, H * 0.42); g.scale(0.7 + 0.3 * k, 0.7 + 0.3 * k);
  mcText(g, main, 0, 0, { size: o.size || 96, color: o.color || '#ff5555', align: 'center' });
  if (sub) mcText(g, sub, 0, 80, { size: 48, color: o.subColor || '#ffffff', align: 'center' });
  g.restore();
}

// ---------------------------------------------------------------- 原版风格按钮
export function button(g, x, y, w, label, o = {}) {
  const h = o.h || P(20);
  g.save();
  g.globalAlpha *= o.alpha ?? 1;
  g.fillStyle = '#000'; g.fillRect(x - w / 2 - G, y - h / 2 - G, w + 2 * G, h + 2 * G);
  const gr = g.createLinearGradient(0, y - h / 2, 0, y + h / 2);
  gr.addColorStop(0, o.hot ? '#8c9bd6' : '#8a8a8a'); gr.addColorStop(1, o.hot ? '#5b67a6' : '#5c5c5c');
  g.fillStyle = gr; g.fillRect(x - w / 2, y - h / 2, w, h);
  g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(x - w / 2, y - h / 2, w, G);
  g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(x - w / 2, y + h / 2 - G, w, G);
  mcText(g, label, x, y + (o.size || 24) * 0.42, { size: o.size || 24, color: o.hot ? '#ffffa0' : '#e0e0e0', align: 'center' });
  g.restore();
}

// 泥土背景（原版菜单底图，压暗）
function dirtBackdrop(g) {
  const tile = tileCanvas('dirt'), s = 64;
  g.save();
  g.imageSmoothingEnabled = false;
  for (let y = 0; y < H; y += s) for (let x = 0; x < W; x += s) g.drawImage(tile, x, y, s, s);
  g.fillStyle = 'rgba(0,0,0,0.72)'; g.fillRect(0, 0, W, H);
  g.restore();
}

// 多人游戏的服务器列表（示意）：entries = [{ icon, name, motd: [[文字, 色], ...], players, t }]
// 服务器名做了模糊处理（不指向任何具体的服务器），只看清 MOTD 里的玩法名
export function serverList(g, t, entries, o = {}) {
  dirtBackdrop(g);
  const w = P(305), h = P(36), x0 = Math.round((W - w) / 2), y0 = o.y ?? 210;
  mcText(g, '多人游戏', W / 2, y0 - 26, { size: 36, align: 'center' });
  entries.forEach((e, i) => {
    const a = prog(t, e.t, 0.35);
    if (a <= 0) return;
    const y = y0 + i * (h + P(4));
    g.save();
    g.globalAlpha *= a;
    if (e.hot) { g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 3; g.strokeRect(x0 - 3, y - 3, w + 6, h + 6); g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(x0 - 2, y - 2, w + 4, h + 4); }
    pixelIcon(g, e.icon, x0 + P(16), y + P(16), P(32));
    g.save(); g.filter = 'blur(7px)'; mcText(g, e.name, x0 + P(35), y + P(10), { size: 24, color: '#ffffff' }); g.restore();
    mcText(g, e.motd, x0 + P(35), y + P(21), { size: 24 });
    if (e.motd2) mcText(g, e.motd2, x0 + P(35), y + P(31), { size: 24 });
    mcText(g, e.players, x0 + w - P(14), y + P(10), { size: 24, color: '#aaaaaa', align: 'right' });
    // 信号格
    for (let b = 0; b < 5; b++) { g.fillStyle = '#55ff55'; g.fillRect(x0 + w - P(10) + b * P(2), y + P(9) - (b + 1) * P(1.4), P(1.2), (b + 1) * P(1.4)); }
    g.restore();
  });
}

// 断线界面：“连接已断开”
export function disconnect(g, t, t0, reason = '服务器已关闭') {
  if (t < t0) return;
  dirtBackdrop(g);
  mcText(g, '连接已断开', W / 2, H / 2 - 120, { size: 72, color: '#aaaaaa', align: 'center' });
  mcText(g, reason, W / 2, H / 2 - 10, { size: 48, color: '#ffffff', align: 'center', alpha: prog(t, t0 + 0.25, 0.2) });
  button(g, W / 2, H / 2 + 130, 800, '返回服务器列表', { h: 84, size: 36, hot: (t - t0) % 1.2 > 0.6, alpha: prog(t, t0 + 0.45, 0.2) });
}

// 死亡界面
export function death(g, t, t0, o = {}) {
  if (t < t0) return;
  const a = prog(t, t0, 0.5);
  g.save();
  g.globalAlpha = a;
  const gr = g.createLinearGradient(0, 0, 0, H);
  gr.addColorStop(0, 'rgba(80,0,0,0.55)'); gr.addColorStop(1, 'rgba(160,30,30,0.7)');
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
  mcText(g, '你死了！', W / 2, H / 2 - 120, { size: 96, color: '#ffffff', align: 'center' });
  mcText(g, [['分数：', '#ffffff'], ['0', '#ffff55']], W / 2, H / 2 - 30, { size: 36, align: 'center' });
  button(g, W / 2, H / 2 + 70, P(200), '重生', { hot: o.hot });
  button(g, W / 2, H / 2 + 150, P(200), '标题画面');
  g.restore();
}

// 时间与数学工具。所有画面都由时间 t 决定：同一个 t 永远画出同一帧。

export const W = 1920, H = 1080;

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const prog = (t, start, dur) => clamp((t - start) / dur);
export const smooth = t => t * t * (3 - 2 * t);
export const E = {
  lin: t => t,
  inCubic: t => t * t * t,
  outCubic: t => 1 - Math.pow(1 - t, 3),
  outQuart: t => 1 - Math.pow(1 - t, 4),
  outQuint: t => 1 - Math.pow(1 - t, 5),
  inOutCubic: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  inOutSine: t => -(Math.cos(Math.PI * t) - 1) / 2,
  inOutQuart: t => (t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2),
  outBack: t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  outBounce: t => {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
};
// 淡入-停留-淡出
export const env = (t, a, b, fin = 0.3, fout = 0.3) => Math.min(prog(t, a, fin), 1 - prog(t, b - fout, fout));

export function hash(i) {
  let n = (i | 0) ^ 0x9e3779b9;
  n = Math.imul(n ^ (n >>> 16), 0x85ebca6b);
  n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
export const hash2 = (a, b) => hash(a * 7919 + b * 104729 + 13);
export const hash3 = (a, b, c) => hash(a * 7919 + b * 104729 + c * 1299709 + 7);
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 关键帧插值：keys = [[t, value], ...]，value 可以是数字或数组
export function track(t, keys, ease = E.inOutCubic) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, a] = keys[i], [t1, b] = keys[i + 1];
    if (t < t1) {
      const k = ease((t - t0) / (t1 - t0));
      return Array.isArray(a) ? a.map((v, j) => lerp(v, b[j], k)) : lerp(a, b, k);
    }
  }
  return keys[keys.length - 1][1];
}

// ---------------------------------------------------------------- 旁白时间轴
export const TL = window.TIMELINE;
const LINE = Object.fromEntries(TL.lines.map(l => [l.id, l]));
export const SCENE = Object.fromEntries(TL.scenes.map(s => [s.id, s]));
export const L = id => LINE[id];
// 估算某个词在这句旁白里被读到的时间（按字数比例）
export function wordTime(id, word) {
  const ln = LINE[id];
  const idx = ln.sub.indexOf(word);
  // 有逐字时间（tools/tts.py 用语音识别对齐的）就用真实时间：这个词第一个汉字是这句里的第几个汉字
  const isHan = c => c >= '\u4e00' && c <= '\u9fff';
  if (ln.ht && idx >= 0 && isHan(word[0])) {
    const k = [...ln.sub.slice(0, idx)].filter(isHan).length;
    if (k < ln.ht.length) return ln.start + ln.ht[k];
  }
  const before = idx < 0 ? 0 : [...ln.sub.slice(0, idx)].length;
  return ln.start + (ln.end - ln.start) * (before / [...ln.sub].length);
}

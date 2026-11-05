#!/usr/bin/env python3
"""合成原创配乐与音效，并和旁白混成成片音轨。

用法：python tools/audio.py ep01-bedwars
输入：data/narration.wav、data/timeline.json、data/cues.json（render.mjs cues 导出）
输出：data/mix.wav、assets/audio/mix.m4a（EBU R128 响度标准化到 -15 LUFS，用于成片）、mix.mp3（网页预览）

所有声音都由代码合成（正弦/锯齿/噪声 + 简易混响），不含任何采样素材。
配乐由 script.json 的 "music" 选：
  cheer  轻快配乐（尤克里里、贝斯、马林巴、钟琴、轻打击），一条不断的 110 BPM 节拍，场景 cues 里的 score 提示点决定每段的编配；
  cine   电影感配乐（钢琴、铺底、低频冲击），同样由 score 提示点驱动。
（CINE 之外的场景用芯片风 BGM，现在所有场景都在 CINE 里。）
"""
import json
import os
import subprocess
import sys

import numpy as np
import soundfile as sf
from scipy.signal import butter, lfilter, oaconvolve, sosfilt

SR = 48000
BPM = 112
BEAT = 60 / BPM
BAR = 4 * BEAT
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RNG = np.random.default_rng(7)


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def tvec(n):
    return np.arange(n) / SR


def wave(kind, f, n, duty=0.5):
    ph = (f * tvec(n)) % 1.0
    if kind == 'square':
        return np.where(ph < duty, 1.0, -1.0)
    if kind == 'tri':
        return 4 * np.abs(ph - 0.5) - 1
    if kind == 'saw':
        return 2 * ph - 1
    return np.sin(2 * np.pi * ph)


def env(n, a=0.004, d=0.08, s=0.6, r=0.05):
    e = np.full(n, s)
    na, nd, nr = int(a * SR), int(d * SR), int(r * SR)
    na = min(na, n)
    e[:na] = np.linspace(0, 1, na, endpoint=False)
    nd = min(nd, n - na)
    e[na:na + nd] = np.linspace(1, s, nd, endpoint=False)
    nr = min(nr, n)
    e[n - nr:] *= np.linspace(1, 0, nr)
    return e


def lp(x, fc, order=2):
    return sosfilt(butter(order, fc, 'low', fs=SR, output='sos'), x)


def hp(x, fc, order=2):
    return sosfilt(butter(order, fc, 'high', fs=SR, output='sos'), x)


def bp(x, lo, hi, order=2):
    return sosfilt(butter(order, [lo, hi], 'band', fs=SR, output='sos'), x)


def noise(n):
    return RNG.uniform(-1, 1, n)


def add(buf, t0, x, gain=1.0, pan=0.0):
    i = int(round(t0 * SR))
    if i >= buf.shape[1] or i + len(x) <= 0:
        return
    j0 = max(0, -i)
    x = x[j0:]
    i = max(0, i)
    n = min(len(x), buf.shape[1] - i)
    l, r = np.sqrt(0.5 * (1 - pan)), np.sqrt(0.5 * (1 + pan))
    buf[0, i:i + n] += x[:n] * gain * l
    buf[1, i:i + n] += x[:n] * gain * r


# ---------------------------------------------------------------- 鼓
def kick():
    n = int(0.32 * SR)
    t = tvec(n)
    f = 48 + 130 * np.exp(-t * 32)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9)


def snare():
    n = int(0.2 * SR)
    t = tvec(n)
    return 0.7 * bp(noise(n), 900, 6000) * np.exp(-t * 22) + 0.4 * np.sin(2 * np.pi * 190 * t) * np.exp(-t * 30)


def hat():
    n = int(0.05 * SR)
    return hp(noise(n), 7000) * np.exp(-tvec(n) * 70)


def crash():
    n = int(1.4 * SR)
    return hp(noise(n), 4000) * np.exp(-tvec(n) * 3.2)


DRUM = {'kick': kick(), 'snare': snare(), 'hat': hat(), 'crash': crash()}

# ---------------------------------------------------------------- 和声
CH = {
    'Am': (45, [57, 60, 64]), 'F': (41, [53, 57, 60]), 'C': (48, [55, 60, 64]), 'G': (43, [55, 59, 62]),
    'Em': (40, [52, 55, 59]), 'Fmaj7': (41, [53, 57, 60, 64]), 'Em7': (40, [55, 59, 62]),
    'Dm7': (38, [57, 60, 65]), 'Cmaj7': (48, [55, 59, 64]),
}
PROG = {
    'main': ['Am', 'F', 'C', 'G'], 'calm': ['Fmaj7', 'Em7', 'Dm7', 'Cmaj7'], 'title': ['Am', 'F', 'G', 'Am'],
    'epic': ['F', 'G', 'Em', 'Am'], 'china': ['Am', 'C', 'G', 'Am'],
}
PENTA = [69, 72, 74, 76, 79, 81]
STYLE = {
    'cold': ('main', 'full', 16), 'title': ('title', 'fill', 8), 'bed': ('calm', 'none', 8),
    'rush': ('main', 'light', 8), 'europe': ('calm', 'light', 8), 'germany': ('main', 'mid', 16),
    'eggwars': ('main', 'light', 8), 'yc': ('china', 'light', 8), 'hypixel': ('epic', 'full', 16),
    'china': ('calm', 'light', 8), 'peak': ('epic', 'full', 16), 'ending': ('calm', 'none', 8),
}
# 场景的 cues 里可以放 music_off / music_on：那段时间音乐静音（比如断线那一下）
# score / tapestop 是电影配乐的提示点，也不当音效播放
MUSIC_CTRL = ('music_off', 'music_on', 'score', 'tapestop')
# 用电影感配乐的场景
CINE = {'cold', 'title', 'bed', 'rush', 'europe', 'germany', 'eggwars', 'yc', 'hypixel', 'china', 'peak', 'ending'}


def chip(sid):
    """这个场景用不用芯片风 BGM：只有 STYLE 里有、又不在 CINE 里的场景才用（EP02 的新场景都不用）。"""
    return sid in STYLE and sid not in CINE


def scene_at(tl, t):
    for s in tl['scenes']:
        if s['start'] <= t < s['end']:
            return s['id']
    return tl['scenes'][-1]['id']


def bgm(tl, n):
    buf = np.zeros((2, n))
    nbars = int(np.ceil(tl['duration'] / BAR)) + 1
    music_start = 0.0
    last_scene = None
    for k in range(nbars):
        tb = k * BAR
        if tb + BAR < music_start:
            continue
        sid = scene_at(tl, tb + 0.05)
        if not chip(sid) or not chip(scene_at(tl, tb + BAR - 0.05)):
            last_scene = None
            continue
        prog, drums, arp_div = STYLE[sid]
        chord = PROG[prog][k % 4]
        root, tones = CH[chord]
        new_scene = sid != last_scene
        last_scene = sid
        # 低音（三角波）
        steps = 8 if drums in ('full', 'mid') else 2
        for i in range(steps):
            t0 = tb + i * BAR / steps
            if t0 < music_start:
                continue
            m = root + (12 if (steps == 8 and i % 4 == 2) else 0)
            d = BAR / steps * 0.85
            x = wave('tri', hz(m), int(d * SR)) * env(int(d * SR), 0.003, 0.05, 0.7, 0.03)
            add(buf, t0, x, 0.32)
        # 琶音（窄方波）
        pool = PENTA if prog == 'china' else sorted(set(tones + [x + 12 for x in tones]))
        for i in range(arp_div):
            t0 = tb + i * BAR / arp_div
            if t0 < music_start:
                continue
            seq = [0, 1, 2, 3, 2, 1, 0, 2] if prog != 'china' else [0, 2, 3, 4, 3, 2, 1, 0]
            m = pool[seq[i % 8] % len(pool)] + (0 if prog == 'china' else 12)
            d = BAR / arp_div * 0.7
            x = wave('square', hz(m), int(d * SR), duty=0.125) * env(int(d * SR), 0.002, 0.04, 0.35, 0.02)
            add(buf, t0, lp(x, 5000, 1), 0.06, pan=(-0.35 if i % 2 else 0.35))
        # 铺底（滤波锯齿波和弦）
        d = BAR
        for m in tones:
            x = wave('saw', hz(m), int(d * SR)) + 0.6 * wave('saw', hz(m) * 1.004, int(d * SR))
            x = lp(x, 1400, 2) * env(int(d * SR), 0.25, 0.3, 0.8, 0.35)
            add(buf, tb, x, 0.035)
        # 鼓
        if new_scene and drums in ('full', 'fill', 'mid') and tb >= music_start:
            add(buf, tb, DRUM['crash'], 0.18)
        for b in range(4):
            tt = tb + b * BEAT
            if tt < music_start:
                continue
            if drums == 'full':
                if b in (0, 2):
                    add(buf, tt, DRUM['kick'], 0.55)
                if b == 2:
                    add(buf, tt + BEAT / 2, DRUM['kick'], 0.35)
                if b in (1, 3):
                    add(buf, tt, DRUM['snare'], 0.28)
                for h in (0, 0.5):
                    add(buf, tt + h * BEAT, DRUM['hat'], 0.10 if h else 0.06, pan=0.2)
            elif drums == 'mid':
                if b in (0, 2):
                    add(buf, tt, DRUM['kick'], 0.45)
                if b in (1, 3):
                    add(buf, tt, DRUM['snare'], 0.16)
                add(buf, tt + BEAT / 2, DRUM['hat'], 0.08, pan=0.2)
            elif drums == 'light':
                if b == 0:
                    add(buf, tt, DRUM['kick'], 0.35)
                add(buf, tt + BEAT / 2, DRUM['hat'], 0.06, pan=0.2)
            elif drums == 'fill':
                add(buf, tt, DRUM['kick'], 0.45)
                add(buf, tt + BEAT / 2, DRUM['hat'], 0.08)
    # 片尾：最后一个和弦拉长收住
    tend = tl['duration'] - 2.4
    if chip(scene_at(tl, tend)):
        for m in [45, 57, 60, 64, 69]:
            d = 2.4
            x = (wave('square', hz(m), int(d * SR), 0.25) * 0.4 + wave('tri', hz(m), int(d * SR))) * env(int(d * SR), 0.01, 0.4, 0.5, 1.5)
            add(buf, tend, lp(x, 3000), 0.05)
    return buf


# ---------------------------------------------------------------- 电影感配乐
def fade(n, a, r):
    e = np.ones(n)
    na, nr = min(n, int(a * SR)), min(n, int(r * SR))
    if na:
        e[:na] = np.linspace(0, 1, na) ** 2
    if nr:
        e[n - nr:] *= np.linspace(1, 0, nr) ** 2
    return e


def reverb(x, rt=2.8, wet=0.32, seed=3, pre=0.015):
    """简易混响：左右声道各一条指数衰减的噪声做脉冲响应，分块 FFT 卷积。x: (2, n)"""
    r = np.random.default_rng(seed)
    n_ir = int(rt * SR)
    t = tvec(n_ir)
    out = np.empty_like(x)
    for ch in range(2):
        ir = lp(r.uniform(-1, 1, n_ir), 5200) * np.exp(-6.9 * t / rt)
        ir[:int(pre * SR)] = 0
        ir /= np.sqrt(np.sum(ir ** 2))
        out[ch] = oaconvolve(x[ch], ir)[:x.shape[1]]
    return x * (1 - wet) + out * wet


def piano(m, dur=3.0, vel=0.6):
    """加法合成的钢琴音：带一点非谐性的泛音、高次泛音衰减更快、两根弦轻微失谐、琴槌噪声。"""
    f0, n = hz(m), int(dur * SR)
    t = tvec(n)
    x = np.zeros(n)
    for k in range(1, 12):
        fk = k * f0 * np.sqrt(1 + 0.0004 * k * k)
        if fk > 11000:
            break
        x += (1 / k ** 1.3) * np.sin(2 * np.pi * fk * t + k) * np.exp(-t * (0.9 + 0.75 * k * (f0 / 440) ** 0.5))
    x *= 1 + 0.12 * np.sin(2 * np.pi * 0.8 * t)
    nh = int(0.02 * SR)
    x[:nh] += bp(noise(nh), 700, 3500) * np.exp(-tvec(nh) * 220) * 0.2
    return x * fade(n, 0.003, 0.15) * vel * 0.32


def pad(ms, dur, cutoff=1000, attack=1.5, release=1.5, detune=0.006):
    """铺底：每个音三根轻微失谐的锯齿波，低通后慢慢起、慢慢收。"""
    n = int(dur * SR)
    x = np.zeros(n)
    for m in ms:
        for d in (-detune, 0, detune):
            x += wave('saw', hz(m) * (1 + d), n)
    return lp(x, cutoff, 2) / (len(ms) * 3) * fade(n, attack, release)


def pluck(m, dur, cutoff=900):
    n = int(dur * SR)
    x = wave('saw', hz(m), n) + 0.5 * wave('saw', hz(m) * 1.003, n)
    return lp(x, cutoff, 2) * env(n, 0.003, 0.12, 0.25, 0.03)


def drone(m, dur, attack=1.5, release=1.0):
    n = int(dur * SR)
    return (np.sin(2 * np.pi * hz(m) * tvec(n)) * 0.6 + lp(wave('saw', hz(m + 12), n), 260) * 0.4) * fade(n, attack, release)


def wind(dur):
    n = int(dur * SR)
    t = tvec(n)
    mod = 0.55 + 0.45 * np.sin(2 * np.pi * 0.09 * t + 1.3) * np.sin(2 * np.pi * 0.23 * t)
    return lp(noise(n), 420, 2) * mod * fade(n, 1.0, 0.3) * 0.5


def shimmer(dur):
    n = int(dur * SR)
    t = tvec(n)
    x = sum(np.sin(2 * np.pi * hz(m) * t) * (0.6 + 0.4 * np.sin(2 * np.pi * (0.3 + 0.07 * i) * t + i)) for i, m in enumerate([81, 88, 93]))
    return x / 3 * fade(n, 0.8, 1.5)


def tape_stop(buf, t0, dur):
    """磁带停转：这段音频越放越慢，音高一路往下掉。"""
    a, n = int(t0 * SR), int(dur * SR)
    tau = np.arange(n) / SR
    pos = a + (tau - tau ** 2 / (2 * dur)) * SR
    for ch in range(buf.shape[0]):
        buf[ch, a:a + n] = np.interp(pos, np.arange(buf.shape[1]), buf[ch]) * np.linspace(1, 0.3, n)


def cue_t(cues, sfx, name=None):
    for c in cues:
        if c['sfx'] == sfx and (name is None or c.get('name') == name):
            return c['t']
    return None


# 每种情绪一个函数：在 buf 的 t0 处写入一段 d 秒的音乐（尾音可以拖过 d）
def m_lobby(buf, t0, d):
    # 深夜的广场：低音持续音、A 小调铺底、稀疏下行的钢琴、风声
    add(buf, t0, drone(33, d, 2.0, 0.3), 0.45)
    add(buf, t0, pad([57, 64, 71, 72], d, 900, 2.0, 0.3), 0.5, pan=-0.25)
    add(buf, t0, pad([45, 52, 60], d, 600, 2.5, 0.3), 0.45, pan=0.25)
    for m, dt in [(76, 0.7), (72, 1.6), (69, 2.4), (71, 3.3), (64, 4.2)]:
        add(buf, t0 + dt, piano(m, 3.2, 0.6), 1.0, pan=0.2)
    add(buf, t0, wind(d), 0.5)


def m_run(buf, t0, d):
    # 冲桥：100 BPM 的八分音符低音脉冲，越来越亮；心跳一样的底鼓；渐强的铺底
    step, k = 60 / 100 / 2, 0
    while k * step < d:
        tt = k * step
        m = [45, 45, 45, 48, 45, 45, 43, 45][k % 8]
        add(buf, t0 + tt, pluck(m, step * 0.9, 300 + 1700 * tt / d), 0.32 + 0.3 * tt / d, pan=0.25 if k % 2 else -0.25)
        if k % 2 == 0:
            add(buf, t0 + tt, lp(DRUM['kick'], 900), 0.5 + 0.2 * tt / d)
        k += 1
    add(buf, t0, pad([57, 60, 64], d, 700, 0.8, 0.1) * np.linspace(0.4, 1.2, int(d * SR)), 0.5)


def m_after(buf, t0, d):
    # 床碎之后：大和弦长长地铺开，高音钢琴一个一个落下来（慢动作 + 定格）
    d += 0.4
    add(buf, t0, pad([53, 57, 60, 64, 69], d, 1500, 0.3, 1.2), 0.5)
    add(buf, t0, drone(29, d, 0.2, 1.2), 0.4)
    for m, dt in [(81, 0.8), (76, 2.4), (74, 3.5), (69, 4.6)]:
        if dt < d - 0.5:
            add(buf, t0 + dt, piano(m, 3.5, 0.5), 1.0, pan=-0.15)


def m_title(buf, t0, d):
    # 片头：钢琴和弦 + 高音微光 + 铺底
    d += 0.6
    for i, m in enumerate([45, 52, 57, 60, 64]):
        add(buf, t0 + 0.03 + i * 0.012, piano(m, 4.5, 0.55), 1.0)
    add(buf, t0, pad([57, 64, 69, 72, 76], d, 1800, 0.6, 1.0), 0.4)
    add(buf, t0 + 0.3, shimmer(d - 0.3), 0.18)


def arpeggio(buf, t0, d, chords, step=0.5, vel=0.42, bar=8, pan=0.15):
    """钢琴分解和弦：chords 是 [[音, ...], ...]，每个和弦占 bar 个 step。"""
    k = 0
    while k * step < d - 0.2:
        ch = chords[(k // bar) % len(chords)]
        m = ch[[0, 2, 1, 3, 2, 1, 3, 2][k % 8] % len(ch)]
        add(buf, t0 + k * step, piano(m, 2.6, vel * (1.0 if k % 4 == 0 else 0.8)), 1.0, pan=pan if k % 2 else -pan)
        k += 1


def m_bed(buf, t0, d):
    # 小木屋：C 大调的钢琴分解和弦，温暖的铺底，像在讲一个睡前故事
    arpeggio(buf, t0, d, [[48, 55, 60, 64], [43, 55, 59, 62], [45, 52, 57, 60], [41, 53, 57, 60]], step=0.42)
    add(buf, t0, pad([60, 64, 67], d + 0.8, 1100, 1.5, 1.0), 0.32)


def m_reveal(buf, t0, d):
    # 推出屋外、天亮：F → C 的大和弦慢慢展开，高音微光
    h = d / 2
    add(buf, t0, pad([53, 57, 60, 65, 69], h + 0.8, 1600, 0.6, 1.0), 0.45)
    add(buf, t0 + h, pad([48, 55, 60, 64, 67], h + 1.0, 1800, 0.8, 1.2), 0.45)
    add(buf, t0, drone(36, d + 1.0, 1.0, 1.2), 0.3)
    for m, dt in [(72, 0.2), (76, 0.9), (79, 1.6), (84, h + 0.2)]:
        if dt < d:
            add(buf, t0 + dt, piano(m, 3.0, 0.45), 1.0, pan=0.2)
    add(buf, t0 + 0.4, shimmer(d), 0.14)


def ks(m, dur=2.5, decay=0.996, bright=0.6):
    """拨弦（Karplus-Strong）：一小段噪声在延迟线里来回衰减，听起来像古筝 / 吉他。"""
    f, n = hz(m), int(dur * SR)
    N = max(2, int(round(SR / f)))
    x = np.zeros(n)
    x[:N] = lp(noise(N), 1500 + 7000 * bright)
    a = np.zeros(N + 2)
    a[0], a[N], a[N + 1] = 1.0, -0.5 * decay, -0.5 * decay
    y = lfilter([1.0], a, x)
    return y / (np.abs(y).max() + 1e-9) * fade(n, 0.001, 0.25) * 0.5


def brush():
    n = int(0.25 * SR)
    return bp(noise(n), 1500, 7000) * np.exp(-tvec(n) * 16) * 0.5


def beat(buf, t0, d, bpm=84, kick=0.45, snare=0.18, hat=0.06):
    """克制的鼓：一、三拍底鼓，二、四拍刷子军鼓，八分音符的沙锤。"""
    b = 60 / bpm
    k = 0
    while k * b < d:
        tt = t0 + k * b
        if k % 2 == 0:
            add(buf, tt, lp(DRUM['kick'], 900), kick)
        else:
            add(buf, tt, brush(), snare)
        add(buf, tt + b / 2, DRUM['hat'], hat, pan=0.3)
        k += 1


def melody(buf, t0, d, notes, step, voice=ks, vel=0.5, pan=-0.15):
    """notes: 音高列表（None 是休止），按 step 秒一个往后排，循环到 d 秒。"""
    k = 0
    while k * step < d - 0.3:
        m = notes[k % len(notes)]
        if m is not None:
            add(buf, t0 + k * step, voice(m, 2.6), vel, pan=pan)
        k += 1


C = {'Am': [45, 57, 60, 64], 'F': [41, 57, 60, 65], 'C': [48, 55, 60, 64], 'G': [43, 55, 59, 62], 'Dm': [38, 57, 62, 65],
     'Em': [40, 55, 59, 64], 'Bb': [46, 58, 62, 65], 'D': [38, 57, 62, 66], 'A': [45, 57, 61, 64], 'Bm': [47, 59, 62, 66]}


def theme(chords, step=0.45, cutoff=1200, beat_bpm=None, pad_gain=0.34, vel=0.42, extra=None):
    def f(buf, t0, d):
        arpeggio(buf, t0, d, [C[c] for c in chords], step=step, vel=vel)
        bar = step * 8
        k = 0
        while k * bar < d:
            ch = C[chords[k % len(chords)]]
            add(buf, t0 + k * bar, pad(ch[1:], min(bar, d - k * bar) + 1.0, cutoff, 0.6, 0.9), pad_gain)
            add(buf, t0 + k * bar, drone(ch[0], min(bar, d - k * bar) + 0.6, 0.3, 0.6), 0.25)
            k += 1
        if beat_bpm:
            beat(buf, t0 + 0.02, d, beat_bpm)
        if extra:
            extra(buf, t0, d)
    return f


PENTA_A = [69, 72, 74, 76, 79, 81]
MOODS = {
    'lobby': m_lobby, 'run': m_run, 'after': m_after, 'title': m_title, 'bed': m_bed, 'reveal': m_reveal,
    'duel': theme(['Dm', 'Bb', 'F', 'C'], step=0.38, cutoff=900, beat_bpm=80),
    'shop': theme(['C', 'G', 'Am', 'F'], step=0.3, cutoff=1500),
    'source': theme(['F', 'C', 'Dm', 'Bb'], step=0.55, cutoff=1100),
    'europe': theme(['G', 'Em', 'C', 'D'], step=0.34, cutoff=1500),
    'germany': theme(['Am', 'F', 'C', 'G'], step=0.36, cutoff=1300, beat_bpm=84),
    'forum': theme(['Am', 'Em', 'F', 'C'], step=0.6, cutoff=900, vel=0.32),
    'germany2': theme(['Em', 'C', 'G', 'D'], step=0.3, cutoff=1500, beat_bpm=92),
    'egg': theme(['Em', 'C', 'Am', 'Bm'], step=0.5, cutoff=900, extra=lambda b, t0, d: add(b, t0, shimmer(d + 0.5), 0.14)),
    'both': theme(['C', 'G'], step=0.5, cutoff=1500),
    'yc': theme(['Am', 'F', 'C', 'G'], step=0.5, cutoff=1100, vel=0.3,
                extra=lambda b, t0, d: melody(b, t0 + 1.0, d - 1.0, [76, None, 79, 81, None, 79, 76, None, 74, 76, None, None, 72, 74, 76, None], 0.5)),
    'decline': theme(['Am', 'Dm', 'F', 'Em'], step=0.65, cutoff=800, vel=0.34),
    'remain': theme(['F', 'C'], step=0.6, cutoff=1500, extra=lambda b, t0, d: add(b, t0 + 0.3, shimmer(d + 0.5), 0.14)),
    'hypixel': theme(['D', 'Bm', 'G', 'A'], step=0.33, cutoff=1700, beat_bpm=90),
    'hypixel2': theme(['G', 'D', 'Em', 'C'], step=0.33, cutoff=1800, beat_bpm=90),
    'china': theme(['C', 'Am', 'F', 'G'], step=0.48, cutoff=1300, vel=0.3,
                   extra=lambda b, t0, d: melody(b, t0 + 0.5, d - 0.5, [79, 76, None, 74, 72, None, 74, 76, 79, None, 81, 79, None, None, 76, None], 0.48, vel=0.45)),
    'bloom': theme(['F', 'G', 'C', 'C'], step=0.4, cutoff=1900, beat_bpm=88, extra=lambda b, t0, d: add(b, t0, shimmer(d + 0.5), 0.16)),
    'peak': theme(['D', 'A', 'Bm', 'G'], step=0.3, cutoff=2000, beat_bpm=96),
    'beyond': theme(['A', 'D'], step=0.36, cutoff=1700),
    'question': theme(['Am', 'F'], step=0.7, cutoff=800, vel=0.3, pad_gain=0.28),
    'chain': theme(['C', 'G', 'Am', 'F'], step=0.4, cutoff=1500, beat_bpm=80),
    'outro': theme(['F', 'C', 'G', 'C'], step=0.5, cutoff=1700, extra=lambda b, t0, d: add(b, t0, shimmer(d + 1), 0.14)),
}


def score(tl, cues, n):
    """电影感配乐：每个 score 提示点开始一段情绪，持续到下一个 score 提示点（或片尾）。"""
    buf = np.zeros((2, n))
    marks = sorted((c for c in cues if c['sfx'] == 'score'), key=lambda c: c['t'])
    for i, c in enumerate(marks):
        nxt = marks[i + 1]['t'] if i + 1 < len(marks) else tl['duration']
        MOODS[c['name']](buf, c['t'], max(0.5, nxt - c['t']))
    buf = reverb(buf, rt=3.0, wet=0.34)
    for c in cues:
        if c['sfx'] == 'tapestop':
            tape_stop(buf, c['t'], c['dur'])
    return buf


# ---------------------------------------------------------------- 轻快配乐（script.json 里 "music": "cheer"）
# 从头到尾一条不断的 110 BPM 节拍：尤克里里扫弦、圆润的贝斯、马林巴旋律、钟琴、轻打击。
# 场景 cues 里的 score 提示点只决定“这一段用哪套编配”，换段都落在小节线上，整片听起来是同一首歌。
CBPM = 110
C8 = 30 / CBPM                      # 八分音符
CBAR = 8 * C8                        # 一小节（4/4）
# 尤克里里（GCEA 高音 G 定弦）四根弦从上往下扫的音，加上贝斯根音
UKE = {
    'G': (43, [67, 62, 67, 71]), 'D': (50, [69, 62, 66, 69]), 'Em': (40, [67, 64, 67, 71]), 'C': (48, [67, 60, 64, 72]),
    'Am': (45, [69, 60, 64, 69]), 'Bm': (47, [71, 62, 66, 71]),
}
PROGS = {'A': ['G', 'D', 'Em', 'C'], 'B': ['C', 'G', 'Am', 'D'], 'S': ['Em', 'C', 'G', 'D'], 'T': ['G', 'C', 'G', 'D']}
# 主旋律（G 大调，配 A 进行，八小节一句；None 是休止）
TUNE = [
    [71, None, 74, None, 79, None, 78, 76], [74, None, None, 69, 78, None, 76, 74],
    [76, None, 79, None, 83, None, 81, 79], [76, None, 74, None, 72, None, 74, None],
    [71, None, 74, None, 79, None, 81, 83], [81, None, 78, None, 74, None, 76, 78],
    [79, None, 76, None, 71, None, 74, 76], [72, None, 74, 76, 79, None, None, None],
]
# 每套编配各声部的音量（0 = 不出现）
PROFILES = {
    'full':    dict(prog='A', uke=1.0, bass=1.0, kick=1.0, snap=1.0, shaker=1.0, tamb=0.7, mel=1.0, glock=0.45, pad=0.0),
    'open':    dict(prog='A', uke=0.9, bass=1.0, kick=1.0, snap=0.9, shaker=1.0, tamb=0.5, mel=0.5, glock=0.3, pad=0.0),
    'mid':     dict(prog='A', uke=0.9, bass=0.9, kick=0.8, snap=0.8, shaker=0.8, tamb=0.0, mel=0.0, glock=0.3, pad=0.0),
    'melody':  dict(prog='A', uke=0.8, bass=0.85, kick=0.6, snap=0.7, shaker=0.7, tamb=0.0, mel=0.85, glock=0.0, pad=0.0),
    'light':   dict(prog='B', uke=0.75, bass=0.7, kick=0.0, snap=0.55, shaker=0.6, tamb=0.0, mel=0.0, glock=0.25, pad=0.25),
    'build':   dict(prog='B', uke=0.85, bass=0.85, kick=0.75, snap=0.6, shaker=0.9, tamb=0.0, mel=0.0, glock=0.3, pad=0.0),
    'soft':    dict(prog='S', uke=0.5, bass=0.5, kick=0.0, snap=0.0, shaker=0.0, tamb=0.0, mel=0.0, glock=0.4, pad=0.7),
    'sparkle': dict(prog='T', uke=0.0, bass=0.5, kick=0.0, snap=0.0, shaker=0.0, tamb=0.0, mel=0.0, glock=1.0, pad=0.6),
    'finale':  dict(prog='A', uke=1.0, bass=1.0, kick=1.0, snap=1.0, shaker=1.0, tamb=0.7, mel=1.0, glock=0.7, pad=0.0),
}
MOOD_PROFILE = {
    'open': 'open', 'title': 'sparkle', 'bed': 'light', 'reveal': 'light', 'duel': 'mid', 'shop': 'mid', 'source': 'light',
    'europe': 'mid', 'germany': 'mid', 'forum': 'light', 'germany2': 'mid', 'egg': 'melody', 'both': 'light',
    'yc': 'melody', 'decline': 'soft', 'remain': 'light', 'hypixel': 'full', 'hypixel2': 'mid', 'china': 'melody',
    'bloom': 'full', 'peak': 'full', 'beyond': 'mid', 'question': 'soft', 'chain': 'build', 'outro': 'finale',
    'lobby': 'mid', 'run': 'full', 'after': 'sparkle',
    # EP02
    'skyblock': 'soft', 'plugin': 'build',
}
# script.json 里 "music_calm": true：安静版——热闹的编配换成轻一点的，鼓和打击乐减半（旁白在前，配乐只垫底）
CALM_PROFILE = {'full': 'melody', 'open': 'melody', 'finale': 'melody', 'mid': 'light', 'build': 'light'}
_KS = {}


def uke_note(m, var):
    """尤克里里的一根弦：Karplus-Strong，按（音高, 变体）缓存。"""
    k = (m, var)
    if k not in _KS:
        f, n = hz(m), int(1.3 * SR)
        N = max(2, int(round(SR / f)))
        r = np.random.default_rng(100 + m * 7 + var)
        x = np.zeros(n)
        x[:N] = lp(r.uniform(-1, 1, N), 4200)
        a = np.zeros(N + 2)
        a[0], a[N], a[N + 1] = 1.0, -0.4965, -0.4965
        y = lfilter([1.0], a, x)
        y = hp(y, 180)
        _KS[k] = y / (np.abs(y).max() + 1e-9)
    return _KS[k]


def strum(buf, t0, notes, length, vel, up=False, pan=-0.12):
    """扫一下：下扫从高音 G 弦到 A 弦，上扫反过来、轻一些；下一次扫弦时止音。"""
    order = notes[::-1] if up else notes
    for i, m in enumerate(order):
        x = uke_note(m, (i + (3 if up else 0)) % 4)[:int((length + 0.08) * SR)].copy()
        nr = min(len(x), int(0.06 * SR))
        x[len(x) - nr:] *= np.linspace(1, 0, nr)
        add(buf, t0 + i * (0.009 if up else 0.013), x, vel * (0.7 if up else 1.0) * (0.92 if i else 1.0), pan=pan + 0.06 * i)


def bass_note(m, dur):
    n = int(dur * SR)
    t = tvec(n)
    f = hz(m)
    x = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(4 * np.pi * f * t) + 0.12 * np.sin(6 * np.pi * f * t)
    return np.tanh(1.6 * x) / np.tanh(1.6) * env(n, 0.006, 0.18, 0.55, 0.06)


def marimba(m, dur=1.2):
    """马林巴：基音 + 4 倍、9.9 倍泛音，泛音衰减快；软槌的一点噪声。"""
    n = int(dur * SR)
    t = tvec(n)
    f = hz(m)
    x = np.sin(2 * np.pi * f * t) * np.exp(-t * 4.5) + 0.32 * np.sin(2 * np.pi * 3.99 * f * t) * np.exp(-t * 16) \
        + 0.08 * np.sin(2 * np.pi * 9.9 * f * t) * np.exp(-t * 34)
    nh = int(0.008 * SR)
    x[:nh] += bp(noise(nh), 800, 4000) * 0.15
    return x * fade(n, 0.002, 0.1)


def glock(m, dur=2.2):
    """钟琴：亮、长尾音的金属泛音。"""
    n = int(dur * SR)
    t = tvec(n)
    f = hz(m)
    x = np.zeros(n)
    for r_, a_, d_ in ((1, 1.0, 1.6), (2.76, 0.42, 4.0), (5.40, 0.22, 8.0), (8.93, 0.08, 13.0)):
        if r_ * f < 15000:
            x += a_ * np.sin(2 * np.pi * r_ * f * t) * np.exp(-t * d_)
    return x * fade(n, 0.001, 0.2)


def snap():
    """响指 / 拍手：带通噪声 + 一点木头的“哒”。"""
    n = int(0.16 * SR)
    t = tvec(n)
    return 0.8 * bp(noise(n), 1200, 5200) * np.exp(-t * 38) + 0.25 * np.sin(2 * np.pi * 1350 * t) * np.exp(-t * 90)


def shaker():
    n = int(0.06 * SR)
    t = tvec(n)
    e = np.minimum(t / 0.012, 1) * np.exp(-np.maximum(t - 0.012, 0) * 70)
    return hp(noise(n), 5200) * e


def tamb():
    n = int(0.22 * SR)
    t = tvec(n)
    return hp(noise(n), 6500) * np.exp(-t * 18) * (1 + 0.6 * np.sin(2 * np.pi * 70 * t))


def cheer_score(tl, cues, n, calm=False):
    marks = sorted((c for c in cues if c['sfx'] == 'score'), key=lambda c: c['t'])
    end = tl['duration']
    last_voice = max(ln['end'] for ln in tl['lines'])
    # 每个小节用哪套编配：提示点落在小节前半就从这一小节换，落在后半就从下一小节换
    nbar = int(np.ceil(end / CBAR)) + 1
    prof, sec_start = [], []
    for b in range(nbar):
        tb = b * CBAR
        cur = [c for c in marks if c['t'] <= tb + CBAR * 0.5]
        name = cur[-1]['name'] if cur else 'open'
        p = MOOD_PROFILE.get(name, 'mid')
        prof.append(CALM_PROFILE.get(p, p) if calm else p)
        sec_start.append(sec_start[-1] if b and prof[b] == prof[b - 1] else b)
    # 最后一句旁白念完后的那个小节线：全体奏一个 G 和弦收尾，之后只剩余音
    b_end = int(np.ceil((last_voice + 0.2) / CBAR))
    buf = np.zeros((2, n))
    K, SN, SH, TB = lp(DRUM['kick'], 700), snap(), shaker(), tamb()
    for b in range(min(b_end, nbar)):
        P = dict(PROFILES[prof[b]])
        if calm:
            for d in ('kick', 'snap', 'shaker', 'tamb'):
                P[d] *= 0.5
        tb, k = b * CBAR, b - sec_start[b]
        prog = PROGS[P['prog']]
        ch = prog[k % len(prog)]
        root, notes = UKE[ch]
        nxt = prog[(k + 1) % len(prog)]
        if P['uke']:
            # 扫弦型：下 · 下上 · 上下上（八分音符位置 0 2 3 5 6 7）；soft 段只在一拍、三拍下扫
            pat = [(0, False), (4, False)] if prof[b] == 'soft' else [(0, False), (2, False), (3, True), (5, True), (6, False), (7, True)]
            for j, (pos, up) in enumerate(pat):
                nxt_pos = pat[j + 1][0] if j + 1 < len(pat) else 8
                strum(buf, tb + pos * C8, notes, (nxt_pos - pos) * C8, 0.2 * P['uke'] * (1.0 if pos in (0, 4) else 0.85), up)
        if P['bass']:
            if prof[b] in ('soft', 'sparkle'):
                add(buf, tb, bass_note(root, CBAR * 0.95), 0.26 * P['bass'])
            else:
                nroot = UKE[nxt][0]
                for pos, m, d in ((0, root, 1.5), (3, root, 0.9), (4, root + 7, 1.5), (6, root + 12 if root < 45 else root - 5, 0.9), (7, nroot + (1 if nroot < root else -1), 0.9)):
                    add(buf, tb + pos * C8, bass_note(m, d * C8), 0.26 * P['bass'] * (1.0 if pos in (0, 4) else 0.7))
        if P['kick']:
            for pos in (0, 4) if prof[b] != 'build' else (0, 2, 4, 6):
                add(buf, tb + pos * C8, K, 0.34 * P['kick'])
            if prof[b] in ('full', 'finale', 'open') and k % 2 == 1:
                add(buf, tb + 7 * C8, K, 0.22 * P['kick'])
        if P['snap']:
            for pos in (2, 6):
                add(buf, tb + pos * C8, SN, 0.15 * P['snap'], pan=0.1)
        if P['shaker']:
            for s16 in range(16):
                add(buf, tb + s16 * C8 / 2, SH, 0.05 * P['shaker'] * (1.0 if s16 % 2 == 0 else 0.55), pan=0.35)
        if P['tamb']:
            for pos in (2, 6):
                add(buf, tb + pos * C8, TB, 0.05 * P['tamb'], pan=-0.3)
        if P['mel'] and P['prog'] == 'A':
            for pos, m in enumerate(TUNE[k % 8]):
                if m is not None:
                    add(buf, tb + pos * C8, marimba(m), 0.24 * P['mel'], pan=0.15)
                    if prof[b] == 'finale':
                        add(buf, tb + pos * C8, glock(m + 12, 1.4), 0.05, pan=0.25)
        if P['glock']:
            if prof[b] == 'sparkle':
                # 十六分音符的分解和弦，像星星闪
                arp = sorted(set(notes)) + [notes[0] + 12]
                for s16 in range(16):
                    add(buf, tb + s16 * C8 / 2, glock(arp[s16 % len(arp)] + 12, 1.6), 0.06 * P['glock'], pan=0.25 * (1 if s16 % 2 else -1))
            elif k % 2 == 0:
                for j, m in enumerate(sorted(set(notes))[-2:]):
                    add(buf, tb + j * 3 * C8, glock(m + 12), 0.07 * P['glock'], pan=0.25)
        if P['pad']:
            add(buf, tb, pad([m - 12 for m in sorted(set(notes))], CBAR + 0.6, 1400, 0.25, 0.5), 0.16 * P['pad'])
        # 进入热闹的段落前一小节的最后两拍：响指连打做个小过门；进入时敲一下镲
        if b + 1 < nbar and prof[b + 1] in ('full', 'finale', 'open') and prof[b] not in ('full', 'finale', 'open'):
            for s16 in range(8, 16):
                add(buf, tb + s16 * C8 / 2, SN, 0.05 + 0.012 * (s16 - 8), pan=0.1)
        if k == 0 and prof[b] in ('full', 'finale') and b > 0:
            add(buf, tb, hp(DRUM['crash'], 5000), 0.1, pan=-0.2)
    # 收尾：G 和弦扫一下 + 贝斯 + 钟琴往上走 + 镲，然后让它自然消失
    tE = b_end * CBAR
    if tE < end + 0.5:
        root, notes = UKE['G']
        strum(buf, tE, notes, 3.0, 0.22)
        add(buf, tE, bass_note(root, 2.6), 0.28)
        add(buf, tE, K, 0.34)
        add(buf, tE, hp(DRUM['crash'], 5000), 0.12, pan=-0.2)
        for j, m in enumerate([79, 83, 86, 91]):
            add(buf, tE + 0.09 * j, glock(m, 2.6), 0.08, pan=-0.2 + 0.15 * j)
    buf = reverb(buf, rt=1.7, wet=0.2, seed=11)
    # 片尾淡出（最后 1.2 秒）
    i1, i0 = int(end * SR), int(max(0, end - 1.2) * SR)
    buf[:, i0:i1] *= np.linspace(1, 0, i1 - i0)[None, :]
    buf[:, i1:] = 0
    return buf


# ---------------------------------------------------------------- 8-bit 芯片音乐（EP02 第七轮起）
# 原创的小调循环：Am – F – C – G，120 BPM，一小节 2 秒。
# 乐器全是代码合成：方波主旋律（占空比 25%）、方波分解和弦（50%）、三角波贝斯、噪声鼓。
# 场景 cues 里的 score 提示点决定每段的编配（安静的讲故事段只留分解和弦和贝斯，打架、开局的段落全上）。
CHIP_BAR = 2.0
CHIP8 = CHIP_BAR / 8
CHIP_CHORDS = [('Am', 45, [57, 60, 64]), ('F', 41, [53, 57, 60]), ('C', 48, [60, 64, 67]), ('G', 43, [55, 59, 62])]
# 主旋律：两句，每句 4 小节、每小节 8 个八分音符（None 是休止）
CHIP_TUNE = [
    [[69, None, 72, 74, 76, None, 74, 72], [72, None, 69, 72, 74, 72, 69, None], [67, None, 72, 76, 79, None, 76, 74], [74, 71, 67, None, 71, 74, 79, None]],
    [[76, 76, None, 74, 72, None, 69, 72], [74, None, 72, 69, 65, None, 69, 72], [76, None, 79, 76, 72, None, 74, 76], [74, None, 71, 74, 67, None, None, None]],
]
CHIP_PROFILE = {   # lead 主旋律 / arp 分解和弦 / bass（0 不要，1 长音，2 八分音符）/ kick / snare / hat
    'question': dict(lead=0, arp=0.7, bass=1, kick=0, snare=0, hat=0),
    'run':      dict(lead=1, arp=0.6, bass=2, kick=1, snare=1, hat=1),
    'duel':     dict(lead=0.8, arp=0.5, bass=2, kick=1, snare=1, hat=1),
    'forum':    dict(lead=0, arp=0.8, bass=1, kick=0.6, snare=0, hat=0.6),
    'hypixel':  dict(lead=1, arp=0.6, bass=2, kick=1, snare=1, hat=1),
    'china':    dict(lead=0.7, arp=0.6, bass=1, kick=0.6, snare=0.5, hat=0.6),
    'decline':  dict(lead=0, arp=0.6, bass=1, kick=0, snare=0, hat=0),
    'beyond':   dict(lead=0.6, arp=0.6, bass=2, kick=0.8, snare=0.6, hat=0.8),
    'chain':    dict(lead=0, arp=0.9, bass=2, kick=1, snare=0, hat=1),
    'after':    dict(lead=0, arp=0.5, bass=1, kick=0, snare=0, hat=0),
    'outro':    dict(lead=0.8, arp=0.6, bass=1, kick=0.6, snare=0.5, hat=0.5),
}


def chip_note(kind, m, dur, vel=1.0, duty=0.5, vib=0.0):
    n = int(dur * SR)
    f = hz(m)
    if vib:
        t = tvec(n)
        ph = np.cumsum(f * (1 + vib * np.sin(2 * np.pi * 5.5 * t) * np.clip(t / 0.15 - 1, 0, 1))) / SR % 1.0
        x = np.where(ph < duty, 1.0, -1.0)
    else:
        x = wave(kind, f, n, duty)
    return lp(x * env(n, 0.003, 0.06, 0.55, min(0.04, dur * 0.3)), 5200) * vel


def chip_drum(kind):
    if kind == 'kick':
        n = int(0.16 * SR); t = tvec(n)
        return np.sin(2 * np.pi * np.cumsum(180 * np.exp(-t * 28) + 45) / SR) * np.exp(-t * 18)
    if kind == 'snare':
        n = int(0.14 * SR); t = tvec(n)
        return (0.7 * bp(noise(n), 1200, 6000) + 0.3 * np.sin(2 * np.pi * 190 * t)) * np.exp(-t * 26)
    n = int(0.05 * SR)
    return hp(noise(n), 7000) * np.exp(-tvec(n) * 90)


def chip_score(tl, cues, n):
    marks = sorted((c for c in cues if c['sfx'] == 'score'), key=lambda c: c['t'])
    end = tl['duration']
    last_voice = max(ln['end'] for ln in tl['lines'])
    nbar = int(np.ceil(end / CHIP_BAR)) + 1
    b_end = int(np.ceil((last_voice + 0.5) / CHIP_BAR))
    buf = np.zeros((2, n))
    K, SN, HT = chip_drum('kick'), chip_drum('snare'), chip_drum('hat')
    for b in range(min(b_end, nbar)):
        tb = b * CHIP_BAR
        cur = [c for c in marks if c['t'] <= tb + CHIP_BAR * 0.5]
        P = CHIP_PROFILE.get(cur[-1]['name'] if cur else 'question', CHIP_PROFILE['forum'])
        name, root, tones = CHIP_CHORDS[b % 4]
        if P['arp']:
            arp = tones + [tones[0] + 12]
            for s16 in range(16):
                add(buf, tb + s16 * CHIP8 / 2, chip_note('square', arp[s16 % 4] + 12, CHIP8 / 2 * 0.9, 0.12 * P['arp'], 0.5), pan=0.25 if s16 % 2 else -0.25)
        if P['bass'] == 1:
            add(buf, tb, chip_note('tri', root, CHIP_BAR * 0.95, 0.5), 0)
        elif P['bass'] == 2:
            for pos in range(8):
                add(buf, tb + pos * CHIP8, chip_note('tri', root + (12 if pos % 2 else 0), CHIP8 * 0.85, 0.45), 0)
        if P['lead']:
            phrase = CHIP_TUNE[(b // 4) % 2][b % 4]
            for pos, m in enumerate(phrase):
                if m is None:
                    continue
                length = 1
                while pos + length < 8 and phrase[pos + length] is None:
                    length += 1
                add(buf, tb + pos * CHIP8, chip_note('square', m, length * CHIP8 * 0.92, 0.2 * P['lead'], 0.25, vib=0.006), pan=0.05)
        if P['kick']:
            for pos in (0, 3, 4) if P['snare'] else (0, 4):
                add(buf, tb + pos * CHIP8, K, 0.42 * P['kick'])
        if P['snare']:
            for pos in (2, 6):
                add(buf, tb + pos * CHIP8, SN, 0.22 * P['snare'], pan=0.1)
        if P['hat']:
            for pos in range(8):
                add(buf, tb + pos * CHIP8, HT, 0.08 * P['hat'] * (1 if pos % 2 == 0 else 0.6), pan=0.3)
    # 收尾：Am 和弦琶音往上走，然后让它自然消失
    tE = b_end * CHIP_BAR
    if tE < end + 0.5:
        for j, m in enumerate([57, 60, 64, 69, 72, 76]):
            add(buf, tE + 0.08 * j, chip_note('square', m + 12, 1.6, 0.14, 0.5), pan=-0.2 + 0.08 * j)
        add(buf, tE, chip_note('tri', 45, 2.0, 0.5), 0)
    buf = reverb(buf, rt=1.2, wet=0.15, seed=13)
    i1, i0 = int(end * SR), int(max(0, end - 1.2) * SR)
    buf[:, i0:i1] *= np.linspace(1, 0, i1 - i0)[None, :]
    buf[:, i1:] = 0
    return buf


# ---------------------------------------------------------------- 音效
def sweep(f0, f1, dur, kind='sine', curve='exp'):
    n = int(dur * SR)
    t = tvec(n) / dur
    f = f0 * (f1 / f0) ** t if curve == 'exp' else f0 + (f1 - f0) * t
    ph = np.cumsum(f) / SR
    if kind == 'square':
        return np.where(ph % 1 < 0.5, 1.0, -1.0)
    return np.sin(2 * np.pi * ph)


def sfx(name, dur=None):
    if name == 'snuff':
        # 灯笼熄灭：一小口闷闷的气声
        n = int(0.18 * SR)
        t = tvec(n)
        return 0.5 * lp(noise(n), 1100) * np.exp(-t * 26) + 0.3 * np.sin(2 * np.pi * 70 * t) * np.exp(-t * 22)
    if name == 'step':
        n = int(0.06 * SR)
        return 0.4 * lp(noise(n), 900) * np.exp(-tvec(n) * 70)
    if name == 'riser':
        # 渐强的上升音：分段带通噪声越扫越高 + 一条上滑的正弦
        dur = dur or 1.8
        n = int(dur * SR)
        k = tvec(n) / dur
        nz, out = noise(n), np.zeros(n)
        for i in range(12):
            a, b = i * n // 12, (i + 1) * n // 12
            f = 300 * 12 ** (i / 11)
            out[a:b] = bp(nz, f * 0.7, min(f * 1.5, 18000))[a:b]
        return (0.6 * out + 0.35 * sweep(110, 440, dur)) * k ** 2.2 * 0.6
    if name == 'braam':
        # 低沉的铜管式冲击：失谐锯齿波过饱和，滤波器先开后合，再垫一层次低音
        n = int(3.2 * SR)
        t = tvec(n)
        x = sum(wave('saw', hz(m) * (1 + d), n) for m in (33, 45, 52) for d in (-0.004, 0, 0.004))
        x = np.tanh(x * 0.5)
        k = np.minimum(t / 0.12, 1) * np.exp(-t * 1.3)
        x = lp(x, 260) * (1 - k) + lp(x, 1900) * k
        return (0.5 * x + 0.7 * np.sin(2 * np.pi * 55 * t) * np.exp(-t * 1.4)) * np.minimum(t / 0.015, 1) * np.exp(-t * 0.8)
    if name == 'pluck':
        return ks(76, 1.4, 0.994, 0.8) * 0.8
    if name == 'swell':
        # 时间流逝：反向的镲片 + 慢慢升高的正弦
        dur = dur or 2.0
        n = int(dur * SR)
        k = tvec(n) / dur
        return (0.5 * hp(noise(n), 3000) * k ** 3 + 0.3 * sweep(220, 660, dur)) * k ** 1.6 * 0.5
    if name == 'rewind':
        return sfx('whoosh')[::-1] * 0.8
    if name == 'scratch':
        # 唱片急停：音高来回抖 + 噪声
        n = int(0.4 * SR)
        t = tvec(n)
        f = 330 + 240 * np.sin(2 * np.pi * 3.4 * t) * np.exp(-t * 2.5)
        x = 0.45 * np.sign(np.sin(2 * np.pi * np.cumsum(f) / SR)) + 0.6 * bp(noise(n), 700, 4200)
        return x * np.exp(-t * 5.5) * 0.7
    if name == 'hit':
        n = int(0.12 * SR)
        return 0.6 * bp(noise(n), 1500, 6000) * np.exp(-tvec(n) * 45) + 0.6 * np.sin(2 * np.pi * 140 * tvec(n)) * np.exp(-tvec(n) * 30)
    if name == 'break':
        n = int(0.6 * SR)
        x = lp(noise(n), 3500) * np.exp(-tvec(n) * 7)
        grains = np.zeros(n)
        for k in range(14):
            i = int(RNG.uniform(0, 0.35) * SR)
            g = bp(noise(int(0.03 * SR)), 800, 4000) * np.exp(-tvec(int(0.03 * SR)) * 120)
            grains[i:i + len(g)] += g[:n - i]
        thump = sweep(180, 50, 0.4) * np.exp(-tvec(int(0.4 * SR)) * 8)
        out = 0.7 * x + 0.6 * grains
        out[:len(thump)] += 0.9 * thump
        return out
    if name in ('kill', 'boom'):
        dur = 1.2 if name == 'boom' else 0.7
        n = int(dur * SR)
        sub = sweep(90, 35, dur) * np.exp(-tvec(n) * (3 if name == 'boom' else 5))
        nz = lp(noise(n), 1200) * np.exp(-tvec(n) * 6)
        return 0.9 * sub + 0.45 * nz
    if name == 'pop':
        return sweep(520, 980, 0.09) * env(int(0.09 * SR), 0.002, 0.03, 0.5, 0.04) * 0.6
    if name == 'stamp':
        n = int(0.25 * SR)
        return 0.9 * sweep(160, 55, 0.25) * np.exp(-tvec(n) * 14) + 0.5 * lp(noise(n), 2500) * np.exp(-tvec(n) * 40)
    if name in ('click', 'tick'):
        d = 0.03 if name == 'click' else 0.015
        n = int(d * SR)
        return wave('square', 1300 if name == 'click' else 2200, n, 0.5) * np.exp(-tvec(n) * 140) * (0.35 if name == 'click' else 0.2)
    if name == 'ding':
        n = int(1.0 * SR)
        t = tvec(n)
        return (np.sin(2 * np.pi * 1046.5 * t) + 0.5 * np.sin(2 * np.pi * 1568 * t) + 0.25 * np.sin(2 * np.pi * 2093 * t)) * np.exp(-t * 4.5) * 0.35
    if name == 'whoosh':
        n = int(0.55 * SR)
        x = noise(n)
        out = np.zeros(n)
        for k in range(8):
            a, b = k * n // 8, (k + 1) * n // 8
            f = 400 + 3000 * (k / 7)
            out[a:b] = bp(x, f * 0.7, min(f * 1.4, 20000))[a:b]
        return out * np.sin(np.pi * tvec(n) / 0.55) * 0.5
    if name == 'rise':
        n = int(0.7 * SR)
        return sweep(300, 1200, 0.7) * np.sin(np.pi * tvec(n) / 0.7) ** 2 * 0.3 + 0.1 * hp(noise(n), 6000) * tvec(n) / 0.7
    if name == 'place':
        n = int(0.08 * SR)
        return 0.6 * lp(noise(n), 1800) * np.exp(-tvec(n) * 50) + 0.5 * np.sin(2 * np.pi * 210 * tvec(n)) * np.exp(-tvec(n) * 45)
    if name == 'coin':
        a = wave('square', hz(83), int(0.06 * SR), 0.5)
        b = wave('square', hz(88), int(0.16 * SR), 0.5) * np.exp(-tvec(int(0.16 * SR)) * 14)
        return np.concatenate([a, b]) * 0.18
    if name == 'heart':
        n = int(0.18 * SR)
        beat = np.sin(2 * np.pi * 60 * tvec(n)) * np.exp(-tvec(n) * 18)
        out = np.zeros(int(0.5 * SR))
        out[:n] += beat
        i = int(0.22 * SR)
        out[i:i + n] += 0.7 * beat
        return out * 0.9
    if name == 'confetti':
        out = np.zeros(int(1.2 * SR))
        for k in range(10):
            i = int(RNG.uniform(0, 0.9) * SR)
            f = RNG.uniform(1500, 3500)
            p = np.sin(2 * np.pi * f * tvec(int(0.05 * SR))) * np.exp(-tvec(int(0.05 * SR)) * 80)
            out[i:i + len(p)] += p * 0.3
        return out
    if name == 'glitch':
        n = int(0.7 * SR)
        x = np.round(noise(n) * 4) / 4
        gate = np.repeat((RNG.uniform(0, 1, n // 1200 + 1) > 0.45).astype(float), 1200)[:n]
        return lp(x, 4000) * gate * 0.35
    if name == 'count':
        out = np.zeros(int(1.3 * SR))
        tt, k = 0.0, 0
        while tt < 1.2:
            p = wave('square', 1800 + 30 * k, int(0.012 * SR), 0.5) * 0.12
            i = int(tt * SR)
            out[i:i + len(p)] += p[:len(out) - i]
            tt += 0.09 * (1 - tt / 1.4) + 0.02
            k += 1
        return out
    if name == 'shatter':
        # 玻璃碎：一团很亮的碎噪声 + 几声高音的叮当，落在不同的时间
        n = int(0.9 * SR)
        t = tvec(n)
        out = 0.55 * hp(noise(n), 2500) * np.exp(-t * 14)
        for k in range(12):
            i = int(RNG.uniform(0, 0.35) * SR)
            f = RNG.uniform(2400, 6200)
            m = int(0.18 * SR)
            p = np.sin(2 * np.pi * f * tvec(m)) * np.exp(-tvec(m) * 28)
            out[i:i + m] += p[:n - i] * 0.28
        return out * 0.8
    if name == 'chest':
        # 开箱子：木头吱呀一声（锯齿波音高往下滑）+ 盖子碰到底的一下
        n = int(0.45 * SR)
        t = tvec(n)
        f = 150 - 60 * t / 0.45
        creak = np.sign(np.sin(2 * np.pi * np.cumsum(f) / SR)) * 0.5 + bp(noise(n), 300, 1800) * 0.8
        x = lp(creak, 1600) * np.minimum(t / 0.02, 1) * np.exp(-t * 6) * 0.35
        m = int(0.08 * SR)
        x[int(0.3 * SR):int(0.3 * SR) + m] += 0.5 * lp(noise(m), 900) * np.exp(-tvec(m) * 60)
        return x
    if name == 'equip':
        # 穿铁甲：两声金属的“叮”
        n = int(0.5 * SR)
        t = tvec(n)
        x = np.zeros(n)
        for dt0, f in ((0.0, 1760), (0.09, 2380)):
            i = int(dt0 * SR)
            m = n - i
            x[i:] += (np.sin(2 * np.pi * f * tvec(m)) + 0.4 * np.sin(2 * np.pi * f * 2.7 * tvec(m))) * np.exp(-tvec(m) * 18) * 0.22
        x[:int(0.03 * SR)] += hp(noise(int(0.03 * SR)), 3000) * 0.3
        return x
    if name == 'fall':
        # 掉下去：越来越低的风声 + 一条往下滑的音
        dur = dur or 1.3
        n = int(dur * SR)
        k = tvec(n) / dur
        nz, out = noise(n), np.zeros(n)
        for i in range(10):
            a, b = i * n // 10, (i + 1) * n // 10
            f = 2400 * (0.15 ** (i / 9))
            out[a:b] = bp(nz, f * 0.6, f * 1.5)[a:b]
        return (0.6 * out + 0.3 * sweep(620, 110, dur)) * np.sin(np.pi * np.minimum(k * 1.2, 1)) ** 0.5 * (1 - k) * 0.6
    if name == 'off':
        n = int(0.6 * SR)
        return sweep(500, 40, 0.6) * np.exp(-tvec(n) * 3) * 0.5
    raise ValueError(name)


def speech_env(x):
    """旁白包络：50ms RMS，快起慢落，用来压低 BGM。"""
    win = int(0.05 * SR)
    rms = np.sqrt(np.convolve(x * x, np.ones(win) / win, mode='same'))
    act = np.clip(rms / 0.05, 0, 1)
    out = np.zeros_like(act)
    a_up, a_dn = np.exp(-1 / (0.03 * SR)), np.exp(-1 / (0.45 * SR))
    v = 0.0
    # 逐块近似（每 10ms 一步，避免 Python 逐样本循环太慢）
    step = int(0.01 * SR)
    for i in range(0, len(act), step):
        target = act[i:i + step].max()
        k = a_up ** step if target > v else a_dn ** step
        v = target + (v - target) * k
        out[i:i + step] = v
    return out


def main():
    ep = sys.argv[1]
    epdir = os.path.join(ROOT, ep)
    tl = json.load(open(os.path.join(epdir, 'data', 'timeline.json'), encoding='utf-8'))
    cues = json.load(open(os.path.join(epdir, 'data', 'cues.json'), encoding='utf-8'))
    voice, sr = sf.read(os.path.join(epdir, 'data', 'narration.wav'), dtype='float64')
    assert sr == SR
    n = int((tl['duration'] + 0.5) * SR)
    voice = np.pad(voice, (0, max(0, n - len(voice))))[:n]

    music = bgm(tl, n)
    rms = lambda x: np.sqrt(np.mean(x[np.abs(x) > 1e-4] ** 2)) if np.any(np.abs(x) > 1e-4) else 1.0
    music *= 0.11 / (rms(music) + 1e-9)                          # 芯片风 BGM 约 -19 dBFS RMS
    script = json.load(open(os.path.join(epdir, 'script.json'), encoding='utf-8'))
    style = script.get('music', 'cine')
    if style == 'cheer':
        cheer = cheer_score(tl, cues, n, calm=script.get('music_calm', False))
        music += cheer * (0.085 * script.get('music_gain', 1.0) / (rms(cheer) + 1e-9))   # music_gain：整体配乐音量倍数
    elif style == 'chip':
        music = chip_score(tl, cues, n)
        music *= 0.075 / (rms(music) + 1e-9)                    # 8-bit 方波比较刺，放轻一点
    else:
        cine = score(tl, cues, n)
        music += cine * (0.085 / (rms(cine) + 1e-9))              # 电影配乐稍轻一些
    gain = np.ones(n)
    ons = sorted(c['t'] for c in cues if c['sfx'] == 'music_on')
    for t0 in sorted(c['t'] for c in cues if c['sfx'] == 'music_off'):
        t1 = next((x for x in ons if x > t0), tl['duration'])
        a, b = int(t0 * SR), int(t1 * SR)
        f = int(0.04 * SR)
        gain[a:b] = 0
        gain[max(0, a - f):a] = np.linspace(1, 0, a - max(0, a - f))
    music *= gain[None, :]
    se = speech_env(voice)
    if style in ('cheer', 'chip'):
        # 轻快配乐比较满：人声频段（250 Hz–4 kHz）压得最狠，低频的鼓和贝斯、高频的沙锤少压一点，节奏不断
        for ch in range(2):
            lo, hi = lp(music[ch], 250), hp(music[ch], 4000)
            music[ch] = lo * (1 - 0.72 * se) + (music[ch] - lo - hi) * (1 - 0.92 * se) + hi * (1 - 0.8 * se)
    else:
        music *= (1 - 0.62 * se)[None, :]

    fx = np.zeros((2, n))
    cache = {}
    for c in cues:
        if c['sfx'] in MUSIC_CTRL:
            continue
        key = (c['sfx'], c.get('dur'))
        if key not in cache:
            cache[key] = sfx(c['sfx'], c.get('dur'))
        add(fx, c['t'], cache[key], 0.55, pan=float(RNG.uniform(-0.25, 0.25)))
    fx = reverb(fx, rt=1.6, wet=0.18, seed=5)

    mix = music + fx + np.stack([voice, voice]) * 0.95
    mix = np.tanh(mix * 1.1) / np.tanh(1.1)                       # 软限幅
    mix *= 0.95 / np.abs(mix).max()
    data = os.path.join(epdir, 'data')
    sf.write(os.path.join(data, 'mix.wav'), mix.T.astype(np.float32), SR, subtype='FLOAT')
    out = os.path.join(epdir, 'assets', 'audio', 'mix.m4a')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', os.path.join(data, 'mix.wav'),
                    '-af', 'loudnorm=I=-15:TP=-1.5:LRA=11', '-ar', str(SR), '-c:a', 'aac', '-b:a', '192k', out], check=True)
    # 网页预览用 MP3（各浏览器都能解码）
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', out, '-c:a', 'libmp3lame', '-b:a', '160k', out[:-4] + '.mp3'], check=True)
    print(f'mix: {n / SR:.2f}s, {len(cues)} cues -> {out} (+ .mp3)')


if __name__ == '__main__':
    main()

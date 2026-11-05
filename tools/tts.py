#!/usr/bin/env python3
"""逐句合成旁白，回听校对，生成时间轴。

用法：
  python tools/tts.py ep01-bedwars            # 合成 + 回听 + 写 timeline / narration.wav / .srt
  python tools/tts.py ep01-bedwars --force    # 忽略缓存重新合成
  python tools/tts.py ep02-skywars --redo S04,H03   # 只把这几句重新念（覆盖缓存里的那一遍）
  python tools/tts.py ep02-skywars --audit    # 全片排查：逐句列出断句、拖腔、剪接点和念错的地方 → narration-audit.md

回听除了算字错率，还查断句：把句中每段静音按语音识别的逐字时间对到原文上，
落在标点处的是正常停顿，落在词组中间的（比如“东西|活下去”）算断错了。
voice.pauses 打开后，挑候选时断错的停顿要扣分，挑剩下的也会被收短（见 pause_check、squeeze）。

三种引擎（script.json 的 voice.engine）：
  qwen      Qwen3-TTS CustomVoice（Apache-2.0），自带音色 + 文字描述语气，最像真人说话。
            依赖 torch，单独装在 $QWEN_PY 指向的 Python 里，见 tools/qwen_tts_worker.py
  zipvoice  ZipVoice（sherpa-onnx，Apache-2.0），零样本：照着一段参考音频的音色说话。
            EP02 用它沿用 EP01 设计出来的旁白声音（参考音频不是真人录音）；模型在 GitHub Releases 上，
            下载不了 HuggingFace 时也能用
  kokoro    Kokoro（sherpa-onnx，Apache-2.0），快，但语调平
依赖：pip install sherpa-onnx numpy soundfile
模型（放在 $MODELS_DIR，默认 ./models）：
  Qwen3-TTS-12Hz-1.7B-CustomVoice                         （TTS）
  sherpa-onnx-zipvoice-distill-zh-en-emilia + vocos_24khz.onnx （TTS）
  kokoro-multi-lang-v1_0                                  （TTS）
  sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17      （仅用于回听校对）
下载地址见 README。
"""
import difflib
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile

import numpy as np
import sherpa_onnx
import soundfile as sf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS = os.environ.get('MODELS_DIR', os.path.join(ROOT, 'models'))
SR = 48000
DEFAULT_GAP = 0.25

# Kokoro 的英文词典里没有、或在中文句子里容易吞音的专名，补上读音（音素集合见模型 tokens.txt）
CUSTOM_EN = """\
xisuma z ɪ s ˈ u m ə
hypixel h ˈ I p ɪ k s ᵊ l
gomme ɡ ˈ ɑ m ə
pvp p ˌ i v ˌ i p ˈ i
roblox ɹ ˈ O b l ɑ k s
bedwars b ˈ ɛ d w ˌ ɔ ɹ z
eggwars ˈ ɛ ɡ w ˌ ɔ ɹ z
cubecraft k j ˈ u b k ɹ ˌ æ f t
yourcraft j ˈ ʊ ɹ k ɹ ˌ æ f t
rel ɹ ˈ ɛ l
"""


def kokoro():
    d = os.path.join(MODELS, 'kokoro-multi-lang-v1_0')
    lex = os.path.join(d, 'lexicon-us-en-custom.txt')
    if not os.path.exists(lex):
        with open(lex, 'w', encoding='utf-8') as f:
            f.write(CUSTOM_EN)
            with open(os.path.join(d, 'lexicon-us-en.txt'), encoding='utf-8') as base:
                f.write(base.read())
    cfg = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                model=f'{d}/model.onnx', voices=f'{d}/voices.bin', tokens=f'{d}/tokens.txt',
                data_dir=f'{d}/espeak-ng-data', dict_dir=f'{d}/dict',
                lexicon=f'{lex},{d}/lexicon-zh.txt'),
            num_threads=4),
        rule_fsts=f'{d}/date-zh.fst,{d}/phone-zh.fst,{d}/number-zh.fst',
        max_num_sentences=1)
    return sherpa_onnx.OfflineTts(cfg)


def qwen_text(line):
    """Qwen3-TTS 能直接念英文名和数字，就用字幕原文，只做两处处理：
    去掉引号和破折号（换成逗号），去掉“2016年，”这类时间词后面的逗号（不然“年”会被单独拖出来）。"""
    if 'say_qwen' in line:
        return line['say_qwen']
    s = line['sub'].replace('“', '').replace('”', '').replace('——', '，')
    s = re.sub(r'([0-9]+年(?:[0-9]+月)?)，', r'\1', s)
    s = re.sub(r'\s+', ' ', s).replace(' ，', '，')
    return s


CN_DIGIT = '零一二三四五六七八九'


def cn_int(n):
    """整数读法：190 → 一百九十，12 → 十二，105 → 一百零五（一万以内够用）。"""
    if n == 0:
        return '零'
    out, zero = '', False
    for unit, p in (('千', 1000), ('百', 100), ('十', 10), ('', 1)):
        d = n // p % 10
        if d == 0:
            zero = bool(out)
            continue
        if zero:
            out += '零'
            zero = False
        out += ('' if (unit == '十' and d == 1 and not out) else CN_DIGIT[d]) + unit
    return out


def zipvoice_text(line, voice=None):
    """ZipVoice 的前端不会读阿拉伯数字，先换成汉字读法：年份逐位读（2011年 → 二零一一年），其余按数值读；
    再去掉引号、把破折号和省略号换成逗号，去掉汉字之间多余的空格；
    最后按 voice.replace 把容易念歪的英文专名换成更好念的拼法（比如 Hypixel → Hi pixel）。"""
    if 'say' in line:
        return line['say']
    s = line['sub'].replace('“', '').replace('”', '').replace('——', '，').replace('……', '，')
    s = re.sub(r'([0-9]{4})年', lambda m: ''.join(CN_DIGIT[int(c)] for c in m.group(1)) + '年', s)
    s = re.sub(r'([0-9]+)\s*(?=[万千百])', lambda m: cn_int(int(m.group(1))), s)
    s = re.sub(r'[0-9]+', lambda m: cn_int(int(m.group(0))), s)
    s = re.sub(r'(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])', '', s)
    s = re.sub(r'\s+', ' ', s).replace(' ，', '，')
    for a, b in ((voice or {}).get('replace') or {}).items():
        s = s.replace(a, b)
    return s


def synth_zipvoice(todo, voice):
    """零样本 TTS：用参考音频（EP01 设计出来的旁白声音）的音色逐句合成。
    ZipVoice 没有随机种子参数，同一句每次念得都不一样：每句先念 voice.candidates 遍，
    用 SenseVoice 回听，留下字错率最低的一遍（英文专名最容易念歪，多念几遍挑最准的）；
    设了 voice.pauses 时，断错的停顿按秒数 × weight 计入扣分，字念对了、断句也自然的那一遍才算满分。
    take 用来微调语速（每加 1 快 1.5%），挑出来的还不满意时换一个 take 重念。"""
    d = os.path.join(MODELS, voice.get('model', 'sherpa-onnx-zipvoice-distill-zh-en-emilia'))
    pick = lambda *names: next((os.path.join(d, n) for n in names if os.path.exists(os.path.join(d, n))), os.path.join(d, names[0]))
    cfg = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            zipvoice=sherpa_onnx.OfflineTtsZipvoiceModelConfig(
                tokens=f'{d}/tokens.txt', encoder=pick('encoder.onnx', 'encoder.int8.onnx'), decoder=pick('decoder.onnx', 'decoder.int8.onnx'),
                data_dir=f'{d}/espeak-ng-data', lexicon=f'{d}/lexicon.txt', vocoder=os.path.join(MODELS, voice.get('vocoder', 'vocos_24khz.onnx')),
                guidance_scale=voice.get('guidance', 1.0)),
            num_threads=int(os.environ.get('TTS_THREADS', '4')), provider='cpu'))
    tts = sherpa_onnx.OfflineTts(cfg)
    ref, ref_sr = sf.read(os.path.join(ROOT, voice['ref_audio']), dtype='float32')
    if ref.ndim > 1:
        ref = ref[:, 0]
    ref_text = open(os.path.join(ROOT, voice['ref_text']), encoding='utf-8').read().strip()
    asr = sense_voice()
    for line, say, path in todo:
        g = sherpa_onnx.GenerationConfig()
        g.reference_audio, g.reference_sample_rate, g.reference_text = ref, ref_sr, ref_text
        g.num_steps = voice.get('steps', 8)
        g.speed = voice.get('speed', 1.0) * line.get('speed', 1.0) * (1 + 0.015 * line.get('take', 0))
        g.extra['min_char_in_sentence'] = str(voice.get('min_chars', 200))
        weight = (voice.get('pauses') or {}).get('weight', 0)
        good = line.get('good', (voice.get('pauses') or {}).get('good', 0))  # 分数不超过它就不用再念了（单句可以另设，比如 0：每一遍都念完再挑）
        best = None
        if os.path.exists(path) and asr is not None:
            # 重念（--redo）时，已有的那一遍也参加比较：新念的都不如它，就留着它
            x0, sr0 = sf.read(path, dtype='float32')
            h0, c0, t0 = listen(asr, x0, sr0)
            o0 = [p for p in pause_check(say, c0, t0, x0, sr0) if not p[2]]
            b0 = rhythm_check(say, c0, t0)
            s0 = min(cer(line['sub'], h0), cer(say, h0)) + filler_penalty(line['sub'], h0) + weight * (odd_penalty(o0) + rhythm_penalty(b0) + pitch_penalty(*tail_drop(t0, x0, sr0)))
            best = (s0, None, h0, o0, b0)
            print(f"  {line['id']} 已有的一遍 score {s0:.2f}  {h0}", flush=True)
        for k in range(max(1, voice.get('candidates', 1))):
            a = tts.generate(say, g)
            raw = np.array(a.samples, dtype=np.float32)
            x = trim(raw, a.sample_rate)
            score, heard, odd, breaks = 0.0, '', [], []
            if asr is not None:
                heard, chars, times = listen(asr, x, a.sample_rate)
                score = min(cer(line['sub'], heard), cer(say, heard)) + filler_penalty(line['sub'], heard)
                odd = [p for p in pause_check(say, chars, times, x, a.sample_rate) if not p[2]]
                breaks = rhythm_check(say, chars, times)
                score += weight * (odd_penalty(odd) + rhythm_penalty(breaks) + pitch_penalty(*tail_drop(times, x, a.sample_rate)))
                if line.get('_tone_ref') is not None:
                    score += weight * tone_penalty(word_tones(x, a.sample_rate, chars, times, line['tone']['word']), line['_tone_ref'])
            if cut_off(raw, a.sample_rate):
                score += 1  # 结尾被截掉的一遍不要
            if best is None or score < best[0]:
                best = (score, x, heard, odd, breaks)
            if score <= good:
                break
        score, x, heard, odd, breaks = best
        if x is None:
            print(f"  {line['id']} 新念的 {k + 1} 遍都不如已有的那一遍，保留原样", flush=True)
            continue
        if line.get('_tone_ref') is not None:
            hb, cb, tb = listen(asr, x, a.sample_rate)
            w = word_tones(x, a.sample_rate, cb, tb, line['tone']['word'])
            print(f"  {line['id']} 挑中的这一遍 {line['tone']['word']}：{' '.join(f'{v:+.1f}' for v in w) if w is not None else '没识别出来'} 半音", flush=True)
        if voice.get('tighten'):
            x = tighten(x, a.sample_rate, **voice['tighten'])
        sf.write(path, resample(x, a.sample_rate, SR), SR)
        print(f"  {line['id']} {len(x) / a.sample_rate:.1f}s  score {score:.2f} ({k + 1} tries)  {heard}  {describe(odd, breaks)}", flush=True)


def synth_qwen(todo, voice):
    """todo: [(line, say, path)]。一次起一个子进程把缺的句子全合成完（模型只加载一次）。
    instruct：整体语气（voice.instruct）+ 这一句的语气（line.instruct），拼成一句指令。
    每句念 voice.candidates 遍（随机种子 seed + take*100 + k），用 SenseVoice 回听，
    按字错率 + 多出来的语气词 + 断句 + 拖腔 + 句尾杂音打分，留最好的一遍。"""
    py = os.environ.get('QWEN_PY', sys.executable)
    n = max(1, voice.get('candidates', 1))
    asr = sense_voice()
    with tempfile.TemporaryDirectory() as tmp:
        jobs = []
        for line, say, _ in todo:
            ins = '，'.join(x for x in (voice.get('instruct', ''), line.get('instruct', '')) if x)
            for k in range(n):
                jobs.append({'text': say, 'out': os.path.join(tmp, f"{line['id']}-{k}.wav"), 'take': line.get('take', 0) * 100 + k, 'instruct': ins, 'id': line['id']})
        cfg = {'mode': voice.get('mode', 'custom'), 'model': os.path.join(MODELS, voice.get('model', 'Qwen3-TTS-12Hz-1.7B-CustomVoice')),
               'speaker': voice.get('speaker'), 'instruct': '', 'language': voice.get('language', 'Chinese'),
               'seed': voice.get('seed', 7), 'jobs': jobs}
        if cfg['mode'] == 'clone':
            # 参考音频随仓库提供（设计出来的声音，不是真人）
            cfg['ref_audio'] = os.path.join(ROOT, voice['ref_audio'])
            cfg['ref_text'] = open(os.path.join(ROOT, voice['ref_text']), encoding='utf-8').read().strip()
        jf = os.path.join(tmp, 'jobs.json')
        json.dump(cfg, open(jf, 'w', encoding='utf-8'), ensure_ascii=False)
        subprocess.run([py, os.path.join(ROOT, 'tools', 'qwen_tts_worker.py'), jf], check=True)
        for line, say, path in todo:
            best = None
            for job in [j for j in jobs if j['id'] == line['id']]:
                x, sr = sf.read(job['out'], dtype='float32')
                x = trim(x, sr)
                sc, heard = 0.0, ''
                if asr is not None:
                    heard, chars, times = listen(asr, x, sr)
                    sc = min(cer(line['sub'], heard), cer(say, heard)) + filler_penalty(line['sub'], heard) + edge_penalty(say, heard)
                    odd = [p for p in pause_check(say, chars, times, x, sr) if not p[2]]
                    sc += odd_penalty(odd) + rhythm_penalty(rhythm_check(say, chars, times))
                if best is None or sc < best[0]:
                    best = (sc, x, sr, heard)
            sc, x, sr, heard = best
            if voice.get('tighten'):
                x = tighten(x, sr, **voice['tighten'])
            sf.write(path, resample(x, sr, SR), SR)
            print(f"  {line['id']} {len(x) / sr:.1f}s  score {sc:.2f} ({n} takes)  {heard}", flush=True)


def synth_kokoro(todo, voice):
    tts = kokoro()
    for line, say, path in todo:
        a = tts.generate(say, sid=voice['speaker'], speed=voice.get('speed', 1.0))
        x = trim(np.array(a.samples, dtype=np.float32), a.sample_rate)
        if voice.get('tighten'):
            x = tighten(x, a.sample_rate, **voice['tighten'])
        sf.write(path, resample(x, a.sample_rate, SR), SR)


def sense_voice():
    d = os.path.join(MODELS, 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17')
    if not os.path.exists(d):
        return None
    # 不做逆文本归一化：数字保持汉字读法，才能和朗读文本逐字对上
    return sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=f'{d}/model.int8.onnx', tokens=f'{d}/tokens.txt', language='auto', use_itn=False, num_threads=4)


def resample(x, sr_in, sr_out):
    if sr_in == sr_out:
        return x
    n = int(round(len(x) * sr_out / sr_in))
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)


def trim(x, sr, thresh=0.012, pad=0.04):
    """去掉首尾静音，留一点余量，并做 10ms 淡入淡出。"""
    win = int(sr * 0.01)
    env = np.convolve(np.abs(x), np.ones(win) / win, mode='same')
    idx = np.where(env > thresh)[0]
    if len(idx) == 0:
        return x
    a = max(0, idx[0] - int(pad * sr))
    b = min(len(x), idx[-1] + int(pad * sr))
    y = x[a:b].copy()
    f = min(win, len(y) // 2)
    y[:f] *= np.linspace(0, 1, f)
    y[-f:] *= np.linspace(1, 0, f)
    return y


def tighten(x, sr, longest=0.22, keep=0.16, thresh=0.01):
    """句中超过 longest 秒的停顿收短到 keep 秒，像剪辑时剪掉多余的气口，读起来更连贯。"""
    win = int(sr * 0.01)
    quiet = np.convolve(np.abs(x), np.ones(win) / win, mode='same') < thresh
    out, i, n = [], 0, len(x)
    while i < n:
        j = i
        while j < n and quiet[j] == quiet[i]:
            j += 1
        seg = x[i:j]
        if quiet[i] and 0 < i and j < n and (j - i) / sr > longest:
            k = int(keep * sr)
            seg = np.concatenate([seg[:k // 2], seg[-(k - k // 2):]])
        out.append(seg)
        i = j
    return np.concatenate(out)


PUNCT = set('，。、？！：；,.?!:;…—')


def listen(asr, x, sr):
    """回听：识别出的文字，以及逐字（英文逐字母）的起始时间。"""
    s = asr.create_stream()
    s.accept_waveform(16000, resample(x, sr, 16000))  # 识别模型用 16kHz，先降好采样
    asr.decode_stream(s)
    chars, times = '', []
    for tok, t in zip(s.result.tokens, s.result.timestamps):
        if tok.startswith('<|'):
            continue
        for c in norm(tok):
            chars += c
            times.append(t)
    return re.sub(r'<\|[^|]*\|>', '', s.result.text), chars, times


def silences(x, sr, min_len=0.1, drop=38):
    """句中的静音段：比整句最响处低 drop dB、长于 min_len 秒，不算句首句尾。"""
    win = int(sr * 0.01)
    n = len(x) // win
    db = 20 * np.log10(np.sqrt(np.mean(x[:n * win].reshape(n, win) ** 2, axis=1)) + 1e-9)
    quiet = db < db.max() - drop
    out, i = [], 0
    while i < n:
        j = i
        while j < n and quiet[j] == quiet[i]:
            j += 1
        if quiet[i] and 0 < i and j < n and (j - i) * win / sr >= min_len:
            out.append((i * win / sr, j * win / sr))
        i = j
    return out


def align(say, chars):
    """识别结果和原文按字对齐（同音字、念错的字对不上）。返回 (原文每个字在 say 里的位置, 识别字下标 → 原文字下标)。"""
    ref = [i for i, ch in enumerate(say) if norm(ch)]
    m = difflib.SequenceMatcher(None, chars, ''.join(norm(say[i]) for i in ref), autojunk=False)
    return ref, {a + k: b + k for a, b, size in m.get_matching_blocks() for k in range(size)}


def boundary(say, ref, left, right):
    """识别出的前后两段对应原文的哪个位置：left、right 是两边对上原文的字（取离边界最近的一个）。
    返回 (中间有没有标点, 前文, 后文)；对不上时返回 None。"""
    if not left or not right or right[0] <= left[-1]:
        return None
    il, ir = ref[left[-1]], ref[right[0]]
    return any(c in PUNCT for c in say[il + 1:ir]), say[max(0, il - 3):il + 1], say[ir:ir + 4]


def pause_check(say, chars, times, x, sr, min_len=0.1):
    """把句中每段静音对到原文：落在标点处的是正常停顿，落在词组中间的（比如“东西|活下去”）是断错了。
    返回 [(开始秒, 结束秒, 是否正常, 前文, 后文)]；对不上原文的静音按正常停顿算。"""
    ref, h2r = align(say, chars)
    out = []
    for a, b in silences(x, sr, min_len):
        left = [h2r[k] for k in range(len(chars)) if times[k] < a and k in h2r]
        right = [h2r[k] for k in range(len(chars)) if times[k] >= b - 0.12 and k in h2r]
        r = boundary(say, ref, left, right)
        out.append((a, b, True, '', '') if r is None else (a, b) + r)
    return out


def rhythm_check(say, chars, times, factor=1.6):
    """节奏断裂：相邻两个音节（一个汉字，或识别器切出的一段英文）的起点间隔超过这句中位间隔的 factor 倍，
    中间又没有标点。前一个字被拖长时不一定有静音（比如“一场……PVP”），静音检查发现不了，要靠这个。
    返回 [(前一音节起点秒, 后一音节起点秒, 中位间隔, 前文, 后文)]。"""
    starts = [k for k in range(len(times)) if k == 0 or times[k] != times[k - 1]]
    if len(starts) < 4:
        return []
    onset = [times[k] for k in starts]
    med = float(np.median(np.diff(onset)))
    ref, h2r = align(say, chars)
    out = []
    for i in range(len(starts) - 1):
        if onset[i + 1] - onset[i] < factor * med:
            continue
        left = [h2r[k] for k in range(starts[i + 1]) if k in h2r]
        right = [h2r[k] for k in range(starts[i + 1], len(chars)) if k in h2r]
        r = boundary(say, ref, left, right)
        if r is not None and not r[0]:
            out.append((onset[i], onset[i + 1], med) + r[1:])
    return out


def f0_track(x, sr, hop=0.01, step=1):
    """基频（YIN），每 hop 秒一帧，单位 Hz；不发声、测不出来的帧是 nan。step > 1 时隔几帧取一帧（只求整体中位数时够用）。"""
    x = resample(x, sr, 16000)
    n, tmin, tmax = 512, 16000 // 320, 16000 // 60
    gate = 0.03 * (np.abs(x).max() + 1e-9)
    out = np.full(max(0, (len(x) - n - tmax) // 160), np.nan)
    for j in range(0, len(out), step):
        f = x[j * 160:j * 160 + n + tmax]
        if np.sqrt(np.mean(f[:n] ** 2)) < gate:
            continue
        d = np.array([np.sum((f[:n] - f[tau:tau + n]) ** 2) for tau in range(1, tmax + 1)])
        c = d / (np.cumsum(d) / np.arange(1, tmax + 1) + 1e-12)
        idx = np.where(c[tmin - 1:] < 0.2)[0]
        k = (idx[0] if len(idx) else int(np.argmin(c[tmin - 1:]))) + tmin - 1
        if c[k] > 0.45:
            continue
        while k + 1 < len(c) and c[k + 1] < c[k]:
            k += 1
        out[j] = 16000 / (k + 1)
    return out


def tail_drop(times, x, sr):
    """句尾掉调：最后两个音节比整句低多少个半音，以及这两个音节里测得出音高的帧占多少
    （掉到嗓子底的气泡音测不出音高）。用户听到 2:24“就有空岛战争”的“战争”突然变了个调，就是这种。"""
    starts = sorted(set(times))
    if len(starts) < 4:
        return 0.0, 1.0
    f_all = f0_track(x, sr, step=3)
    med = np.nanmedian(f_all)
    if not np.isfinite(med):
        return 0.0, 1.0
    t0 = starts[-2]
    tail = f0_track(x[int(t0 * sr):], sr)
    ok = tail[np.isfinite(tail)]
    for _ in range(2):                       # 八度错误折回来
        ok = np.where(ok > 1.8 * med, ok / 2, np.where(ok < 0.55 * med, ok * 2, ok))
    voiced = len(ok) / max(1, int((len(x) / sr - t0) / 0.01 * 0.6))
    return (float(12 * np.log2(np.median(ok) / med)) if len(ok) else -12.0), min(1.0, voiced)


def word_tones(x, sr, chars, times, word):
    """某个词（取最后一处）每个字的音高：相对整句中位音高的半音数；识别结果里找不到这个词时返回 None。"""
    i = chars.rfind(word)
    f = f0_track(x, sr)
    med = np.nanmedian(f) if np.isfinite(f).any() else np.nan
    if i < 0 or not np.isfinite(med):
        return None
    out = []
    for k in range(len(word)):
        a = times[i + k]
        b = times[i + k + 1] if i + k + 1 < len(times) else len(x) / sr
        seg = f[int(a / 0.01):max(int(a / 0.01) + 1, int(b / 0.01))]
        seg = seg[np.isfinite(seg)]
        out.append(12 * np.log2(np.median(seg) / med) if len(seg) else np.nan)
    return np.array(out)


def tone_ref(line, paths, asr):
    """line.tone = {word, like}：同一个词在 like 那几句里的读法（每个字的音高取平均），当作这一句的参考读法。"""
    rs = []
    for rid in line['tone']['like']:
        if not os.path.exists(paths[rid]):
            continue  # 参考句这一轮也要重念、还没有录音：这一遍先不比，等参考句念好以后用 --redo 再念这一句
        x, sr = sf.read(paths[rid], dtype='float32')
        heard, chars, times = listen(asr, x, sr)
        w = word_tones(x, sr, chars, times, line['tone']['word'])
        if w is not None:
            rs.append(w)
    return np.nanmean(rs, axis=0) if rs else None


def tone_penalty(tones, ref, allow=0.5):
    """和参考读法比：每个字平均差出 allow 个半音以上的部分，每半音扣 0.1；这一遍里找不到这个词扣 0.5。
    allow 定得很紧，几乎每一遍都会被扣一点，于是会把 candidates 遍都念完，挑读法最像的那一遍。
    用户听到 2:24“就有空岛战争”和片子里别处的“空岛战争”不是一个调：“空”起得低、“争”一路往下掉。"""
    if ref is None:
        return 0.0
    d = np.abs(tones - ref) if tones is not None else np.array([])
    d = d[np.isfinite(d)]
    return 0.1 * max(0.0, float(np.mean(d)) - allow) if len(d) else 0.5


def pitch_penalty(drop, voiced, allow=4.0):
    """句尾掉得比平时的句末下降（2～4 个半音）还多，或者大半测不出音高，就扣分。"""
    return 0.05 * max(0.0, -drop - allow) + 0.4 * max(0.0, 0.5 - voiced)


def rhythm_penalty(breaks, allow=1.5):
    """节奏断裂扣分：每处间隔超出中位间隔 allow 倍的部分按秒计（识别的逐字时间以 0.06 秒为刻度，差一两格不算）。"""
    return sum(max(0.0, b - a - allow * med) for a, b, med, *_ in breaks)


def cut_off(raw, sr, drop=20):
    """ZipVoice 按字数估一句的总长，念得慢、中间停得多时，最后一个字会被截掉（比如“PvP”只剩“P V”）：
    模型原始输出的最后 50ms 还比全句最响处高于 -drop dB，就算截掉了。"""
    w = int(sr * 0.05)
    peak = np.abs(raw).max() + 1e-9
    return 20 * np.log10(np.sqrt(np.mean(raw[-w:] ** 2)) / peak + 1e-9) > -drop


def odd_penalty(odd, allow=0.08):
    """断错的停顿扣分：每处超出 allow 秒的部分按秒计。"""
    return sum(max(0.0, b - a - allow) for a, b, *_ in odd)


def squeeze(x, sr, odd, keep=0.08):
    """把断错的停顿收短到 keep 秒（两头各留一半，接缝 5ms 交叉淡化）；标点处的正常停顿不动。"""
    fade, half = int(sr * 0.005), int(keep * sr / 2)
    for a, b, *_ in sorted(odd, reverse=True):
        i, j = int(a * sr) + half, int(b * sr) - half
        if j - i <= fade:
            continue
        w = np.linspace(1, 0, fade, dtype=np.float32)
        x = np.concatenate([x[:i - fade], x[i - fade:i] * w + x[j:j + fade] * (1 - w), x[j + fade:]])
    return x


def describe(odd, breaks=()):
    return '  '.join([f'断句 {l}|{r} {b - a:.2f}s' for a, b, ok, l, r in odd] +
                     [f'拖腔 {l}|{r} {b - a:.2f}s（平时 {med:.2f}s）' for a, b, med, l, r in breaks])


FILLERS = set('嗯呃啊哦吼哈唉诶呢嘛')


def edge_penalty(say, heard):
    """回听结果比原文在句首、句尾多出来的字（句尾多念的杂音、句首重复的字），每个扣 0.2。"""
    r, h = norm(say), norm(heard)
    m = [b for b in difflib.SequenceMatcher(None, r, h, autojunk=False).get_matching_blocks() if b.size]
    if not m:
        return 1.0
    return 0.2 * (m[0].b + len(h) - (m[-1].b + m[-1].size))


def filler_penalty(ref, heard):
    """回听里多出来的语气词（嗯、呃、啊……原文里没有的）每个扣 0.15：多半是气口、拖音或句尾多出来的杂音。"""
    extra = sum(1 for c in norm(heard) if c in FILLERS) - sum(1 for c in norm(ref) if c in FILLERS)
    return 0.15 * max(0, extra)


def norm(s):
    return re.sub(r'[^\w]|_', '', s.lower())


def cer(ref, hyp):
    r, h = norm(ref), norm(hyp)
    dp = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, dp[0] = dp[0], i
        for j in range(1, len(h) + 1):
            cur = dp[j]
            dp[j] = min(dp[j] + 1, dp[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev = cur
    return dp[len(h)] / max(1, len(r))


def srt_time(t):
    ms = int(round(t * 1000))
    return f'{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}'


def bend_tones(x, sr, bends):
    """把录音里某个字改成降调（比如轻声的“地”改念四声 dè，换字做不到时用）。
    bends: [{"at": [开始秒, 结束秒], "hi": 起点赫兹, "lo": 终点赫兹, "gain": 这个字放大几倍}]，时间是原始录音里的。
    用 Praat 的 PSOLA 只改这一段的音高（按半音线性下降），长度不变；需要 pip install praat-parselmouth。"""
    import parselmouth
    from parselmouth.praat import call
    for b in bends:
        a, e = b['at']
        snd = parselmouth.Sound(x.astype(float), sr)
        m = call(snd, 'To Manipulation', 0.01, 40, 500)
        pt = call(m, 'Extract pitch tier')
        call(pt, 'Remove points between', a - 0.005, e + 0.005)
        for t in np.linspace(a + 0.01, e - 0.01, 8):
            r = (t - a) / (e - a)
            call(pt, 'Add point', t, b['hi'] * (b['lo'] / b['hi']) ** r)
        call([pt, m], 'Replace pitch tier')
        y = call(m, 'Get resynthesis (overlap-add)').values[0]
        n = len(x); y = y[:n] if len(y) >= n else np.pad(y, (0, n - len(y)))
        env = np.ones(n); i0, i1 = int((a - 0.03) * sr), int((e + 0.03) * sr)
        env[i0:i1] += (b.get('gain', 1.0) - 1) * np.hanning(i1 - i0)
        y = y * env
        # 只换这个字前后一小段，其余保留原始录音（整句重合成会让别的字也变一点，识别都会听错）
        w = np.zeros(n); f = int(0.02 * sr); j0, j1 = int((a - 0.05) * sr), int((e + 0.05) * sr)
        w[j0:j1] = 1; w[j0 - f:j0] = np.linspace(0, 1, f); w[j1:j1 + f] = np.linspace(1, 0, f)
        y = x * (1 - w) + y * w
        x = (y / max(1.0, np.abs(y).max() / 0.98)).astype(np.float32)
    return x


def cut_spans(x, sr, spans):
    """剪掉录音里的几段（[开始秒, 结束秒]，结束可以写很大表示剪到末尾），接缝处 15 毫秒交叉淡化。
    用来去掉挑中的那一遍里个别的杂音：句尾多念出来的几个字、句首的重复字、逗号处的长气口。"""
    f = int(0.015 * sr)
    for a, b in sorted(spans, reverse=True):
        i, j = int(a * sr), min(len(x), int(b * sr))
        if j >= len(x):
            x = x[:i].copy(); x[-f:] *= np.linspace(1, 0, f); continue
        if i <= 0:
            x = x[j:].copy(); x[:f] *= np.linspace(0, 1, f); continue
        head, tail = x[:i], x[j:]
        w = np.linspace(0, 1, f)
        mid = head[-f:] * (1 - w) + tail[:f] * w
        x = np.concatenate([head[:-f], mid, tail[f:]])
    return x


def syllables(say):
    """估算一句话的音节数：汉字一字一音节，英文按元音组数，阿拉伯数字一位一音节（年份已在 say 里转成汉字）。"""
    n = len(re.findall(r'[\u4e00-\u9fff]', say))
    for w in re.findall(r'[A-Za-z]+', say):
        n += max(1, len(re.findall(r'[aeiouy]+', w.lower())))
    return n + len(re.findall(r'[0-9]', say))


def stretch(x, sr, tempo):
    """保持音高放慢 / 加快（ffmpeg 的 rubberband 滤镜；tempo < 1 是放慢）。"""
    with tempfile.TemporaryDirectory() as d:
        a, b = os.path.join(d, 'a.wav'), os.path.join(d, 'b.wav')
        sf.write(a, x, sr)
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', a, '-af',
                        f'rubberband=tempo={tempo:.4f}:formant=preserved:pitchq=quality', b], check=True)
        y, _ = sf.read(b, dtype='float32')
    return y


def cache_key(say, voice, take, speed=1.0):
    """同一句话 + 同一套声音设置 + 同一个 take 才算命中缓存。replace（只影响 say，say 已经在键里）、
    candidates 和 pauses（只影响挑哪一遍、怎么收短停顿）不算声音设置，改了它们不用把整片重念一遍。"""
    v = {k: x for k, x in voice.items() if k not in ('replace', 'candidates', 'pauses', 'rate', 'rate_floor')}
    key = [say, v, take] if speed == 1.0 else [say, v, take, speed]  # 单句语速（line.speed）只在设了的时候算进键里
    return hashlib.sha1(json.dumps(key, ensure_ascii=False).encode()).hexdigest()[:12]


def take_path(epdir, line, voice):
    """这一句用的是哪个录音文件（line.use 指定的那一遍，或按缓存键算出来的）。"""
    name = line.get('use') or f"{line['id']}-{cache_key(say_text(line, voice), voice, line.get('take', 0), line.get('speed', 1.0))}.flac"
    return os.path.join(epdir, 'data', 'tts', name)


def say_text(line, voice):
    eng = voice.get('engine')
    if eng == 'qwen':
        s = qwen_text(line)
        for a, b in (voice.get('replace') or {}).items():   # 和第一期一样：Hypixel 念作“嗨皮克斯”（中文玩家的叫法）
            s = s.replace(a, b)
        return s
    return zipvoice_text(line, voice) if eng == 'zipvoice' else line.get('say', line['sub'])


def main():
    ep = sys.argv[1]
    force = '--force' in sys.argv
    redo = set(sys.argv[sys.argv.index('--redo') + 1].split(',')) if '--redo' in sys.argv else set()
    epdir = os.path.join(ROOT, ep)
    script = json.load(open(os.path.join(epdir, 'script.json'), encoding='utf-8'))
    voice = script['voice']
    cache_dir = os.path.join(epdir, 'data', 'tts')
    os.makedirs(cache_dir, exist_ok=True)

    asr = sense_voice()
    clips, report, marks = {}, [], {}
    # 先找出缓存里没有的句子（同一句话 + 同一套声音设置 + 同一个 take 才算命中）
    todo, paths = [], {}
    for scene in script['scenes']:
        for line in scene['lines']:
            say = say_text(line, voice)
            key = cache_key(say, voice, line.get('take', 0), line.get('speed', 1.0))
            # 缓存用 FLAC（无损、体积小）：ZipVoice 每次念得都不一样，EP02 起把挑好的每一句提交进仓库，以后只改一句时其余句子原样复用
            path = os.path.join(cache_dir, f"{line['id']}-{key}.flac")
            if line.get('use'):
                path = os.path.join(cache_dir, line['use'])  # 指定用某一遍现成的录音（比如前几轮审过的那一遍），不再合成
            if not os.path.exists(path) and os.path.exists(path[:-5] + '.wav'):
                path = path[:-5] + '.wav'
            paths[line['id']] = path
            if force or line['id'] in redo or not os.path.exists(path):
                todo.append((line, say, path))
    # --say ID=朗读文字：这一次临时换掉某句的朗读文字（字幕不变），用来几台机器同时试几种念法；换了文字，缓存键也跟着变，不会覆盖别的版本
    for i, a in enumerate(sys.argv):
        if a == '--say':
            lid, txt = sys.argv[i + 1].split('=', 1)
            for scene in script['scenes']:
                for line in scene['lines']:
                    if line['id'] == lid:
                        line['say'] = txt
                        say = say_text(line, voice)
                        key = cache_key(say, voice, line.get('take', 0), line.get('speed', 1.0))
                        paths[lid] = os.path.join(cache_dir, f"{lid}-{key}.flac")
                        todo = [x for x in todo if x[0]['id'] != lid] + [(line, say, paths[lid])] if not os.path.exists(paths[lid]) else [x for x in todo if x[0]['id'] != lid]
    # --only C02,C04：只合成这几句（缓存里没有的）就退出，不写时间轴；几个进程分头合成不同的句子，最后不带参数再跑一遍拼起来
    only = set(sys.argv[sys.argv.index('--only') + 1].split(',')) if '--only' in sys.argv else None
    if only is not None:
        todo = [x for x in todo if x[0]['id'] in only]
    if todo:
        # 要和别的句子读成一个调的词（line.tone）：先从参考句的现有录音里量出参考读法
        for line, say, path in todo:
            if line.get('tone') and asr is not None:
                line['_tone_ref'] = tone_ref(line, paths, asr)
                if line['_tone_ref'] is not None:
                    print(f"  {line['id']} 参考读法 {line['tone']['word']}：{' '.join(f'{v:+.1f}' for v in line['_tone_ref'])} 半音（{'、'.join(line['tone']['like'])}）")
        print(f"synthesizing {len(todo)} lines with {voice.get('engine', 'kokoro')}")
        {'qwen': synth_qwen, 'zipvoice': synth_zipvoice}.get(voice.get('engine'), synth_kokoro)(todo, voice)
    if only is not None:
        return
    for scene in script['scenes']:
        for line in scene['lines']:
            say = say_text(line, voice)
            x, _ = sf.read(paths[line['id']], dtype='float32')
            if line.get('bend'):
                x = bend_tones(x, SR, line['bend'])
            if line.get('cut'):
                x = cut_spans(x, SR, line['cut'])
            if asr is not None:
                heard, chars, times = listen(asr, x, SR)
                score = min(cer(line['sub'], heard), cer(say, heard))
                odd = [p for p in pause_check(say, chars, times, x, SR) if not p[2]]
                breaks = rhythm_check(say, chars, times)
                # 缓存里存的是念出来的原样；断错的停顿在这里收短，只影响整条旁白和时间轴
                if voice.get('pauses') and odd:
                    x = squeeze(x, SR, odd, voice['pauses'].get('keep', 0.08))
                report.append((line['id'], score, heard, odd, breaks))
            # 语速统一：比 voice.rate（音节/秒）快的句子，保持音高放慢到 rate（最多放慢 voice.rate_floor，默认 12%）；
            # 本来就不快的句子不动（英文名多的句子本来就慢一点，不去加快它）
            if voice.get('rate'):
                r = syllables(say) / (len(x) / SR)
                if r > voice['rate'] * 1.02:
                    tempo = max(1 - voice.get('rate_floor', 0.12), voice['rate'] / r)
                    x = stretch(x, SR, tempo)
                    print(f"  {line['id']} 语速 {r:.2f} → {syllables(say) / (len(x) / SR):.2f} 音节/秒（tempo {tempo:.3f}）")
            clips[line['id']] = x
            # 每个汉字在这句录音里的真实时间（语音识别的逐字时间，按原文对齐；识别漏掉的字按前后插值）：
            # 画面上的动作按“某句话里的某个字”触发时用它，而不是按字数比例估
            if asr is not None:
                hx, cx, tx = listen(asr, x, SR)
                hanzi = [c for c in line['sub'] if '\u4e00' <= c <= '\u9fff']
                got = [(c, tt) for c, tt in zip(cx, tx) if '\u4e00' <= c <= '\u9fff']
                sm = difflib.SequenceMatcher(None, ''.join(hanzi), ''.join(c for c, _ in got), autojunk=False)
                ht = [None] * len(hanzi)
                for blk in sm.get_matching_blocks():
                    for k in range(blk.size):
                        ht[blk.a + k] = got[blk.b + k][1]
                known = [(i, v) for i, v in enumerate(ht) if v is not None]
                if known:
                    dur_ = len(x) / SR
                    for i in range(len(ht)):
                        if ht[i] is None:
                            lo = max([(j, v) for j, v in known if j < i], default=(-1, 0.0))
                            hi = min([(j, v) for j, v in known if j > i], default=(len(ht), dur_))
                            ht[i] = lo[1] + (hi[1] - lo[1]) * (i - lo[0]) / (hi[0] - lo[0])
                    marks[line['id']] = [round(v, 3) for v in ht]

    by_id_line = {line['id']: line for scene in script['scenes'] for line in scene['lines']}
    # 时间轴：每句真实时长 + 句间停顿 + 场景前后留白
    t, lines, scenes = 0.0, [], []
    for scene in script['scenes']:
        s0 = t
        t += scene.get('lead', 0.3)
        for line in scene['lines']:
            dur = len(clips[line['id']]) / SR
            lines.append({'id': line['id'], 'scene': scene['id'], 'start': round(t, 3),
                          'end': round(t + dur, 3), 'sub': line['sub'], **({'ht': marks[line['id']]} if line['id'] in marks else {})})
            t += dur + line.get('gap', DEFAULT_GAP)
        t += scene.get('tail', 0.3)
        scenes.append({'id': scene['id'], 'start': round(s0, 3), 'end': round(t, 3)})
    duration = round(t, 3)

    narration = np.zeros(int(duration * SR) + SR, dtype=np.float32)
    for ln in lines:
        x = clips[ln['id']]
        i = int(ln['start'] * SR)
        narration[i:i + len(x)] += x
    narration = narration[:int(duration * SR)]
    # line.mute：整条旁白里某句的几段（相对这句开头的秒数）压成静音，不改变长度——
    # 去掉句首、句尾多出来的杂音而不动时间轴（画面已经按时间轴渲好时用）
    for ln in lines:
        for a, b in by_id_line[ln['id']].get('mute', []):
            i, j = int((ln['start'] + a) * SR), int((ln['start'] + b) * SR)
            f = int(0.03 * SR)
            env_ = np.ones(j - i, dtype=np.float32) * 0
            env_[:f] = np.linspace(1, 0, f); env_[-f:] = np.linspace(0, 1, f)
            narration[i:j] *= env_
    peak = np.abs(narration).max()
    narration *= 0.89 / peak  # 约 -1 dBFS

    data = os.path.join(epdir, 'data')
    sf.write(os.path.join(data, 'narration.wav'), narration, SR)
    sf.write(os.path.join(data, 'narration.flac'), narration, SR)
    tl = {'title': script['title'], 'duration': duration, 'fps': 30, 'scenes': scenes, 'lines': lines}
    json.dump(tl, open(os.path.join(data, 'timeline.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    with open(os.path.join(data, 'timeline.js'), 'w', encoding='utf-8') as f:
        f.write('window.TIMELINE = ' + json.dumps(tl, ensure_ascii=False) + ';\n')
    with open(os.path.join(epdir, 'out', 'subtitles.srt'), 'w', encoding='utf-8') as f:
        for i, ln in enumerate(lines, 1):
            f.write(f"{i}\n{srt_time(ln['start'])} --> {srt_time(ln['end'])}\n{ln['sub']}\n\n")

    print(f'duration {duration:.2f}s, {len(lines)} lines, {len(scenes)} scenes')
    for sc in scenes:
        print(f"  {sc['id']:9s} {sc['start']:7.2f} → {sc['end']:7.2f}  ({sc['end'] - sc['start']:.1f}s)")
    if report:
        print('\n回听校对（CER 越低越好，>0.25 需人工确认；“断句”是落在词组中间的停顿，收短前的长度；'
              '“拖腔”是两个字之间的间隔比这句平时长得多）:')
        for lid, score, heard, odd, breaks in report:
            flag = '  <-- check' if score > 0.25 or odd_penalty(odd, 0.15) > 0 or breaks else ''
            print(f'  {lid} {score:.2f} {heard}  {describe(odd, breaks)}{flag}')


def audit(ep):
    """全片排查：按成片里的整条旁白（收短停顿之后的样子）逐句检查，列出每个问题在视频里的时间，
    写进 <集>/narration-audit.md。只读，不改任何文件以外的东西。"""
    epdir = os.path.join(ROOT, ep)
    script = json.load(open(os.path.join(epdir, 'script.json'), encoding='utf-8'))
    voice = script['voice']
    by_id = {line['id']: line for scene in script['scenes'] for line in scene['lines']}
    tl = json.load(open(os.path.join(epdir, 'data', 'timeline.json'), encoding='utf-8'))
    nar, sr = sf.read(os.path.join(epdir, 'data', 'narration.flac'), dtype='float32')
    asr = sense_voice()
    keep = (voice.get('pauses') or {}).get('keep', 0.08)
    mmss = lambda t: f'{int(t // 60)}:{t % 60:05.2f}'
    rows, clean = [], 0
    for ln in tl['lines']:
        line = by_id[ln['id']]
        say = say_text(line, voice)
        seg = nar[int(ln['start'] * sr):int(ln['end'] * sr)]
        heard, chars, times = listen(asr, seg, sr)
        score = min(cer(line['sub'], heard), cer(say, heard))
        found = [(a, f'断句（静音 {b - a:.2f}s）', l, r) for a, b, ok, l, r in pause_check(say, chars, times, seg, sr, 0.08) if not ok]
        # 只列间隔到平时 2 倍以上的拖腔：识别的逐字时间有 0.06 秒的刻度误差，差一两格的不算
        found += [(a, f'拖腔（{b - a:.2f}s，平时 {med:.2f}s）', l, r) for a, b, med, l, r in rhythm_check(say, chars, times, 2.0)]
        # 合成整条旁白时收短过的停顿：剪接点，可能听得出硬接
        raw, rsr = sf.read(take_path(epdir, line, voice), dtype='float32')
        rh, rc, rt = listen(asr, raw, rsr)
        cut = 0.0
        for a, b, ok, l, r in sorted(pause_check(say, rc, rt, raw, rsr)):
            if not ok and voice.get('pauses'):
                found.append((a - cut, f'剪接（原停顿 {b - a:.2f}s 收短到 {keep:.2f}s）', l, r))
                cut += b - a - keep
        if score > 0.15:
            found.append((0.0, f'字错率 {score:.2f}（听成：{heard}）', '', ''))
        if line.get('tone'):
            ref = tone_ref(line, {rid: take_path(epdir, by_id[rid], voice) for rid in line['tone']['like']}, asr)
            w = word_tones(seg, sr, chars, times, line['tone']['word'])
            if tone_penalty(w, ref, 1.0) > 0:   # 排查时差出 1 个半音以上才报（两句参考句彼此之间也差 1 个半音左右）
                found.append((0.0, f"“{line['tone']['word']}”读法和{'、'.join(line['tone']['like'])}不一样（{' '.join(f'{v:+.1f}' for v in w) if w is not None else '没识别出来'} / 参考 {' '.join(f'{v:+.1f}' for v in ref)} 半音）", '', ''))
        if not found:
            clean += 1
        for t, what, l, r in sorted(found):
            rows.append((ln['start'] + t, ln['id'], what, f'{l}｜{r}' if l or r else '', ln['sub']))
    with open(os.path.join(epdir, 'narration-audit.md'), 'w', encoding='utf-8') as f:
        f.write(f"# 旁白排查（{script['title']}）\n\n由 `python3 tools/tts.py {ep} --audit` 生成：按成片里的整条旁白逐句回听，"
                f"列出落在词组中间的停顿（断句）、两个字之间间隔明显变长（拖腔）、合成时收短过停顿的地方（剪接）和念错的句子。\n\n"
                f"共 {len(tl['lines'])} 句，没有问题的 {clean} 句，问题 {len(rows)} 处。\n\n| 视频时间 | 句 | 问题 | 位置 | 字幕 |\n|---|---|---|---|---|\n")
        for t, lid, what, where, sub in rows:
            f.write(f'| {mmss(t)} | {lid} | {what} | {where} | {sub} |\n')
    for t, lid, what, where, sub in rows:
        print(f'  {mmss(t):>8}  {lid}  {what}  {where}')
    print(f'{len(tl["lines"])} lines, {clean} clean, {len(rows)} issues -> {ep}/narration-audit.md')


if __name__ == '__main__':
    audit(sys.argv[1]) if '--audit' in sys.argv else main()

#!/usr/bin/env python3
"""文字没改的句子：在“前几轮审过的那一遍”和“这一轮新念的那一遍”之间挑一个。

用法：python3 tools/pick_takes.py ep02-skywars <旧 script.json 所在的 git 提交>
对每个文字（sub / say）和旧稿一模一样的句子，用和 tools/tts.py 挑候选时一样的分数
（字错率 + 断句 + 拖腔 + 句尾音高）给两遍打分：新的一遍不比旧的差（分数 ≤ 旧的），就用新的；
否则在 script.json 里写上 "use": "<旧文件名>"，沿用旧的那一遍（语速由 voice.rate 统一放慢）。
"""
import json
import os
import subprocess
import sys

import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tts  # noqa: E402

ep, rev = sys.argv[1], sys.argv[2]
epdir = os.path.join(tts.ROOT, ep)
path = os.path.join(epdir, 'script.json')
script = json.load(open(path, encoding='utf-8'))
voice = script['voice']
old = json.loads(subprocess.check_output(['git', '-C', tts.ROOT, 'show', f'{rev}:{ep}/script.json']))
old_by = {l['id']: l for s in old['scenes'] for l in s['lines']}
asr = tts.sense_voice()
weight = (voice.get('pauses') or {}).get('weight', 1.0)


def score(line, say, f):
    x, sr = sf.read(f, dtype='float32')
    heard, chars, times = tts.listen(asr, x, sr)
    sc = min(tts.cer(line['sub'], heard), tts.cer(say, heard))
    odd = [p for p in tts.pause_check(say, chars, times, x, sr) if not p[2]]
    sc += weight * (tts.odd_penalty(odd) + tts.rhythm_penalty(tts.rhythm_check(say, chars, times)) + tts.pitch_penalty(*tts.tail_drop(times, x, sr)))
    return sc, heard


changed = False
for scene in script['scenes']:
    for line in scene['lines']:
        o = old_by.get(line['id'])
        if not o or o['sub'] != line['sub'] or o.get('say') != line.get('say'):
            continue
        say = tts.say_text(line, voice)
        old_say = tts.say_text(o, old['voice'])
        old_file = f"{line['id']}-{tts.cache_key(old_say, old['voice'], o.get('take', 0))}.flac"
        old_path = os.path.join(epdir, 'data', 'tts', old_file)
        new_path = os.path.join(epdir, 'data', 'tts', f"{line['id']}-{tts.cache_key(say, voice, line.get('take', 0), line.get('speed', 1.0))}.flac")
        if not os.path.exists(old_path):
            print(f"  {line['id']} 旧录音不在了，跳过"); continue
        so, ho = score(o, old_say, old_path)
        if os.path.exists(new_path):
            sn, hn = score(line, say, new_path)
        else:
            sn, hn = float('inf'), '（没有新的一遍）'
        pick_old = sn > so
        print(f"  {line['id']} 旧 {so:.2f} {ho} | 新 {sn:.2f} {hn} → {'旧' if pick_old else '新'}")
        if pick_old and line.get('use') != old_file:
            line['use'] = old_file; changed = True
        if not pick_old and 'use' in line:
            del line['use']; changed = True
if changed:
    txt = json.dumps(script, ensure_ascii=False, indent=2)
    open(path, 'w', encoding='utf-8').write(txt + '\n')
    print('script.json updated')

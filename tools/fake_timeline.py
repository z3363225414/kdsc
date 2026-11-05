#!/usr/bin/env python3
"""配音还没出来时，按字数估一个临时时间轴（data/timeline.json / .js），让画面可以先写、先试。
真正的时间轴由 tools/tts.py 生成，会直接覆盖这两个文件。
用法：python3 tools/fake_timeline.py ep03-hungergames
"""
import json, os, re, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ep = sys.argv[1]
s = json.load(open(os.path.join(ROOT, ep, 'script.json'), encoding='utf-8'))
t, lines, scenes = 0.0, [], []
for sc in s['scenes']:
    s0 = t; t += sc.get('lead', 0.3)
    for ln in sc['lines']:
        txt = ln['sub']
        han = len(re.findall(r'[一-鿿]', txt)); eng = len(re.findall(r'[A-Za-z]+', txt)) * 2; dig = len(re.findall(r'\d', txt))
        pauses = len(re.findall(r'[，、；：——]', txt)) * 0.18
        dur = (han + eng + dig) / 4.6 + pauses + 0.2
        lines.append({'id': ln['id'], 'scene': sc['id'], 'start': round(t, 3), 'end': round(t + dur, 3), 'sub': txt})
        t += dur + ln.get('gap', 0.3)
    t += sc.get('tail', 0.3)
    scenes.append({'id': sc['id'], 'start': round(s0, 3), 'end': round(t, 3)})
tl = {'title': s['title'], 'duration': round(t, 3), 'fps': 30, 'estimated': True, 'scenes': scenes, 'lines': lines}
d = os.path.join(ROOT, ep, 'data')
json.dump(tl, open(os.path.join(d, 'timeline.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
open(os.path.join(d, 'timeline.js'), 'w', encoding='utf-8').write('window.TIMELINE = ' + json.dumps(tl, ensure_ascii=False) + ';\n')
print('estimated', tl['duration'], 's;', [(x['id'], round(x['end'] - x['start'], 1)) for x in scenes])

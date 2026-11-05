#!/usr/bin/env python3
"""用 Qwen3-TTS VoiceDesign 按文字描述生成旁白的参考声音（不克隆任何真人），
之后 tools/tts.py 的 clone 模式拿它当固定音色，整片音色一致。

用法：$QWEN_PY tools/design_voice.py ep01-bedwars
读取 script.json 里 voice.design（描述）和 voice.ref_text，写出 voice.ref_audio。
"""
import json
import os
import sys

import numpy as np
import soundfile as sf
import torch

torch.set_num_threads(int(os.environ.get('TTS_THREADS', '3')))
from qwen_tts import Qwen3TTSModel  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS = os.environ.get('MODELS_DIR', os.path.join(ROOT, 'models'))


def main():
    epdir = os.path.join(ROOT, sys.argv[1])
    voice = json.load(open(os.path.join(epdir, 'script.json'), encoding='utf-8'))['voice']
    text = open(os.path.join(ROOT, voice['ref_text']), encoding='utf-8').read().strip()
    torch.manual_seed(voice.get('design_seed', 11))
    model = Qwen3TTSModel.from_pretrained(os.path.join(MODELS, 'Qwen3-TTS-12Hz-1.7B-VoiceDesign'), device_map='cpu', dtype=torch.float32)
    wavs, sr = model.generate_voice_design(text=text, language=voice.get('language', 'Chinese'), instruct=voice['design'])
    x = np.asarray(wavs[0], dtype=np.float32)
    out = os.path.join(ROOT, voice['ref_audio'])
    os.makedirs(os.path.dirname(out), exist_ok=True)
    sf.write(out, x, sr)
    print(f'{out}: {len(x) / sr:.1f}s')


if __name__ == '__main__':
    main()

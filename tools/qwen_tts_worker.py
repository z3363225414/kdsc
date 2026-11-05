#!/usr/bin/env python3
"""Qwen3-TTS 合成子进程：由 tools/tts.py 调用（Qwen3-TTS 依赖 torch，和 sherpa-onnx 分开装）。

用法：$QWEN_PY tools/qwen_tts_worker.py jobs.json
jobs.json: {"mode": "custom" | "clone", "model": 模型目录, "language": "Chinese", "seed": 7,
            custom 模式："speaker": "Dylan", "instruct": "..."
            clone 模式："ref_audio": 参考音频, "ref_text": 参考音频的文字,
            "jobs": [{"text": "...", "out": "xxx.wav", "take": 0, "instruct": "这一句的语气（可省略）"}, ...]}

clone 模式用的参考音频是 VoiceDesign 模型按文字描述“设计”出来的声音（见 tools/design_voice.py），不是真人录音。
模型（Apache-2.0）：Qwen3-TTS-12Hz-1.7B-CustomVoice / -Base / -VoiceDesign，https://huggingface.co/Qwen
"""
import json
import os
import sys
import time

import numpy as np
import soundfile as sf
import torch

torch.set_num_threads(int(os.environ.get('TTS_THREADS', '3')))
from qwen_tts import Qwen3TTSModel  # noqa: E402


def main():
    cfg = json.load(open(sys.argv[1], encoding='utf-8'))
    t0 = time.time()
    model = Qwen3TTSModel.from_pretrained(cfg['model'], device_map='cpu', dtype=torch.float32)
    lang = cfg.get('language', 'Chinese')
    if cfg.get('mode') == 'clone':
        ref, sr = sf.read(cfg['ref_audio'], dtype='float32')
        prompt = model.create_voice_clone_prompt(ref_audio=(ref, sr), ref_text=cfg['ref_text'])
        gen = lambda text, instruct=None: model.generate_voice_clone(text=text, language=lang, voice_clone_prompt=prompt)
    else:
        gen = lambda text, instruct=None: model.generate_custom_voice(text=text, language=lang, speaker=cfg['speaker'], instruct=(instruct or cfg.get('instruct')) or None)
    print(f'qwen3-tts loaded in {time.time() - t0:.0f}s', flush=True)
    for i, job in enumerate(cfg['jobs']):
        # 每句固定随机种子：同一句话重跑结果一样，换一个 take 就是“重录一遍”
        torch.manual_seed(cfg.get('seed', 7) + job.get('take', 0))
        t1 = time.time()
        wavs, sr = gen(job['text'], job.get('instruct'))
        x = np.asarray(wavs[0], dtype=np.float32)
        sf.write(job['out'], x, sr)
        print(f"  [{i + 1}/{len(cfg['jobs'])}] {len(x) / sr:.1f}s audio, {time.time() - t1:.0f}s", flush=True)


if __name__ == '__main__':
    main()

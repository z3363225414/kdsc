#!/usr/bin/env python3
"""从 HuggingFace 下载整个模型仓库到 models/<仓库名>，断了自动续传、重试（大文件经常被连接重置）。

用法：python3 tools/hf_download.py Qwen/Qwen3-TTS-12Hz-1.7B-Base
需要环境能访问 huggingface.co（云端环境的网络设置里放行）。
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    repo = sys.argv[1]
    d = os.path.join(os.environ.get('MODELS_DIR', os.path.join(ROOT, 'models')), repo.split('/')[1])
    tree = json.load(urllib.request.urlopen(f'https://huggingface.co/api/models/{repo}/tree/main?recursive=true'))
    ok = True
    for x in tree:
        if x['type'] != 'file':
            continue
        f, size = x['path'], x.get('lfs', {}).get('size', x.get('size', 0))
        p = os.path.join(d, f)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        for _ in range(30):
            if os.path.exists(p) and os.path.getsize(p) == size:
                break
            subprocess.run(['curl', '-sS', '-L', '-C', '-', '--retry', '5', '--retry-delay', '3', '-o', p, f'https://huggingface.co/{repo}/resolve/main/{f}'])
            time.sleep(1)
        done = os.path.exists(p) and os.path.getsize(p) == size
        ok &= done
        print(f, 'OK' if done else 'INCOMPLETE', flush=True)
    print('done' if ok else 'INCOMPLETE', repo)
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()

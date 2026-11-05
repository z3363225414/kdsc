#!/usr/bin/env bash
# 分批配音、每批念完就提交推送（额度用完、会话中断时，已经念好的句子不会丢）。
#   tools/tts_batches.sh ep03-hungergames [每批句数=6]
# 已经有缓存的句子 tts.py 会跳过；全部念完后不带 --only 再跑一次，写出时间轴和整条旁白。
set -uo pipefail
EP=${1:?usage: tools/tts_batches.sh <episode-dir> [batch]}
B=${2:-6}
cd "$(dirname "$0")/.."
IDS=$(python3 -c "import json; s=json.load(open('$EP/script.json', encoding='utf-8')); print(' '.join(l['id'] for sc in s['scenes'] for l in sc['lines']))")
set -- $IDS
while [ $# -gt 0 ]; do
  batch=$(echo "${@:1:$B}" | tr ' ' ','); shift $(( $# < B ? $# : B ))
  echo "== batch $batch"
  TTS_THREADS=${TTS_THREADS:-4} python3 tools/tts.py "$EP" --only "$batch"
  for d in 1 2 4 8; do
    git add "$EP/data/tts" && git commit -q -m "$EP: voiced $batch" -m "Partial voice-over saved so an interrupted run can resume." ${GIT_TRAILERS:+-m "$GIT_TRAILERS"} -- "$EP/data/tts" && break
    sleep $d
  done
  for d in 2 4 8 16; do git push -q origin HEAD && break || sleep $d; done
done
# 全部句子都有了：写时间轴、整条旁白、字幕
TTS_THREADS=${TTS_THREADS:-4} python3 tools/tts.py "$EP"
echo "ALL DONE"

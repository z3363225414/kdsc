#!/usr/bin/env bash
# 一键出片：旁白 → 时间轴 → 音效点 → 混音 → 逐帧渲染 → 编码
#   tools/build.sh ep01-bedwars   （改了文字时先运行 tools/subset_font.py 重新裁剪字体）
set -euo pipefail
EP=${1:?usage: tools/build.sh <episode-dir>}
cd "$(dirname "$0")/.."
PY=${PYTHON:-python3}
$PY tools/tts.py "$EP"
node tools/render.mjs "$EP" cues
$PY tools/audio.py "$EP"
node tools/render.mjs "$EP" cover
rm -rf "$EP/out/frames"
node tools/render.mjs "$EP" frames --workers "${WORKERS:-2}"
# 画面每帧都有胶片颗粒，CRF 20 会超过 GitHub 单文件 100MB 上限，所以默认用 CRF 23（可用 CRF=26 覆盖）
ffmpeg -y -loglevel error -framerate 30 -i "$EP/out/frames/%06d.jpg" -i "$EP/assets/audio/mix.m4a" \
  -map 0:v -map 1:a -c:v libx264 -preset slow -crf ${CRF:-23} -tune animation -pix_fmt yuv420p \
  -c:a copy -movflags +faststart -shortest "$EP/out/$EP-1080p.mp4"
node tools/render.mjs "$EP" sheet 36
echo "done: $EP/out/$EP-1080p.mp4"

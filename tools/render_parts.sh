#!/usr/bin/env bash
# 分段渲染（可断点续做）：每段 SEG 秒（默认 20 秒 = 600 帧）渲染完立刻编码成 out/parts/partNNN.mp4，
# 设了 COMMIT=1 时每段编码完就提交、推送到当前分支。中途断了（额度用完、容器被回收），
# 下次重新运行同一条命令，已经有的段会跳过，从缺的那段接着渲染；全部完成后拼接成片、混入音轨。
#   COMMIT=1 tools/render_parts.sh ep02-skywars
# 多台机器（或多个会话）分头渲染：PARTS=0-3 只渲第 0–3 段，渲完提交推送就退出（不拼接）；
# 各段都齐了以后，不带 PARTS 再跑一遍，已有的段全部跳过，直接拼接成片。
# GIT_TRAILERS 里的文字会附在每个提交说明的末尾（比如署名行）。
# 前提：data/timeline.json 和 assets/audio/mix.m4a 已经是最终版（改了配音或画面，要先删掉 out/parts 重来）。
set -euo pipefail
EP=${1:?usage: tools/render_parts.sh <episode-dir>}
cd "$(dirname "$0")/.."
SEG=${SEG:-20}
FPS=${FPS:-30}          # FPS=60：第一人称的画面转视角更顺（渲染时间翻倍）
DUR=$(python3 -c "import json; print(json.load(open('$EP/data/timeline.json'))['duration'])")
N=$(python3 -c "import math; print(math.ceil($DUR / $SEG))")
mkdir -p "$EP/out/parts"
# 提交并推送一段。git 正忙（另一个提交拿着 index.lock）就等一会儿再试；
# 上次渲完却没提交上的段，下次运行时补交。
save() {
  [ -n "${COMMIT:-}" ] || return 0
  [ -n "$(git ls-tree HEAD -- "$1")" ] && return 0
  for d in 1 2 4 8 16 32; do
    git add -f "$1" && git commit -q -m "$2" -m "Partial render saved so an interrupted render can resume from the next part." \
      ${GIT_TRAILERS:+-m "$GIT_TRAILERS"} && break
    sleep $d
  done
  # 还没有远程仓库（origin）时只在本地提交，等加上 origin 再一起推送
  git remote get-url origin >/dev/null 2>&1 || return 0
  # 别的机器可能也在往同一个分支推（各推各的段，文件不重叠），先变基再推
  local br; br=$(git rev-parse --abbrev-ref HEAD)
  for d in 2 4 8 16 32; do git pull -q --rebase --autostash origin "$br" && git push -q origin HEAD && break || sleep $d; done
}
P0=0; P1=$((N - 1))
if [ -n "${PARTS:-}" ]; then P0=${PARTS%-*}; P1=${PARTS#*-}; fi
for ((i = P0; i <= P1 && i < N; i++)); do
  part=$(printf "%s/out/parts/part%03d.mp4" "$EP" "$i")
  from=$((i * SEG))
  to=$(python3 -c "print(min($DUR, ($i + 1) * $SEG))")
  msg="$EP: rendered part $((i + 1))/$N (${from}s–${to}s)"
  if [ -f "$part" ]; then save "$part" "$msg"; continue; fi
  rm -rf "$EP/out/frames"
  node tools/render.mjs "$EP" frames --workers "${WORKERS:-2}" --fps "$FPS" --from "$from" --to "$to"
  # 画面每帧都有胶片颗粒；CRF 23 和 tools/build.sh 一致
  mkdir -p "$EP/out/parts"
  ffmpeg -y -loglevel error -framerate "$FPS" -start_number $((from * FPS)) -i "$EP/out/frames/%06d.jpg" \
    -c:v libx264 -preset slow -crf "${CRF:-23}" -tune animation -pix_fmt yuv420p "$part.tmp.mp4"
  mv "$part.tmp.mp4" "$part"
  rm -rf "$EP/out/frames"
  echo "$(date +%H:%M) part $((i + 1))/$N done: $part"
  save "$part" "$msg"
done
if [ -n "${PARTS:-}" ]; then echo "parts $PARTS done"; exit 0; fi
# 拼接：各段编码参数相同，直接拷贝码流；再混入音轨
list="$EP/out/parts/list.txt"
: > "$list"
for ((i = 0; i < N; i++)); do printf "file 'part%03d.mp4'\n" "$i" >> "$list"; done
ffmpeg -y -loglevel error -f concat -safe 0 -i "$list" -i "$EP/assets/audio/mix.m4a" \
  -map 0:v -map 1:a -c:v copy -c:a copy -movflags +faststart -shortest "$EP/out/$EP-1080p.mp4"
rm -f "$list"
echo "done: $EP/out/$EP-1080p.mp4"

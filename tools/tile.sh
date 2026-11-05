#!/usr/bin/env bash
# 把若干张截图拼成一张检查图：tile.sh out.jpg cols width img1 img2 ...
out=$1; cols=$2; w=$3; shift 3
n=$#; rows=$(( (n + cols - 1) / cols ))
args=(); for f in "$@"; do args+=(-i "$f"); done
inputs=""; for i in $(seq 0 $((n-1))); do inputs+="[$i:v]scale=$w:-1[v$i];"; done
layout=""; for i in $(seq 0 $((n-1))); do x=$(( (i % cols) * (w + 6) )); y=$(( (i / cols) * (w * 9 / 16 + 6) )); layout+="${x}_${y}|"; done
stack=""; for i in $(seq 0 $((n-1))); do stack+="[v$i]"; done
ffmpeg -y -loglevel error "${args[@]}" -filter_complex "${inputs}${stack}xstack=inputs=$n:layout=${layout%|}:fill=0x202020" -frames:v 1 "$out"

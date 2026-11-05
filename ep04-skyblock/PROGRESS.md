# EP04 空岛生存 · 制作进度（断点续做用）

> 额度用完或中途停下时，下次打开会话（或定时任务唤醒时）先读这里，从“下一步”接着做。命令都在仓库根目录运行。
> 每完成一步：更新本文件 → 提交 → `git push origin main`。

## 目标

《我的世界小游戏起源》第四期：空岛生存（Skyblock）是从哪来的、怎么一路长成今天的样子。
形式和第三期饥饿游戏一样：**边玩一局空岛生存，边讲它的历史**（第一人称实况，每到一步弹出原版样式的“进度达成”讲一段）。
画面是 Three.js 现搭的方块世界，旁白、配乐、音效都由代码生成。流畅度第一：动作全部由 `src/motion.js` 逐 tick 模拟。

## 代码从哪来

- `tools/`、`src/`（含 `motion.js` 动作系统）、`vendor/`、`assets/fonts/`、`assets/voice/` 从 EP03（`z3363225414/jeyx` 提交 1eea6c0）复制。
- `src/scenes.js` 现在还是饥饿游戏的场景，**要整个换成空岛生存**（饥饿游戏的版本留在 jeyx 里作参考）。
- 字体是按 EP03 的字裁剪的，定稿后要重新裁剪（`tools/subset_font.py`，源字体下载见 jeyx 的 PROGRESS.md）。

## 计划（一局空岛生存的第一人称实况）

开局站在原版那座 L 形小岛上（一棵树、一个箱子、脚下是虚空）→ 打树、做工作台 → 开箱子（岩浆桶、冰）→
做刷石机（岩浆 + 水 = 圆石）→ 挖圆石、扩建小岛 → 种地 / 刷怪 → 结尾：小岛长成一座基地。
需要在动作系统里新加：**挖方块**（原版的裂纹 10 段、挖掉的瞬间掉落物飞出来）、**倒水 / 倒岩浆**、合成界面。

## 进度

- [x] 接入 `kdsc`，复制 EP03 的工具链和代码，写 `CLAUDE.md`、本文件、`FEEDBACK.md`
- [x] 定时任务 `trig_01VwV2mLCZyaYah3VLEbdjo6`：每 3 小时（:23 分）唤醒这个会话，读本文件接着做（全部完成后关掉）
- [x] 史料检索 → `facts.md`（15 条 + 能说 / 不能说；钩子：2019 年申请商标 → 2026-05-11 裁定“Skyblock”只是描述、不能注册 → 第二天撤下原版地图）
- [x] 分镜旁白 → `script.json`（8 段 25 句，估计 2:50：两条规矩 → 撸树做工作台 → 刷石机 → 扩岛（skyblock.net、ASkyBlock）→ 盖房种地（Hypixel SkyBlock）→ OneBlock → 商标 → 结尾）
- [x] 动作系统扩展：`mine`（对准 → 每 0.25 秒挥一下 → 碎掉，事件 mine / break）、`placeAt`、往虚空里搭路（`bridge` 的 `open`）
- [x] 整期 `scenes.js`：L 形小岛（原木、刷石机的三个坑单独做成方块，可挖）、树叶腐烂、合成界面、箱子界面、刷石机（冰化成水 → 岩浆流过去 → 圆石，挖掉 0.9 秒后再生）、往东搭 4 格圆石、延时（天色走两轮，平台 / 房子 / 农田一块块长出来）、OneBlock、商标裁定卡片；按估计时间轴抽帧检查过
- [x] 配音（4 个云端会话并行，每句 4 遍挑最好）→ 真时间轴 2:26（145.5 秒）；回听全部和原文一致（撸树→卢树、圆石→原石是同音）
- [x] 字体裁剪、音效点、混音（安静版 cheer）；按真时间轴复查抽帧、转身最快 178°/秒
- [x] 分段渲染（60 帧，8 段 × 20 秒，4 个云端会话各渲两段）→ 本机拼接（8732 帧 = 145.53 秒，接缝逐段检查连续）→ 成片 50 MB，不用再压
- [x] **1080p 成片已提交**：`ep04-skyblock/out/ep04-skyblock-1080p.mp4`（第三轮修改后：K10“一格一格地”念四声 dè，只重渲 40–60 秒），分段已撤掉；720p60 预览已发给用户
- [x] 封面（`out/cover.png`、`cover-4x3.png`）、字幕（`out/subtitles.srt`）、`publish.md`、README
- [x] 关掉定时任务 `trig_01VwV2mLCZyaYah3VLEbdjo6`

## 下一步

**全部完成，用户已确认定稿**（第三版预览：“可以 没什么问题”）。用户有意见就先记进 `FEEDBACK.md`，改 `src/scenes.js` 后重新分段渲染（`FPS=60 SEG=20 COMMIT=1 PARTS=a-b tools/render_parts.sh ep04-skyblock`，可分给多个会话）。

## 环境（新会话要先装好）

```bash
pip install "sherpa-onnx>=1.12" numpy soundfile scipy fonttools brotli
pip install --index-url https://download.pytorch.org/whl/cpu torch torchaudio && pip install qwen-tts
python3 tools/hf_download.py Qwen/Qwen3-TTS-12Hz-1.7B-Base      # 需要环境放行 huggingface.co；断了重跑会续传
mkdir -p models && cd models    # 不进仓库（.gitignore）
R=https://github.com/k2-fsa/sherpa-onnx/releases/download
curl -LO $R/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2 && tar xjf sherpa-onnx-sense-voice-*.tar.bz2 && rm sherpa-onnx-sense-voice-*.tar.bz2
```

渲染需要 playwright 和 Chromium（云端容器里已经预装）。

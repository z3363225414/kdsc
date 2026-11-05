#!/usr/bin/env node
// 用无头 Chromium 驱动 index.html，按时间逐帧取画面。
//
//   node tools/render.mjs ep01-bedwars stills 0,3.5,20      # 指定时间点截图 → out/stills/
//   node tools/render.mjs ep01-bedwars sheet 48             # 均匀抽 48 帧拼成联系表 → out/contact-sheet.jpg
//   node tools/render.mjs ep01-bedwars cover                # 封面 → out/cover.png
//   node tools/render.mjs ep01-bedwars cues                 # 导出音效提示点 → data/cues.json
//   node tools/render.mjs ep01-bedwars frames [--fps 30] [--workers 2] [--format jpg|png] [--from s] [--to s]   # 全片帧 → out/frames/
//
// 需要 playwright（本机全局安装的即可）与 Chromium。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  try { return require('playwright'); } catch {}
  const root = execSync('npm root -g').toString().trim();
  return require(path.join(root, 'playwright'));
}
const { chromium } = loadPlaywright();

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [ep, mode, arg] = process.argv.slice(2);
const opt = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; };
const epdir = path.join(ROOT, ep);
const out = path.join(epdir, 'out');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.woff2': 'font/woff2', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.png': 'image/png', '.jpg': 'image/jpeg' };
function serve(dir) {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const p = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!p.startsWith(dir) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function openPage(browser, port) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => console.error('[page error]', e.message));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.error('[console]', m.text()); });
  await page.goto(`http://127.0.0.1:${port}/index.html?render`);
  await page.evaluate(() => window.__ready);
  page.setDefaultTimeout(0);
  return page;
}
const grab = (page, t, type = 'image/png', q = 0.95) => page.evaluate(([t, type, q]) => { window.renderAt(t); return document.getElementById('c').toDataURL(type, q).split(',')[1]; }, [t, type, q]);

const srv = await serve(epdir);
const port = srv.address().port;
// 无 GPU 环境下用 SwiftShader 软件渲染 WebGL
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--force-color-profile=srgb'] });
const tl = JSON.parse(fs.readFileSync(path.join(epdir, 'data', 'timeline.json'), 'utf8'));

try {
  if (mode === 'stills') {
    fs.mkdirSync(path.join(out, 'stills'), { recursive: true });
    const page = await openPage(browser, port);
    for (const t of arg.split(',').map(Number)) {
      const f = path.join(out, 'stills', `t${t.toFixed(2).padStart(7, '0')}.png`);
      fs.writeFileSync(f, Buffer.from(await grab(page, t), 'base64'));
      console.log(f);
    }
  } else if (mode === 'cover') {
    const page = await openPage(browser, port);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'cover.png'), Buffer.from(await grab(page, -1), 'base64'));
    console.log(path.join(out, 'cover.png'));
    // 4:3 封面：整帧渲染，再裁出中间 1440×1080
    const tmp = path.join(out, 'cover-4x3-full.png');
    fs.writeFileSync(tmp, Buffer.from(await grab(page, -2), 'base64'));
    execSync(`ffmpeg -y -loglevel error -i "${tmp}" -vf crop=1440:1080:240:0 "${path.join(out, 'cover-4x3.png')}"`);
    fs.rmSync(tmp);
    console.log(path.join(out, 'cover-4x3.png'));
  } else if (mode === 'sheet') {
    const n = Number(arg || 48);
    const page = await openPage(browser, port);
    const dir = path.join(out, 'sheet');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n * tl.duration;
      fs.writeFileSync(path.join(dir, `${String(i).padStart(3, '0')}.jpg`), Buffer.from(await grab(page, t, 'image/jpeg', 0.85), 'base64'));
    }
    const cols = 6;
    execSync(`ffmpeg -y -loglevel error -framerate 1 -i "${dir}/%03d.jpg" -vf "scale=480:-1,tile=${cols}x${Math.ceil(n / cols)}:padding=6:color=0x202020" -frames:v 1 "${out}/contact-sheet.jpg"`);
    console.log(path.join(out, 'contact-sheet.jpg'));
  } else if (mode === 'probe') {
    // 量镜头：每 1/30 秒取一次位置和朝向，列出转头、移动最快的地方（看有没有不像真人的急转）
    const page = await openPage(browser, port);
    const rows = await page.evaluate(d => { const out = []; for (let t = 0; t < d; t += 1 / 30) out.push([t, ...window.__camProbe(t)]); return out; }, tl.duration);
    const sp = [];
    for (let i = 1; i < rows.length; i++) {
      const [t, x, y, z, yw, pt] = rows[i], [, x0, y0, z0, yw0, pt0] = rows[i - 1];
      let dy = yw - yw0; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
      sp.push({ t: t.toFixed(2), turn: Math.round(Math.hypot(dy, pt - pt0) * 30 * 180 / Math.PI), move: +(Math.hypot(x - x0, z - z0) * 30).toFixed(1) });
    }
    console.log('fastest turns (deg/s):', sp.slice().sort((a, b) => b.turn - a.turn).slice(0, 8).map(r => `${r.t}s ${r.turn}`).join(', '));
    console.log('fastest moves (blocks/s):', sp.slice().sort((a, b) => b.move - a.move).slice(0, 8).map(r => `${r.t}s ${r.move}`).join(', '));
  } else if (mode === 'cues') {
    const page = await openPage(browser, port);
    const cues = await page.evaluate(() => window.collectCues());
    fs.writeFileSync(path.join(epdir, 'data', 'cues.json'), JSON.stringify(cues, null, 1));
    console.log(`${cues.length} cues -> data/cues.json`);
  } else if (mode === 'frames') {
    const fps = Number(opt('fps', 30)), workers = Number(opt('workers', 2)), jpg = opt('format', 'jpg') === 'jpg';
    const from = Number(opt('from', 0)), to = Number(opt('to', tl.duration));
    const dir = path.join(out, 'frames');
    fs.mkdirSync(dir, { recursive: true });
    const f0 = Math.round(from * fps), f1 = Math.round(to * fps);
    let next = f0, done = 0;
    const t0 = Date.now();
    await Promise.all(Array.from({ length: workers }, async () => {
      const page = await openPage(browser, port);
      while (next < f1) {
        const f = next++;
        const b64 = await grab(page, f / fps, jpg ? 'image/jpeg' : 'image/png', 0.95);
        fs.writeFileSync(path.join(dir, `${String(f).padStart(6, '0')}.${jpg ? 'jpg' : 'png'}`), Buffer.from(b64, 'base64'));
        if (++done % 150 === 0) {
          const rate = done / ((Date.now() - t0) / 1000);
          console.log(`${done}/${f1 - f0} frames, ${rate.toFixed(1)} fps, eta ${((f1 - f0 - done) / rate / 60).toFixed(1)} min`);
        }
      }
      await page.close();
    }));
    console.log(`frames ${f0}..${f1 - 1} -> ${dir}`);
  } else {
    console.error('unknown mode', mode);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  srv.close();
}

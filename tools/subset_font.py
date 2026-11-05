#!/usr/bin/env python3
"""把字体裁成只含本集用到的字（几 MB → 几十 KB）。

用法：
  python tools/subset_font.py ep01-bedwars \
      --pixel  path/to/fusion-pixel-12px-proportional-zh_hans.ttf \
      --noto   path/to/dir-with-NotoSansSC-{Medium,Bold,Black}.otf \
      --serif  path/to/dir-with-NotoSerifSC-{SemiBold,Black}.otf

字体（均为 SIL OFL 1.1）：
  Fusion Pixel Font  https://github.com/TakWolf/fusion-pixel-font
  Noto Sans SC / Noto Serif SC  https://github.com/notofonts/noto-cjk
"""
import argparse
import glob
import os

from fontTools import subset

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def used_chars(epdir):
    chars = set(chr(c) for c in range(0x20, 0x7f))
    chars |= set('，。；：、！？“”‘’（）《》——…·×→←↑↓★☆✖✔＝')
    files = [os.path.join(epdir, 'script.json'), os.path.join(epdir, 'index.html')]
    files += glob.glob(os.path.join(epdir, 'src', '*.js'))
    for f in files:
        if os.path.exists(f):
            with open(f, encoding='utf-8') as fh:
                chars |= set(fh.read())
    return ''.join(sorted(c for c in chars if c.isprintable()))


def make_subset(src, out, text):
    opts = subset.Options()
    opts.flavor = 'woff2'
    opts.layout_features = ['*']
    opts.name_IDs = ['*']
    opts.notdef_outline = True
    font = subset.load_font(src, opts)
    sub = subset.Subsetter(opts)
    sub.populate(text=text)
    sub.subset(font)
    subset.save_font(font, out, opts)
    print(f'{os.path.basename(src)} -> {os.path.relpath(out, ROOT)} ({os.path.getsize(out) // 1024} KB)')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('episode')
    ap.add_argument('--pixel')
    ap.add_argument('--noto')
    ap.add_argument('--serif')
    a = ap.parse_args()
    epdir = os.path.join(ROOT, a.episode)
    fonts = os.path.join(epdir, 'assets', 'fonts')
    text = used_chars(epdir)
    print(f'{len(text)} chars')
    if a.pixel:
        make_subset(a.pixel, os.path.join(fonts, 'fusion-pixel-12px-zh_hans.woff2'), text)
    if a.noto:
        for weight, name in [(500, 'Medium'), (700, 'Bold'), (900, 'Black')]:
            make_subset(os.path.join(a.noto, f'NotoSansSC-{name}.otf'), os.path.join(fonts, f'NotoSansSC-{weight}.woff2'), text)
    if a.serif:
        for weight, name in [(600, 'SemiBold'), (900, 'Black')]:
            make_subset(os.path.join(a.serif, f'NotoSerifSC-{name}.otf'), os.path.join(fonts, f'NotoSerifSC-{weight}.woff2'), text)


if __name__ == '__main__':
    main()

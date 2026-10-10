#!/usr/bin/env python3
"""生成 Agent Panel 图标：蓝色圆角方块 + 三根白色数据条（对应面板的用量条形图）。

依赖：Pillow（仅生成时需要，运行时不需要）
    python3 -m venv /tmp/imgvenv && /tmp/imgvenv/bin/pip install pillow
    /tmp/imgvenv/bin/python desktop/make-logo.py

输出：
    web/favicon.ico           多尺寸图标（Edge 应用窗口 / 浏览器标签页 用）
    web/logo.svg              页面头部 logo（矢量）
    desktop/logo/logo-256.png 256px 源图
"""

import os
import sys

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ACCENT_TOP = (77, 132, 255, 255)   # #4d84ff
ACCENT_BOTTOM = (47, 107, 255, 255)  # #2f6bff（与面板 --accent 一致）
BAR = (255, 255, 255, 255)
SS = 8  # 超采样倍数（先大后缩，得到抗锯齿边缘）

# 几何比例（相对画布边长，与 logo.svg 的 64×64 viewBox 一致）
RADIUS_RATIO = 14 / 64
BAR_WIDTH = 8 / 64
BAR_X = [15 / 64, 28 / 64, 41 / 64]
BAR_TOP = [34 / 64, 24 / 64, 14 / 64]
BAR_BOTTOM = 50 / 64
BAR_RADIUS_RATIO = 3.2 / 8  # 圆角相对条宽

SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Agent Panel">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4d84ff"/>
      <stop offset="1" stop-color="#2f6bff"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#bg)"/>
  <g fill="#ffffff">
    <rect x="15" y="34" width="8" height="16" rx="3.2"/>
    <rect x="28" y="24" width="8" height="26" rx="3.2"/>
    <rect x="41" y="14" width="8" height="36" rx="3.2"/>
  </g>
</svg>
"""


def gradient(size: int) -> Image.Image:
    top, bottom = ACCENT_TOP, ACCENT_BOTTOM
    img = Image.new("RGBA", (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        img.putpixel((0, y), tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(4)))
    return img.resize((size, size))


def render(size: int) -> Image.Image:
    w = size * SS
    canvas = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    mask = Image.new("L", (w, w), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, w - 1], radius=round(w * RADIUS_RATIO), fill=255)
    canvas.paste(gradient(w), (0, 0), mask)

    draw = ImageDraw.Draw(canvas)
    bar_w = w * BAR_WIDTH
    radius = bar_w * BAR_RADIUS_RATIO
    for x, top in zip(BAR_X, BAR_TOP):
        draw.rounded_rectangle(
            [w * x, w * top, w * x + bar_w, w * BAR_BOTTOM],
            radius=radius,
            fill=BAR,
        )
    return canvas.resize((size, size), Image.LANCZOS)


def main() -> int:
    sizes = [16, 24, 32, 48, 64, 128, 256]
    images = {size: render(size) for size in sizes}

    favicon = os.path.join(ROOT, "web", "favicon.ico")
    base = images[256]
    base.save(favicon, format="ICO", sizes=[(s, s) for s in sizes], append_images=[images[s] for s in sizes[:-1]])

    logo_dir = os.path.join(ROOT, "desktop", "logo")
    os.makedirs(logo_dir, exist_ok=True)
    images[256].save(os.path.join(logo_dir, "logo-256.png"))
    with open(os.path.join(ROOT, "web", "logo.svg"), "w", encoding="utf-8") as fh:
        fh.write(SVG)
    # rsrc 用：Windows 可执行文件图标（可由 ico 生成 .syso）
    images[256].save(os.path.join(logo_dir, "logo.ico"), format="ICO", sizes=[(s, s) for s in sizes], append_images=[images[s] for s in sizes[:-1]])

    print(f"✓ web/favicon.ico（{', '.join(f'{s}px' for s in sizes)}）")
    print("✓ web/logo.svg")
    print("✓ desktop/logo/logo-256.png, desktop/logo/logo.ico")
    return 0


if __name__ == "__main__":
    sys.exit(main())

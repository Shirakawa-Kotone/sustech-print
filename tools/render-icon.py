#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 build/icon.svg 光栅化成全套图标资源。

为什么单独有这么一个脚本，而不是继续用 desktop/make-icons.mjs：
make-icons.mjs 是手写的程序化图形（无第三方依赖，仓库里不存二进制素材）。
后来图标改成由一份 SVG 提供，就需要一个真正的矢量光栅化器。cairosvg 是
目前最省事的那个，代价是它只在这台 Mac 上（brew install cairosvg）。

依赖（只在改图标时需要，打包/运行都不需要）：
    brew install cairosvg        # 会带上 Pillow

用法：
    python3 tools/render-icon.py

产物：
    build/icon.png                    1024x1024  macOS 打包
    build/icon.ico                    16/24/32/48/64/128/256  Windows 打包
    desktop/assets/tray.png           32x32      Windows 托盘（彩色）
    desktop/assets/trayTemplate.png   16x16      macOS 托盘（黑 + alpha 模板图）
    desktop/assets/trayTemplate@2x.png 32x32     macOS 托盘高分屏
    screens/icon-preview.png          对比图，给人看的

关于裁切：原 SVG 的 viewBox 是 1024x1024，但实际图形只占中间约 58%，
直接渲染出来四周全是空白、图标会显得很小。所以先渲染一遍量出图形的
alpha 包围盒，再按包围盒反推一个正方形的 viewBox 去渲染每个尺寸。
"""

import io
import os
import re
import struct
import sys

try:
    import cairosvg
    from PIL import Image
except ImportError as exc:  # pragma: no cover - 只在缺依赖时走到
    sys.exit(f"缺少依赖：{exc}\n请先执行：brew install cairosvg")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "build", "icon.svg")
ICON_PNG = os.path.join(ROOT, "build", "icon.png")
ICON_ICO = os.path.join(ROOT, "build", "icon.ico")
TRAY = os.path.join(ROOT, "desktop", "assets", "tray.png")
TRAY_T = os.path.join(ROOT, "desktop", "assets", "trayTemplate.png")
TRAY_T2 = os.path.join(ROOT, "desktop", "assets", "trayTemplate@2x.png")
PREVIEW = os.path.join(ROOT, "screens", "icon-preview.png")

# 图形四周留多少边（占正方形边长的比例）。0.06 => 内容占 88%
MARGIN = 0.06
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def load_svg(path):
    """读 SVG，去掉写死的 width/height，让 viewBox 决定缩放。"""
    with open(path, encoding="utf-8") as fh:
        svg = fh.read()
    # 只去掉 <svg> 上那两个属性：stroke-width 之类前面是连字符，不会被误伤
    svg = re.sub(r'\s(width|height)="[^"]*"', "", svg, count=2, flags=re.IGNORECASE)
    if "viewBox" not in svg:
        raise SystemExit(f"{path} 里没有 viewBox，无法确定坐标系")
    return svg


def with_viewbox(svg, viewbox):
    return re.sub(r'viewBox="[^"]*"', f'viewBox="{viewbox}"', svg, count=1)


def render(svg, size):
    png = cairosvg.svg2png(
        bytestring=svg.encode("utf-8"), output_width=size, output_height=size
    )
    return Image.open(io.BytesIO(png)).convert("RGBA")


def content_viewbox(svg):
    """渲染一遍量出图形包围盒，返回一个把它居中放大的正方形 viewBox。"""
    probe = render(svg, 1024)
    box = probe.getchannel("A").getbbox()
    if box is None:
        raise SystemExit("SVG 渲染出来是空的，检查一下文件")
    left, top, right, bottom = box
    cx, cy = (left + right) / 2, (top + bottom) / 2
    # 取长边，保证内容和正方形四边都有 MARGIN 的余量
    side = max(right - left, bottom - top) / (1 - 2 * MARGIN)
    print(
        f"  内容包围盒 {right - left}x{bottom - top} "
        f"(x {left}..{right}, y {top}..{bottom})  ->  正方形 viewBox 边长 {side:.1f}"
    )
    return f"{cx - side / 2:.2f} {cy - side / 2:.2f} {side:.2f} {side:.2f}"


def encode_ico(entries):
    """entries: [(size, png_bytes)]。Vista 以后 ICO 每一项都可以直接内嵌 PNG。"""
    count = len(entries)
    header = struct.pack("<HHH", 0, 1, count)
    directory = b""
    offset = 6 + 16 * count
    for size, data in entries:
        dim = 0 if size >= 256 else size  # 宽高字段是 1 字节，256 记作 0
        directory += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    return header + directory + b"".join(data for _, data in entries)


def to_template(img):
    """macOS 菜单栏模板图：只保留 alpha，颜色一律涂黑。"""
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.putalpha(img.getchannel("A"))
    return out


def png_bytes(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def write_preview(svg, sizes=(256, 96, 48, 32), cell=288):
    """出一张对比图 —— 写这个脚本的人看不见图，只能给人看。"""
    width, height = cell * len(sizes), cell
    sheet = Image.new("RGBA", (width, height), (0xF5, 0xF6, 0xF8, 255))
    for col, size in enumerate(sizes):
        icon = render(svg, size)
        x = col * cell + (cell - size) // 2
        y = (cell - size) // 2
        sheet.alpha_composite(icon, (x, y))
    sheet.save(PREVIEW)
    print(f"  对比图 {PREVIEW}  ({' / '.join(str(s) for s in sizes)})")


def main():
    if not os.path.exists(SRC):
        sys.exit(f"找不到源图：{SRC}")
    os.makedirs(os.path.dirname(TRAY), exist_ok=True)
    os.makedirs(os.path.dirname(PREVIEW), exist_ok=True)

    base = load_svg(SRC)
    print(f"源图 {SRC}")
    viewbox = content_viewbox(base)
    fitted = with_viewbox(base, viewbox)

    render(fitted, 1024).save(ICON_PNG)
    print(f"  已生成 {ICON_PNG} (1024x1024)")

    entries = [(s, png_bytes(render(fitted, s))) for s in ICO_SIZES]
    with open(ICON_ICO, "wb") as fh:
        fh.write(encode_ico(entries))
    print(f"  已生成 {ICON_ICO} ({'/'.join(str(s) for s in ICO_SIZES)})")

    render(fitted, 32).save(TRAY)
    to_template(render(fitted, 16)).save(TRAY_T)
    to_template(render(fitted, 32)).save(TRAY_T2)
    print(f"  已生成 {TRAY} (32x32)")
    print(f"  已生成 {TRAY_T} (16x16 黑白模板)")
    print(f"  已生成 {TRAY_T2} (32x32 黑白模板)")

    write_preview(fitted)


if __name__ == "__main__":
    main()

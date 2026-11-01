# -*- coding: utf-8 -*-
"""
为 YouTube 下载器生成图标（多尺寸 .ico）

设计思路（贴合程序现有视觉）：
  - 深色圆角方底，呼应前端深色卡片主题（--bg:#0b0d12 / 卡片 #1e2430）
  - YouTube 红（#ff3b5c，与前端 --accent 一致）径向渐变圆盘
  - 白色向下箭头 = 下载
  - 右下角红色播放三角 = 视频
  - 底部白色圆角横线 = 下载到本地

关键：**尺寸自适应**
  Windows 图标在 16/24 这种小尺寸下，细节会糊成一团。
  所以按尺寸分三档，逐档简化元素、加粗笔画：

    档位 A（>= 48px）：完整版 —— 圆盘 + 箭头 + 承托线 + 播放三角徽标
    档位 B（32px）   ：精简版 —— 圆盘 + 加粗箭头 + 承托线，播放三角改为简化小块
    档位 C（<= 24px）：极简版 —— 放大的圆盘 + 粗箭头，**去掉承托线和播放三角**

所有元素都是几何图形绘制，不依赖字体（换机器也不会乱码）。
"""

from PIL import Image, ImageDraw
import os

# ---- 主题色（与前端 CSS 变量保持一致）
BG_TOP      = (30, 36, 48)      # 卡片底色偏亮一档 (#1e2430)
BG_BOT      = (16, 19, 26)      # 更深的底       (#10131a)
ACCENT      = (255, 59, 92)     # --accent / YouTube 红
ACCENT_DARK = (206, 36, 66)     # 强调色暗部
WHITE       = (255, 255, 255)

S = 1024                        # 以 1024 为基准绘制，最后缩小，边缘更干净


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


# --------------------------------------------------------------------------- #
# 基础部件
# --------------------------------------------------------------------------- #

def draw_gradient_bg(size):
    """竖向渐变底"""
    img = Image.new('RGB', (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        d.line([(0, y), (size, y)], fill=lerp(BG_TOP, BG_BOT, y / max(1, size - 1)))
    return img


def rounded_mask(size, radius_ratio=0.22, inset_ratio=0.035):
    """圆角矩形遮罩（Windows 图标那种圆角方胶囊）"""
    mask = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(mask)
    inset = int(size * inset_ratio)
    r = int(size * radius_ratio)
    d.rounded_rectangle([inset, inset, size - inset - 1, size - inset - 1],
                        radius=r, fill=255)
    return mask


def make_base(size):
    """渐变底 + 圆角 + 内描边（让图标在深浅桌面上都有边界感）"""
    grad = draw_gradient_bg(size)
    mask = rounded_mask(size)

    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)

    # 内描边高光，增加立体感
    hl = Image.new('L', (size, size), 0)
    dh = ImageDraw.Draw(hl)
    inset = int(size * 0.035)
    r = int(size * 0.22)
    dh.rounded_rectangle([inset, inset, size - inset - 1, size - inset - 1],
                         radius=r, outline=255, width=max(2, int(size * 0.006)))
    edge = Image.new('RGBA', (size, size), (255, 255, 255, 0))
    edge.putalpha(hl.point(lambda v: int(v * 0.10)))
    return Image.alpha_composite(img, edge)


def draw_arrow(draw, cx, cy, w, h, color, thicken=1.0):
    """
    向下的下载箭头：竖杆 + 下三角箭头头部。
    thicken > 1 时把竖杆加粗（小尺寸下防糊）。
    """
    stem_w = w * 0.30 * thicken
    head_h = h * (0.52 if thicken <= 1.0 else 0.60)
    stem_h = h - head_h

    top_w = stem_w * (0.82 if thicken <= 1.0 else 1.0)
    draw.polygon([
        (cx - top_w / 2, cy - h / 2),
        (cx + top_w / 2, cy - h / 2),
        (cx + stem_w / 2, cy - h / 2 + stem_h),
        (cx - stem_w / 2, cy - h / 2 + stem_h),
    ], fill=color)

    # 箭头三角：略微上移与杆重叠，避免出现接缝
    overlap = head_h * (0.10 if thicken <= 1.0 else 0.18)
    draw.polygon([
        (cx - w / 2, cy - h / 2 + stem_h - overlap),
        (cx + w / 2, cy - h / 2 + stem_h - overlap),
        (cx,          cy + h / 2),
    ], fill=color)


def draw_play(draw, cx, cy, size, color):
    """播放三角（视觉重心略右移，看起来更居中）"""
    h = size
    w = size * 0.88
    ox = w * 0.06
    draw.polygon([
        (cx - w / 2 + ox, cy - h / 2),
        (cx - w / 2 + ox, cy + h / 2),
        (cx + w / 2 + ox, cy),
    ], fill=color)


def draw_disc(img, cx, cy, r, steps=80):
    """强调色径向渐变圆盘（多同心圆近似），返回合成后的图"""
    disc = Image.new('RGBA', img.size, (0, 0, 0, 0))
    dd = ImageDraw.Draw(disc)
    for i in range(steps, 0, -1):
        t = i / steps
        rr = r * t
        col = lerp(ACCENT, ACCENT_DARK, 1 - t)
        dd.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=col + (255,))
    return Image.alpha_composite(img, disc)


# --------------------------------------------------------------------------- #
# 三档设计
# --------------------------------------------------------------------------- #

def icon_full(size):
    """完整版：>= 48px —— 圆盘 + 箭头 + 承托线 + 播放三角徽标"""
    img = make_base(size)
    cx = size / 2

    disc_r = size * 0.245
    disc_cy = size * 0.455
    img = draw_disc(img, cx, disc_cy, disc_r)
    d = ImageDraw.Draw(img)

    # 下载箭头
    draw_arrow(d, cx, disc_cy - disc_r * 0.04,
               disc_r * 0.86, disc_r * 1.00, WHITE)

    # 承托线
    line_w = size * 0.30
    line_y = disc_cy + disc_r * 0.62
    line_h = max(2, int(size * 0.028))
    d.rounded_rectangle([cx - line_w / 2, line_y, cx + line_w / 2, line_y + line_h],
                        radius=line_h / 2, fill=WHITE + (235,))

    # 右下角播放三角徽标
    tri_sz = size * 0.155
    tcx = size * 0.755
    tcy = size * 0.735
    pad_r = tri_sz * 0.78
    pad = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    dp = ImageDraw.Draw(pad)
    dp.ellipse([tcx - pad_r, tcy - pad_r, tcx + pad_r, tcy + pad_r],
               fill=(12, 15, 21, 235))
    img = Image.alpha_composite(img, pad)
    d = ImageDraw.Draw(img)
    draw_play(d, tcx, tcy, tri_sz, ACCENT)
    return img


def icon_mid(size):
    """精简版：32px —— 圆盘放大 + 加粗箭头 + 承托线，播放三角做成简化实心块"""
    img = make_base(size)
    cx = size / 2

    disc_r = size * 0.270
    disc_cy = size * 0.455
    img = draw_disc(img, cx, disc_cy, disc_r)
    d = ImageDraw.Draw(img)

    draw_arrow(d, cx, disc_cy - disc_r * 0.06,
               disc_r * 0.90, disc_r * 1.00, WHITE, thicken=1.25)

    # 承托线：加粗、缩短，避免与圆盘边缘糊在一起
    line_w = size * 0.26
    line_y = disc_cy + disc_r * 0.66
    line_h = max(2, int(size * 0.045))
    d.rounded_rectangle([cx - line_w / 2, line_y, cx + line_w / 2, line_y + line_h],
                        radius=line_h / 2, fill=WHITE + (240,))

    # 右下角播放三角：小尺寸下不要圆形垫底（会糊），只留三角 + 细描边
    tri_sz = size * 0.20
    tcx = size * 0.760
    tcy = size * 0.745
    pad_r = tri_sz * 0.70
    pad = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    dp = ImageDraw.Draw(pad)
    dp.ellipse([tcx - pad_r, tcy - pad_r, tcx + pad_r, tcy + pad_r],
               fill=(14, 17, 23, 255))
    img = Image.alpha_composite(img, pad)
    d = ImageDraw.Draw(img)
    draw_play(d, tcx, tcy, tri_sz, ACCENT)
    return img


def icon_mini(size):
    """极简版：<= 24px —— 只留放大的圆盘 + 粗箭头，去掉所有装饰"""
    img = make_base(size)
    cx = size / 2
    cy = size / 2

    disc_r = size * 0.335
    img = draw_disc(img, cx, cy, disc_r, steps=40)
    d = ImageDraw.Draw(img)

    # 小尺寸下箭头要又粗又短，才看得清
    draw_arrow(d, cx, cy, disc_r * 1.00, disc_r * 1.12, WHITE, thicken=1.45)
    return img


def icon_tiny(size):
    """
    极小版：16px —— 这个尺寸下圆盘+箭头必然互相吞噬（可用的像素太少）。
    改用「红底 + 大号白箭头」，箭头占满圆盘、笔画拉粗，
    牺牲圆盘轮廓感，换取一眼能认出「下载」。
    """
    img = make_base(size)
    cx = size / 2
    cy = size / 2

    # 圆盘几乎占满图标，红色成为主视觉
    disc_r = size * 0.365
    img = draw_disc(img, cx, cy, disc_r, steps=32)
    d = ImageDraw.Draw(img)

    # 箭头放大 + 笔画加粗到极限，保证 16px 下仍是清晰的白箭头
    draw_arrow(d, cx, cy, disc_r * 1.18, disc_r * 1.30, WHITE, thicken=1.75)
    return img


def draw_icon(size):
    """按尺寸选档位"""
    if size >= 48:
        return icon_full(size)
    if size >= 32:
        return icon_mid(size)
    if size >= 24:
        return icon_mini(size)
    return icon_tiny(size)


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #

SIZES = [256, 128, 64, 48, 32, 24, 16]


def main():
    # 图标输出到程序根目录（tools 的上一级）
    out_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    # 大图 PNG 用完整版设计（1024 基准）
    master = icon_full(S)
    master.save(os.path.join(out_dir, 'app-icon.png'), 'PNG')

    # 每个尺寸单独绘制，而不是从大图缩 —— 小尺寸才能保清晰
    frames = [draw_icon(s) for s in SIZES]

    ico_path = os.path.join(out_dir, 'app-icon.ico')
    frames[0].save(ico_path, format='ICO',
                   sizes=[(s, s) for s in SIZES],
                   append_images=frames[1:])

    print('已生成:', ico_path)
    print('已生成:', os.path.join(out_dir, 'app-icon.png'))
    for s in SIZES:
        tag = ('完整' if s >= 48 else
               '精简' if s >= 32 else
               '极简' if s >= 24 else '极小')
        print('  {:>3}x{:<3} -> {}版'.format(s, s, tag))


if __name__ == '__main__':
    main()

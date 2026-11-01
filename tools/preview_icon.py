# -*- coding: utf-8 -*-
"""生成图标展示图（给用户看效果用的交付预览）"""
from PIL import Image
import os

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

master = Image.open(os.path.join(root, 'app-icon.png')).convert('RGBA')
ico_path = os.path.join(root, 'app-icon.ico')

# 各尺寸单独渲染（避免 IcoImagePlugin 的 size 属性切换限制）
frames = {}
for s in [256, 128, 64, 48, 32, 24, 16]:
    f = Image.open(ico_path)
    f.size = (s, s)
    frames[s] = f.copy().convert('RGBA')

BIG = 380
cell = 150
pad = 18
show = [64, 48, 32, 16]
W = BIG + len(show) * (cell + pad) + pad
H = BIG
canvas = Image.new('RGB', (W, H), (18, 20, 26))

m = master.resize((BIG, BIG), Image.LANCZOS)
canvas.paste(m, (0, 0), m)

for i, s in enumerate(show):
    f = frames[s].resize((cell, cell), Image.LANCZOS)
    x = BIG + pad + i * (cell + pad)
    canvas.paste(f, (x, (H - cell) // 2), f)

out = os.path.join(root, 'icon-showcase.png')
canvas.save(out)
print('展示图:', out, canvas.size)

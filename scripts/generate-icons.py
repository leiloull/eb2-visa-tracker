#!/usr/bin/env python3
"""从源图标生成 iOS / Android 应用图标与启动屏。

源图：assets/icon-source.png（1024x1024，白底 + 绿色上升箭头 #12B866）。
用法：python scripts/generate-icons.py
依赖：Pillow（pip install pillow）

设计原则：
- 普通 launcher / AppIcon：整图等比缩放（保留白底）。
- Android adaptive foreground：白底转透明，箭头缩到安全区（约 66% 画布），背景单独用白色。
- Splash：白底 + 居中箭头（缩小到 22% 短边），保持极简。
"""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets', 'icon-source.png')

GREEN = (18, 184, 102)       # #12B866
WHITE = (255, 255, 255, 255)


def load():
    im = Image.open(SRC).convert('RGBA')
    assert im.width == im.height, '源图必须是正方形'
    return im


def save(im, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.convert('RGBA').save(path)


def resized(im, size):
    return im.resize((size, size), Image.LANCZOS)


def make_foreground(im, size):
    """白底 -> 透明，箭头保留并缩到 adaptive icon 安全区（中心 66%）。"""
    fg = im.convert('RGBA')
    px = fg.load()
    w, h = fg.size
    # 把接近白色的像素 alpha 置 0，其余保留原色（抗锯齿边缘按亮度渐隐）
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            # 白色（或接近白）透明化；用最小通道判断，避免误伤绿色
            if r > 240 and g > 240 and b > 240:
                px[x, y] = (r, g, b, 0)
            elif r > 200 and g > 200 and b > 200:
                # 抗锯齿边缘：按与白色的距离设置透明度，保持绿色
                alpha = int(255 * min(1.0, (255 - min(r, g, b)) / 55))
                px[x, y] = (GREEN[0], GREEN[1], GREEN[2], alpha)
    # 缩放箭头到安全区：adaptive 可见区域是画布的 66%（内圈直径）
    safe = int(size * 0.66)
    arrow = fg.resize((safe, safe), Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), (255, 255, 255, 0))
    canvas.alpha_composite(arrow, ((size - safe) // 2, (size - safe) // 2))
    return canvas


def make_splash(w, h):
    """白底 + 居中绿色箭头（短边 22%）。"""
    im = Image.new('RGBA', (w, h), WHITE)
    src = load()
    icon_size = int(min(w, h) * 0.22)
    arrow = resized(src, icon_size)
    im.alpha_composite(arrow, ((w - icon_size) // 2, (h - icon_size) // 2))
    return im


def main():
    src = load()
    print(f'源图: {SRC} {src.size}')

    # ---------- Android launcher 图标 ----------
    densities = {
        'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192,
    }
    # adaptive 前景先用最大规格生成一次，再缩到各密度，避免重复处理源图
    fg192 = make_foreground(load(), 192)
    for name, size in densities.items():
        d = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'res', f'mipmap-{name}')
        icon = resized(src, size)
        save(icon, os.path.join(d, 'ic_launcher.png'))
        save(icon, os.path.join(d, 'ic_launcher_round.png'))
        save(resized(fg192, size), os.path.join(d, 'ic_launcher_foreground.png'))
        print(f'  android mipmap-{name}: {size}px')

    # ---------- iOS AppIcon ----------
    ios_icon = os.path.join(ROOT, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset')
    save(resized(src, 1024), os.path.join(ios_icon, 'AppIcon-512@2x.png'))
    print('  ios AppIcon: 1024x1024')

    # ---------- Android Splash ----------
    splash_specs = {
        'drawable': (320, 480),
        'drawable-land-mdpi': (480, 320),
        'drawable-land-hdpi': (800, 480),
        'drawable-land-xhdpi': (1280, 720),
        'drawable-land-xxhdpi': (1600, 960),
        'drawable-land-xxxhdpi': (1920, 1280),
        'drawable-port-mdpi': (320, 480),
        'drawable-port-hdpi': (480, 800),
        'drawable-port-xhdpi': (720, 1280),
        'drawable-port-xxhdpi': (960, 1600),
        'drawable-port-xxxhdpi': (1280, 1920),
    }
    for folder, (w, h) in splash_specs.items():
        d = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'res', folder)
        make_splash(w, h).save(os.path.join(d, 'splash.png'))
    print('  android splash: 11 档')

    # ---------- iOS Splash ----------
    ios_splash = os.path.join(ROOT, 'ios', 'App', 'App', 'Assets.xcassets', 'Splash.imageset')
    for fn in ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']:
        make_splash(2732, 2732).convert('RGB').save(os.path.join(ios_splash, fn))
    print('  ios splash: 2732x2732 x3')

    print('完成。')


if __name__ == '__main__':
    main()

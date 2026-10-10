# 生成 PWA 图标（PNG）。SVG 图标已存在，这里只补齐 iOS / Android 需要的位图。
# 用法：python tools/make-icons.py
import os
from PIL import Image, ImageDraw, ImageFont

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app-mobile", "public", "icons")

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
]


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def rounded_gradient(size, radius):
    """用竖向渐变近似图标底色。"""
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gradient = Image.new("RGB", (size, size))
    top = (47, 115, 85)
    bottom = (21, 63, 45)
    for y in range(size):
        ratio = y / max(1, size - 1)
        color = tuple(int(top[i] + (bottom[i] - top[i]) * ratio) for i in range(3))
        for x in range(size):
            gradient.putpixel((x, y), color)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    image.paste(gradient, (0, 0), mask)
    return image


def draw_icon(size, maskable=False):
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    radius = int(size * 0.22) if not maskable else int(size * 0.5)
    base = rounded_gradient(size, radius)
    canvas.alpha_composite(base)

    draw = ImageDraw.Draw(canvas)
    # 太阳
    sun_r = size * 0.115
    draw.ellipse(
        [size * 0.17, size * 0.135, size * 0.17 + sun_r * 2, size * 0.135 + sun_r * 2],
        fill=(244, 184, 68, 235),
    )
    # 叶子（简单两片）
    draw.polygon(
        [
            (size * 0.50, size * 0.83),
            (size * 0.62, size * 0.53),
            (size * 0.86, size * 0.41),
            (size * 0.80, size * 0.70),
        ],
        fill=(143, 208, 165, 210),
    )
    draw.polygon(
        [
            (size * 0.50, size * 0.83),
            (size * 0.40, size * 0.55),
            (size * 0.20, size * 0.45),
            (size * 0.26, size * 0.72),
        ],
        fill=(95, 179, 124, 185),
    )

    font = load_font(int(size * 0.46))
    text = "芽"
    bbox = draw.textbbox((0, 0), text, font=font)
    x = (size - (bbox[2] - bbox[0])) / 2 - bbox[0]
    y = size * 0.53 - (bbox[3] - bbox[1]) / 2 - bbox[1]
    draw.text((x, y), text, font=font, fill=(255, 253, 248, 255))
    return canvas


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    outputs = [
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-180.png", 180, False),
        ("icon-maskable-512.png", 512, True),
    ]
    for name, size, maskable in outputs:
        icon = draw_icon(size, maskable)
        path = os.path.join(OUT_DIR, name)
        icon.save(path, "PNG")
        print(f"{name}: {size}x{size} -> {path}")


if __name__ == "__main__":
    main()

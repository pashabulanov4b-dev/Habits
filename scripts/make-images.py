"""Генерує іконки та splash-екрани для iPhone. Запуск: python3 scripts/make-images.py"""
import math
import re
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent / "public"
BG = (6, 7, 10)
LIME = (212, 245, 122)


def background(w, h, scale=1.0):
    img = Image.new("RGB", (w, h), BG)
    glow = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(glow)
    s = min(w, h)
    blobs = [((0.78, 0.18), 0.42, (91, 61, 245)), ((0.15, 0.62), 0.38, (16, 169, 154)), ((0.85, 0.88), 0.30, (120, 150, 40))]
    for (cx, cy), r, col in blobs:
        R = s * r * scale
        x, y = w * cx, h * cy
        d.ellipse([x - R, y - R, x + R, y + R], fill=col)
    glow = glow.filter(ImageFilter.GaussianBlur(s * 0.16))
    return Image.blend(img, glow, 0.55)


def mark(size, pad_ratio=0.22):
    """Скляне коло з салатовим кільцем і галочкою, RGBA."""
    S = size * 4
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    pad = S * pad_ratio
    box = [pad, pad, S - pad, S - pad]
    # скло
    d.ellipse(box, fill=(255, 255, 255, 26), outline=(255, 255, 255, 60), width=int(S * 0.006))
    # кільце
    w = int(S * 0.07)
    inner = [box[0] + w, box[1] + w, box[2] - w, box[3] - w]
    d.arc(inner, start=0, end=360, fill=(255, 255, 255, 34), width=w)
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.arc(inner, start=-90, end=200, fill=LIME + (200,), width=w)
    glow = glow.filter(ImageFilter.GaussianBlur(S * 0.02))
    layer = Image.alpha_composite(layer, glow)
    d = ImageDraw.Draw(layer)
    d.arc(inner, start=-90, end=200, fill=LIME + (255,), width=w)
    # заокруглені кінці дуги
    cx, cy = S / 2, S / 2
    rr = (inner[2] - inner[0]) / 2 - w / 2
    for ang in (-90, 200):
        a = math.radians(ang)
        x, y = cx + rr * math.cos(a), cy + rr * math.sin(a)
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=LIME + (255,))
    # галочка
    pts = [(S * 0.385, S * 0.51), (S * 0.465, S * 0.59), (S * 0.625, S * 0.415)]
    d.line(pts, fill=(242, 244, 247, 255), width=int(S * 0.055), joint="curve")
    for x, y in (pts[0], pts[-1]):
        r = S * 0.0275
        d.ellipse([x - r, y - r, x + r, y + r], fill=(242, 244, 247, 255))
    return layer.resize((size, size), Image.LANCZOS)


def icon(size, pad_ratio=0.2):
    base = background(size, size).convert("RGBA")
    base.alpha_composite(mark(size, pad_ratio))
    return base.convert("RGB")


def badge(size=96):
    img = Image.new("RGBA", (size * 4, size * 4), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    S = size * 4
    pts = [(S * 0.25, S * 0.52), (S * 0.42, S * 0.69), (S * 0.76, S * 0.33)]
    d.line(pts, fill=(255, 255, 255, 255), width=int(S * 0.12), joint="curve")
    for x, y in (pts[0], pts[-1]):
        r = S * 0.06
        d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, 255))
    return img.resize((size, size), Image.LANCZOS)


# (ширина в pt, висота в pt, масштаб) — усі актуальні iPhone
SPLASH = [
    (440, 956, 3), (402, 874, 3), (420, 912, 3), (430, 932, 3), (393, 852, 3), (428, 926, 3),
    (390, 844, 3), (375, 812, 3), (414, 896, 3), (414, 896, 2), (375, 667, 2), (414, 736, 3), (320, 568, 2)
]


def splash(wpt, hpt, sc):
    w, h = wpt * sc, hpt * sc
    img = background(w, h, 1.0).convert("RGBA")
    m = mark(int(w * 0.42), 0.12)
    img.alpha_composite(m, ((w - m.width) // 2, int(h * 0.42 - m.height / 2)))
    return img.convert("RGB")


def main():
    (ROOT / "icons").mkdir(parents=True, exist_ok=True)
    (ROOT / "splash").mkdir(parents=True, exist_ok=True)
    big = icon(1024)
    big.resize((512, 512), Image.LANCZOS).save(ROOT / "icons/icon-512.png", optimize=True)
    big.resize((192, 192), Image.LANCZOS).save(ROOT / "icons/icon-192.png", optimize=True)
    big.resize((180, 180), Image.LANCZOS).save(ROOT / "icons/apple-touch-icon.png", optimize=True)
    icon(1024, 0.28).resize((512, 512), Image.LANCZOS).save(ROOT / "icons/icon-maskable-512.png", optimize=True)
    badge().save(ROOT / "icons/badge-96.png", optimize=True)

    links = []
    for wpt, hpt, sc in SPLASH:
        name = f"splash-{wpt*sc}x{hpt*sc}.png"
        splash(wpt, hpt, sc).save(ROOT / "splash" / name, optimize=True)
        links.append(
            f'  <link rel="apple-touch-startup-image" href="/splash/{name}" '
            f'media="(device-width: {wpt}px) and (device-height: {hpt}px) and (-webkit-device-pixel-ratio: {sc}) and (orientation: portrait)">'
        )
    html_path = ROOT / "index.html"
    html = html_path.read_text(encoding="utf-8")
    block = "<!--SPLASH-->\n" + "\n".join(links) + "\n  <!--/SPLASH-->"
    html = re.sub(r"<!--SPLASH-->(.*?<!--/SPLASH-->)?", lambda _: block, html, count=1, flags=re.S)
    html_path.write_text(html, encoding="utf-8")
    print("ok:", len(links), "splash screens")


if __name__ == "__main__":
    main()

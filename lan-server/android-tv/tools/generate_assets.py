#!/usr/bin/env python3
"""Derive Android TV launcher art from the approved 2026 print artwork."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps

SOURCE = Path("/home/chris/junkyard_olympics/junkyard_olympics_2026_print.png")
ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "app/src/main/res"
DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
CONTENT_BOX = (900, 1200, 3300, 3600)
BG = (26, 24, 18, 255)
ORANGE = (255, 122, 26, 255)


def contain_art(size: int, inset: float) -> Image.Image:
    source = Image.open(SOURCE).convert("RGBA").crop(CONTENT_BOX)
    target = max(1, round(size * inset))
    source.thumbnail((target, target), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size), BG)
    canvas.alpha_composite(source, ((size - source.width) // 2, (size - source.height) // 2))
    return canvas


def font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype("/usr/share/fonts/truetype/liberation/LiberationSansNarrow-Bold.ttf", size)


def save_assets() -> None:
    for density, size in DENSITIES.items():
        out = RES / f"mipmap-{density}"
        out.mkdir(parents=True, exist_ok=True)
        icon = contain_art(size, 0.86)
        icon.save(out / "ic_launcher.png", optimize=True)
        icon.save(out / "ic_launcher_round.png", optimize=True)

    foreground = contain_art(432, 0.64)
    foreground_dir = RES / "drawable"
    foreground_dir.mkdir(parents=True, exist_ok=True)
    foreground.save(foreground_dir / "ic_launcher_foreground.png", optimize=True)

    banner = Image.new("RGBA", (320, 180), BG)
    art = contain_art(112, 1.0)
    banner.alpha_composite(art, (20, 34))
    draw = ImageDraw.Draw(banner)
    draw.text((140, 47), "JUNKYARD", font=font(23), fill=ORANGE, stroke_width=1, stroke_fill=(0, 0, 0, 255))
    draw.text((140, 78), "OLYMPICS", font=font(21), fill=(245, 240, 221, 255), stroke_width=1, stroke_fill=(0, 0, 0, 255))
    draw.text((140, 109), "FIELD TV", font=font(15), fill=(181, 191, 157, 255))
    banner_dir = RES / "drawable-xhdpi"
    banner_dir.mkdir(parents=True, exist_ok=True)
    banner.save(banner_dir / "tv_banner.png", optimize=True)


if __name__ == "__main__":
    save_assets()

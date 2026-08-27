#!/usr/bin/env python3
"""
Generate the extension icon set from the mark the UI already uses.

The mark is not invented here: options.html and popup.html both draw a
circle in --series with a bold white K, so the icon is that same mark at
raster sizes rather than a second, competing logo.

Supersampled 8x and downscaled with LANCZOS. A circle rasterised directly
at 16px has visibly ragged edges, and the toolbar size is the one people
actually look at.

    python tools/make-icons.py
"""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

BRAND = (42, 120, 214, 255)          # --series #2a78d6
WHITE = (255, 255, 255, 255)
SS = 8                                # supersample factor
FONT = "C:/Windows/Fonts/segoeuib.ttf"

# The store shows the 128 in a container that clips tight artwork, so it
# gets breathing room; toolbar sizes need every pixel and get almost none.
PADDING = {16: 0.02, 32: 0.03, 48: 0.03, 128: 0.12}

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"


def render(size: int) -> Image.Image:
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    pad = int(big * PADDING[size])
    box = [pad, pad, big - pad - 1, big - pad - 1]
    draw.ellipse(box, fill=BRAND)

    diameter = box[2] - box[0]
    # Cap height ~0.58 of the circle: large enough to read at 16px, short
    # enough that the glyph never touches the rim.
    font = ImageFont.truetype(FONT, int(diameter * 0.62))

    # Centre on the K's ink, not on its advance width — the two differ enough
    # to look off-centre at small sizes.
    l, t, r, b = draw.textbbox((0, 0), "K", font=font)
    cx = box[0] + diameter / 2
    cy = box[1] + diameter / 2
    draw.text((cx - (l + r) / 2, cy - (t + b) / 2), "K", font=font, fill=WHITE)

    return img.resize((size, size), Image.LANCZOS)


OUT.mkdir(parents=True, exist_ok=True)
for size in sorted(PADDING):
    path = OUT / f"icon{size}.png"
    render(size).save(path, "PNG", optimize=True)
    print(f"{path.relative_to(OUT.parent.parent)}  {path.stat().st_size:>5} bytes")

#!/usr/bin/env python3
"""
Generate the extension icon set from the Kilroy logo.

Source of truth is brand/kilroy-logo.jpg — the full lockup (emblem, wordmark,
tagline) on its cream field. This traces the EMBLEM only (the Kilroy peering
over the envelope) and renders it as a navy mark on a light circular chip.

Why the chip, not the bare emblem: the artwork is navy on light, which is
invisible on a dark browser toolbar. A light chip carries it on any theme, the
way the logo carries it on its own cream field. Measured actual-size on both a
light and a dark toolbar before choosing.

The emblem is found, not hard-coded: the lockup's top band of dark pixels is the
emblem, so re-exporting the logo at another size still works.

    python tools/make-icons.py
"""
import numpy as np
from PIL import Image, ImageDraw
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "brand" / "kilroy-logo.jpg"
OUT = ROOT / "extension" / "icons"

NAVY = (10, 44, 80)        # #0a2c50 — the logo navy, a hair lifted for punch
CHIP = (247, 247, 245)     # #f7f7f5 — the logo's own cream field
SS = 8                     # supersample for clean edges at small sizes

# Chip padding: the emblem sits inside the circle with room so the envelope
# corners never touch the rim. Smaller icons get proportionally more.
CHIP_PAD = {16: 0.20, 32: 0.22, 48: 0.22, 128: 0.26}


def emblem_rgba():
    """The emblem as navy-on-transparent RGBA, squared, antialiased."""
    src = Image.open(SRC).convert("RGB")
    a = np.asarray(src).astype(float)
    lum = a.mean(2)
    dark = lum < 110

    # Top band of dark rows = the emblem, above the wordmark.
    rows = dark.sum(1)
    thr = rows.max() * 0.02
    ys = np.where(rows > thr)[0]
    splits = np.where(np.diff(ys) > 30)[0]
    top = ys[: splits[0] + 1] if len(splits) else ys
    y0, y1 = int(top.min()), int(top.max())
    cols = dark[y0:y1 + 1].sum(0)
    xs = np.where(cols > 0)[0]
    x0, x1 = int(xs.min()), int(xs.max())

    m = 24
    crop = src.crop((x0 - m, y0 - m, x1 + m, y1 + m))
    ca = np.asarray(crop).astype(float).mean(2)
    lo, hi = 95, 150                      # antialiased ink coverage
    alpha = np.clip((hi - ca) / (hi - lo), 0, 1)
    ink = Image.fromarray((alpha * 255).astype("uint8"), "L")

    w, h = ink.size
    side = max(w, h)
    solid = Image.new("RGBA", ink.size, NAVY + (255,))
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.paste(solid, ((side - w) // 2, (side - h) // 2), ink)
    return sq


def render(emblem, size):
    big = size * SS
    c = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(c)
    r = round(big * 0.02)
    d.ellipse([r, r, big - r - 1, big - r - 1], fill=CHIP + (255,))
    inner = round(big * (1 - CHIP_PAD[size]))
    e = emblem.resize((inner, inner), Image.LANCZOS)
    c.paste(e, ((big - inner) // 2, (big - inner) // 2), e)
    return c.resize((size, size), Image.LANCZOS)


emblem = emblem_rgba()
OUT.mkdir(parents=True, exist_ok=True)
for size in sorted(CHIP_PAD):
    path = OUT / f"icon{size}.png"
    render(emblem, size).save(path, "PNG", optimize=True)
    print(f"{path.relative_to(ROOT)}  {path.stat().st_size:>5} bytes")


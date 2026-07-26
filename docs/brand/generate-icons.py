#!/usr/bin/env python3
"""
Rasterizes the SpeakUp brand mark into the binary icon formats browsers need.

The SVGs in this folder (and client/public/favicon.svg) are the source of truth
for the *design*; this script re-draws the same geometry with Pillow because
Safari and older browsers can't consume an SVG favicon. Keep the numbers here in
sync with the SVGs if the mark ever changes, then re-run:

    python docs/brand/generate-icons.py

Outputs (all committed):
    client/public/favicon.ico          16 / 32 / 48 px, simplified 3-bar mark
    client/public/apple-touch-icon.png 180 px, full 5-bar mark

No SVG rasterizer (ImageMagick / Inkscape / cairosvg) is required.
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

OUT_DIR = Path(__file__).resolve().parents[2] / "client" / "public"

# Palette — mirrors client/src/index.css design tokens.
TILE = (21, 16, 31, 255)  # --color-ink-2  #15101f
RING_STOPS = [(0.00, (0x8B, 0x6C, 0xFF)),  # --color-coach
              (0.46, (0xB9, 0xA6, 0xFF)),  # --color-coach-soft
              (1.00, (0x2E, 0xE6, 0xA6))]  # --color-accent
BAR_STOPS = [(0.00, (0xFF, 0xB3, 0x5C)),   # --color-user
             (1.00, (0x8B, 0x6C, 0xFF))]

SS = 8  # supersample factor — drawn big, then LANCZOS-downscaled for antialiasing


# --- geometry, in each mark's own SVG user units ---------------------------

# client/public/favicon.svg — simplified and deliberately overweight for small
# sizes: 3 bars instead of 5, heavier ring, and only ~5% tile margin. At 16px a
# tab icon is 16 device pixels total, so legibility beats elegance — the graceful
# proportions live in MARK below.
FAVICON = {
    "units": 64,
    "tile_radius": 12,
    "circle": (32, 30, 23.5),        # cx, cy, r
    "stroke": 7,
    # attach @150deg, tip @132deg out at 1.55r, attach @113deg. The tip has to
    # clear the stroke width by ~1.5x or the tail renders as a blunt notch.
    "tail": [(11.648, 41.750), (7.627, 57.069), (22.818, 51.632)],
    "arc": (150, 113),               # degrees, drawn clockwise the long way
    "ring_axis": ((9, 40), (55, 20)),
    "bars": [(18.0, 22.0, 7, 16), (28.5, 16.5, 7, 27), (39.0, 22.0, 7, 16)],
}

# docs/brand/mark.svg — the full mark
MARK = {
    "units": 160,
    "tile_radius": 32,
    "circle": (80, 80, 53),
    "stroke": 9,
    # same construction, tip at 1.45r — the larger mark needs less overshoot.
    "tail": [(34.10, 106.50), (28.58, 137.11), (59.29, 128.79)],
    "arc": (150, 113),
    "ring_axis": ((27, 104), (133, 52)),
    "bars": [(50.7, 66.9, 7.5, 24.2), (63.5, 56.8, 7.5, 44.5), (76.3, 43.9, 7.5, 70.3),
             (89.1, 56.8, 7.5, 44.5), (101.9, 66.9, 7.5, 24.2)],
}


def _ramp(stops, t):
    """Interpolate a multi-stop colour ramp at t in [0,1] (t is an ndarray)."""
    out = np.zeros(t.shape + (3,), dtype=np.float64)
    for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
        seg = (t >= t0) & (t <= t1)
        local = np.zeros_like(t)
        local[seg] = (t[seg] - t0) / (t1 - t0)
        for ch in range(3):
            out[..., ch] = np.where(seg, c0[ch] + (c1[ch] - c0[ch]) * local, out[..., ch])
    return out


def _linear_gradient(size, p0, p1, stops):
    """RGB image whose colour ramps along the p0 -> p1 axis (pixel coords)."""
    ys, xs = np.mgrid[0:size, 0:size]
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    denom = dx * dx + dy * dy
    t = np.clip(((xs - p0[0]) * dx + (ys - p0[1]) * dy) / denom, 0.0, 1.0)
    return Image.fromarray(_ramp(stops, t).round().astype(np.uint8))


def render(spec, px):
    """Draw one mark at `px` pixels square, supersampled then downscaled."""
    n = px * SS
    k = n / spec["units"]                      # user units -> supersampled pixels
    def s(v):                                  # scale helper
        return v * k

    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    ImageDraw.Draw(img).rounded_rectangle(
        [0, 0, n - 1, n - 1], radius=s(spec["tile_radius"]), fill=TILE
    )

    # Ring + tail, drawn into a mask so a gradient can be poured through it.
    mask = Image.new("L", (n, n), 0)
    md = ImageDraw.Draw(mask)
    cx, cy, r = spec["circle"]
    w = s(spec["stroke"])
    md.arc([s(cx - r), s(cy - r), s(cx + r), s(cy + r)],
           start=spec["arc"][0], end=spec["arc"][1], fill=255, width=round(w))
    tail = [(s(x), s(y)) for x, y in spec["tail"]]
    md.line(tail, fill=255, width=round(w), joint="curve")
    for x, y in tail:                          # round the caps and the tip
        md.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=255)

    (ax0, ay0), (ax1, ay1) = spec["ring_axis"]
    ring = _linear_gradient(n, (s(ax0), s(ay0)), (s(ax1), s(ay1)), RING_STOPS)
    img.paste(ring, (0, 0), mask)

    # Bars — each carries the full amber->violet ramp over its own height.
    for bx, by, bw, bh in spec["bars"]:
        x0, y0, x1, y1 = s(bx), s(by), s(bx + bw), s(by + bh)
        bar_mask = Image.new("L", (n, n), 0)
        ImageDraw.Draw(bar_mask).rounded_rectangle(
            [x0, y0, x1, y1], radius=s(bw) / 2, fill=255
        )
        ys = np.mgrid[0:n, 0:n][0]
        t = np.clip((ys - y0) / (y1 - y0), 0.0, 1.0)
        bar = Image.fromarray(_ramp(BAR_STOPS, t).round().astype(np.uint8))
        img.paste(bar, (0, 0), bar_mask)

    return img.resize((px, px), Image.LANCZOS)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    ico_sizes = [48, 32, 16]
    frames = [render(FAVICON, n) for n in ico_sizes]
    # Pillow builds the multi-resolution container from the largest frame.
    frames[0].save(OUT_DIR / "favicon.ico", format="ICO",
                   sizes=[(n, n) for n in ico_sizes], append_images=frames[1:])
    print(f"wrote {OUT_DIR / 'favicon.ico'}  ({', '.join(f'{n}x{n}' for n in ico_sizes)})")

    touch = render(MARK, 180)
    touch.save(OUT_DIR / "apple-touch-icon.png", format="PNG", optimize=True)
    print(f"wrote {OUT_DIR / 'apple-touch-icon.png'}  (180x180)")


if __name__ == "__main__":
    main()

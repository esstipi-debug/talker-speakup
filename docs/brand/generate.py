#!/usr/bin/env python3
"""
Renders every binary brand asset SpeakUp needs from one set of geometry.

The SVGs in this folder (and client/public/favicon.svg) are the source of truth
for the *design*; this script re-draws the same geometry with Pillow because
Safari can't consume an SVG favicon and GitHub's social preview needs a PNG.
Keep the numbers here in sync with the SVGs if the mark ever changes, then:

    python docs/brand/generate.py

Outputs (all committed):
    client/public/favicon.ico          16 / 32 / 48 px, simplified 3-bar mark
    client/public/apple-touch-icon.png 180 px, full 5-bar mark
    docs/brand/social-card.png         1280x640, GitHub / OG link preview

No SVG rasterizer (ImageMagick / Inkscape / cairosvg) is required.
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "client" / "public"
BRAND_DIR = Path(__file__).resolve().parent

# Palette — mirrors client/src/index.css design tokens.
TILE = (21, 16, 31, 255)  # --color-ink-2  #15101f
RING_STOPS = [(0.00, (0x8B, 0x6C, 0xFF)),  # --color-coach
              (0.46, (0xB9, 0xA6, 0xFF)),  # --color-coach-soft
              (1.00, (0x2E, 0xE6, 0xA6))]  # --color-accent
BAR_STOPS = [(0.00, (0xFF, 0xB3, 0x5C)),   # --color-user
             (1.00, (0x8B, 0x6C, 0xFF))]
INK = (0x0E, 0x0B, 0x16)   # --color-ink
TEXT = (0xF3, 0xEE, 0xFE)  # --color-text
MUTED = (0xA3, 0x94, 0xC4)  # --color-muted
LINE = (0x39, 0x2C, 0x57)  # --color-line

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


def render(spec, px, tile=True):
    """Draw one mark at `px` pixels square, supersampled then downscaled.

    tile=False drops the dark rounded square, leaving a transparent mark to
    compose onto an existing background (the social card does this).
    """
    n = px * SS
    k = n / spec["units"]                      # user units -> supersampled pixels
    def s(v):                                  # scale helper
        return v * k

    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    if tile:
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


# --- social card -----------------------------------------------------------

CARD = (1280, 640)  # GitHub's recommended social preview size
FONT_DIR = Path("C:/Windows/Fonts")
FONTS = {  # first match wins; Inter is the app's face, Segoe UI is the fallback
    "bold": ["Inter-Bold.ttf", "segoeuib.ttf", "arialbd.ttf"],
    "semibold": ["Inter-SemiBold.ttf", "seguisb.ttf", "segoeuib.ttf"],
    "regular": ["Inter-Regular.ttf", "segoeui.ttf", "arial.ttf"],
}


def _font(weight, size):
    for name in FONTS[weight]:
        path = FONT_DIR / name
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default(size)


def _radial(w, h, cx, cy, rx, ry, rgb, peak, edge=0.6):
    """One CSS-style radial-gradient layer as an RGBA overlay.

    Mirrors the two glows on `body` in client/src/index.css so the card and the
    running app share a background, rather than merely a palette.
    """
    ys, xs = np.mgrid[0:h, 0:w]
    d = np.sqrt(((xs - cx) / rx) ** 2 + ((ys - cy) / ry) ** 2)
    t = np.clip(1 - d / edge, 0, 1)
    a = peak * t * t * (3 - 2 * t)             # smoothstep falloff
    layer = np.zeros((h, w, 4), dtype=np.uint8)
    layer[..., 0], layer[..., 1], layer[..., 2] = rgb
    layer[..., 3] = (a * 255).round().astype(np.uint8)
    return Image.fromarray(layer, "RGBA")


def social_card():
    w, h = CARD
    card = Image.new("RGBA", (w, h), INK + (255,))
    card.alpha_composite(_radial(w, h, 0.78 * w, -0.08 * h, 860, 700,
                                 (0x8B, 0x6C, 0xFF), 0.30))
    card.alpha_composite(_radial(w, h, 0.08 * w, 1.08 * h, 700, 600,
                                 (0x2E, 0xE6, 0xA6), 0.16))
    d = ImageDraw.Draw(card)

    # Right side: a waveform bleeding off the edge — the same amber->violet ramp
    # as the mark's bars, at low opacity so it reads as atmosphere, not content.
    wave = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    wd = ImageDraw.Draw(wave)
    env = [0.24, 0.44, 0.31, 0.66, 0.88, 0.54, 0.74, 1.00, 0.66, 0.42,
           0.81, 0.50, 0.92, 0.60, 0.34, 0.57, 0.26, 0.47, 0.21]
    bw, gap, mid, x0 = 18, 26, h / 2, 782
    x = x0
    for e in env:
        bh = 48 + e * 320
        wd.rounded_rectangle([x, mid - bh / 2, x + bw, mid + bh / 2],
                             radius=bw / 2, fill=(255, 255, 255, 255))
        x += bw + gap
    ramp = _linear_gradient_rect(w, h, (x0, 0), (w, 0), RING_STOPS)
    tinted = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    tinted.paste(ramp, (0, 0), wave.getchannel("A").point(lambda v: int(v * 0.78)))
    card.alpha_composite(tinted)

    # Left column: mark + wordmark on one baseline, then tagline, then chips.
    pad = 84
    mark_px, lock_y = 126, 186
    card.alpha_composite(render(MARK, mark_px, tile=False), (pad - 8, lock_y - mark_px // 2))
    d.text((pad + mark_px + 18, lock_y + 4), "SpeakUp",
           font=_font("bold", 88), fill=TEXT, anchor="lm")

    tag = _font("regular", 34)
    d.text((pad, 300), "An English speaking coach", font=tag, fill=MUTED)
    d.text((pad, 344), "that lives on localhost.", font=tag, fill=MUTED)

    chips = [("local-first", (0x2E, 0xE6, 0xA6)),
             ("voice in, voice out", (0x8B, 0x6C, 0xFF)),
             ("$0 to start", (0xFF, 0xB3, 0x5C))]
    cf = _font("semibold", 22)
    x, top, hgt = pad, 452, 50
    for label, dot in chips:
        cw = d.textlength(label, font=cf) + 62
        d.rounded_rectangle([x, top, x + cw, top + hgt], radius=hgt / 2,
                            outline=LINE, width=2)
        d.ellipse([x + 22, top + 20, x + 32, top + 30], fill=dot)
        d.text((x + 44, top + hgt / 2 + 1), label, font=cf, fill=MUTED, anchor="lm")
        x += cw + 16

    return card.convert("RGB")


def _linear_gradient_rect(w, h, p0, p1, stops):
    """Like _linear_gradient but for a non-square canvas."""
    ys, xs = np.mgrid[0:h, 0:w]
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    t = np.clip(((xs - p0[0]) * dx + (ys - p0[1]) * dy) / (dx * dx + dy * dy), 0.0, 1.0)
    return Image.fromarray(_ramp(stops, t).round().astype(np.uint8)).convert("RGBA")


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

    card_path = BRAND_DIR / "social-card.png"
    social_card().save(card_path, format="PNG", optimize=True)
    kb = card_path.stat().st_size / 1024
    print(f"wrote {card_path}  ({CARD[0]}x{CARD[1]}, {kb:.0f} kB)")


if __name__ == "__main__":
    main()

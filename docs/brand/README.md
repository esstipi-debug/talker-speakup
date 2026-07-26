# Brand assets

Everything here is generated from one set of geometry. The SVGs are the source
of truth for the *design*; [`generate.py`](generate.py) re-draws the same shapes
with Pillow to produce the raster formats that browsers and GitHub require.

```bash
python docs/brand/generate.py
```

No SVG rasterizer (ImageMagick, Inkscape, cairosvg) is needed — the script draws
the geometry directly, so it runs anywhere Pillow and numpy do.

## Inventory

| Asset | Size | Consumer |
|---|---|---|
| [`mark.svg`](mark.svg) | 160u, 5 bars | README header, anywhere ≥64px |
| [`social-card.png`](social-card.png) | 1280×640 | GitHub social preview, OG/Twitter cards |
| `../../client/public/favicon.svg` | 64u, 3 bars | Chrome, Edge, Firefox tabs |
| `../../client/public/favicon.ico` | 16/32/48 | Safari and anything without SVG favicon support |
| `../../client/public/apple-touch-icon.png` | 180×180 | iOS "Add to Home Screen" |

## Two weights, on purpose

The favicon is **not** a scaled-down `mark.svg`. It carries 3 bars instead of 5,
a heavier ring, and ~5% tile margin instead of ~14%. A browser tab icon is 16
device pixels total; at that size the 5-bar mark turns to mush. Legibility wins
below ~32px, elegance wins above it — so there are two drawings, not one.

Same reason the tail tip sits at 1.45–1.55× the ring radius: the ring stroke is
~0.2r thick, so a tail that only protrudes 1.2r gets swallowed by its own stroke
and reads as a blunt notch rather than a point.

## Uploading the social card

**This step is manual — GitHub has no API for it.** The image is committed here,
but it does nothing until someone attaches it to the repo:

> Repo → **Settings** → **General** → **Social preview** → *Edit* → *Upload an image*

GitHub wants 1280×640 and caps the file at 1MB; `social-card.png` is ~69kB.
Re-upload after any re-run of `generate.py` that changes the card.

## Changing the mark

1. Edit the SVG(s).
2. Mirror the numbers into the `FAVICON` / `MARK` dicts in `generate.py`.
3. Re-run the script and eyeball the output **at 16px**, not just at full size.
4. Re-upload the social card if it changed.

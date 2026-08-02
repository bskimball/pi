"""Render a designed shark silhouette into a truecolor half-block cell grid.

Each output cell is one `▀` glyph: foreground = upper pixel, background =
lower pixel, so one text row carries two rows of pixels.

The mark is drawn, not photographed. Earlier versions downsampled a reference
photo (reference/shark.jpg); everything realism contributed — outline wobble,
mottled shading — read as noise at cell resolution. What remains of the photo
is proportion: the silhouette below was designed against it, then simplified.

The shape is a parametric side profile built from smooth dorsal/ventral body
curves plus straight-edged fin polygons: pointed snout, tall triangular first
dorsal, small second dorsal, raked pectoral, pelvic, narrow peduncle and a
crescent caudal fin with a longer upper lobe — the cues that make a silhouette
read as "shark" at a glance.

Colour is flat posterized bands driven by body depth alone: dark back, violet
flank, one cyan lateral line, pale belly. Thin geometry (fins, tail) shifts one
band darker so it separates from the trunk. No texture, no gradients.

Usage:
    python encode-shark.py preview <cols> <rows>   # ANSI to stdout
    python encode-shark.py json <cols> <rows>      # packed cells to stdout
"""

import json
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.interpolate import PchipInterpolator

# --- canvas -----------------------------------------------------------------
# Rasterization size for the vector silhouette. High enough that downsampling
# antialiases cleanly at any target grid.
CANVAS_W, CANVAS_H = 1800, 640

# --- edges ------------------------------------------------------------------
# Fraction of a cell that must be shark for the cell to be drawn at all.
# Lower keeps thin fin tips; higher is crisper.
COVERAGE_CUTOFF = 0.3

# --- styling ----------------------------------------------------------------
# Thin geometry (fins, tail lobes, peduncle rim) steps one band darker so it
# separates from the trunk. THIN_SCALE is in canvas pixels.
THIN_SCALE = 46.0
THIN_BANDS_SHIFT = 1.2

# Flat bands from back to belly, applied by index rather than blended, so the
# mark reads as a few solid shapes instead of a gradient. The cyan band is the
# lateral line: the one accent that keeps the mark from being a flat fish.
BANDS = [
    (24, 18, 56),  # back
    (58, 38, 126),  # upper flank
    (125, 211, 252),  # lateral line
    (150, 180, 224),  # lower flank
    (214, 232, 248),  # belly
]

# Where each band ends, as a fraction of body depth from the dorsal edge.
BAND_EDGES = [0.45, 0.58, 0.68, 0.85, 1.0]

# Band depth is measured against the analytic body curves, not the rasterized
# outline, so fins never distort where the bands sit on the trunk. Pixels above
# the dorsal curve (fins) clip to depth 0 = back tone; pixels below the ventral
# curve clip to 1 and are then pushed dark again by the thin-geometry shift.

# Counter-shade sweep: a perfectly level split reads as a sea horizon, not a
# body. Real counter-shading swoops — the pale belly rides high on the jaw,
# dips under the trunk, and pinches out at the peduncle where the tail goes
# all dark. Values shift every band edge at that x (in depth units).
SWEEP = [
    (0.00, -0.16),
    (0.18, -0.06),
    (0.45, 0.00),
    (0.70, 0.06),
    (0.88, 0.16),
    (1.00, 0.22),
]

# Face marks, the difference between a shape and a creature. Design coords.
EYE_CENTER = (0.085, 0.10)
EYE_RADIUS = 0.009  # of body length
EYE_COLOR = (232, 242, 250)
GILL_XS = (0.235, 0.27, 0.305)  # three slits ahead of the pectoral
GILL_DEPTH = (0.26, 0.55)  # vertical span in depth units, ending at the flank
GILL_WIDTH = 0.009  # of body length
MOUTH = ((0.045, -0.30), (0.115, -0.42))  # jaw slit under the snout
MOUTH_WIDTH = 0.007

# --- the drawing ------------------------------------------------------------
# All coordinates are design units: x runs 0 (snout tip) to 1 (tail tip), y is
# height above the midline. The shark swims left.

# Dorsal (top) body outline, snout to peduncle. The body is deep: it, not the
# fins, carries the mark, and the counter-shading bands need room to read.
TOP_PROFILE = [
    (0.000, 0.03),
    (0.060, 0.34),
    (0.160, 0.52),
    (0.340, 0.64),
    (0.520, 0.62),
    (0.700, 0.42),
    (0.860, 0.16),
]

# Ventral (bottom) body outline, snout to peduncle.
BOTTOM_PROFILE = [
    (0.000, -0.03),
    (0.060, -0.34),
    (0.160, -0.52),
    (0.300, -0.60),
    (0.500, -0.55),
    (0.680, -0.36),
    (0.860, -0.14),
]

# Fin polygons, drawn over the body. Each is a list of (x, y) vertices. Fin
# sizes sit near real great-white proportions (dorsal height ~ half the body
# depth); anything larger reads as a sailfish, anything smaller as a tuna.
FINS = [
    # First dorsal: tall triangle, slightly raked.
    [(0.36, 0.60), (0.46, 1.30), (0.49, 0.92), (0.56, 0.56)],
    # Second dorsal, small.
    [(0.72, 0.36), (0.77, 0.62), (0.785, 0.32)],
    # Pectoral: long, raked down and back.
    [(0.22, -0.50), (0.42, -1.18), (0.38, -0.42)],
    # Pelvic, small.
    [(0.56, -0.48), (0.62, -0.78), (0.64, -0.42)],
    # Anal, small.
    [(0.73, -0.30), (0.77, -0.54), (0.79, -0.27)],
    # Caudal: crescent, longer upper lobe, deep fork. Lobes kept wide enough
    # to survive downsampling as solid shapes.
    [
        (0.840, 0.20),
        (0.920, 0.62),
        (1.000, 1.00),
        (0.965, 0.28),
        (0.935, 0.02),
        (0.950, -0.22),
        (0.995, -0.62),
        (0.915, -0.42),
        (0.840, -0.18),
    ],
]


def draw_mask(sweep_scale=1.0):
    """Rasterize the designed silhouette; also return the body-depth field.

    The body is the closed region between two monotone-x interpolated curves
    (PCHIP: smooth but overshoot-free); the fins are straight-edged polygons
    on top. Depth is computed analytically from those same curves — 0 at the
    dorsal edge, 1 at the ventral edge — so the fins never skew where the
    colour bands sit on the trunk.
    """
    all_y = (
        [y for _, y in TOP_PROFILE]
        + [y for _, y in BOTTOM_PROFILE]
        + [y for fin in FINS for _, y in fin]
    )
    y_max, y_min = max(all_y), min(all_y)
    pad = 6

    def to_px(x, y):
        px = pad + x * (CANVAS_W - 2 * pad)
        py = pad + (y_max - y) / (y_max - y_min) * (CANVAS_H - 2 * pad)
        return px, py

    im = Image.new("1", (CANVAS_W, CANVAS_H), 0)
    draw = ImageDraw.Draw(im)

    xs = np.linspace(TOP_PROFILE[0][0], TOP_PROFILE[-1][0], 400)
    top = PchipInterpolator(*zip(*TOP_PROFILE))
    bottom = PchipInterpolator(*zip(*BOTTOM_PROFILE))
    outline = [to_px(x, float(top(x))) for x in xs]
    outline += [to_px(x, float(bottom(x))) for x in xs[::-1]]
    draw.polygon(outline, fill=1)

    for fin in FINS:
        draw.polygon([to_px(x, y) for x, y in fin], fill=1)

    mask = np.asarray(im, dtype=bool)
    unit = CANVAS_W - 2 * pad  # design-length → pixels

    # Analytic depth field over the full canvas, from the same design curves,
    # with the counter-shade sweep folded in: shifting depth by -sweep(x) is
    # equivalent to shifting every band edge by +sweep(x).
    px_x = np.arange(CANVAS_W, dtype=np.float32)
    design_x = np.clip((px_x - pad) / unit, 0.0, 1.0)
    top_y = np.array([to_px(0, float(top(x)))[1] for x in design_x])
    bot_y = np.array([to_px(0, float(bottom(x)))[1] for x in design_x])
    span = np.maximum(bot_y - top_y, 1.0)
    rows_px = np.arange(CANVAS_H, dtype=np.float32)[:, None]
    depth = (rows_px - top_y[None, :]) / span[None, :]
    sweep = np.interp(design_x, [x for x, _ in SWEEP], [s for _, s in SWEEP])
    depth = np.clip(depth - sweep_scale * sweep[None, :], 0.0, 1.0)

    # Face marks on separate layers, drawn in the same canvas space.
    eye_im = Image.new("1", (CANVAS_W, CANVAS_H), 0)
    eye_draw = ImageDraw.Draw(eye_im)
    ex, ey = to_px(*EYE_CENTER)
    er = EYE_RADIUS * unit
    eye_draw.ellipse([ex - er, ey - er, ex + er, ey + er], fill=1)

    dark_im = Image.new("1", (CANVAS_W, CANVAS_H), 0)
    dark_draw = ImageDraw.Draw(dark_im)
    for gx in GILL_XS:
        col = int(pad + gx * unit)
        y_hi = top_y[col] + GILL_DEPTH[0] * span[col]
        y_lo = top_y[col] + GILL_DEPTH[1] * span[col]
        # Slits rake slightly back, like the reference.
        rake = 0.012 * unit
        dark_draw.line(
            [col + rake, y_hi, col, y_lo], fill=1, width=int(GILL_WIDTH * unit)
        )
    (mx0, my0), (mx1, my1) = MOUTH
    dark_draw.line(
        [to_px(mx0, my0), to_px(mx1, my1)], fill=1, width=int(MOUTH_WIDTH * unit)
    )

    eye = np.asarray(eye_im, dtype=bool) & mask
    dark = np.asarray(dark_im, dtype=bool) & mask

    ys, xs_idx = np.where(mask)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs_idx.min(), xs_idx.max() + 1
    box = (slice(y0, y1), slice(x0, x1))
    return mask[box], depth[box], eye[box], dark[box]


def thickness(mask):
    """Normalized distance to the nearest non-shark pixel, clipped at THIN_SCALE."""
    edt = ndimage.distance_transform_edt(mask)
    return np.clip(edt / THIN_SCALE, 0.0, 1.0)


def box_downsample(values, weights, cols, rows):
    """Weighted box average of `values` into a cols x rows grid.

    Returns (averaged values, mean weight per cell). Averaging over `weights`
    (the mask) keeps background out of edge values.
    """
    h, w = weights.shape
    ys = (np.arange(h) * rows // h).clip(0, rows - 1)
    xs = (np.arange(w) * cols // w).clip(0, cols - 1)
    flat = (ys[:, None] * cols + xs[None, :]).ravel()
    size = rows * cols

    weight_sum = np.bincount(flat, weights.ravel(), minlength=size)
    value_sum = np.bincount(flat, (values * weights).ravel(), minlength=size)
    pixel_count = np.bincount(flat, minlength=size).astype(np.float32)

    with np.errstate(invalid="ignore", divide="ignore"):
        averaged = np.where(weight_sum > 0, value_sum / weight_sum, 0.0)
    coverage = weight_sum / np.maximum(pixel_count, 1.0)
    return averaged.reshape(rows, cols), coverage.reshape(rows, cols)


def stylize(depth, solidity, eye, dark):
    """Paint flat bands by body depth; push thin geometry one band darker."""
    index = np.zeros(depth.shape, dtype=float)
    for edge in BAND_EDGES[:-1]:
        index += (depth > edge).astype(float)

    thin = 1.0 - np.clip(solidity, 0.0, 1.0)
    index = np.maximum(index - thin * THIN_BANDS_SHIFT, 0.0)

    bands = np.asarray(BANDS, dtype=np.uint8)
    rgb = bands[np.clip(np.round(index).astype(int), 0, len(BANDS) - 1)]

    # Face marks override the bands: gill slits and the mouth take the back
    # tone, the eye is a pale dot. A mark claims a pixel at >35% coverage so
    # the slits stay one clean column wide after downsampling.
    rgb[dark > 0.35] = BANDS[0]
    rgb[eye > 0.35] = EYE_COLOR
    return rgb


def encode(cols, rows):
    """Build a (rows x cols) grid of (top_rgb, bottom_rgb) or None per cell.

    Small grids get a flattened counter-shade sweep: with few pixel rows the
    swoop makes the cyan lateral line wander across row boundaries and break
    into dashes, so it fades out as the grid shrinks.
    """
    sweep_scale = np.clip((rows - 8.0) / 4.0, 0.0, 1.0)
    mask, depth_field, eye_field, dark_field = draw_mask(sweep_scale)

    pixel_rows = rows * 2
    weights = mask.astype(np.float32)
    solidity, coverage = box_downsample(thickness(mask), weights, cols, pixel_rows)
    depth, _ = box_downsample(depth_field, weights, cols, pixel_rows)
    eye, _ = box_downsample(eye_field.astype(np.float32), weights, cols, pixel_rows)
    dark, _ = box_downsample(dark_field.astype(np.float32), weights, cols, pixel_rows)
    colors = stylize(depth, solidity, eye, dark)
    drawn = coverage >= COVERAGE_CUTOFF

    grid = []
    for row in range(rows):
        cells = []
        for col in range(cols):
            top_on = drawn[row * 2, col]
            bottom_on = drawn[row * 2 + 1, col]
            if not top_on and not bottom_on:
                cells.append(None)
                continue
            top = colors[row * 2, col] if top_on else None
            bottom = colors[row * 2 + 1, col] if bottom_on else None
            cells.append((top, bottom))
        grid.append(cells)
    return grid


def to_json(cols, rows):
    grid = encode(cols, rows)
    used = [c for c in range(cols) if any(row[c] is not None for row in grid)]
    lo, hi = (min(used), max(used)) if used else (0, cols - 1)

    packed = []
    for row in grid:
        cells = []
        for cell in row[lo : hi + 1]:
            if cell is None:
                cells.append(None)
                continue
            top, bottom = cell
            # A half-lit cell keeps its lit half and renders the other half as
            # empty, which is how the silhouette gets sub-cell precision.
            cells.append(
                [
                    [int(v) for v in top] if top is not None else None,
                    [int(v) for v in bottom] if bottom is not None else None,
                ]
            )
        packed.append(cells)
    return {"width": hi - lo + 1, "rows": packed}


def preview(cols, rows):
    lines = []
    for row in encode(cols, rows):
        line = ""
        for cell in row:
            if cell is None:
                line += " "
                continue
            top, bottom = cell
            if top is not None and bottom is not None:
                line += (
                    f"\x1b[38;2;{top[0]};{top[1]};{top[2]}m"
                    f"\x1b[48;2;{bottom[0]};{bottom[1]};{bottom[2]}m▀\x1b[0m"
                )
            elif top is not None:
                line += f"\x1b[38;2;{top[0]};{top[1]};{top[2]}m▀\x1b[0m"
            else:
                line += f"\x1b[38;2;{bottom[0]};{bottom[1]};{bottom[2]}m▄\x1b[0m"
        lines.append(line)
    return "\n".join(lines)


if __name__ == "__main__":
    mode = sys.argv[1]
    cols, rows = int(sys.argv[2]), int(sys.argv[3])
    if mode == "preview":
        print(preview(cols, rows))
    else:
        print(json.dumps(to_json(cols, rows)))

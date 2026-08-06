"""Render a designed shark silhouette into a truecolor half-block cell grid.

Each output cell is one `▀` glyph: foreground = upper pixel, background =
lower pixel, so one text row carries two rows of pixels.

The mark is drawn, not photographed. Earlier versions downsampled a reference
photo (reference/shark.jpg); everything realism contributed — outline wobble,
mottled shading — read as noise at cell resolution. What remains of the photo
is proportion: the silhouette below was designed against it, then simplified.

The shape is a parametric side profile built from smooth dorsal/ventral body
curves plus many-vertex fin polygons: conical snout tapering to an apex, tall
first dorsal with a convex leading edge and a concave trailing edge running out
to a free rear tip, small second dorsal, long falcate pectoral, pelvic and anal,
narrow keeled peduncle and a crescentic caudal fin with a deep fork — the cues
that make a silhouette read as "great white" at a glance.

Colour is flat posterized bands driven by body depth alone: dark slate back,
mid-slate flank, one lighter lateral line, pale belly. Thin geometry (fins,
tail) shifts one band darker so it separates from the trunk. No texture, no
gradients.

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
# mark reads as a few solid shapes instead of a gradient. Classic great-white
# countershading in slate/gray: dark dorsal, mid-slate flank, pale belly.
BANDS = [
    (30, 41, 59),  # back (slate 800)
    (71, 85, 105),  # upper flank (slate 600)
    (100, 116, 139),  # lateral line (slate 500)
    (203, 213, 225),  # lower flank (slate 300)
    (241, 245, 249),  # belly (slate 50)
]

# Where each band ends, as a fraction of body depth from the dorsal edge.
BAND_EDGES = [0.50, 0.66, 0.78, 0.90, 1.0]

# Band depth is measured against the analytic body curves, not the rasterized
# outline, so fins never distort where the bands sit on the trunk. Fin pixels
# outside the trunk don't get a meaningful body depth at all — above the dorsal
# curve they clip to 0, below the ventral curve to 1 — which would paint the
# pectoral and the lower caudal lobe in belly white and lose them entirely.
# Instead out-of-trunk fin pixels are pinned to a fixed depth per side: fins
# above the back stay in the dark dorsal tone so the first dorsal reads as one
# shape with the spine, and fins below the belly take a mid-slate so the
# pelvic and lower caudal lobe don't vanish into the white underside (the
# pectoral fin is pinned to PECTORAL_DEPTH so it matches the flank above it).
FIN_DEPTH_ABOVE = 0.10
FIN_DEPTH_BELOW = 0.72

# The pectoral is its own case: pinned to the upper-flank band so it continues
# the tone of the flank it grows out of rather than the near-black spine.
PECTORAL_DEPTH = 0.58

# Counter-shade sweep: a perfectly level split reads as a sea horizon, not a
# body. Real counter-shading swoops — the pale belly rides high on the jaw,
# dips under the trunk, and pinches out at the peduncle where the tail goes
# all dark. Values shift every band edge at that x (in depth units).
SWEEP = [
    (0.00, -0.04),
    (0.12, -0.06),
    (0.22, -0.04),
    (0.45, 0.00),
    (0.70, 0.06),
    (0.88, 0.16),
    (1.00, 0.22),
]

# Face marks, the difference between a shape and a creature. Design coords.
EYE_CENTER = (0.108, 0.078)  # just above and behind the mouth corner
EYE_RADIUS = 0.008  # of body length
EYE_COLOR = (248, 250, 252)
GILL_XS = (0.196, 0.217, 0.238, 0.259, 0.280)  # five slits ahead of the pectoral
GILL_DEPTH = (0.22, 0.62)  # vertical span in depth units, ending at the flank
GILL_WIDTH = 0.006  # of body length
MOUTH = ((0.034, -0.10), (0.142, -0.30))  # jaw slit under the conical snout
MOUTH_WIDTH = 0.006

# --- the drawing ------------------------------------------------------------
# All coordinates are design units: x runs 0 (snout tip) to 1 (tail tip), y is
# height above the midline. The shark swims left.

# Dorsal (top) body outline, snout to peduncle.
TOP_PROFILE = [
    (0.000, 0.020),
    (0.015, 0.090),
    (0.035, 0.170),
    (0.065, 0.270),
    (0.110, 0.370),
    (0.170, 0.460),
    (0.250, 0.540),
    (0.340, 0.590),
    (0.430, 0.610),
    (0.520, 0.590),
    (0.620, 0.520),
    (0.720, 0.400),
    (0.810, 0.250),
    (0.880, 0.130),
    (0.920, 0.050),
]

# Ventral (bottom) body outline, snout to peduncle.
BOTTOM_PROFILE = [
    (0.000, -0.015),
    (0.015, -0.070),
    (0.035, -0.130),
    (0.065, -0.220),
    (0.110, -0.320),
    (0.170, -0.420),
    (0.250, -0.500),
    (0.350, -0.550),
    (0.450, -0.520),
    (0.550, -0.450),
    (0.650, -0.350),
    (0.750, -0.230),
    (0.840, -0.120),
    (0.920, -0.040),
]

# Fin polygons, drawn over the body. Each is a list of (x, y) vertices; edges
# are straight, so curvature is carried by vertex density — leading edges bow
# outside their chord, trailing edges cut inside it, which is what makes a fin
# read as falcate rather than triangular.
PECTORAL_INDEX = 2

# Shoulder wedge: the patch of trunk that carries the dark back tone down to
# the pectoral root so the fin grows out of the flank instead of floating under
# the belly. Widest at the insertion, raked forward and narrowing as it climbs.
PECTORAL_SHOULDER = [
    (0.272, -0.520),
    (0.408, -0.440),
    (0.386, -0.250),
    (0.300, -0.205),
]

FINS = [
    # First dorsal: base 0.38-0.56 on the deepest part of the trunk, convex
    # leading edge, rounded apex just past x=0.47, concave trailing edge
    # sweeping to a free rear tip that settles back onto the dorsal ridge.
    [
        (0.390, 0.600),
        (0.415, 0.780),
        (0.445, 0.940),
        (0.470, 1.040),
        (0.485, 1.080),
        (0.495, 1.070),
        (0.500, 0.980),
        (0.510, 0.850),
        (0.525, 0.700),
        (0.545, 0.580),
        (0.570, 0.520),
        (0.535, 0.550),
        (0.450, 0.605),
    ],
    # Second dorsal: small, raked, with its own little rear tip.
    [(0.742, 0.238), (0.766, 0.412), (0.790, 0.272), (0.814, 0.196)],
    # Pectoral fin:
    [
        (0.278, -0.465),
        (0.318, -0.625),
        (0.362, -0.790),
        (0.410, -0.940),
        (0.456, -1.055),
        (0.485, -1.110),
        (0.495, -1.070),
        (0.482, -0.950),
        (0.470, -0.850),
        (0.452, -0.735),
        (0.428, -0.590),
        (0.402, -0.470),
    ],
    # Pelvic: small, set between the dorsal fins on the ventral line.
    [(0.592, -0.400), (0.634, -0.582), (0.658, -0.608), (0.672, -0.436), (0.694, -0.340)],
    # Anal: small, mirrors the second dorsal just behind it.
    [(0.752, -0.208), (0.778, -0.372), (0.800, -0.246), (0.822, -0.168)],
    # Caudal: lamnid crescent — narrow peduncle, upper lobe slightly longer
    # than the lower, both trailing edges concave into a deep fork notch.
    [
        (0.882, 0.050),
        (0.908, 0.310),
        (0.936, 0.600),
        (0.964, 0.830),
        (0.990, 0.985),
        (0.982, 0.780),
        (0.970, 0.470),
        (0.960, 0.210),
        (0.950, 0.010),
        (0.962, -0.230),
        (0.980, -0.470),
        (0.996, -0.660),
        (0.965, -0.620),
        (0.940, -0.510),
        (0.915, -0.320),
        (0.882, -0.050),
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
    body = np.asarray(im, dtype=bool).copy()

    # Draw pectoral fin separately so we can identify its pixels
    pectoral_im = Image.new("1", (CANVAS_W, CANVAS_H), 0)
    pectoral_draw = ImageDraw.Draw(pectoral_im)
    pectoral_draw.polygon([to_px(x, y) for x, y in FINS[PECTORAL_INDEX]], fill=1)
    pectoral_mask = np.asarray(pectoral_im, dtype=bool)

    for fin in FINS:
        draw.polygon([to_px(x, y) for x, y in fin], fill=1)

    mask = np.asarray(im, dtype=bool)
    fin_only = mask & ~body
    # Pectoral fin pixels that are not part of the body
    pectoral_fin_only = fin_only & pectoral_mask
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
    below = rows_px > (top_y + bot_y)[None, :] / 2.0
    # The pectoral takes the upper-flank tone rather than the mid-slate the
    # other ventral fins get, so it reads as the shaded top surface of the fin.
    depth = np.where(
        fin_only,
        np.where(
            pectoral_fin_only,
            PECTORAL_DEPTH,
            np.where(below, FIN_DEPTH_BELOW, FIN_DEPTH_ABOVE),
        ),
        depth,
    )
    depth = np.where(pectoral_mask & body, PECTORAL_DEPTH, depth)

    # A dark fin rooted in the pale belly reads as a detached blade. On a real
    # shark the flank dips down over the pectoral insertion, so carry the flank
    # tone into the body as a wedge: wide at the fin root, narrowing as it
    # climbs forward to the shoulder, so the belly still reads fore and aft.
    shoulder_im = Image.new("1", (CANVAS_W, CANVAS_H), 0)
    ImageDraw.Draw(shoulder_im).polygon(
        [to_px(x, y) for x, y in PECTORAL_SHOULDER], fill=1
    )
    shoulder = np.asarray(shoulder_im, dtype=bool) & body
    depth = np.where(shoulder, PECTORAL_DEPTH, depth)

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
    if sys.platform == "win32":
        sys.stdout.reconfigure(encoding="utf-8")
    mode = sys.argv[1]
    cols, rows = int(sys.argv[2]), int(sys.argv[3])
    if mode == "preview":
        print(preview(cols, rows))
    else:
        print(json.dumps(to_json(cols, rows)))

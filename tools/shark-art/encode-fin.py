"""Render the dorsal fin of the observatory shark as a small cruising sprite.

The landing mark (encode-shark.py) is a full side profile. The fleet waterline
needs the same creature reduced to the one cue that reads at 2 rows: the first
dorsal fin breaking a surface, with a sliver of back under it.

Rather than hand-picking a triangle glyph, this crops the *same* design used by
the mark — the first dorsal polygon from FINS[0] plus the dorsal body curve
beneath it — and rasterizes that window through the same depth-band palette. So
the fin is literally the mark's own fin, not a lookalike.

Horizontal sub-cell motion is impossible with half blocks (they split cells
vertically), so smoothness comes from phase sprites instead: the same fin
rendered at fractional column offsets, which shifts which columns light up via
coverage. Cycling phases then stepping one column reads as continuous travel.

Usage:
    python encode-fin.py preview <cols> <rows> [phases]   # ANSI to stdout
    python encode-fin.py json <cols> <rows> [phases]      # packed sprites
"""

import importlib.util
import json
import pathlib
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.interpolate import PchipInterpolator

# The shark encoder owns the design; load it despite the hyphenated filename.
_spec = importlib.util.spec_from_file_location(
    "encode_shark", pathlib.Path(__file__).with_name("encode-shark.py")
)
shark = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(shark)

# The shark's own canvas fixes the design's true scale: x is body length over
# CANVAS_W, y is the full height range over CANVAS_H. Both are needed or the
# cropped fin renders at the wrong aspect and downsamples into a mound.
_SHARK_Y_SPAN = max(
    y
    for _, y in shark.TOP_PROFILE + [v for fin in shark.FINS for v in fin]
) - min(
    y
    for _, y in shark.BOTTOM_PROFILE + [v for fin in shark.FINS for v in fin]
)
X_UNIT_PX = shark.CANVAS_W
Y_UNIT_PX = shark.CANVAS_H / _SHARK_Y_SPAN

# Rasterization resolution; the actual canvas is sized per-window from the
# design aspect so proportions survive the crop.
SUPERSAMPLE = 900

# Design window around the first dorsal, tight: x runs from just ahead of the
# fin's leading edge to just behind its trailing edge, y from above the tip down
# through the back, which is where the waterline sits. At two rows the fin has
# to fill the frame or it downsamples into an unreadable blob.
WINDOW_X = (0.335, 0.585)
WINDOW_Y = (0.520, 1.340)

# Phase shifting slides geometry sideways, which would push the fin out of a
# tight window. Render one spare column on each side and crop it back off, so
# every phase keeps the whole fin.
MARGIN_COLS = 1

# The fin is thin geometry and should read one band darker than the trunk, the
# same rule the full mark uses.
COVERAGE_CUTOFF = shark.COVERAGE_CUTOFF
THIN_SCALE = 26.0
THIN_BANDS_SHIFT = 1.2


def draw_window(cols_hint, phase_shift=0.0):
    """Rasterize the dorsal fin + back within the design window.

    `phase_shift` moves the geometry by a fraction of one output column before
    rasterization, so downsample coverage lands differently and the sprite
    reads as a sub-column position.
    """
    x0, x1 = WINDOW_X
    y0, y1 = WINDOW_Y
    span_y = y1 - y0
    # Widen by the margin columns so the crop below has material to keep.
    core = x1 - x0
    pad = core / max(cols_hint, 1) * MARGIN_COLS
    x0, x1 = x0 - pad, x1 + pad
    span_x = x1 - x0
    step = core / max(cols_hint, 1)

    # True proportions: scale both axes by the design's own pixel units, then
    # normalize the taller one to SUPERSAMPLE.
    width_px = span_x * X_UNIT_PX
    height_px = span_y * Y_UNIT_PX
    scale = SUPERSAMPLE / max(width_px, height_px)
    canvas_w = max(2, int(round(width_px * scale)))
    canvas_h = max(2, int(round(height_px * scale)))

    def to_px(x, y):
        px = (x - x0 - phase_shift * step) / span_x * canvas_w
        py = (y1 - y) / span_y * canvas_h
        return px, py

    im = Image.new("1", (canvas_w, canvas_h), 0)
    draw = ImageDraw.Draw(im)

    # Body: the dorsal curve down to the bottom of the window. This is the back
    # breaking the surface, and it anchors the fin so it is not a floating
    # triangle.
    top = PchipInterpolator(*zip(*shark.TOP_PROFILE))
    xs = np.linspace(x0, x1, 240)
    body = [to_px(x, float(top(x))) for x in xs]
    body += [to_px(x, y0 - 0.1) for x in xs[::-1]]
    draw.polygon(body, fill=1)

    # The first dorsal, from the shark's own fin table.
    draw.polygon([to_px(x, y) for x, y in shark.FINS[0]], fill=1)

    mask = np.asarray(im, dtype=bool)

    # Depth is measured from the fin tip down, so the tip takes the darkest
    # back tone and the waterline end lightens toward the flank — the same
    # top-to-bottom reading as the full mark.
    rows_px = np.arange(canvas_h, dtype=np.float32)[:, None]
    depth = np.repeat(rows_px / max(canvas_h - 1, 1), canvas_w, axis=1)
    return mask, depth


def stylize(depth, solidity):
    """The mark's flat depth bands, with thin geometry pushed one band darker."""
    index = np.zeros(depth.shape, dtype=float)
    for edge in shark.BAND_EDGES[:-1]:
        index += (depth > edge).astype(float)
    thin = 1.0 - np.clip(solidity, 0.0, 1.0)
    index = np.maximum(index - thin * THIN_BANDS_SHIFT, 0.0)
    bands = np.asarray(shark.BANDS, dtype=np.uint8)
    return bands[np.clip(np.round(index).astype(int), 0, len(shark.BANDS) - 1)]


def encode(cols, rows, phase_shift=0.0):
    mask, depth_field = draw_window(cols, phase_shift)
    pixel_rows = rows * 2
    wide_cols = cols + 2 * MARGIN_COLS
    weights = mask.astype(np.float32)

    edt = ndimage.distance_transform_edt(mask)
    thickness = np.clip(edt / THIN_SCALE, 0.0, 1.0)

    solidity, coverage = shark.box_downsample(
        thickness, weights, wide_cols, pixel_rows
    )
    depth, _ = shark.box_downsample(depth_field, weights, wide_cols, pixel_rows)
    colors = stylize(depth, solidity)
    drawn = coverage >= COVERAGE_CUTOFF

    grid = []
    for row in range(rows):
        cells = []
        for col in range(MARGIN_COLS, MARGIN_COLS + cols):
            top_on = drawn[row * 2, col]
            bottom_on = drawn[row * 2 + 1, col]
            if not top_on and not bottom_on:
                cells.append(None)
                continue
            cells.append(
                (
                    colors[row * 2, col] if top_on else None,
                    colors[row * 2 + 1, col] if bottom_on else None,
                )
            )
        grid.append(cells)
    return grid


def pack(grid):
    packed = []
    for row in grid:
        cells = []
        for cell in row:
            if cell is None:
                cells.append("")
                continue
            top, bottom = cell
            if top is not None and bottom is not None:
                cells.append(
                    "".join(f"{int(v):02x}" for v in top)
                    + "".join(f"{int(v):02x}" for v in bottom)
                )
            elif top is not None:
                cells.append("t" + "".join(f"{int(v):02x}" for v in top))
            else:
                cells.append("b" + "".join(f"{int(v):02x}" for v in bottom))
        packed.append(",".join(cells))
    return packed


def to_json(cols, rows, phases):
    return {
        "width": cols,
        "rows": rows,
        "phases": [pack(encode(cols, rows, p / phases)) for p in range(phases)],
    }


def render(grid):
    lines = []
    for row in grid:
        line = ""
        for cell in row:
            if cell is None:
                line += " "
                continue
            top, bottom = cell
            if top is not None and bottom is not None:
                line += (
                    f"\x1b[38;2;{top[0]};{top[1]};{top[2]}m"
                    f"\x1b[48;2;{bottom[0]};{bottom[1]};{bottom[2]}m\u2580\x1b[0m"
                )
            elif top is not None:
                line += f"\x1b[38;2;{top[0]};{top[1]};{top[2]}m\u2580\x1b[0m"
            else:
                line += f"\x1b[38;2;{bottom[0]};{bottom[1]};{bottom[2]}m\u2584\x1b[0m"
        lines.append(line)
    return lines


if __name__ == "__main__":
    mode = sys.argv[1]
    cols, rows = int(sys.argv[2]), int(sys.argv[3])
    phases = int(sys.argv[4]) if len(sys.argv) > 4 else 3
    if mode == "preview":
        for phase in range(phases):
            for line in render(encode(cols, rows, phase / phases)):
                print(line)
            print()
    else:
        print(json.dumps(to_json(cols, rows, phases)))

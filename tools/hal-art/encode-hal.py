"""Render the HAL mark into a truecolor half-block cell grid.

Same output contract as tools/shark-art/encode-shark.py: each cell is one `▀`
glyph whose foreground is the upper pixel and background the lower pixel, so a
text row carries two pixel rows.

The mark is drawn, not traced: a shaded crimson hero orb with a cyan instrument
rim, locked up beside block-capital HAL letterforms that carry the desktop
titlebar's 2:1 solid-to-translucent banding. Geometry is evaluated analytically
at 4x supersample and box-downsampled, which is where the anti-aliased limb and
the clean letterform edges come from.

The lockup is horizontal because the landing tiers are wide and short (the
Apex shark occupies the same band): stacking orb over wordmark leaves a wide
canvas mostly empty and forces both elements small. Every dimension derives
from the target box and is then uniformly fit-scaled, so one geometry serves
every tier.

Usage:
    python encode-hal.py preview <cols> <rows>   # ANSI to stdout
    python encode-hal.py json <cols> <rows>      # packed cells to stdout
"""

import json
import sys

import numpy as np

# --- sampling ---------------------------------------------------------------
SS = 4  # supersample factor per axis before box-downsampling to pixels

# Pixels below this coverage stay empty so the mark never paints a translucent
# rectangle over a terminal background that is not exactly `page`.
ALPHA_CUTOFF = 0.22

# Crimson falloff outside the orb disc, in pixels. Reserved as layout margin so
# the halo is never clipped by the left edge of the grid.
HALO_PX = 2.6

# Banding is a wordmark treatment, not a pixel effect: below this cap height the
# dim band eats too large a fraction of a stroke and the letterforms turn to
# mush, so small tiers render the wordmark solid instead.
BAND_MIN_CAP = 13.0

# --- identity colours -------------------------------------------------------
# hal-dark.json: brand #9e1b32, brandDim #3a1019, accent cyan #57b8d9,
# page #05080d. The orb ramp stays inside the crimson identity and only
# brightens toward an ember core; the rim is the cyan instrument frame.
PAGE = np.array((5, 8, 13), dtype=np.float32)
BRAND = np.array((158, 27, 50), dtype=np.float32)
BRAND_DIM = np.array((58, 16, 25), dtype=np.float32)
CYAN = np.array((87, 184, 217), dtype=np.float32)
CYAN_DIM = np.array((52, 103, 121), dtype=np.float32)

# Orb shading ramp, indexed by lit intensity 0..1.
ORB_STOPS = np.array([0.00, 0.22, 0.46, 0.68, 0.86, 1.00], dtype=np.float32)
ORB_PALETTE = np.array(
    [
        (30, 8, 16),     # unlit limb, just above the page
        (78, 16, 33),    # shadowed crimson
        (140, 24, 45),   # brand body
        (190, 38, 62),   # lit crimson
        (232, 96, 92),   # ember shoulder
        (255, 206, 188), # core highlight
    ],
    dtype=np.float32,
)

# Light comes from the upper left and slightly toward the viewer, so the core
# highlight sits up-left of centre and the cyan rim rides the lower-right limb.
LIGHT = np.array((-0.42, -0.52, 0.74), dtype=np.float32)
LIGHT /= np.linalg.norm(LIGHT)


def ramp(values, stops, palette):
    """Interpolate an RGB palette over scalar values."""
    flat = np.clip(values, 0.0, 1.0).ravel()
    rgb = np.column_stack(
        [np.interp(flat, stops, palette[:, channel]) for channel in range(3)]
    )
    return rgb.reshape((*values.shape, 3))


def smoothstep(edge0, edge1, values):
    t = np.clip((values - edge0) / max(edge1 - edge0, 1e-6), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def capsule(x, y, ax, ay, bx, by, half):
    """Coverage-friendly signed distance to a thick segment, as an inside mask."""
    px, py = x - ax, y - ay
    dx, dy = bx - ax, by - ay
    length2 = dx * dx + dy * dy
    t = np.clip((px * dx + py * dy) / max(length2, 1e-6), 0.0, 1.0)
    qx, qy = px - t * dx, py - t * dy
    return np.sqrt(qx * qx + qy * qy) <= half


def box(x, y, x0, y0, x1, y1):
    return (x >= x0) & (x <= x1) & (y >= y0) & (y <= y1)


def letterforms(x, y, left, top, cap, stroke, gap):
    """Block-capital H A L as a boolean mask. Square strokes, no serifs."""
    width = cap * 0.74
    half = stroke / 2.0
    bottom = top + cap
    mask = np.zeros(x.shape, dtype=bool)

    # H: two stems and a crossbar on the optical midline.
    hx = left
    mask |= box(x, y, hx, top, hx + stroke, bottom)
    mask |= box(x, y, hx + width - stroke, top, hx + width, bottom)
    mask |= box(x, y, hx, top + cap * 0.46, hx + width, top + cap * 0.46 + stroke)

    # A: splayed legs plus a crossbar. The bar sits low so the counter above it
    # stays open; at small cap heights a centred bar closes the letter up.
    ax = left + width + gap
    apex = ax + width / 2.0
    mask |= capsule(x, y, apex, top + half, ax + half, bottom - half, half)
    mask |= capsule(x, y, apex, top + half, ax + width - half, bottom - half, half)
    mask |= box(x, y, ax + width * 0.15, top + cap * 0.66, ax + width * 0.85, top + cap * 0.66 + stroke)

    # L: stem and foot.
    lx = left + 2.0 * (width + gap)
    mask |= box(x, y, lx, top, lx + stroke, bottom)
    mask |= box(x, y, lx, bottom - stroke, lx + width, bottom)
    return mask


def layout(width, height):
    """Lockup metrics for a target pixel box, uniformly fit-scaled to fit it.

    Returns (orb_center, orb_radius, word_left, word_top, cap, stroke, gap).
    """
    orb_d = min(0.88 * height, 0.30 * width)
    cap = 0.74 * height
    stroke = 0.20 * cap
    letter_w = 0.72 * cap
    gap = 0.26 * cap
    lockup_gap = 0.32 * orb_d
    total = orb_d + lockup_gap + 3.0 * letter_w + 2.0 * gap

    # One uniform scale keeps the orb/wordmark relationship identical at every
    # tier instead of letting narrow tiers distort the lockup. The halo is
    # reserved on both sides so the disc's falloff is never clipped.
    budget = width - 2.0 * HALO_PX
    if total > budget:
        scale = budget / total
        orb_d *= scale
        cap *= scale
        stroke *= scale
        letter_w *= scale
        gap *= scale
        lockup_gap *= scale
        total *= scale

    left = (width - total) / 2.0
    radius = orb_d / 2.0
    return (
        (left + radius, height / 2.0),
        radius,
        left + orb_d + lockup_gap,
        (height - cap) / 2.0,
        cap,
        max(1.0, stroke),
        gap,
    )


def compose(cols, rows):
    """Return (rgb float array, alpha) at pixel resolution (rows*2 x cols)."""
    width, height = float(cols), float(rows * 2)
    ys, xs = np.mgrid[0 : rows * 2 * SS, 0 : cols * SS]
    x = (xs + 0.5) / SS
    y = (ys + 0.5) / SS

    rgb = np.zeros((*x.shape, 3), dtype=np.float32)
    alpha = np.zeros(x.shape, dtype=np.float32)
    (cx, cy), radius, word_left, word_top, cap, stroke, gap = layout(width, height)

    # --- hero orb ---------------------------------------------------------
    nx = (x - cx) / radius
    ny = (y - cy) / radius
    d2 = nx * nx + ny * ny
    d = np.sqrt(d2)
    inside = d <= 1.0

    nz = np.sqrt(np.clip(1.0 - d2, 0.0, 1.0))
    lambert = np.clip(nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2], 0.0, 1.0)
    # Emissive core: the orb reads as a lit instrument, not a billiard ball.
    core = np.exp(-((d / 0.52) ** 2))
    intensity = np.clip(0.20 + 0.62 * lambert ** 1.35 + 0.46 * core, 0.0, 1.0)
    body = ramp(intensity, ORB_STOPS, ORB_PALETTE)

    # Cyan instrument rim on the unlit limb, strongest lower-right.
    limb = smoothstep(0.74, 1.0, d)
    facing = np.clip(-(nx * LIGHT[0] + ny * LIGHT[1]), 0.0, 1.0)
    rim = (limb ** 2.0) * (0.30 + 0.70 * facing)
    body = body * (1.0 - 0.85 * rim[..., None]) + CYAN * (0.85 * rim[..., None])

    rgb = np.where(inside[..., None], body, rgb)
    alpha = np.where(inside, 1.0, alpha)

    # Tight crimson halo: a few pixels of falloff, never a wash.
    halo = np.exp(-(((d - 1.0) * radius / HALO_PX) ** 2)) * (~inside)
    halo = np.where(d > 1.0, halo * 0.55, 0.0)
    rgb = np.where((halo > alpha)[..., None], BRAND * 0.85 + CYAN_DIM * 0.15, rgb)
    alpha = np.maximum(alpha, halo)

    # --- wordmark ---------------------------------------------------------
    glyphs = letterforms(x, y, word_left, word_top, cap, stroke, gap)

    # Desktop titlebar banding at pixel scale: two solid bands to one
    # translucent band down the cap height, so the ratio survives the
    # resolution jump instead of being a per-text-row stripe.
    band = np.floor((y - word_top) / (cap / 6.0))
    dim_band = ((band % 3.0) == 2.0) & (cap >= BAND_MIN_CAP)
    word = np.where(dim_band[..., None], BRAND_DIM * 1.35 + BRAND * 0.10, BRAND)
    # A soft vertical lift keeps the wordmark from reading as a flat slab.
    lift = 1.0 + 0.16 * (1.0 - np.clip((y - word_top) / max(cap, 1e-6), 0.0, 1.0))
    word = np.clip(word * lift[..., None], 0.0, 255.0)

    rgb = np.where(glyphs[..., None], word, rgb)
    alpha = np.where(glyphs, 1.0, alpha)

    # --- downsample -------------------------------------------------------
    def shrink(field):
        shape = (rows * 2, SS, cols, SS) if field.ndim == 2 else (rows * 2, SS, cols, SS, 3)
        return field.reshape(shape).mean(axis=(1, 3))

    rgb = shrink(rgb)
    alpha = shrink(alpha)
    return rgb, alpha


def encode(cols, rows):
    """Grid of (top_rgb, bottom_rgb) or None per cell."""
    rgb, alpha = compose(cols, rows)
    # Composite over the page so anti-aliased edges blend instead of stepping.
    # Sub-cutoff pixels drop out entirely and stay transparent.
    lit = alpha >= ALPHA_CUTOFF
    blended = PAGE + (rgb - PAGE) * np.clip(alpha, 0.0, 1.0)[..., None]
    colors = np.clip(np.round(blended), 0, 255).astype(np.uint8)

    grid = []
    for row in range(rows):
        cells = []
        for col in range(cols):
            top_on = bool(lit[row * 2, col])
            bottom_on = bool(lit[row * 2 + 1, col])
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
    mode = sys.argv[1] if len(sys.argv) > 1 else "preview"
    cols = int(sys.argv[2]) if len(sys.argv) > 2 else 64
    rows = int(sys.argv[3]) if len(sys.argv) > 3 else 16
    if mode == "json":
        print(json.dumps(to_json(cols, rows)))
    else:
        print(preview(cols, rows))

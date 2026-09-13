"""Generate agent/extensions/apex/observatory/hal-art.ts from the HAL encoder.

Runs encode-hal.py's `to_json` at the landing-screen sizes, packs each cell into
the string form pixel-art.ts decodes, and overwrites the TS module.

Usage:
    python tools/hal-art/emit-ts.py
"""

import importlib.util
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
OUT = ROOT / "agent" / "extensions" / "apex" / "observatory" / "hal-art.ts"

spec = importlib.util.spec_from_file_location("encode_hal", HERE / "encode-hal.py")
encode_hal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(encode_hal)

HEADER = """\
// Generated HAL bitmap data for the Observatory landing screen.
//
// The mark is drawn, not traced: a shaded crimson hero orb with a cyan
// instrument rim, locked up beside block-capital HAL letterforms carrying the
// desktop titlebar's 2:1 solid-to-translucent banding. Geometry is evaluated
// analytically at 4x supersample and box-downsampled, so the limb and the
// letterform edges are anti-aliased rather than stair-stepped.
//
// Colour stays inside the HAL Desktop identity: brand crimson #9e1b32 and
// brandDim #3a1019 across the wordmark, a crimson-to-ember orb ramp, and the
// accent cyan #57b8d9 confined to the lower-right instrument rim. The orb is
// a lit sphere, never an eye: no pupil, no iris ring, no concentric stroke.
//
// Cell encoding, comma-separated per row:
//   "rrggbbRRGGBB"  both halves lit -> `\u2580`, foreground top, background bottom
//   "trrggbb"       upper half only -> `\u2580` with no background
//   "brrggbb"       lower half only -> `\u2584` with no background
//   ""              empty, rendered as a space so the background shows through
//
// Half-lit cells give the disc sub-cell precision around the limb.
//
// Regenerate with tools/hal-art/emit-ts.py; do not edit by hand.
"""


def hex6(rgb):
    return "%02x%02x%02x" % tuple(rgb)


def pack_cell(cell):
    """One packed cell string: "" | "trrggbb" | "brrggbb" | "rrggbbRRGGBB"."""
    if cell is None:
        return ""
    top, bottom = cell
    if top is not None and bottom is not None:
        return hex6(top) + hex6(bottom)
    if top is not None:
        return "t" + hex6(top)
    if bottom is not None:
        return "b" + hex6(bottom)
    return ""


def block(name, cols, rows):
    data = encode_hal.to_json(cols, rows)
    width = data["width"]
    lines = [",".join(pack_cell(c) for c in row) for row in data["rows"]]
    body = "".join(f'  "{line}",\n' for line in lines)
    return (
        f"/** {name['doc']}: {len(lines)} rows x {width} cells "
        f"({width}x{len(lines) * 2} pixels). */\n"
        f"export const {name['const']}_WIDTH = {width};\n"
        f"export const {name['const']}: readonly string[] = [\n"
        f"{body}];\n"
    )


def main():
    ultra = block({"const": "HAL_PIXELS_ULTRA", "doc": "Ultra-wide mark"}, 112, 16)
    wide = block({"const": "HAL_PIXELS_WIDE", "doc": "Full-width mark"}, 72, 12)
    mid = block({"const": "HAL_PIXELS_MID", "doc": "Mid-width mark"}, 48, 8)
    OUT.write_text(
        f"{HEADER}\n\n{ultra}\n{wide}\n{mid}", encoding="utf-8", newline="\n"
    )
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()

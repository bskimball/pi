"""Generate agent/extensions/apex/observatory/shark-art.ts from the shark encoder.

Runs encode-shark.py's `to_json` at the landing-screen sizes, packs each cell
into the string form pixel-art.ts decodes, and overwrites the TS module.

Usage:
    python tools/shark-art/emit-ts.py
"""

import importlib.util
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
OUT = ROOT / "agent" / "extensions" / "apex" / "observatory" / "shark-art.ts"

spec = importlib.util.spec_from_file_location("encode_shark", HERE / "encode-shark.py")
encode_shark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(encode_shark)

HEADER = """\
// Generated shark bitmap data for the Observatory landing screen.
//
// The mark is drawn, not photographed: a parametric side-profile silhouette
// (smooth PCHIP body curves plus straight-edged fin polygons) rendered into a
// half-block cell grid. Each cell is one glyph carrying two rows of pixels at
// full truecolor depth, so the mark has twice the vertical resolution of the
// text grid it lives in.
//
// Colour is a designed cosmic countershade: violet and indigo across the back,
// a narrow cyan lateral glow, and a cool pearl belly. Restrained deterministic
// highlights add pixel-scale depth at the ultra tier. The eye, gill slits and
// jaw remain authored anatomical marks, not details sampled from a photograph.
//
// Cell encoding, comma-separated per row:
//   "rrggbbRRGGBB"  both halves lit -> `\u2580`, foreground top, background bottom
//   "trrggbb"       upper half only -> `\u2580` with no background
//   "brrggbb"       lower half only -> `\u2584` with no background
//   ""              empty, rendered as a space so the star field shows through
//
// Half-lit cells give the silhouette sub-cell precision along the dorsal edge,
// the fin tips and the tail.
//
// Regenerate with tools/shark-art/emit-ts.py; do not edit by hand.
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
    data = encode_shark.to_json(cols, rows)
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
    ultra = block(
        {"const": "SHARK_PIXELS_ULTRA", "doc": "Ultra-wide mark"}, 112, 16
    )
    wide = block(
        {"const": "SHARK_PIXELS_WIDE", "doc": "Full-width mark"}, 72, 12
    )
    mid = block({"const": "SHARK_PIXELS_MID", "doc": "Mid-width mark"}, 48, 8)
    OUT.write_text(
        f"{HEADER}\n\n{ultra}\n{wide}\n{mid}", encoding="utf-8", newline="\n"
    )
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()

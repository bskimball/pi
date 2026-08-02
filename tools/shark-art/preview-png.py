"""Render ANSI truecolor half-block text to a PNG, approximating a terminal.

Lets the shark art be judged at real cell metrics without launching a TUI:

    python tools/shark-art/encode-shark.py preview 64 12 > out.ansi
    python tools/shark-art/preview-png.py out.ansi out.png
"""

import re
import sys

from PIL import Image, ImageDraw

CELL_W, CELL_H = 8, 17
BG = (13, 13, 23)
SGR = re.compile(r"\x1b\[([0-9;]*)m")


def parse(line):
    """Yield (char, fg, bg) per cell, tracking 24-bit SGR colour only."""
    fg, bg, out, index = (200, 200, 200), None, [], 0
    for match in SGR.finditer(line):
        out.extend((ch, fg, bg) for ch in line[index : match.start()])
        codes = [int(c) for c in match.group(1).split(";") if c != ""] or [0]
        i = 0
        while i < len(codes):
            if codes[i] == 0:
                fg, bg = (200, 200, 200), None
            elif codes[i] == 38 and codes[i + 1] == 2:
                fg = tuple(codes[i + 2 : i + 5])
                i += 4
            elif codes[i] == 48 and codes[i + 1] == 2:
                bg = tuple(codes[i + 2 : i + 5])
                i += 4
            i += 1
        index = match.end()
    out.extend((ch, fg, bg) for ch in line[index:])
    return out


def render(path_in, path_out, scale=3):
    rows = [parse(line) for line in open(path_in, encoding="utf-8").read().split("\n")]
    cols = max((len(r) for r in rows), default=0)
    im = Image.new("RGB", (cols * CELL_W, len(rows) * CELL_H), BG)
    draw = ImageDraw.Draw(im)
    for y, row in enumerate(rows):
        for x, (ch, fg, bg) in enumerate(row):
            px, py = x * CELL_W, y * CELL_H
            if bg:
                draw.rectangle([px, py, px + CELL_W - 1, py + CELL_H - 1], fill=bg)
            if ch == "\u2580":  # ▀ upper half
                draw.rectangle([px, py, px + CELL_W - 1, py + CELL_H // 2 - 1], fill=fg)
            elif ch == "\u2584":  # ▄ lower half
                draw.rectangle([px, py + CELL_H // 2, px + CELL_W - 1, py + CELL_H - 1], fill=fg)
    im = im.resize((im.width * scale, im.height * scale), Image.NEAREST)
    im.save(path_out)
    print(path_out, im.size)


if __name__ == "__main__":
    render(sys.argv[1], sys.argv[2])

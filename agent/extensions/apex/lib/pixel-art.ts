// pixel-art: the shared decoder for packed half-block truecolor sprites.
//
// The landing mark (shark-art.ts) is emitted by the Python encoder in this
// packed cell format, so the decoding, the truecolor gate and the failure
// behaviour live here once.
//
// Cell encoding, comma-separated per row:
//   "rrggbbRRGGBB"  both halves lit -> `▀`, foreground top, background bottom
//   "trrggbb"       upper half only -> `▀` with no background
//   "brrggbb"       lower half only -> `▄` with no background
//   ""              empty, rendered as a space so whatever is behind shows
//
// Anything unparseable renders as a space rather than leaking escape codes.

/** Upper-half and lower-half blocks; both are narrow BMP, one cell wide. */
export const UPPER_HALF = "\u2580";
export const LOWER_HALF = "\u2584";

/**
 * Truecolor is required for the pixel art: it carries its shading as per-cell
 * RGB, so on a 256-colour terminal it would band into mud. Callers keep a
 * glyph fallback for that case.
 *
 * Detection mirrors the usual terminal convention and is deliberately
 * conservative: only an explicit 24-bit signal opts in.
 */
export function supportsTruecolor(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return true;
  // Windows Terminal, VS Code and iTerm all render 24-bit colour.
  if (env.WT_SESSION || env.VSCODE_INJECTION) return true;
  return (env.TERM_PROGRAM ?? "") === "iTerm.app";
}

export const TRUECOLOR = supportsTruecolor();

/** Parse `rrggbb` into an SGR colour triple, or null when malformed. */
function parseHex(hex: string): [number, number, number] | null {
  if (hex.length !== 6) return null;
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return [r, g, b];
}

/** Expand one packed cell into an SGR-styled block glyph. */
export function pixelCell(packed: string): string {
  if (packed.length === 7) {
    const half = packed[0];
    if (half !== "t" && half !== "b") return " ";
    const only = parseHex(packed.slice(1));
    if (!only) return " ";
    const glyph = half === "t" ? UPPER_HALF : LOWER_HALF;
    return `\x1b[38;2;${only[0]};${only[1]};${only[2]}m${glyph}\x1b[0m`;
  }
  if (packed.length !== 12) return " ";
  const top = parseHex(packed.slice(0, 6));
  const bottom = parseHex(packed.slice(6));
  if (!top || !bottom) return " ";
  return (
    `\x1b[38;2;${top[0]};${top[1]};${top[2]}m` +
    `\x1b[48;2;${bottom[0]};${bottom[1]};${bottom[2]}m` +
    `${UPPER_HALF}\x1b[0m`
  );
}

/**
 * Render a packed bitmap into styled rows. Empty cells stay spaces so whatever
 * sits behind the sprite shows through instead of being punched out by a
 * background colour.
 */
export function pixelRows(art: readonly string[]): string[] {
  return art.map((row) =>
    row
      .split(",")
      .map((cell) => (cell ? pixelCell(cell) : " "))
      .join(""),
  );
}

/**
 * Decode one packed row into per-cell strings rather than a joined line, for
 * callers that composite a sprite into an existing row of text.
 */
export function pixelCells(row: string): string[] {
  return row.split(",").map((cell) => (cell ? pixelCell(cell) : " "));
}

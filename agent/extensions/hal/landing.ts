import {
  TRUECOLOR,
  registerObservatoryLanding,
  type LandingBlock,
} from "@pi/ui-kit";

type Fg = (key: any, text: string) => string;
const MINIMAL_MIN = 20;

/**
 * The HAL mark is a lens orb above an IBM-style striped wordmark. Both are
 * drawn from upper-half blocks (`▀`, U+2580) so every terminal row lights only
 * its top half and leaves its bottom half dark — continuous horizontal
 * scanlines at row granularity, without a wide, ambiguous or combining glyph
 * and without a generated bitmap.
 *
 * The orb is the HAL 9000 lens: a dark bezel ring, a concentric crimson glow,
 * and a radiant amber pupil at the center. On a truecolor terminal each cell
 * is inked from its own radial distance, giving a true continuous gradient.
 * Elsewhere the same geometry collapses to three theme keys.
 *
 * Crimson stays on the dedicated `brand`/`brandDim` keys of hal-dark and
 * degrades to accent/muted under any other theme (see {@link halFg}).
 */
const STRIPE = "\u2580";

/**
 * Full tier needs room for the lockup *and* for the constellation the
 * interactive orb draws beneath the mark, so it is gated on the same width the
 * kit uses for its wide layout rather than on the art's own width alone.
 */
const HAL_FULL_MIN = 62;

/* ------------------------------------------------------------------ orb --- */

/**
 * Radial colour ramp, center outwards. Stops are the lens read off the HAL
 * desktop hero: a radiant amber pupil, a crimson glow falling to near-black,
 * then a narrow bronze/charcoal bezel at the very limb.
 *
 * Positions are normalized radius (0 = center, 1 = limb), so the same ramp
 * serves every tier without retuning.
 */
const ORB_RAMP: readonly (readonly [number, readonly [number, number, number]])[] = [
  [0.0, [255, 245, 157]], // #fff59d radiant yellow core
  [0.13, [255, 235, 59]], // #ffeb3b bright yellow
  [0.26, [245, 158, 11]], // #f59e0b warm amber
  [0.36, [240, 44, 68]], // #f02c44 glowing red
  [0.48, [224, 34, 58]], // #e0223a bright red
  [0.66, [158, 27, 50]], // #9e1b32 brand crimson
  [0.84, [74, 14, 24]], // #4a0e18 dark crimson
  [0.92, [53, 32, 24]], // #352018 bronze bezel
  [1.0, [40, 22, 28]], // #28161c charcoal bezel
];

/** Radii where the fallback palette switches key. Matches the ramp's bands. */
const ORB_CORE_MAX = 0.3;
const ORB_RED_MAX = 0.84;

function rampAt(radius: number): readonly [number, number, number] {
  for (let index = 1; index < ORB_RAMP.length; index++) {
    const [from, fromColor] = ORB_RAMP[index - 1]!;
    const [to, toColor] = ORB_RAMP[index]!;
    if (radius <= to) {
      const span = to - from;
      const t = span === 0 ? 0 : (radius - from) / span;
      return [
        Math.round(fromColor[0] + (toColor[0] - fromColor[0]) * t),
        Math.round(fromColor[1] + (toColor[1] - fromColor[1]) * t),
        Math.round(fromColor[2] + (toColor[2] - fromColor[2]) * t),
      ];
    }
  }
  return ORB_RAMP[ORB_RAMP.length - 1]![1];
}

/**
 * Normalized radius per cell, or `undefined` outside the disc. Rows and columns
 * are normalized independently, so the disc reads as a circle on a terminal
 * grid whose cells are roughly twice as tall as they are wide.
 */
function discRadii(rows: number, columns: number): (number | undefined)[][] {
  const centerY = rows / 2;
  const centerX = columns / 2;
  const grid: (number | undefined)[][] = [];
  for (let y = 0; y < rows; y++) {
    const dy = (y + 0.5 - centerY) / centerY;
    const line: (number | undefined)[] = [];
    for (let x = 0; x < columns; x++) {
      const dx = (x + 0.5 - centerX) / centerX;
      const radius = Math.hypot(dx, dy);
      line.push(radius <= 1 ? radius : undefined);
    }
    grid.push(line);
  }
  return grid;
}

/**
 * Bake the truecolor orb once at module load. Every cell carries its own RGB,
 * coalesced into runs so a row emits one escape per colour change rather than
 * one per cell. Cells outside the disc are plain spaces, so each row's visible
 * width is exactly `columns`.
 */
function truecolorOrb(rows: number, columns: number): string[] {
  return discRadii(rows, columns).map((line) => {
    let out = "";
    let current: string | undefined;
    for (const radius of line) {
      if (radius === undefined) {
        if (current !== undefined) {
          out += "\u001b[39m";
          current = undefined;
        }
        out += " ";
        continue;
      }
      const [r, g, b] = rampAt(radius);
      const color = `${r};${g};${b}`;
      if (color !== current) {
        if (current !== undefined) out += "\u001b[39m";
        out += `\u001b[38;2;${color}m`;
        current = color;
      }
      out += STRIPE;
    }
    if (current !== undefined) out += "\u001b[39m";
    return out;
  });
}

/** One `[themeKey, cellCount]` run; `undefined` key means unstyled spaces. */
type Run = readonly [string | undefined, number];

/**
 * The same geometry for terminals without 24-bit colour: the bezel and the
 * outer glow collapse to `brandDim`, the crimson body to `brand`, and the
 * pupil to `warning` (amber in hal-dark, and present in every bundled theme).
 */
function fallbackOrb(rows: number, columns: number): Run[][] {
  return discRadii(rows, columns).map((line) => {
    const runs: Run[] = [];
    for (const radius of line) {
      const key =
        radius === undefined
          ? undefined
          : radius <= ORB_CORE_MAX
            ? "warning"
            : radius <= ORB_RED_MAX
              ? "brand"
              : "brandDim";
      const last = runs[runs.length - 1];
      if (last && last[0] === key) runs[runs.length - 1] = [key, last[1] + 1];
      else runs.push([key, 1]);
    }
    return runs;
  });
}

const ORB_FULL_ROWS = 9;
const ORB_FULL_WIDTH = 18;
const ORB_COMPACT_ROWS = 7;
const ORB_COMPACT_WIDTH = 14;

const ORB_FULL_TRUECOLOR = truecolorOrb(ORB_FULL_ROWS, ORB_FULL_WIDTH);
const ORB_FULL_FALLBACK = fallbackOrb(ORB_FULL_ROWS, ORB_FULL_WIDTH);
const ORB_COMPACT_TRUECOLOR = truecolorOrb(ORB_COMPACT_ROWS, ORB_COMPACT_WIDTH);
const ORB_COMPACT_FALLBACK = fallbackOrb(ORB_COMPACT_ROWS, ORB_COMPACT_WIDTH);

/* -------------------------------------------------------------- wordmark --- */

/**
 * Paul Rand's IBM mark is eight bars of *uniform* intensity — the stripes are
 * cut by the letterform, never by shading. So every wordmark row is inked with
 * the same `brand` key; no row is dimmed.
 *
 * Letterforms follow City Medium slab-serif construction at two-cell stroke
 * weight: slab serifs top and bottom, a crossbar on the fourth and fifth bars
 * for `H`, the fifth for `A`, and an `L` whose foot turns up at its terminal.
 * Strokes must stay at least two cells wide at the full tier or the scanlines
 * eat the letterform instead of banding it.
 */
const GLYPH_H: readonly string[] = [
  "███   ███",
  " ██   ██ ",
  " ██   ██ ",
  " ███████ ",
  " ███████ ",
  " ██   ██ ",
  " ██   ██ ",
  "███   ███",
];
const GLYPH_A: readonly string[] = [
  "  █████  ",
  " ██   ██ ",
  " ██   ██ ",
  "██     ██",
  "█████████",
  "██     ██",
  "██     ██",
  "███   ███",
];
const GLYPH_L: readonly string[] = [
  "███      ",
  " ██      ",
  " ██      ",
  " ██      ",
  " ██      ",
  " ██      ",
  " ██    ██",
  "█████████",
];

/** One-cell strokes for narrow terminals, same eight bars and same skeleton. */
const GLYPH_H_COMPACT: readonly string[] = [
  "██ ██",
  " █ █ ",
  " █ █ ",
  " ███ ",
  " ███ ",
  " █ █ ",
  " █ █ ",
  "██ ██",
];
const GLYPH_A_COMPACT: readonly string[] = [
  " ███ ",
  " █ █ ",
  "█   █",
  "█   █",
  "█████",
  "█   █",
  "█   █",
  "██ ██",
];
const GLYPH_L_COMPACT: readonly string[] = [
  "██  ",
  " █  ",
  " █  ",
  " █  ",
  " █  ",
  " █  ",
  " █ █",
  "████",
];

const WORDMARK_GAP = 2;

/** Set the three glyphs side by side on a shared baseline. */
function setWordmark(glyphs: readonly (readonly string[])[]): string[] {
  const gap = " ".repeat(WORDMARK_GAP);
  return glyphs[0]!.map((_, row) => glyphs.map((glyph) => glyph[row]!).join(gap));
}

const WORDMARK_FULL = setWordmark([GLYPH_H, GLYPH_A, GLYPH_L]);
const WORDMARK_COMPACT = setWordmark([
  GLYPH_H_COMPACT,
  GLYPH_A_COMPACT,
  GLYPH_L_COMPACT,
]);
const WORDMARK_FULL_WIDTH = WORDMARK_FULL[0]!.length;
const WORDMARK_COMPACT_WIDTH = WORDMARK_COMPACT[0]!.length;

/* ---------------------------------------------------------------- render --- */

/** Swap solid blocks for upper-half blocks so each row renders as one stripe. */
function striped(art: readonly string[]): readonly string[] {
  return art.map((row) => row.replaceAll("█", STRIPE));
}

const WORDMARK_FULL_STRIPED = striped(WORDMARK_FULL);
const WORDMARK_COMPACT_STRIPED = striped(WORDMARK_COMPACT);

/** Centering pad for a row whose visible width is known without measuring. */
function pad(visibleWidth: number, blockWidth: number): [string, string] {
  const slack = Math.max(0, blockWidth - visibleWidth);
  const left = Math.floor(slack / 2);
  return [" ".repeat(left), " ".repeat(slack - left)];
}

/**
 * Brand inks with graceful degradation: `brand`/`brandDim` exist only in
 * hal-dark, so under any other theme the mark renders in accent/muted
 * instead of throwing (Pi's theme.fg throws on unknown keys, which would
 * otherwise collapse the whole landing to the unavailable fallback).
 */
function halFg(fg: Fg, key: string, text: string): string {
  try {
    return fg(key, text);
  } catch {
    return fg(key === "brand" ? "accent" : "muted", text);
  }
}

function orbBlock(
  fg: Fg,
  full: boolean,
  blockWidth: number,
): string[] {
  const width = full ? ORB_FULL_WIDTH : ORB_COMPACT_WIDTH;
  const [left, right] = pad(width, blockWidth);
  if (TRUECOLOR) {
    const rows = full ? ORB_FULL_TRUECOLOR : ORB_COMPACT_TRUECOLOR;
    return rows.map((row) => `${left}${row}${right}`);
  }
  const rows = full ? ORB_FULL_FALLBACK : ORB_COMPACT_FALLBACK;
  return rows.map((runs) => {
    let out = left;
    for (const [key, count] of runs) {
      const cells = key === undefined ? " ".repeat(count) : STRIPE.repeat(count);
      out += key === undefined ? cells : halFg(fg, key, cells);
    }
    return out + right;
  });
}

function wordmarkBlock(fg: Fg, full: boolean, blockWidth: number): string[] {
  const rows = full ? WORDMARK_FULL_STRIPED : WORDMARK_COMPACT_STRIPED;
  const width = full ? WORDMARK_FULL_WIDTH : WORDMARK_COMPACT_WIDTH;
  const [left, right] = pad(width, blockWidth);
  // Eight bars at one uniform intensity, exactly as the IBM mark is set.
  return rows.map((row) => `${left}${halFg(fg, "brand", row)}${right}`);
}

export function registerHalLanding(): void {
  registerObservatoryLanding("hal", {
    prelude() {
      return [];
    },
    logo(fg, width): LandingBlock {
      if (width < MINIMAL_MIN) {
        return { rows: [halFg(fg, "brand", STRIPE)], blockWidth: 1 };
      }
      const full = width >= HAL_FULL_MIN;
      const blockWidth = full
        ? Math.max(ORB_FULL_WIDTH, WORDMARK_FULL_WIDTH)
        : Math.max(ORB_COMPACT_WIDTH, WORDMARK_COMPACT_WIDTH);
      return {
        rows: [
          ...orbBlock(fg, full, blockWidth),
          // One dark row between lens and wordmark, as the desktop hero sets
          // them. Without it the bezel's bottom stripe reads as a ninth bar.
          "",
          ...wordmarkBlock(fg, full, blockWidth),
        ],
        blockWidth,
      };
    },
    invitation(fg, width) {
      const label = width >= 28 ? "What are we working on?" : "Ready";
      return fg("accent", "> ") + fg("muted", label);
    },
  });
}

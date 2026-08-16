// star-field: the sky behind the mark, carrying two truths at once.
//
// Shape is the *project*: the pattern is derived deterministically from the
// workspace path, so every repo has its own recognizable constellation and the
// same repo looks the same on every launch. "Which project am I in" becomes a
// visual fact rather than a line of text.
//
// Density is the *context*: stars burn out as the window fills, dimmest first,
// so a nearly-full context is a nearly-empty sky. Nothing is spelled out; the
// footer still carries the exact number for anyone who wants it.
//
// Pure and dependency-free: same inputs, same row, no timers, no state.

export interface StarFieldTheme {
  fg(token: string, text: string): string;
}

/** Bright anchors and faint dust. Both are single-cell BMP. */
const BRIGHT = "\u22c6";
const FAINT = "\u00b7";

/**
 * Stars per column. Sparse on purpose: the sky frames the mark, it does not
 * compete with it.
 */
const DENSITY = 0.085;

/**
 * The burn line never rises past this, so the brightest anchors always survive
 * and the field degrades to a sparse constellation rather than an empty band.
 */
const BURN_CEILING = 0.72;

/** FNV-1a over the seed, so the constellation is stable across launches. */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: small, fast, good enough for placing dots. */
function makeRandom(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Star {
  column: number;
  /** 0..1; higher survives a fuller context and renders as a bright anchor. */
  magnitude: number;
}

/**
 * The project's own constellation: deterministic positions and magnitudes for
 * a given seed and width.
 */
function constellation(seed: string, width: number): Star[] {
  const random = makeRandom(hashSeed(seed));
  const count = Math.max(2, Math.round(width * DENSITY));
  const stars: Star[] = [];
  const taken = new Set<number>();
  // Reject adjacent columns so the field reads as separated stars rather than
  // a dotted line.
  for (let attempt = 0; attempt < count * 12 && stars.length < count; attempt++) {
    const column = Math.floor(random() * width);
    if (taken.has(column) || taken.has(column - 1) || taken.has(column + 1)) {
      continue;
    }
    taken.add(column);
    stars.push({ column, magnitude: random() });
  }
  return stars.sort((a, b) => a.column - b.column);
}

/**
 * Render the field.
 *
 * `fill` is context usage in 0..1; at 0 the whole constellation is visible, and
 * as it approaches 1 the faint stars go out first and the bright anchors last.
 * An unknown fill (no usage yet) renders the full sky.
 */
export function starFieldRow(
  fg: StarFieldTheme["fg"],
  width: number,
  seed: string,
  fill: number | undefined,
): string {
  if (width <= 0) return "";
  // The sky thins but never empties: a black band would read as a rendering
  // failure, and the brightest anchors are what make the constellation
  // recognizable as *this* project even at the very end of a context.
  const burn = Math.min(BURN_CEILING, Math.max(0, fill ?? 0));
  const cells: string[] = new Array(width).fill(" ");
  const stars = constellation(seed, width);
  // Guarantee at least one survivor even if every magnitude happens to fall
  // below the ceiling, so the row is never completely blank.
  let brightest: Star | undefined;
  for (const star of stars) {
    if (!brightest || star.magnitude > brightest.magnitude) brightest = star;
  }
  for (const star of stars) {
    // A star survives while its magnitude still clears the burn line.
    if (star.magnitude < burn && star !== brightest) continue;
    if (star.column < 0 || star.column >= width) continue;
    const bright = star.magnitude > 0.72;
    cells[star.column] = bright
      ? fg("dim", BRIGHT)
      : fg("borderMuted", FAINT);
  }
  return cells.join("").replace(/\s+$/, "");
}

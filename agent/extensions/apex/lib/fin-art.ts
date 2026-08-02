// Generated dorsal-fin sprite for the fleet waterline.
//
// This is not a lookalike glyph: encode-fin.py crops the *same* parametric
// design the landing mark uses (encode-shark.py's first-dorsal polygon plus the
// dorsal body curve beneath it) and rasterizes that window through the same
// depth-band palette. So the fin on the waterline is the mark's own fin.
//
// Cell encoding matches shark-art.ts exactly:
//   "rrggbbRRGGBB"  both halves lit -> `▀`, foreground top, background bottom
//   "trrggbb"       upper half only -> `▀` with no background
//   "brrggbb"       lower half only -> `▄` with no background
//   ""              empty, rendered as a space so the rule shows through
//
// Half blocks split cells vertically, so there is no sub-cell precision along
// the axis a fin actually travels. Smoothness comes from phase sprites instead:
// the same fin rasterized at fractional column offsets, which changes which
// columns clear the coverage cutoff. Cycling the phases and then stepping one
// whole column reads as continuous travel rather than a 1-cell hop.
//
// Regenerate with tools/shark-art/encode-fin.py; do not edit by hand.

/** Sprite footprint: 7 cells wide, 2 rows tall. */
export const FIN_WIDTH = 7;
export const FIN_ROWS = 2;

/** Sub-column phases, in travel order. */
export const FIN_PHASES: readonly (readonly string[])[] = [
  [
    ",,b181238,181238181238,,,",
    "bd6e8f8,7dd3fcd6e8f8,7dd3fcd6e8f8,7dd3fcd6e8f8,7dd3fcd6e8f8,bd6e8f8,b96b4e0",
  ],
  [
    ",,b181238,b181238,,,",
    "bd6e8f8,7dd3fcd6e8f8,7dd3fcd6e8f8,7dd3fcd6e8f8,7dd3fcd6e8f8,bd6e8f8,b96b4e0",
  ],
  [
    ",,181238181238,b181238,,,",
    "bd6e8f8,7dd3fcd6e8f8,7dd3fcd6e8f8,7dd3fcd6e8f8,bd6e8f8,bd6e8f8,",
  ],
];

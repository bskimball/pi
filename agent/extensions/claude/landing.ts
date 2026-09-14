import {
  registerObservatoryLanding,
  safeTruncateToWidth,
  safeVisibleWidth,
  starFieldRow,
  type LandingBlock,
} from "@pi/ui-kit";

type Fg = (key: any, text: string) => string;

const FULL_MIN = 62;
const MINIMAL_MIN = 20;
const STARFIELD_WIDE_SPAN = 42;
const STARFIELD_NARROW_SPAN = 20;

// The Claude critter: an original block-art robot head in the same layout
// language Claude Code uses on its blank screen — square head with side ears,
// two dark slit eyes, and a split-foot body in terracotta. Eyes and gaps are
// plain spaces so the dark terminal background shows through (no theme-key
// gamble for a contrasting pupil color). Narrow block cells only.
//
// Terminal cells are roughly twice as tall as they are wide, so an equal-count
// grid reads as a stretched column. The full mark is 29 cells across and 7
// rows tall (compact 19 x 5) so the head stays squat and the feet stay short.
const CRITTER_FULL_RAW: readonly string[] = [
  "     ▄█████████████████▄     ",
  "  ██ ███████████████████ ██  ",
  "  ██ ███████████████████ ██  ",
  "  ██ ████   █████   ████ ██  ",
  "     ███████████████████     ",
  "      █████████████████      ",
  "      █████       █████      ",
];
const CRITTER_COMPACT_RAW: readonly string[] = [
  "   ▄███████████▄   ",
  " █ █████████████ █ ",
  " █ ███  ███  ███ █ ",
  "   █████████████   ",
  "    ███     ███    ",
];
const CRITTER_MINIMAL = "█";

function center(text: string, width: number): string {
  const visible = safeVisibleWidth(text);
  if (visible >= width) return safeTruncateToWidth(text, width);
  return `${" ".repeat(Math.floor((width - visible) / 2))}${text}`;
}

function normalize(raw: readonly string[]): { rows: string[]; width: number } {
  const width = Math.max(...raw.map((row) => [...row].length));
  const rows = raw.map((row) => {
    const cells = [...row].length;
    const pad = Math.max(0, width - cells);
    const left = Math.floor(pad / 2);
    return `${" ".repeat(left)}${row}${" ".repeat(pad - left)}`;
  });
  return { rows, width };
}

const CRITTER_FULL = normalize(CRITTER_FULL_RAW);
const CRITTER_COMPACT = normalize(CRITTER_COMPACT_RAW);

// Geometry is static on focus, like the HAL mark: selection state never
// moves or recolors the art.
function critterBlock(
  fg: Fg,
  art: { rows: string[]; width: number },
): LandingBlock {
  return { rows: art.rows.map((row) => fg("accent", row)), blockWidth: art.width };
}

export function registerClaudeLanding(): void {
  registerObservatoryLanding("claude", {
    prelude(fg, width, view) {
      if (width < MINIMAL_MIN) return [];
      const skySpan = Math.min(width, width >= FULL_MIN ? STARFIELD_WIDE_SPAN : STARFIELD_NARROW_SPAN);
      return [center(starFieldRow(fg, skySpan, view.seed, view.contextFill), width)];
    },
    logo(fg, width, _active): LandingBlock {
      if (width < MINIMAL_MIN) return { rows: [fg("accent", CRITTER_MINIMAL)], blockWidth: 1 };
      if (width >= FULL_MIN) return critterBlock(fg, CRITTER_FULL);
      return critterBlock(fg, CRITTER_COMPACT);
    },
    invitation(fg, width) {
      const full = fg("accent", "> ") + fg("muted", "transmit an intention…");
      if (safeVisibleWidth(full) <= width) return full;
      return fg("accent", "> ") + fg("muted", "an intention…");
    },
  });
}

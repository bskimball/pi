import { pixelRows, TRUECOLOR } from "./pixel-art.ts";
import {
  SHARK_PIXELS_MID,
  SHARK_PIXELS_MID_WIDTH,
  SHARK_PIXELS_ULTRA,
  SHARK_PIXELS_ULTRA_WIDTH,
  SHARK_PIXELS_WIDE,
  SHARK_PIXELS_WIDE_WIDTH,
} from "./shark-art.ts";
import { starFieldRow } from "./star-field.ts";
import { safeTruncateToWidth, safeVisibleWidth } from "../internal/presentation/safe-text-layout.ts";
import {
  registerObservatoryLanding,
  type Fg,
  type LandingBlock,
  type ObservatoryLanding,
} from "./landing.ts";
import type { SkinName } from "../internal/presentation/skin.ts";

const FULL_MIN = 62;
const MINIMAL_MIN = 20;
const PIXEL_ULTRA_MIN = SHARK_PIXELS_ULTRA_WIDTH + 2;
const PIXEL_WIDE_MIN = SHARK_PIXELS_WIDE_WIDTH + 2;
const PIXEL_MID_MIN = SHARK_PIXELS_MID_WIDTH + 2;
const STARFIELD_WIDE_SPAN = 42;
const STARFIELD_NARROW_SPAN = 20;

const SHARK_LOGO: readonly string[] = [
  "                  ▄██▄                              ▄███",
  "                ▄██████▄                         ▄████▀ ",
  "     ▄▄▄▄█████████████████████████▄▄▄▄        ▄█████▀   ",
  " ▄▓██▒█████▓█▓█▓████████████████████████▄▄▄▄▄▄██████    ",
  "  ▀▀ ▓▓▓▓██████████████████████▀▀▀▀▀▀▀▀         ▄████   ",
  "      ▀▀▀▀███████▀▀▀▀                             ▀███▀ ",
  "             ▀▀██▄▄                                     ",
];
const SHARK_LOGO_WIDTH = 56;
const SHARK_LOGO_KEYS: readonly (string | null)[] = [
  "customMessageLabel",
  "customMessageLabel",
  "customMessageLabel",
  null,
  "text",
  "text",
  "muted",
];
const SHARK_COMPACT: readonly string[] = [
  "     ▄██▄       ▄█",
  " ▄▄███████▄▄▄▄▄██▀",
  "▀████████████▀▀██▄",
  "  ▀▀▀▀███       ▀█",
];
const SHARK_COMPACT_WIDTH = 18;
const SHARK_COMPACT_KEYS: readonly (string | null)[] = [
  "customMessageLabel",
  null,
  "text",
  "muted",
];
const SHARK_MINIMAL = "▴";

function center(text: string, width: number): string {
  const visible = safeVisibleWidth(text);
  if (visible >= width) return safeTruncateToWidth(text, width);
  return `${" ".repeat(Math.floor((width - visible) / 2))}${text}`;
}

function lateralLine(art: string, fg: Fg): string {
  const edge = Math.max(1, Math.round(art.length * 0.22));
  return (
    fg("customMessageLabel", art.slice(0, edge)) +
    fg("accent", art.slice(edge, art.length - edge)) +
    fg("customMessageLabel", art.slice(art.length - edge))
  );
}

export const classicObservatoryLanding: ObservatoryLanding = {
  prelude(fg, width, view) {
    if (width < MINIMAL_MIN) return [];
    const skySpan = Math.min(width, width >= FULL_MIN ? STARFIELD_WIDE_SPAN : STARFIELD_NARROW_SPAN);
    return [center(starFieldRow(fg, skySpan, view.seed, view.contextFill), width)];
  },
  logo(fg, width, active): LandingBlock {
    if (width < MINIMAL_MIN) return { rows: [fg("accent", SHARK_MINIMAL)], blockWidth: 1 };
    if (TRUECOLOR && width >= PIXEL_ULTRA_MIN) {
      return { rows: pixelRows(SHARK_PIXELS_ULTRA), blockWidth: SHARK_PIXELS_ULTRA_WIDTH };
    }
    if (TRUECOLOR && width >= PIXEL_WIDE_MIN) {
      return { rows: pixelRows(SHARK_PIXELS_WIDE), blockWidth: SHARK_PIXELS_WIDE_WIDTH };
    }
    if (TRUECOLOR && width >= PIXEL_MID_MIN) {
      return { rows: pixelRows(SHARK_PIXELS_MID), blockWidth: SHARK_PIXELS_MID_WIDTH };
    }
    const full = width >= FULL_MIN;
    const art = full ? SHARK_LOGO : SHARK_COMPACT;
    const keys = full ? SHARK_LOGO_KEYS : SHARK_COMPACT_KEYS;
    const rows = art.map((row, index) => {
      const key = keys[index];
      if (key !== null && key !== undefined) return fg(key, row);
      return active ? fg("accent", row) : lateralLine(row, fg);
    });
    return { rows, blockWidth: full ? SHARK_LOGO_WIDTH : SHARK_COMPACT_WIDTH };
  },
  invitation(fg, width) {
    const full = fg("accent", "❯ ") + fg("muted", "transmit an intention…");
    if (safeVisibleWidth(full) <= width) return full;
    return fg("accent", "❯ ") + fg("muted", "an intention…");
  },
};

export function registerClassicObservatoryLanding(skin: SkinName): void {
  registerObservatoryLanding(skin, classicObservatoryLanding);
}

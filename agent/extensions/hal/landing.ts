import {
  TRUECOLOR,
  pixelRows,
  registerObservatoryLanding,
  safeTruncateToWidth,
  safeVisibleWidth,
  type LandingBlock,
} from "@pi/ui-kit";
import {
  HAL_PIXELS_MID,
  HAL_PIXELS_MID_WIDTH,
  HAL_PIXELS_ULTRA,
  HAL_PIXELS_ULTRA_WIDTH,
  HAL_PIXELS_WIDE,
  HAL_PIXELS_WIDE_WIDTH,
} from "./hal-art.ts";

type Fg = (key: any, text: string) => string;
const MINIMAL_MIN = 20;
const HAL_ULTRA_MIN = HAL_PIXELS_ULTRA_WIDTH + 2;
const HAL_WIDE_MIN = HAL_PIXELS_WIDE_WIDTH + 2;
const HAL_MID_MIN = HAL_PIXELS_MID_WIDTH + 2;
const HAL_WORDMARK: readonly string[] = [
  "█   █   ███   █    ",
  "█   █  █   █  █    ",
  "█████  █████  █    ",
  "█   █  █   █  █    ",
  "█   █  █   █  █    ",
  "█   █  █   █  █████",
];
const HAL_WORDMARK_WIDTH = 19;
const HAL_WORDMARK_KEYS: readonly [string, string, string, string, string, string] = [
  "brand", "brand", "brand", "brandDim", "brand", "brandDim",
];
const HAL_ORB_WIDTH = 8;

function center(text: string, width: number): string {
  const visible = safeVisibleWidth(text);
  if (visible >= width) return safeTruncateToWidth(text, width);
  return `${" ".repeat(Math.floor((width - visible) / 2))}${text}`;
}

function indent(text: string, blockWidth: number, width: number): string {
  const pad = Math.max(0, Math.floor((width - blockWidth) / 2));
  return `${" ".repeat(pad)}${text}`;
}

function halOrb(fg: Fg): string[] {
  return [
    fg("accent", " ▄████▄ "),
    fg("accent", "█") + fg("brand", "██████") + fg("accent", "█"),
    fg("accent", " ▀████▀ "),
  ];
}

function halPixelBlock(width: number): LandingBlock | undefined {
  if (!TRUECOLOR) return undefined;
  if (width >= HAL_ULTRA_MIN) return { rows: pixelRows(HAL_PIXELS_ULTRA), blockWidth: HAL_PIXELS_ULTRA_WIDTH };
  if (width >= HAL_WIDE_MIN) return { rows: pixelRows(HAL_PIXELS_WIDE), blockWidth: HAL_PIXELS_WIDE_WIDTH };
  if (width >= HAL_MID_MIN) return { rows: pixelRows(HAL_PIXELS_MID), blockWidth: HAL_PIXELS_MID_WIDTH };
  return undefined;
}

export function registerHalLanding(): void {
  registerObservatoryLanding("hal", {
    prelude(fg, width) {
      if (width < MINIMAL_MIN) return [];
      const lines = [center(fg("dim", "OPERATIONS CONSOLE"), width)];
      if (!halPixelBlock(width)) {
        for (const row of halOrb(fg)) lines.push(indent(row, HAL_ORB_WIDTH, width));
      }
      return lines;
    },
    logo(fg, width): LandingBlock {
      if (width < MINIMAL_MIN) return { rows: [fg("text", "HAL")], blockWidth: 3 };
      const pixels = halPixelBlock(width);
      if (pixels) return pixels;
      const rows = HAL_WORDMARK.map((row, index) => fg(HAL_WORDMARK_KEYS[index] ?? "brand", row));
      return { rows, blockWidth: HAL_WORDMARK_WIDTH };
    },
    invitation(fg, width) {
      const label = width >= 28 ? "What are we working on?" : "Ready";
      return fg("accent", "> ") + fg("muted", label);
    },
  });
}

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const RANDOM_INDICATOR_FRAME_COUNT = 256;
export const RANDOM_INDICATOR_INTERVAL_MS = 120;

export const WORKING_MESSAGES = [
  "Thinking through it",
  "Tracing the next move",
  "Exploring the code",
  "Working the problem",
  "Following the signal",
  "Chasing the details",
  "Piecing it together",
];

const THINKING_TONES: Record<string, string> = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
  max: "thinkingMax",
};

const WORKING_PATTERNS = [
  ["000010000", "010111010", "111111111", "010111010", "000010000"],
  ["111000000", "000111000", "000000111", "000111000"],
  ["100100100", "010010010", "001001001", "010010010"],
  ["101010101", "010101010", "101010101", "010101010"],
  ["100000001", "101010101", "111111111", "010101010"],
  ["001010100", "010101010", "100010001", "010101010"],
  [
    "100000000", "010000000", "001000000", "000001000",
    "000000001", "000000010", "000000100", "000100000",
  ],
  ["100000001", "010000010", "001000100", "000101000", "001000100", "010000010"],
  [
    "100000000", "100100000", "010100100", "010010100",
    "001010010", "001001010", "000001001", "000000001",
  ],
  ["000010000", "010101010", "111111111", "010101010", "000010000"],
  ["100100100", "110110110", "011011011", "001001001", "000000000"],
] as const;

function shuffle<T>(values: readonly T[]): T[] {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }
  return shuffled;
}

function renderWorkingDots(mask: string): string {
  let firstTwoColumns = 0;
  let thirdColumn = 0;
  for (let cell = 0; cell < 9; cell++) {
    if (mask[cell] !== "1") continue;
    const row = Math.floor(cell / 3);
    const column = cell % 3;
    if (column < 2) firstTwoColumns |= 1 << (row + column * 3);
    else thirdColumn |= 1 << row;
  }
  return `${String.fromCodePoint(0x2800 + firstTwoColumns)}${String.fromCodePoint(0x2800 + thirdColumn)}`;
}

export function resolveWorkingLeadTone(pi: ExtensionAPI): string {
  try {
    return THINKING_TONES[String(pi.getThinkingLevel())] ?? "accent";
  } catch {
    return "accent";
  }
}

export function buildWorkingIndicator(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): { frames: string[]; intervalMs: number; message: string } {
  const leadTone = resolveWorkingLeadTone(pi);
  const frames: string[] = [];
  while (frames.length < RANDOM_INDICATOR_FRAME_COUNT) {
    for (const sourcePattern of shuffle(WORKING_PATTERNS)) {
      const pattern = Math.random() < 0.5 ? [...sourcePattern].reverse() : sourcePattern;
      for (let beat = 0; beat < pattern.length; beat++) {
        const tone = beat === 0 ? leadTone : beat % 2 === 0 ? "muted" : "dim";
        frames.push(ctx.ui.theme.fg(tone as any, renderWorkingDots(pattern[beat])));
        if (frames.length >= RANDOM_INDICATOR_FRAME_COUNT) {
          return {
            frames,
            intervalMs: RANDOM_INDICATOR_INTERVAL_MS,
            message: ctx.ui.theme.fg("dim", `${WORKING_MESSAGES[Math.floor(Math.random() * WORKING_MESSAGES.length)]}...`),
          };
        }
      }
    }
  }
  return {
    frames,
    intervalMs: RANDOM_INDICATOR_INTERVAL_MS,
    message: ctx.ui.theme.fg("dim", `${WORKING_MESSAGES[Math.floor(Math.random() * WORKING_MESSAGES.length)]}...`),
  };
}

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const HAL_INDICATOR_FRAME_COUNT = 128;

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

function halLensFrames(ctx: ExtensionContext, leadTone: string): string[] {
  const beats = ["000010000", "010101010", "111111111", "010101010", "000010000"];
  const tones = ["dim", "muted", leadTone, "muted", "dim"];
  const frames: string[] = [];
  while (frames.length < HAL_INDICATOR_FRAME_COUNT) {
    for (let beat = 0; beat < beats.length; beat++) {
      frames.push(ctx.ui.theme.fg(tones[beat] as any, renderWorkingDots(beats[beat])));
      if (frames.length >= HAL_INDICATOR_FRAME_COUNT) return frames;
    }
  }
  return frames;
}

function halSweepFrames(ctx: ExtensionContext, leadTone: string): string[] {
  const beats = ["100100100", "010010010", "001001001", "010010010"];
  const tones = [leadTone, "muted", "dim", "muted"];
  const frames: string[] = [];
  while (frames.length < HAL_INDICATOR_FRAME_COUNT) {
    for (let beat = 0; beat < beats.length; beat++) {
      frames.push(ctx.ui.theme.fg(tones[beat] as any, renderWorkingDots(beats[beat])));
      if (frames.length >= HAL_INDICATOR_FRAME_COUNT) return frames;
    }
  }
  return frames;
}

function halReadoutFrames(ctx: ExtensionContext, leadTone: string): string[] {
  const beats = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█", "▇", "▆", "▅", "▄", "▃", "▂"];
  const frames: string[] = [];
  while (frames.length < HAL_INDICATOR_FRAME_COUNT) {
    for (const glyph of beats) {
      const tone = glyph === "█" ? leadTone : glyph === "▆" || glyph === "▇" ? "muted" : "dim";
      frames.push(ctx.ui.theme.fg(tone as any, glyph));
      if (frames.length >= HAL_INDICATOR_FRAME_COUNT) return frames;
    }
  }
  return frames;
}

function halOrbitFrames(ctx: ExtensionContext, leadTone: string): string[] {
  const beats = [
    "100000000", "010000000", "001000000", "000001000",
    "000000001", "000000010", "000000100", "000100000",
  ];
  const frames: string[] = [];
  while (frames.length < HAL_INDICATOR_FRAME_COUNT) {
    for (let beat = 0; beat < beats.length; beat++) {
      const tone = beat === 0 ? leadTone : beat % 2 === 0 ? "muted" : "dim";
      frames.push(ctx.ui.theme.fg(tone as any, renderWorkingDots(beats[beat])));
      if (frames.length >= HAL_INDICATOR_FRAME_COUNT) return frames;
    }
  }
  return frames;
}

function halCoreFrames(ctx: ExtensionContext, leadTone: string): string[] {
  const beats: Array<[string, string]> = [
    ["█", "brand"], ["▓", "brand"], ["▒", "brandDim"], ["░", "dim"], ["▒", "brandDim"], ["▓", "brand"],
  ];
  const frames: string[] = [];
  while (frames.length < HAL_INDICATOR_FRAME_COUNT) {
    for (const [glyph, tone] of beats) {
      frames.push(
        ctx.ui.theme.fg(leadTone as any, "▌") +
          ctx.ui.theme.fg(tone as any, glyph) +
          ctx.ui.theme.fg(leadTone as any, "▐"),
      );
      if (frames.length >= HAL_INDICATOR_FRAME_COUNT) return frames;
    }
  }
  return frames;
}

export interface HalIndicatorCandidate {
  name: string;
  description: string;
  intervalMs: number;
  build: (ctx: ExtensionContext, leadTone: string) => string[];
}

export const HAL_INDICATOR_CANDIDATES: HalIndicatorCandidate[] = [
  { name: "lens", description: "Braille sensor breathing: density swells and releases", intervalMs: 150, build: halLensFrames },
  { name: "sweep", description: "Scan bar crossing a 3-column field with a fading tail", intervalMs: 120, build: halSweepFrames },
  { name: "readout", description: "Single-cell level bar rising and falling like a VU meter", intervalMs: 140, build: halReadoutFrames },
  { name: "orbit", description: "One telemetry blip walking the field perimeter", intervalMs: 100, build: halOrbitFrames },
  { name: "core", description: "Breathing crimson core in a static instrument frame", intervalMs: 220, build: halCoreFrames },
];

export const HAL_DEFAULT_CANDIDATE = "core";

export const HAL_WORKING_MESSAGES = [
  "Running diagnostics", "Computing trajectory", "Realigning the array", "Parsing telemetry",
  "Recalibrating sensors", "Charting the course", "Verifying systems", "Scanning the horizon",
  "Plotting the maneuver", "Checking guidance", "Testing the circuits", "Aligning the dish",
  "Checking instruments", "Warming the reactor", "Balancing the load", "Triangulating position",
  "Decoding the signal", "Holding the orbit", "Surveying the terrain", "Logging the anomaly",
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

function resolveWorkingLeadTone(pi: ExtensionAPI): string {
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
  const candidate =
    HAL_INDICATOR_CANDIDATES.find((item) => item.name === HAL_DEFAULT_CANDIDATE) ?? HAL_INDICATOR_CANDIDATES[0]!;
  return {
    frames: candidate.build(ctx, leadTone),
    intervalMs: candidate.intervalMs,
    message: ctx.ui.theme.fg("dim", `${HAL_WORKING_MESSAGES[Math.floor(Math.random() * HAL_WORKING_MESSAGES.length)]}...`),
  };
}

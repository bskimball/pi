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

/**
 * HAL brand inks with graceful degradation: `brand`/`brandDim` exist only in
 * hal-dark, so under any other theme the core breathes in accent/muted
 * instead of throwing (Pi's theme.fg throws on unknown keys, which would
 * otherwise take the whole working chrome down with it).
 */
function halFg(ctx: ExtensionContext, key: string, text: string): string {
  try {
    return ctx.ui.theme.fg(key as any, text);
  } catch {
    return ctx.ui.theme.fg((key === "brand" ? "accent" : "muted") as any, text);
  }
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
          halFg(ctx, tone, glyph) +
          ctx.ui.theme.fg(leadTone as any, "▐"),
      );
      if (frames.length >= HAL_INDICATOR_FRAME_COUNT) return frames;
    }
  }
  return frames;
}

/**
 * Tone kinds the iris/vocalizer beats are written in. `lead` carries the
 * session thinking level (the thinking-level test watches for it), `brand`
 * and `brandDim` route through halFg so non-HAL themes degrade instead of
 * throwing, and `dim` is a plain theme key present in every theme.
 */
type HalToneKind = "lead" | "brand" | "brandDim" | "dim";

function halToneFg(
  ctx: ExtensionContext,
  kind: HalToneKind,
  leadTone: string,
  text: string,
): string {
  if (kind === "lead") return ctx.ui.theme.fg(leadTone as any, text);
  if (kind === "dim") return ctx.ui.theme.fg("dim", text);
  return halFg(ctx, kind, text);
}

/**
 * Optical Iris: the HAL 9000 eye focusing. A pupil dot blooms to a full
 * aperture, contracts onto a reticle, and settles back to the pupil. Eight
 * beats divide 128 exactly, so the loop seam lands on the pupil every time.
 * Two braille cells keep the mark at text height.
 */
function halIrisFrames(ctx: ExtensionContext, leadTone: string): string[] {
  const beats: Array<[string, HalToneKind]> = [
    ["000010000", "lead"],     // pupil
    ["010111010", "lead"],     // aperture opening
    ["111111111", "brand"],    // full dilation
    ["101000101", "brandDim"], // reticle corners
    ["101010101", "brand"],    // reticle locked on centre
    ["010101010", "brandDim"], // cross collapsing
    ["000010000", "lead"],     // pupil returns
    ["000010000", "dim"],      // rest
  ];
  const frames: string[] = [];
  while (frames.length < HAL_INDICATOR_FRAME_COUNT) {
    for (const [mask, kind] of beats) {
      frames.push(halToneFg(ctx, kind, leadTone, renderWorkingDots(mask)));
      if (frames.length >= HAL_INDICATOR_FRAME_COUNT) return frames;
    }
  }
  return frames;
}

/**
 * Vocalizer Wave: HAL's speech synthesiser readout. Deliberately capped at
 * LOWER THREE EIGHTHS BLOCK (U+2584) so the ink never climbs past x-height —
 * full blocks (U+2588) are what made the old core mark tower over the label.
 * Every beat is exactly three cells; spaces stay unstyled so the ANSI runs
 * around each glyph open and close in place.
 */
const HAL_VOCALIZER_BEATS = [
  " \u2582 ", "\u2582\u2583\u2582", "\u2583\u2584\u2583", "\u2584\u2583\u2582",
  "\u2583\u2582 ", "\u2582 \u2582", " \u2582\u2583", "\u2582\u2583\u2584",
  "\u2583\u2584\u2583", "\u2583\u2582 ", "\u2582  ", " \u2582 ",
] as const;

const HAL_VOCALIZER_TONES: Record<string, HalToneKind> = {
  "\u2584": "lead",
  "\u2583": "brand",
  "\u2582": "brandDim",
};

function halVocalizerFrames(ctx: ExtensionContext, leadTone: string): string[] {
  const frames: string[] = [];
  while (frames.length < HAL_INDICATOR_FRAME_COUNT) {
    for (const beat of HAL_VOCALIZER_BEATS) {
      let frame = "";
      for (const cell of beat) {
        const kind = HAL_VOCALIZER_TONES[cell];
        frame += kind === undefined ? cell : halToneFg(ctx, kind, leadTone, cell);
      }
      frames.push(frame);
      if (frames.length >= HAL_INDICATOR_FRAME_COUNT) return frames;
    }
  }
  return frames;
}

/**
 * Picks one motif per build, never mid-run: frames must all share a single
 * visible width (iris is two cells, vocalizer three), so mixing them inside
 * one frame list would make the mark jump sideways instead of animate.
 */
function halAdaptiveFrames(ctx: ExtensionContext, leadTone: string): string[] {
  return Math.random() < 0.5 ? halIrisFrames(ctx, leadTone) : halVocalizerFrames(ctx, leadTone);
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
  { name: "adaptive", description: "Alternates between optical iris and vocalizer wave", intervalMs: 120, build: halAdaptiveFrames },
  { name: "iris", description: "Optical iris: HAL sensor focal pulse and aperture dilation (3x3)", intervalMs: 120, build: halIrisFrames },
  { name: "vocalizer", description: "Vocalizer wave: acoustic synthesizer logic waveform (compact height)", intervalMs: 120, build: halVocalizerFrames },
];

export const HAL_DEFAULT_CANDIDATE = "adaptive";

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

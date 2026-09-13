import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ClaudeWorkingMotif {
  name: string;
  glyphs: string[];
}

export const CLAUDE_WORKING_MOTIFS: ClaudeWorkingMotif[] = [
  { name: "pulse", glyphs: ["\u273c", "\u273b", "\u273d", "\u273a", "\u273d", "\u273b"] },
  { name: "twinkle", glyphs: ["\u273b", "\u273d", "\u273b", "\u273c", "\u273a", "\u273c"] },
  { name: "bloom", glyphs: ["\u273c", "\u273e", "\u273b", "\u273e"] },
  { name: "flash", glyphs: ["\u273a", "\u273d", "\u273a", "\u273b"] },
];
export const CLAUDE_INDICATOR_FRAME_COUNT = 128;
export const CLAUDE_WORKING_INTERVAL_MS = 180;
export const CLAUDE_WORKING_MESSAGES = [
  "Thinking", "Cogitating", "Pondering", "Ruminating", "Musing", "Mulling",
  "Deliberating", "Contemplating", "Ideating", "Noodling", "Puzzling", "Tinkering",
  "Brewing", "Percolating", "Simmering", "Concocting", "Synthesizing", "Orchestrating",
  "Spelunking", "Wrangling",
];
export const CLAUDE_WORKING_WEIGHTS: Record<string, number> = {
  "\u273c": 1, "\u273b": 2, "\u273e": 2, "\u273d": 3, "\u273a": 4,
};

export function claudeWorkingTonesFor(motifGlyphs: string[], leadTone: string): string[] {
  const weights = motifGlyphs.map((glyph) => {
    const weight = CLAUDE_WORKING_WEIGHTS[glyph];
    if (weight === undefined) throw new Error(`claude indicator: no weight for ${glyph}`);
    return weight;
  });
  const min = Math.min(...weights);
  const max = Math.max(...weights);
  return weights.map((weight) => (weight === max ? leadTone : weight === min ? "dim" : "muted"));
}

function shuffle<T>(values: readonly T[]): T[] {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }
  return shuffled;
}

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
  const frames: string[] = [];
  while (frames.length < CLAUDE_INDICATOR_FRAME_COUNT) {
    for (const motif of shuffle(CLAUDE_WORKING_MOTIFS)) {
      const glyphs = Math.random() < 0.5 ? [...motif.glyphs].reverse() : motif.glyphs;
      const tones = claudeWorkingTonesFor(glyphs, leadTone);
      for (let beat = 0; beat < glyphs.length; beat++) {
        frames.push(ctx.ui.theme.fg(tones[beat] as any, glyphs[beat]));
        if (frames.length >= CLAUDE_INDICATOR_FRAME_COUNT) {
          return {
            frames,
            intervalMs: CLAUDE_WORKING_INTERVAL_MS,
            message: ctx.ui.theme.fg("dim", `${CLAUDE_WORKING_MESSAGES[Math.floor(Math.random() * CLAUDE_WORKING_MESSAGES.length)]}...`),
          };
        }
      }
    }
  }
  return {
    frames,
    intervalMs: CLAUDE_WORKING_INTERVAL_MS,
    message: ctx.ui.theme.fg("dim", `${CLAUDE_WORKING_MESSAGES[Math.floor(Math.random() * CLAUDE_WORKING_MESSAGES.length)]}...`),
  };
}

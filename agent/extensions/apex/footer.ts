// footer: sonar/deep-water instrument footer for the apex UI.
//
// Line 1 is a borderMuted rule carrying inline segments (mode, model, place)
// across the full width; line 2 is a "depth" readout with a 10-cell braille
// context gauge plus token/cost/status groups. Pure: no timers, no I/O,
// never more than FOOTER_MAX_LINES lines.

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  FOOTER_MAX_LINES,
  fitLine,
  formatTokens,
  safeTruncateToWidth,
  safeVisibleWidth,
  type BuildFooter,
} from "@pi/ui-kit";

interface Seg {
  text: string;
  /** Higher drops first; negative never drops (truncated instead). */
  pri: number;
}

/** Join segments, dropping lowest-priority ones until the line fits. */
function joinDropping(segs: Seg[], sep: string, width: number): string {
  const cur = [...segs];
  for (;;) {
    const joined = cur.map((s) => s.text).join(sep);
    if (safeVisibleWidth(joined) <= width) return joined;
    let idx = -1;
    let best = -Infinity;
    cur.forEach((s, i) => {
      if (s.pri >= best) {
        best = s.pri;
        idx = i;
      }
    });
    if (idx < 0 || best < 0 || cur.length <= 1) {
      return safeTruncateToWidth(joined, width);
    }
    cur.splice(idx, 1);
  }
}

// Sub-cell fill steps for one gauge cell; level 0 doubles as the visible
// track (the seabed, painted dim), levels 1+ paint in the fill tone.
const TRACK = "\u28C0";
const FILL_LEVELS = ["\u28C0", "\u28C4", "\u28E4", "\u28E6", "\u28F6", "\u28F7", "\u28FF"];
const GAUGE_CELLS = 10;

/**
 * 10-cell braille depth gauge. Empty cells render as a dim seabed baseline
 * so 0% stays visible; filled cells step the fill tone toward solid.
 * Unknown renders an all-track gauge (the caller shows "?").
 */
function gauge(paint: { fg(color: ThemeColor, text: string): string }, tone: ThemeColor, percent: number | null): string {
  const steps = FILL_LEVELS.length - 1;
  const total =
    percent === null
      ? 0
      : (Math.max(0, Math.min(100, percent)) / 100) * GAUGE_CELLS * steps;
  let out = "";
  let dimRun = "";
  let fillRun = "";
  const flush = () => {
    if (dimRun) {
      out += paint.fg("dim", dimRun);
      dimRun = "";
    }
    if (fillRun) {
      out += paint.fg(tone, fillRun);
      fillRun = "";
    }
  };
  for (let i = 0; i < GAUGE_CELLS; i++) {
    const level = Math.max(0, Math.min(steps, Math.floor(total - i * steps)));
    if (level === 0) {
      if (fillRun) flush();
      dimRun += TRACK;
    } else {
      if (dimRun) flush();
      fillRun += FILL_LEVELS[level];
    }
  }
  flush();
  return out;
}

function toneFor(percent: number | null): ThemeColor {
  if (percent === null) return "dim";
  if (percent >= 90) return "error";
  if (percent >= 70) return "warning";
  return "accent";
}

export const buildFooter: BuildFooter = (s, width, paint) => {
  const w = Math.max(0, Math.floor(width));
  if (w <= 0) return [];
  const narrow = w < 50;
  const mode = (s.mode ?? "").trim();
  const pct = s.context.percent;
  const modelId = s.model?.id ?? "no model";
  const think = (s.thinking ?? "").trim();

  // Line 1: mode and model segments joined by one rule separator, with the
  // rule filling the gap to the right (place) cluster. The model segment is
  // one unit: an optional dim "provider/" prefix, the id, and an optional
  // dim " · thinking" suffix; droppables shed in that reverse order.
  const provName = s.multiProvider && s.model ? s.model.provider : "";
  let useProv = !!provName && !narrow;
  let useThink = !!think && !narrow;
  let useBranch = !!s.branch && !narrow;
  const buildLeft = () => {
    const modelSeg =
      (useProv ? paint.fg("dim", `${provName}/`) : "") +
      paint.fg("text", modelId) +
      (useThink ? paint.fg("dim", ` \u00B7 ${think}`) : "");
    return [mode ? paint.fg("accent", `\u276F ${mode.toUpperCase()}`) : "", modelSeg]
      .filter(Boolean)
      .join(paint.fg("borderMuted", " \u2500 "));
  };
  const buildRight = () =>
    paint.fg("muted", s.cwd) +
    (useBranch ? paint.fg("dim", " on ") + paint.fg("accent", s.branch ?? "") : "");
  let left = buildLeft();
  let right = buildRight();
  // Shed droppables (thinking, provider, branch) until a dash gap remains.
  for (;;) {
    const gap = w - safeVisibleWidth(left) - safeVisibleWidth(right);
    if (gap >= 1) break;
    if (useThink) useThink = false;
    else if (useProv) useProv = false;
    else if (useBranch) useBranch = false;
    else break;
    left = buildLeft();
    right = buildRight();
  }
  let line1: string;
  const gap = w - safeVisibleWidth(left) - safeVisibleWidth(right);
  if (gap >= 2) {
    line1 =
      left + " " + paint.fg("borderMuted", "\u2500".repeat(gap - 2)) + " " + right;
  } else if (gap === 1) {
    line1 = `${left} ${right}`;
  } else {
    line1 = fitLine(left, right, w);
  }

  // Line 2: depth gauge plus token/cost/status groups.
  const groups: Seg[] = [
    {
      text:
        paint.fg("dim", "depth ") +
        gauge(paint, toneFor(pct), pct) +
        " " +
        paint.fg("text", pct === null ? "?" : `${Math.round(pct)}%`) +
        paint.fg("dim", ` of ${formatTokens(s.context.window)}`),
      pri: -1,
    },
  ];
  if (!narrow) {
    const io: string[] = [];
    if (s.usage.input > 0) io.push(`\u2191${formatTokens(s.usage.input)}`);
    if (s.usage.output > 0) io.push(`\u2193${formatTokens(s.usage.output)}`);
    if (io.length > 0) groups.push({ text: paint.fg("dim", io.join(" ")), pri: 5 });
    groups.push({
      text: paint.fg(
        "dim",
        `$${s.usage.cost.toFixed(3)}${s.subscription ? " sub" : ""}`,
      ),
      pri: 4,
    });
    for (const st of s.statuses) {
      groups.push({ text: paint.fg("muted", st.text), pri: 10 });
    }
  }
  const line2 = joinDropping(groups, paint.fg("dim", " \u00B7 "), w);

  return [line1, line2]
    .filter((line) => safeVisibleWidth(line) > 0)
    .slice(0, FOOTER_MAX_LINES);
};

// footer: HAL 9000 panel footer for the hal UI.
//
// Calm, clinical, uppercase labels with square glyphs and the red eye.
// Line 1 pairs the identity/model cluster (eye, name, mode, model id,
// provider prefix, thinking) with the context cluster (10-square gauge,
// percent, tokens/window). Line 2 carries the place cluster (cwd, branch)
// plus session usage, cost, and statuses, with the system phrase
// right-aligned when it fits. Pure: no timers, no I/O, never more than
// FOOTER_MAX_LINES lines.
//
// Degradation order at shrinking width: statuses, then the phrase, then
// cost, then usage, then branch, then thinking, then provider, then the
// tokens/window detail (gauge+percent always remain), then model truncation.
// Narrow (<50) keeps only the eye + model + gauge/percent on line 1 and the
// truncated cwd on line 2.

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  FOOTER_MAX_LINES,
  fitLine,
  formatTokens,
  safeTruncateToWidth,
  safeVisibleWidth,
  type BuildFooter,
  type FooterSnapshot,
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

const GAUGE_CELLS = 10;

/** 10-square gauge: filled vs empty squares by context fill. */
function gauge(percent: number | null): string {
  const filled =
    percent === null ? 0 : Math.round(Math.max(0, Math.min(100, percent)) / 10);
  return "\u25A0".repeat(filled) + "\u25A1".repeat(GAUGE_CELLS - filled);
}

function toneFor(percent: number | null): ThemeColor {
  if (percent === null) return "dim";
  if (percent >= 90) return "error";
  if (percent >= 70) return "warning";
  return "accent";
}

function phraseFor(percent: number | null): string {
  if (percent === null) return "STANDBY";
  if (percent >= 90) return "I'M SORRY, DAVE. CONTEXT CRITICAL.";
  if (percent >= 70) return "MEMORY LOAD ELEVATED";
  return "ALL SYSTEMS NOMINAL";
}

function phraseTone(percent: number | null): ThemeColor {
  if (percent === null) return "dim";
  const tone = toneFor(percent);
  return tone === "accent" ? "success" : tone;
}

/**
 * Context readout tail after the percent: absolute used/window tokens when
 * the estimate is known ("96K/200K"), else the window alone ("OF 200K") so
 * no used count is ever fabricated. Empty when neither is known.
 */
function contextTail(s: FooterSnapshot): string {
  const win = s.context.window;
  const toks = s.context.tokens;
  if (toks !== null && toks !== undefined) {
    const used = formatTokens(toks).toUpperCase();
    return win > 0 ? `${used}/${formatTokens(win).toUpperCase()}` : used;
  }
  return win > 0 ? `OF ${formatTokens(win).toUpperCase()}` : "";
}

export const buildFooter: BuildFooter = (s, width, paint) => {
  const w = Math.max(0, Math.floor(width));
  if (w <= 0) return [];
  const narrow = w < 50;
  const mode = (s.mode ?? "").trim().toUpperCase();
  const pct = s.context.percent;
  const modelId = (s.model?.id ?? "no model").toUpperCase();
  const think = (s.thinking ?? "").trim().toUpperCase();
  const provName = s.multiProvider && s.model ? s.model.provider.toUpperCase() : "";

  // Line 1: identity/model cluster left, context cluster right. Shed
  // thinking, then provider, then the tokens/window detail; the model id
  // and gauge+percent never drop. Narrow keeps only the eye + model.
  let useProv = !!provName && !narrow;
  let useThink = !!think && !narrow;
  let useCtxDetail = !narrow;
  const buildLeft = () => {
    const eye = paint.fg("error", "\u25A0");
    const modelSeg =
      (useProv ? paint.fg("dim", `${provName} \u00B7 `) : "") +
      paint.fg("muted", modelId) +
      (useThink ? paint.fg("dim", ` / ${think}`) : "");
    if (narrow) return `${eye} ${modelSeg}`;
    return (
      eye +
      " " +
      paint.fg("text", "HAL 9000") +
      (mode ? paint.fg("dim", " \u00B7 ") + paint.fg("accent", mode) : "") +
      paint.fg("dim", " \u00B7 ") +
      modelSeg
    );
  };
  const buildCtx = () => {
    const tail = useCtxDetail ? contextTail(s) : "";
    return (
      paint.fg("dim", "CTX ") +
      paint.fg(toneFor(pct), gauge(pct)) +
      " " +
      paint.fg("text", pct === null ? "?" : `${Math.round(pct)}%`) +
      (tail ? paint.fg("dim", ` \u00B7 ${tail}`) : "")
    );
  };
  let left = buildLeft();
  let right = buildCtx();
  for (;;) {
    const gap = w - safeVisibleWidth(left) - safeVisibleWidth(right);
    if (gap >= 1) break;
    if (useThink) useThink = false;
    else if (useProv) useProv = false;
    else if (useCtxDetail) useCtxDetail = false;
    else break;
    left = buildLeft();
    right = buildCtx();
  }
  // fitLine truncates the identity/model side first, so context survives.
  const line1 = fitLine(left, right, w);

  // Line 2: place cluster plus labelled readouts; system phrase on the
  // right when it fits. Shed statuses, then the phrase, then cost, then
  // usage, then branch; the cwd truncates only as a last resort. Narrow
  // keeps just the truncated cwd.
  const hasIO = s.usage.input > 0 || s.usage.output > 0;
  const ioText = `I/O ${formatTokens(s.usage.input).toUpperCase()}/${formatTokens(s.usage.output).toUpperCase()}`;
  const costText = `COST $${s.usage.cost.toFixed(3)}${s.subscription ? " SUB" : ""}`;
  const phrase = paint.fg(phraseTone(pct), phraseFor(pct));
  const phraseW = safeVisibleWidth(phrase);
  let useBranch = !!s.branch && !narrow;
  let useUsage = !narrow && hasIO;
  let useCost = !narrow;
  let useStatuses = !narrow && s.statuses.length > 0;
  let usePhrase = !narrow;
  let line2: string;
  for (;;) {
    const place =
      paint.fg("muted", s.cwd) +
      (useBranch ? paint.fg("dim", " \u00B7 ") + paint.fg("text", s.branch ?? "") : "");
    const groups: Seg[] = [];
    if (useUsage) groups.push({ text: paint.fg("dim", ioText), pri: 5 });
    if (useCost) groups.push({ text: paint.fg("dim", costText), pri: 6 });
    if (useStatuses) {
      for (const st of s.statuses) {
        groups.push({ text: paint.fg("muted", st.text.toUpperCase()), pri: 10 });
      }
    }
    const avail = usePhrase ? Math.max(0, w - phraseW - 1) : w;
    const rest = groups.length > 0 ? joinDropping(groups, paint.fg("dim", " \u00B7 "), avail) : "";
    const total =
      safeVisibleWidth(place) + (rest ? 1 + safeVisibleWidth(rest) : 0) + (usePhrase ? 1 + phraseW : 0);
    if (total <= w) {
      const core = rest ? fitLine(place, rest, avail) : safeTruncateToWidth(place, avail);
      line2 = usePhrase ? fitLine(core, ` ${phrase}`, w) : core;
      break;
    }
    if (useStatuses) useStatuses = false;
    else if (usePhrase) usePhrase = false;
    else if (useCost) useCost = false;
    else if (useUsage) useUsage = false;
    else if (useBranch) useBranch = false;
    else {
      const core = rest ? fitLine(place, rest, w) : safeTruncateToWidth(place, w);
      line2 = core;
      break;
    }
  }

  return [line1, line2]
    .filter((line) => safeVisibleWidth(line) > 0)
    .slice(0, FOOTER_MAX_LINES);
};

// footer: sonar/deep-water instrument footer for the apex UI.
//
// Line 1 carries the model cluster (mode, model id, provider prefix, thinking)
// left and the context cluster (braille gauge, percent, tokens/window) right,
// joined by a borderMuted rule. Line 2 carries the place cluster (cwd, branch)
// plus session usage, cost, and extension statuses. Pure: no timers, no I/O,
// never more than FOOTER_MAX_LINES lines.
//
// Degradation order at shrinking width: statuses, then cost, then usage,
// then branch, then thinking, then provider, then the tokens/window detail
// (gauge+percent always remain), then model truncation. Narrow (<50) keeps
// only model + gauge/percent on line 1 and the truncated cwd on line 2.

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
    if (safeVisibleWidth(joined) <= width || cur.length <= 1) return joined;
    let idx = -1;
    let best = -Infinity;
    cur.forEach((s, i) => {
      if (s.pri >= best) {
        best = s.pri;
        idx = i;
      }
    });
    if (idx < 0 || best < 0) return joined;
    cur.splice(idx, 1);
  }
}

function parseModeCluster(s: FooterSnapshot): {
  modeName: string;
  modePosture: string;
  hydraText: string;
} {
  const raw = (s.mode ?? "").trim();
  if (!raw) {
    return { modeName: "", modePosture: "", hydraText: "" };
  }
  const dotIdx = raw.indexOf("\u00B7");
  const modeName = (dotIdx >= 0 ? raw.slice(0, dotIdx) : raw).trim();
  const modePosture = (dotIdx >= 0 ? raw.slice(dotIdx + 1) : "").trim();
  const hydraStatus = s.statuses.find((st) => st.key === "hydra")?.text.trim() ?? "";
  const hydraText =
    hydraStatus && !raw.toLowerCase().includes(hydraStatus.toLowerCase()) ? hydraStatus : "";
  return { modeName, modePosture, hydraText };
}

function statusPriority(key: string): number {
  if (key === "hydra") return -1;
  if (key === "jev") return 12;
  if (key === "cua") return 8;
  return 10;
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

/**
 * Context readout tail after the percent: absolute used/window tokens when
 * the estimate is known ("96k/200k"), else the window alone ("of 200k") so
 * no used count is ever fabricated. Empty when neither is known.
 */
function contextTail(s: FooterSnapshot): string {
  const win = s.context.window;
  const toks = s.context.tokens;
  if (toks !== null && toks !== undefined) {
    const used = formatTokens(toks);
    return win > 0 ? `${used}/${formatTokens(win)}` : used;
  }
  return win > 0 ? `of ${formatTokens(win)}` : "";
}

export const buildFooter: BuildFooter = (s, width, paint) => {
  const w = Math.max(0, Math.floor(width));
  if (w <= 0) return [];
  const narrow = w < 50;
  const { modeName, modePosture, hydraText } = parseModeCluster(s);
  const pct = s.context.percent;
  const modelId = s.model?.id ?? "no model";
  const think = (s.thinking ?? "").trim();

  // Line 1: model cluster left, context cluster right, rule-filled between.
  // Shed thinking, then provider, then mode posture/hydra detail, then the
  // tokens/window detail until a dash gap remains; the mode badge, model id,
  // and gauge+percent never drop.
  const provName = s.multiProvider && s.model ? s.model.provider : "";
  let useModePosture = Boolean(modePosture) && !narrow;
  let useModeHydra = Boolean(hydraText) && !narrow;
  let useModePrefix = Boolean(modeName) && !narrow;
  let useProv = !!provName && !narrow;
  let useThink = !!think && !narrow;
  let useCtxDetail = !narrow;
  const buildLeft = () => {
    const modeLabel = useModePrefix ? `MODE: ${modeName.toUpperCase()}` : modeName.toUpperCase();
    const modeSeg = modeName
      ? paint.fg("accent", `\u276F ${modeLabel}`) +
        (useModePosture && modePosture ? paint.fg("muted", ` \u00B7 ${modePosture.toUpperCase()}`) : "") +
        (useModeHydra && hydraText ? paint.fg("accent", ` (${hydraText.toUpperCase()})`) : "")
      : "";
    const modelSeg =
      (useProv ? paint.fg("dim", `${provName}/`) : "") +
      paint.fg("text", modelId) +
      (useThink ? paint.fg("dim", ` \u00B7 ${think}`) : "");
    return [modeSeg, modelSeg]
      .filter(Boolean)
      .join(paint.fg("borderMuted", " \u2500 "));
  };
  const buildCtx = () => {
    const tail = useCtxDetail ? contextTail(s) : "";
    return (
      paint.fg("dim", "ctx ") +
      gauge(paint, toneFor(pct), pct) +
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
    else if (useModePosture) useModePosture = false;
    else if (useModeHydra) useModeHydra = false;
    else if (useCtxDetail) useCtxDetail = false;
    else if (useModePrefix) useModePrefix = false;
    else break;
    left = buildLeft();
    right = buildCtx();
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

  // Line 2: place cluster plus session usage/cost/statuses. Shed low-priority
  // statuses first via joinDropping against the remaining width after place,
  // then all statuses, then cost, then usage, then branch; the cwd truncates
  // only as a last resort. Narrow keeps just the truncated cwd.
  const hydraOnLine1 = Boolean(modeName && hydraText && useModeHydra);
  const line2Statuses = hydraOnLine1 ? s.statuses.filter((st) => st.key !== "hydra") : s.statuses;
  const ioParts: string[] = [];
  if (s.usage.input > 0) ioParts.push(`\u2191${formatTokens(s.usage.input)}`);
  if (s.usage.output > 0) ioParts.push(`\u2193${formatTokens(s.usage.output)}`);
  const costText = `$${s.usage.cost.toFixed(3)}${s.subscription ? " sub" : ""}`;
  let useBranch = !!s.branch && !narrow;
  let useUsage = !narrow && ioParts.length > 0;
  let useCost = !narrow;
  let useStatuses = !narrow && line2Statuses.length > 0;
  let line2: string;
  for (;;) {
    const place =
      paint.fg("muted", s.cwd) +
      (useBranch ? paint.fg("dim", " on ") + paint.fg("accent", s.branch ?? "") : "");
    const groups: Seg[] = [];
    if (useUsage) groups.push({ text: paint.fg("dim", ioParts.join(" ")), pri: -1 });
    if (useCost) groups.push({ text: paint.fg("dim", costText), pri: -1 });
    if (useStatuses) {
      for (const st of line2Statuses) {
        groups.push({ text: paint.fg("muted", st.text), pri: statusPriority(st.key) });
      }
    }
    const restAvail = Math.max(0, w - safeVisibleWidth(place) - 1);
    const rest = groups.length > 0 ? joinDropping(groups, paint.fg("dim", " \u00B7 "), restAvail) : "";
    const total = safeVisibleWidth(place) + (rest ? 1 + safeVisibleWidth(rest) : 0);
    if (total <= w) {
      line2 = rest ? fitLine(place, rest, w) : safeTruncateToWidth(place, w);
      break;
    }
    if (useStatuses) useStatuses = false;
    else if (useCost) useCost = false;
    else if (useUsage) useUsage = false;
    else if (useBranch) useBranch = false;
    else {
      line2 = rest ? fitLine(place, rest, w) : safeTruncateToWidth(place, w);
      break;
    }
  }

  return [line1, line2]
    .filter((line) => safeVisibleWidth(line) > 0)
    .slice(0, FOOTER_MAX_LINES);
};

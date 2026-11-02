// footer: Claude Code-style footer for the claude UI.
//
// Two quiet lines under the composer, both with a 2-space indent. Line 1
// pairs the accent mode indicator and model cluster (id, provider prefix,
// thinking) with the context readout (percent, tokens/window), toned warning
// at >=70% and error at >=90% but never replacing the model. Line 2 carries
// the place cluster (cwd, branch) plus session usage, cost, and extension
// statuses. Pure: no timers, no I/O, never more than FOOTER_MAX_LINES lines.
//
// Degradation order at shrinking width: statuses, then cost, then usage,
// then branch, then thinking, then provider, then the tokens/window detail
// (percent always remains), then model truncation. Narrow (<50) keeps only
// model + percent on line 1 and the truncated cwd on line 2.

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

function contextTone(pct: number | null): "dim" | "warning" | "error" {
  if (pct === null) return "dim";
  if (pct >= 90) return "error";
  if (pct >= 70) return "warning";
  return "dim";
}

/**
 * Context readout: percent plus absolute used/window tokens when the
 * estimate is known ("48% · 96k/200k"), else the window alone
 * ("48% of 200k") so no used count is ever fabricated. Unknown renders "?".
 */
function contextText(s: FooterSnapshot): string {
  const pct = s.context.percent;
  const pctText = pct === null ? "?" : `${Math.round(pct)}%`;
  const win = s.context.window;
  const toks = s.context.tokens;
  if (toks !== null && toks !== undefined) {
    const used = formatTokens(toks);
    return win > 0 ? `${pctText} \u00B7 ${used}/${formatTokens(win)}` : `${pctText} \u00B7 ${used}`;
  }
  return win > 0 ? `${pctText} of ${formatTokens(win)}` : pctText;
}

export const buildFooter: BuildFooter = (s, width, paint) => {
  const w = Math.max(0, Math.floor(width));
  if (w <= 0) return [];
  const narrow = w < 50;
  const { modeName, modePosture, hydraText } = parseModeCluster(s);
  const pct = s.context.percent;
  const modelId = s.model?.id ?? "no model";
  const think = (s.thinking ?? "").trim();
  const provName = s.multiProvider && s.model ? s.model.provider : "";

  // Line 1: mode + model cluster left, context readout right. Shed thinking,
  // then provider, then mode posture/hydra detail, then the tokens/window
  // detail; the mode badge, model id, and percent never drop.
  let useModePosture = Boolean(modePosture) && !narrow;
  let useModeHydra = Boolean(hydraText) && !narrow;
  let useProv = !!provName && !narrow;
  let useThink = !!think && !narrow;
  let useCtxDetail = !narrow;
  const buildLeft = () => {
    const modeSeg = modeName
      ? paint.fg("accent", `  \u25B8\u25B8 ${modeName.toLowerCase()} mode`) +
        (useModePosture && modePosture ? paint.fg("muted", ` \u00B7 ${modePosture.toLowerCase()}`) : "") +
        (useModeHydra && hydraText ? paint.fg("accent", ` (${hydraText.toLowerCase()})`) : "")
      : "";
    const modelSeg =
      (useProv ? `(${provName}) ` : "") +
      modelId +
      (useThink ? ` \u00B7 ${think}` : "");
    return modeSeg + (modeSeg ? paint.fg("dim", ` \u00B7 ${modelSeg}`) : paint.fg("dim", `  ${modelSeg}`));
  };
  const buildCtx = () => {
    if (!useCtxDetail) {
      const pctText = pct === null ? "?" : `${Math.round(pct)}%`;
      return paint.fg(contextTone(pct), pctText);
    }
    return paint.fg(contextTone(pct), contextText(s));
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
    else break;
    left = buildLeft();
    right = buildCtx();
  }
  // fitLine truncates the model side first, so the context readout survives.
  const line1 = fitLine(left, right, w);

  // Line 2: dim place cluster plus session details. Shed low-priority
  // statuses first via joinDropping against the remaining width after place,
  // then all statuses, then cost, then usage, then branch; the cwd truncates
  // only as a last resort. Narrow keeps just the truncated cwd.
  const hydraOnLine1 = Boolean(modeName && hydraText && useModeHydra);
  const line2Statuses = hydraOnLine1 ? s.statuses.filter((st) => st.key !== "hydra") : s.statuses;
  const usageParts: string[] = [];
  if (s.usage.input > 0) usageParts.push(`${formatTokens(s.usage.input)} in`);
  if (s.usage.output > 0) usageParts.push(`${formatTokens(s.usage.output)} out`);
  const costText = `$${s.usage.cost.toFixed(3)}${s.subscription ? " sub" : ""}`;
  let useBranch = !!s.branch && !narrow;
  let useUsage = !narrow && usageParts.length > 0;
  let useCost = !narrow;
  let useStatuses = !narrow && line2Statuses.length > 0;
  let line2: string;
  for (;;) {
    const place =
      paint.fg("dim", `  ${s.cwd}`) +
      (useBranch ? paint.fg("dim", ` \u00B7 ${s.branch}`) : "");
    const groups: Seg[] = [];
    if (useUsage) groups.push({ text: paint.fg("dim", usageParts.join(" \u00B7 ")), pri: -1 });
    if (useCost) groups.push({ text: paint.fg("dim", costText), pri: -1 });
    if (useStatuses) {
      for (const st of line2Statuses) {
        groups.push({ text: paint.fg("dim", st.text), pri: statusPriority(st.key) });
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

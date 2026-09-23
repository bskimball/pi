// footer: Claude Code-style footer for the claude UI.
//
// Two quiet lines under the composer, both with a 2-space indent: an accent
// mode indicator with an optional right-aligned model/context note, then dim
// session details whose status items stay visibly separated. Pure: no timers,
// no I/O, never more than FOOTER_MAX_LINES lines.

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

export const buildFooter: BuildFooter = (s, width, paint) => {
  const w = Math.max(0, Math.floor(width));
  if (w <= 0) return [];
  const narrow = w < 50;
  const mode = (s.mode ?? "").trim();
  const pct = s.context.percent;

  // Line 1: accent mode indicator, right-aligned model or context note.
  const left = mode
    ? paint.fg("accent", `  \u25B8\u25B8 ${mode.toLowerCase()} mode`)
    : "";
  let right: string;
  if (pct !== null && pct >= 70) {
    right = paint.fg(
      pct >= 90 ? "error" : "warning",
      `Context left until auto-compact: ${Math.max(0, Math.round(100 - pct))}%`,
    );
  } else {
    const modelId = s.model?.id ?? "no model";
    const think = (s.thinking ?? "").trim();
    const cands: string[] = [];
    if (s.multiProvider && s.model) {
      cands.push(
        `(${s.model.provider}) ${modelId}${think ? ` \u00B7 ${think}` : ""}`,
      );
    }
    cands.push(`${modelId}${think ? ` \u00B7 ${think}` : ""}`);
    cands.push(modelId);
    const budget = w - (left ? safeVisibleWidth(left) + 1 : 0);
    const pick =
      cands.find((c) => safeVisibleWidth(c) <= budget) ??
      cands[cands.length - 1]!;
    right = paint.fg("dim", pick);
  }
  const line1 = narrow
    ? safeTruncateToWidth(left || right, w)
    : left
      ? fitLine(left, right, w)
      : fitLine("", right, w);

  // Line 2: dim session details; statuses stay separate items.
  const segs: Seg[] = [
    {
      text: paint.fg(
        "dim",
        `  ${s.cwd}${s.branch ? ` \u00B7 ${s.branch}` : ""}`,
      ),
      pri: -1,
    },
  ];
  if (!narrow) {
    const parts: string[] = [];
    if (s.usage.input > 0) parts.push(`${formatTokens(s.usage.input)} in`);
    if (s.usage.output > 0) parts.push(`${formatTokens(s.usage.output)} out`);
    if (parts.length > 0) {
      segs.push({ text: paint.fg("dim", parts.join(" \u00B7 ")), pri: 5 });
    }
    segs.push({
      text: paint.fg(
        "dim",
        `$${s.usage.cost.toFixed(3)}${s.subscription ? " sub" : ""}`,
      ),
      pri: 4,
    });
    for (const st of s.statuses) {
      segs.push({ text: paint.fg("dim", st.text), pri: 10 });
    }
  }
  const line2 = joinDropping(segs, paint.fg("dim", " \u00B7 "), w);

  return [line1, line2]
    .filter((line) => safeVisibleWidth(line) > 0)
    .slice(0, FOOTER_MAX_LINES);
};

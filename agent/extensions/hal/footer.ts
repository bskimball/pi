// footer: HAL 9000 panel footer for the hal UI.
//
// Calm, clinical, uppercase labels with square glyphs and the red eye:
// an identity line (eye, name, mode, model, place) plus a CTX gauge line
// with labelled readouts and a right-aligned system phrase. Pure: no timers,
// no I/O, never more than FOOTER_MAX_LINES lines.

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

export const buildFooter: BuildFooter = (s, width, paint) => {
  const w = Math.max(0, Math.floor(width));
  if (w <= 0) return [];
  const narrow = w < 50;
  const mode = (s.mode ?? "").trim().toUpperCase();
  const pct = s.context.percent;

  // Line 1: eye + identity + mode on the left; model and place on the right.
  const leftCore =
    paint.fg("error", "\u25A0") +
    " " +
    paint.fg("text", "HAL 9000") +
    (mode ? paint.fg("dim", " \u00B7 ") + paint.fg("accent", mode) : "");
  const modelId = (s.model?.id ?? "no model").toUpperCase();
  const think = (s.thinking ?? "").trim().toUpperCase();
  const modelCands: string[] = [];
  if (s.multiProvider && s.model && !narrow) {
    modelCands.push(
      paint.fg("muted", `${s.model.provider.toUpperCase()} \u00B7 ${modelId}${think ? ` / ${think}` : ""}`),
    );
  }
  modelCands.push(
    paint.fg("muted", `${modelId}${think ? ` / ${think}` : ""}`),
  );
  modelCands.push(paint.fg("muted", modelId));
  const place =
    paint.fg("muted", s.cwd) +
    (s.branch && !narrow ? paint.fg("dim", " \u00B7 ") + paint.fg("text", s.branch) : "");
  const rightOpts: string[] = [];
  for (const m of modelCands) {
    rightOpts.push(`${m}   ${place}`);
    rightOpts.push(m);
  }
  rightOpts.push(place);
  rightOpts.push("");
  const right =
    rightOpts.find(
      (r) =>
        safeVisibleWidth(leftCore) + (r ? 1 : 0) + safeVisibleWidth(r) <= w,
    ) ?? "";
  const line1 = right
    ? fitLine(leftCore, right, w)
    : safeTruncateToWidth(leftCore, w);

  // Line 2: CTX gauge plus labelled readouts; system phrase on the right.
  const groups: Seg[] = [
    {
      text:
        paint.fg("dim", "CTX ") +
        paint.fg(toneFor(pct), gauge(pct)) +
        " " +
        paint.fg("text", pct === null ? "?" : `${Math.round(pct)}%`),
      pri: -1,
    },
  ];
  if (!narrow) {
    if (s.usage.input > 0 || s.usage.output > 0) {
      groups.push({
        text: paint.fg(
          "dim",
          `I/O ${formatTokens(s.usage.input).toUpperCase()}/${formatTokens(s.usage.output).toUpperCase()}`,
        ),
        pri: 5,
      });
    }
    groups.push({
      text: paint.fg(
        "dim",
        `COST $${s.usage.cost.toFixed(3)}${s.subscription ? " SUB" : ""}`,
      ),
      pri: 4,
    });
    for (const st of s.statuses) {
      groups.push({ text: paint.fg("muted", st.text.toUpperCase()), pri: 10 });
    }
  }
  let line2: string;
  if (narrow) {
    line2 = joinDropping(groups, paint.fg("dim", " \u00B7 "), w);
  } else {
    const phrase = paint.fg(
      pct === null ? "dim" : toneFor(pct) === "accent" ? "success" : toneFor(pct),
      phraseFor(pct),
    );
    const budget = w - safeVisibleWidth(phrase) - 2;
    if (budget < safeVisibleWidth(groups[0]!.text) + 1) {
      line2 = joinDropping(groups, paint.fg("dim", " \u00B7 "), w);
    } else {
      line2 = fitLine(
        joinDropping(groups, paint.fg("dim", " \u00B7 "), Math.max(0, budget)),
        // Leading space keeps at least two columns between the last readout
        // and the phrase when the line is exactly full.
        ` ${phrase}`,
        w,
      );
    }
  }

  return [line1, line2]
    .filter((line) => safeVisibleWidth(line) > 0)
    .slice(0, FOOTER_MAX_LINES);
};

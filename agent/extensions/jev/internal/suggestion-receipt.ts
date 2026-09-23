import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { safeTruncateToWidth, uiChromeEnabled, WidthText } from "@pi/ui-kit";
import { buildTreeLines, noteRow, safeLine, type StatusTheme, type TreeRow } from "@pi/ui-kit/internal/presentation/receipt-tree.ts";
import { skinGlyphs } from "@pi/ui-kit/internal/presentation/skin.ts";
import type { Component } from "@earendil-works/pi-tui";

export const JEV_SUGGESTION_TYPE = "jev-suggestion";

export interface JevSuggestionDetails {
  kind: "turn" | "code" | "todo" | "memory" | "review";
  file?: string;
  skill?: { name: string; probability: number };
  skills?: Array<{ name: string; probability: number }>;
  findings: Array<{ id: string; label: string; probability: number }>;
}

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ").trim().slice(0, max) : "";
}

function validProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export interface JevSuggestionRow {
  id: string;
  subject?: string;
  detail?: string;
}

function rowsFrom(details: JevSuggestionDetails | undefined): JevSuggestionRow[] {
  if (!details || !Array.isArray(details.findings)) return [];
  const file = clean(details.file, 100);
  const rows: JevSuggestionRow[] = [{
    id: "Jev suggestion",
    subject: details.kind === "turn" ? "turn advisory" : (file || `${details.kind} finding`),
  }];
  for (const skill of (details.skills ?? (details.skill ? [details.skill] : [])).slice(0, 12)) {
    const skillName = clean(skill?.name, 80);
    if (skillName && validProbability(skill?.probability)) {
      rows.push({ id: "skill", subject: skillName, detail: `p=${skill.probability.toFixed(2)}` });
    }
  }
  for (const finding of details.findings.slice(0, 8)) {
    const id = clean(finding?.id, 80);
    const label = clean(finding?.label, 160);
    if (!id || !label || !validProbability(finding?.probability)) continue;
    rows.push({ id, subject: label, detail: `p=${finding.probability.toFixed(2)}` });
  }
  return rows;
}

function plainComponent(details: JevSuggestionDetails | undefined) {
  const rows = rowsFrom(details);
  if (rows.length === 0) return undefined;
  const lines = rows.map((row, index) => {
    if (index === 0) return `Jev suggestion: ${row.subject ?? "advisory"}`;
    return `- ${row.id}: ${row.subject ?? "finding"}${row.detail ? ` (${row.detail})` : ""}`;
  });
  return new WidthText((width) => lines.map((line) => safeTruncateToWidth(line, width)), "[Jev suggestion unavailable]");
}

/**
 * Jev's own advisory block. Deliberately not the `notice` shape: a notice
 * is a background-settlement pointer (`background` right rail, settled
 * counts) while a suggestion is foreground advisory with calibrated
 * probabilities. Sharing that chrome made Jev findings read as settled
 * background work and hid the probability detail behind notice bounds.
 */
function suggestionComponent(
  details: JevSuggestionDetails | undefined,
  expanded: boolean,
  pad: number,
  theme: StatusTheme,
): Component | undefined {
  const rows = rowsFrom(details);
  if (rows.length === 0) return undefined;
  const inset = " ".repeat(Math.max(0, Math.min(pad, 8)));
  const render = (width: number): string[] => {
    const inner = Math.max(8, width - inset.length);
    const header = safeTruncateToWidth(
      `${theme.fg("warning", skinGlyphs().statusActive)} ${theme.fg("customMessageLabel", "jev")} ${theme.fg("muted", safeLine(rows[0]?.subject, 120))}`,
      inner,
    );
    const limit = expanded ? 12 : 6;
    const treeRows: TreeRow[] = [];
    for (const row of rows.slice(1, 1 + limit)) {
      const detail = row.detail ? ` ${theme.fg("dim", safeLine(row.detail, 40))}` : "";
      treeRows.push({
        line: (rail) => safeTruncateToWidth(
          `${theme.fg("dim", rail)} ${theme.fg("accent", safeLine(row.id, 40))} ${theme.fg("muted", safeLine(row.subject, 160))}${detail}`,
          inner,
        ),
      });
    }
    const hidden = rows.length - 1 - treeRows.length;
    if (hidden > 0) treeRows.push(noteRow(theme, inner, `${hidden} more not shown`, "muted"));
    const hint = noteRow(theme, inner, "Advisory only. Follow-through metrics are read/edit-after-suggestion proxies, not proof of improvement.", "dim");
    treeRows.push(hint);
    return buildTreeLines(theme, inner, header, treeRows).map((line) =>
      inset ? safeTruncateToWidth(`${inset}${line}`, width) : line,
    );
  };
  return new WidthText(render, "[Jev suggestion unavailable]");
}

/** Register model-visible turn messages and display-only code-finding entries with the same receipt. */
export function registerSuggestionReceipt(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<JevSuggestionDetails>(JEV_SUGGESTION_TYPE, (message, options, theme) =>
    uiChromeEnabled() ? suggestionComponent(message.details, options.expanded, options.outputPad, theme as StatusTheme) : undefined);
  pi.registerEntryRenderer<JevSuggestionDetails>(JEV_SUGGESTION_TYPE, (entry, options, theme) =>
    uiChromeEnabled() ? suggestionComponent(entry.data, options.expanded, 0, theme as StatusTheme) : plainComponent(entry.data));
}

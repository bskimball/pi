import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { safeTruncateToWidth, uiChromeEnabled, WidthText, type NoticeRow } from "@pi/ui-kit";
import { noticeComponent } from "@pi/ui-kit/internal/presentation/notice-view.ts";

export const JEV_SUGGESTION_TYPE = "jev-suggestion";

export interface JevSuggestionDetails {
  kind: "turn" | "code" | "todo" | "memory" | "review";
  file?: string;
  skill?: { name: string; probability: number };
  findings: Array<{ id: string; label: string; probability: number }>;
}

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ").trim().slice(0, max) : "";
}

function validProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function rowsFrom(details: JevSuggestionDetails | undefined): NoticeRow[] {
  if (!details || !Array.isArray(details.findings)) return [];
  const file = clean(details.file, 100);
  const rows: NoticeRow[] = [{
    kind: "unknown",
    id: "Jev suggestion",
    subject: details.kind === "turn" ? "turn advisory" : (file || `${details.kind} finding`),
  }];
  const skillName = clean(details.skill?.name, 80);
  if (skillName && validProbability(details.skill?.probability)) {
    rows.push({
      kind: "unknown",
      id: "skill",
      subject: skillName,
      detail: `p=${details.skill.probability.toFixed(2)}`,
    });
  }
  for (const finding of details.findings.slice(0, 8)) {
    const id = clean(finding?.id, 80);
    const label = clean(finding?.label, 160);
    if (!id || !label || !validProbability(finding?.probability)) continue;
    rows.push({ kind: "unknown", id, subject: label, detail: `p=${finding.probability.toFixed(2)}` });
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

function component(
  details: JevSuggestionDetails | undefined,
  expanded: boolean,
  pad: number,
  theme: Parameters<Parameters<ExtensionAPI["registerMessageRenderer"]>[1]>[2],
) {
  const rows = rowsFrom(details);
  if (rows.length === 0) return undefined;
  return noticeComponent(theme, {
    channel: "Jev suggestion",
    rows,
    hint: "Advisory only. Follow-through metrics are read/edit-after-suggestion proxies, not proof of improvement.",
    expanded,
    pad,
  });
}

/** Register model-visible turn messages and display-only code-finding entries with the same receipt. */
export function registerSuggestionReceipt(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<JevSuggestionDetails>(JEV_SUGGESTION_TYPE, (message, options, theme) =>
    uiChromeEnabled() ? component(message.details, options.expanded, options.outputPad, theme) : undefined);
  pi.registerEntryRenderer<JevSuggestionDetails>(JEV_SUGGESTION_TYPE, (entry, options, theme) =>
    uiChromeEnabled() ? component(entry.data, options.expanded, 0, theme) : plainComponent(entry.data));
}

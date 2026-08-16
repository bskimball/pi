// receipt-tree: the small tree/receipt vocabulary Apex receipts share.
//
// Deliberately dependency-free presentation: no pi-tui Text/Markdown/Container,
// no timers, no visibleWidth/truncateToWidth. Every builder returns plain
// strings that the caller clips through safe-text-layout.

import { safeTruncateToWidth } from "./safe-text-layout.ts";
import { TREE, cleanInline, fitLine } from "./ui-common.ts";

export interface StatusTheme {
  fg(token: string, text: string): string;
}

export interface TreeRow {
  /** Receives the already-selected branch glyph (`├─` or `╰─`). */
  line: (rail: string) => string;
  /** Bounded text that hangs under this row rather than becoming a child. */
  continuation?: string[];
  /** Theme token for continuation text. Defaults to `toolOutput`. */
  continuationToken?: string;
}

/** A non-empty single-line string, or "" for anything else. */
export function safeLine(value: unknown, max = 120): string {
  return cleanInline(value, Math.max(1, max));
}

/** ` (a · b · c)` metadata, or "" when nothing useful is known. */
export function metaText(parts: Array<string | false | undefined>): string {
  const kept = parts.filter((part): part is string => !!part);
  return kept.length ? kept.join(" \u00b7 ") : "";
}

/** A dim note row hanging under a receipt header. */
export function noteRow(
  theme: StatusTheme,
  width: number,
  text: unknown,
  token = "dim",
): TreeRow {
  return {
    line: (rail) =>
      safeTruncateToWidth(
        `${theme.fg("dim", rail)} ${theme.fg(token, safeLine(text, 400))}`,
        width,
      ),
  };
}

/**
 * An elegant empty state: a quiet receipt root plus a single actionable hint,
 * instead of a bare "No todos." sentence.
 */
export function emptyStateLines(
  theme: StatusTheme,
  width: number,
  tool: string,
  headline: string,
  hint?: string,
): string[] {
  const header = fitLine(
    `${theme.fg("dim", TREE.receipt)} ${theme.fg("toolTitle", safeLine(tool, 40))}`,
    theme.fg("muted", safeLine(headline, 200)),
    width,
  );
  if (!hint) return [header];
  return [
    header,
    safeTruncateToWidth(
      `${theme.fg("dim", TREE.last)} ${theme.fg("dim", safeLine(hint, 200))}`,
      width,
    ),
  ];
}

/**
 * Assemble a header and tree children while assigning exactly one terminal
 * branch. Continuations follow their owning child with `│` or `hang` chrome.
 */
export function buildTreeLines(
  theme: StatusTheme,
  width: number,
  headerLine: string,
  rows: readonly TreeRow[],
): string[] {
  const lines = [safeTruncateToWidth(headerLine, width)];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const isLast = index === rows.length - 1;
    lines.push(
      safeTruncateToWidth(row.line(isLast ? TREE.last : TREE.branch), width),
    );
    const prefix = isLast ? TREE.hang : `${theme.fg("dim", TREE.rail)}  `;
    for (const line of row.continuation ?? []) {
      lines.push(
        safeTruncateToWidth(
          `${prefix}${theme.fg(row.continuationToken ?? "toolOutput", line)}`,
          width,
        ),
      );
    }
  }
  return lines;
}

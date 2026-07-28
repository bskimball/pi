// edit-diff: numbered contextual diffs for mono edit/write tool receipts.
//
// Stability: dependency-free width clipping only (safe-text-layout). No
// pi-tui Text/Markdown/Container and no render timers.

import * as Diff from "diff";
import {
  safeTruncateToWidth,
  safeVisibleWidth,
} from "./safe-text-layout.ts";

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Pi-style numbered contextual diff (local equivalent of edit-diff.generateDiffString). */
export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): string {
  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const lineNumWidth = String(
    Math.max(oldLines.length, newLines.length),
  ).length;
  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") raw.pop();

    if (part.added || part.removed) {
      for (const line of raw) {
        if (part.added) {
          output.push(
            `+${String(newLineNum).padStart(lineNumWidth, " ")} ${line}`,
          );
          newLineNum++;
        } else {
          output.push(
            `-${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`,
          );
          oldLineNum++;
        }
      }
      lastWasChange = true;
      continue;
    }

    const nextPartIsChange =
      i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
    const hasLeadingChange = lastWasChange;
    const hasTrailingChange = nextPartIsChange;

    if (hasLeadingChange && hasTrailingChange) {
      if (raw.length <= contextLines * 2) {
        for (const line of raw) {
          output.push(
            ` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`,
          );
          oldLineNum++;
          newLineNum++;
        }
      } else {
        const leading = raw.slice(0, contextLines);
        const trailing = raw.slice(raw.length - contextLines);
        const skipped = raw.length - leading.length - trailing.length;
        for (const line of leading) {
          output.push(
            ` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`,
          );
          oldLineNum++;
          newLineNum++;
        }
        output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
        oldLineNum += skipped;
        newLineNum += skipped;
        for (const line of trailing) {
          output.push(
            ` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`,
          );
          oldLineNum++;
          newLineNum++;
        }
      }
    } else if (hasLeadingChange) {
      const shown = raw.slice(0, contextLines);
      const skipped = raw.length - shown.length;
      for (const line of shown) {
        output.push(
          ` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`,
        );
        oldLineNum++;
        newLineNum++;
      }
      if (skipped > 0) {
        output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
        oldLineNum += skipped;
        newLineNum += skipped;
      }
    } else if (hasTrailingChange) {
      const skipped = Math.max(0, raw.length - contextLines);
      if (skipped > 0) {
        output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
        oldLineNum += skipped;
        newLineNum += skipped;
      }
      for (const line of raw.slice(skipped)) {
        output.push(
          ` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`,
        );
        oldLineNum++;
        newLineNum++;
      }
    } else {
      oldLineNum += raw.length;
      newLineNum += raw.length;
    }
    lastWasChange = false;
  }

  return output.join("\n");
}

export function parseDiffLine(
  line: string,
): { prefix: string; lineNum: string; content: string } | null {
  const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
  if (!match) return null;
  return { prefix: match[1], lineNum: match[2], content: match[3] };
}

export function replaceTabs(text: string): string {
  return text.replace(/\t/g, "   ");
}

export function countDiffStats(diffText: string): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const line of diffText.split("\n")) {
    const parsed = parseDiffLine(line);
    if (!parsed) continue;
    if (parsed.prefix === "+") added++;
    else if (parsed.prefix === "-") removed++;
  }
  return { added, removed };
}

export function formatDiffStats(
  theme: { fg: (key: any, text: string) => string },
  diffText: string | undefined,
): string {
  if (!diffText) return "";
  const { added, removed } = countDiffStats(diffText);
  if (added === 0 && removed === 0) return "";
  const parts: string[] = [];
  if (added > 0) parts.push(theme.fg("toolDiffAdded", `+${added}`));
  if (removed > 0) parts.push(theme.fg("toolDiffRemoved", `-${removed}`));
  return parts.join(" ");
}

export function renderIntraLineDiff(
  oldContent: string,
  newContent: string,
  inverse: (text: string) => string,
): { removedLine: string; addedLine: string } {
  const wordDiff = Diff.diffWords(oldContent, newContent);
  let removedLine = "";
  let addedLine = "";
  let isFirstRemoved = true;
  let isFirstAdded = true;

  for (const part of wordDiff) {
    if (part.removed) {
      let value = part.value;
      if (isFirstRemoved) {
        const leadingWs = value.match(/^(\s*)/)?.[1] || "";
        value = value.slice(leadingWs.length);
        removedLine += leadingWs;
        isFirstRemoved = false;
      }
      if (value) removedLine += inverse(value);
    } else if (part.added) {
      let value = part.value;
      if (isFirstAdded) {
        const leadingWs = value.match(/^(\s*)/)?.[1] || "";
        value = value.slice(leadingWs.length);
        addedLine += leadingWs;
        isFirstAdded = false;
      }
      if (value) addedLine += inverse(value);
    } else {
      removedLine += part.value;
      addedLine += part.value;
    }
  }

  return { removedLine, addedLine };
}

// The theme schema fixes the set of background tokens, so diff row backgrounds
// are emitted as raw truecolor. These match GitHub Dark's diff surfaces and are
// only ever applied to a full row, which keeps the padding math unchanged.
const DIFF_ADDED_BG = "\x1b[48;2;3;35;18m";
const DIFF_REMOVED_BG = "\x1b[48;2;51;13;16m";
const DIFF_RESET = "\x1b[49m";

/**
 * Paint a full-row background. The row is clipped and space-filled to rowWidth
 * first so every diff line paints an even block instead of a ragged one.
 */
export function diffRow(bg: string, text: string, rowWidth: number): string {
  let row = text;
  if (rowWidth > 0) {
    row = safeTruncateToWidth(row, rowWidth);
    row += " ".repeat(Math.max(0, rowWidth - safeVisibleWidth(row)));
  }
  // Re-assert the row background after any inner reset so intra-line inverse
  // highlights cannot punch a hole in it.
  return `${bg}${row.replace(/\x1b\[0m/g, `\x1b[0m${bg}`)}${DIFF_RESET}`;
}

/** Pi-style colored numbered diff with single-line intra-line inverse highlights. */
export function renderDiffLines(
  diffText: string,
  theme: {
    fg: (key: any, text: string) => string;
    inverse?: (text: string) => string;
  },
  maxLines = 80,
  rowWidth = 0,
): string[] {
  const lines = diffText.split("\n");
  const result: string[] = [];
  let i = 0;
  const inverse = theme.inverse?.bind(theme) ?? ((text: string) => text);
  const added = (text: string) => diffRow(DIFF_ADDED_BG, text, rowWidth);
  const removed = (text: string) => diffRow(DIFF_REMOVED_BG, text, rowWidth);

  while (i < lines.length) {
    const parsed = parseDiffLine(lines[i]);
    if (!parsed) {
      result.push(theme.fg("toolDiffContext", lines[i]));
      i++;
      continue;
    }

    if (parsed.prefix === "-") {
      const removedLines: { lineNum: string; content: string }[] = [];
      while (i < lines.length) {
        const p = parseDiffLine(lines[i]);
        if (!p || p.prefix !== "-") break;
        removedLines.push({ lineNum: p.lineNum, content: p.content });
        i++;
      }
      const addedLines: { lineNum: string; content: string }[] = [];
      while (i < lines.length) {
        const p = parseDiffLine(lines[i]);
        if (!p || p.prefix !== "+") break;
        addedLines.push({ lineNum: p.lineNum, content: p.content });
        i++;
      }

      if (removedLines.length === 1 && addedLines.length === 1) {
        const { removedLine, addedLine } = renderIntraLineDiff(
          replaceTabs(removedLines[0].content),
          replaceTabs(addedLines[0].content),
          inverse,
        );
        result.push(
          removed(
            theme.fg(
              "toolDiffRemoved",
              `-${removedLines[0].lineNum} ${removedLine}`,
            ),
          ),
        );
        result.push(
          added(
            theme.fg("toolDiffAdded", `+${addedLines[0].lineNum} ${addedLine}`),
          ),
        );
      } else {
        for (const row of removedLines) {
          result.push(
            removed(
              theme.fg(
                "toolDiffRemoved",
                `-${row.lineNum} ${replaceTabs(row.content)}`,
              ),
            ),
          );
        }
        for (const row of addedLines) {
          result.push(
            added(
              theme.fg(
                "toolDiffAdded",
                `+${row.lineNum} ${replaceTabs(row.content)}`,
              ),
            ),
          );
        }
      }
    } else if (parsed.prefix === "+") {
      result.push(
        added(
          theme.fg(
            "toolDiffAdded",
            `+${parsed.lineNum} ${replaceTabs(parsed.content)}`,
          ),
        ),
      );
      i++;
    } else {
      result.push(
        theme.fg(
          "toolDiffContext",
          ` ${parsed.lineNum} ${replaceTabs(parsed.content)}`,
        ),
      );
      i++;
    }
  }

  if (result.length <= maxLines) return result;
  return [
    ...result.slice(0, maxLines),
    theme.fg("dim", `... ${result.length - maxLines} more lines`),
  ];
}

export function resultDiff(result: any): string | undefined {
  const diff = result?.details?.diff;
  return typeof diff === "string" && diff.length > 0 ? diff : undefined;
}

// builtin-tool-renderers: receipt renderers for the kit's bash/write
// re-registrations. Shared by the main-thread registration (builtin-tools.ts)
// and the Agents peek so both paint the same receipt.

import { padStartToWidth, safeTruncateToWidth } from "./safe-text-layout.ts";
import { boundedOutput, toolRenderers } from "./tool-receipt.ts";
import { formatDiffStats, renderDiffLines, resultDiff } from "./edit-diff.ts";
import { cleanInline } from "./ui-common.ts";

export type BuiltinName = "read" | "bash" | "write";

type LineTheme = { fg: (key: any, text: string) => string };

function primaryArg(name: BuiltinName, args: any): string {
  if (name === "bash") return cleanInline(args?.command, 120);
  const filePath = cleanInline(args?.path, 120);
  if (name === "read" && args?.offset) {
    return `${filePath}:${args.offset}${args?.limit ? `+${args.limit}` : ""}`;
  }
  return filePath;
}

const READ_NOTICE_RE =
  /^(?:\[Showing lines \d+-\d+ of \d+.*\]|\[\d+ more lines in file\. Use offset=\d+ to continue\.\]|\[Line \d+ is .*exceeds .*limit\..*\]|\.\.\. \d+ more lines?|\.\.\. output truncated at \d+ characters)$/;

function numberReadLines(
  lines: string[],
  offset: unknown,
  theme: LineTheme | undefined,
  innerWidth: number,
): string[] {
  const dim = (text: string) => theme?.fg("dim", text) ?? text;
  const body = (text: string) => theme?.fg("toolOutput", text) ?? text;
  const start = Number.isFinite(Number(offset))
    ? Math.max(1, Math.floor(Number(offset)))
    : 1;
  const gutter = Math.max(2, String(start + lines.length - 1).length);
  if (innerWidth <= gutter + 4) return lines;
  let lineNumber = start;
  return lines.map((line) => {
    if (READ_NOTICE_RE.test(line)) return dim(line);
    const numbered = `${padStartToWidth(String(lineNumber), gutter)} `;
    lineNumber++;
    return `${dim(numbered)}${body(safeTruncateToWidth(line, innerWidth - gutter - 1))}`;
  });
}

function shortenPath(value: string, max: number): string {
  if (value.length <= max) return value;
  const segments = value.split(/[\\/]+/).filter(Boolean);
  for (let start = 1; start < segments.length; start++) {
    const tail = `…/${segments.slice(start).join("/")}`;
    if (tail.length <= max) return tail;
  }
  const last = segments[segments.length - 1] ?? value;
  return last.length <= max ? last : `…${last.slice(-Math.max(1, max - 1))}`;
}

/** renderCall/renderResult for one builtin; each call gets its own theme capture. */
export function createBuiltinToolRenderers(name: BuiltinName) {
  const isMutation = name === "write";
  let lastTheme: LineTheme | undefined;
  const ui = toolRenderers<any>({
    surface: name,
    title: name,
    expandVerb: isMutation ? "diff" : "expand",
    expandWhen: (result, _args, isError) =>
      isMutation && !isError && !!resultDiff(result),
    arg(args, budget) {
      const rawArg = primaryArg(name, args);
      return name === "bash"
        ? safeTruncateToWidth(rawArg, budget)
        : shortenPath(rawArg, budget);
    },
    stats(result, _args, theme) {
      return isMutation ? formatDiffStats(theme, resultDiff(result)) : "";
    },
    preview(output) {
      return name === "bash" && output ? boundedOutput(output, 3, 1200) : [];
    },
    body(output, result, args, innerWidth) {
      if (isMutation) {
        const diff = resultDiff(result);
        return diff
          ? renderDiffLines(
              diff,
              lastTheme ?? { fg: (_key, text) => text },
              80,
              innerWidth,
            )
          : [];
      }
      if (!output) return [];
      const lines = boundedOutput(output, 80);
      return name === "read"
        ? numberReadLines(lines, args?.offset, lastTheme, innerWidth)
        : lines;
    },
  });
  return {
    renderCall: ui.renderCall,
    renderResult(result: any, options: any, theme: any, context: any) {
      lastTheme = theme;
      return ui.renderResult(result, options, theme, context);
    },
  };
}

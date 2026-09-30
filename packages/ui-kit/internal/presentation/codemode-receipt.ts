// codemode-receipt: kit chrome for Pi's native `codemode` and `tool_search` tools.
//
// The codemode extension owns execute and its own renderers; `tool_search`
// has no owner renderer (stock Pi fallback). Both attach here through the
// shared headless wrap. `codemode` opts into overrideOwned so the kit's
// compact receipt (nested tool names in the header, per-call lines in the
// body) replaces the owner's script dump.
//
// PI_UI_CHROME=0 skips the wrap and Pi's own presentation shows through.
// Preview hooks cannot color (their lines pass through cleanInline), so
// call status markers are plain words, never ANSI.

import { apexPresentationEnabled } from "./presentation.ts";
import { boundedOutput, toolRenderers } from "./tool-receipt.ts";
import { cleanInline } from "./ui-common.ts";
import { compactMcpProxyArgs } from "./mcp-receipt.ts";
import {
  installHeadlessReceipts,
  registerHeadlessReceipt,
} from "./headless-receipts.ts";

export const CODEMODE_TOOL = "codemode";
export const TOOL_SEARCH_TOOL = "tool_search";

/** Header the owner prepends to codemode output; stripped from previews. */
export const CODEMODE_SCRIPT_HEADER_RE =
  /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n/;

type CodemodeArgs = {
  code?: string;
};

type ToolSearchArgs = {
  query?: string;
  limit?: number;
};

type NestedCall = {
  name?: unknown;
  args?: unknown;
  status?: unknown;
  durationMs?: unknown;
  cost?: unknown;
  error?: unknown;
};

function detailsOf(result: any): Record<string, unknown> {
  return result?.details && typeof result.details === "object"
    ? (result.details as Record<string, unknown>)
    : {};
}

function callsOf(result: any): NestedCall[] {
  const details = detailsOf(result);
  return Array.isArray(details.calls)
    ? (details.calls as NestedCall[]).slice(0, 200)
    : [];
}

function fullOutputPathOf(result: any): string {
  const path = detailsOf(result).fullOutputPath;
  return typeof path === "string" && path ? path : "";
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Cents for larger amounts, two significant digits below a cent (owner parity). */
export function formatCodemodeCost(cost: number): string {
  return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}

function formatCallDuration(ms: unknown): string {
  const value = finiteNumber(ms);
  if (value === undefined) return "";
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;
}

/** Script lines with the `// @options:` line removed (arg purposes only). */
function scriptLines(code: unknown): string[] {
  if (typeof code !== "string") return [];
  return code
    .split("\n")
    .filter((line) => !/^\s*\/\/\s*@options:/.test(line));
}

/** Distinct nested tool names referenced as `tools.ident(` or `tools["name"]`. */
export function nestedToolRefs(code: unknown): string[] {
  if (typeof code !== "string") return [];
  const refs: string[] = [];
  const seen = new Set<string>();
  const re = /tools\.([A-Za-z_$][\w$]*)\s*\(|tools\[\s*["']([^"']+)["']\s*\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) {
    const name = match[1] ?? match[2];
    if (name && !seen.has(name)) {
      seen.add(name);
      refs.push(name);
      if (refs.length >= 12) break;
    }
  }
  return refs;
}

/** `mcp__server__tool` (sanitized/hash-suffixed tolerated) becomes `server/tool`. */
export function prettifyToolName(name: string): string {
  const clean = cleanInline(name, 120);
  if (!clean) return "";
  if (clean.startsWith("mcp__")) {
    const rest = clean.slice("mcp__".length);
    const split = rest.indexOf("__");
    if (split > 0) return `${rest.slice(0, split)}/${rest.slice(split + 2)}`;
    return rest;
  }
  return clean;
}

function failedCount(calls: NestedCall[]): number {
  return calls.filter(
    (call) => call.status === "error" || call.status === "cancelled",
  ).length;
}

function totalCost(calls: NestedCall[]): number | undefined {
  let total = 0;
  let priced = 0;
  for (const call of calls) {
    const cost = finiteNumber(call.cost);
    if (cost !== undefined) {
      total += cost;
      priced++;
    }
  }
  return priced ? total : undefined;
}

/** Plain-text status word for preview lines (no ANSI survives cleanInline). */
function statusWord(status: unknown): string {
  switch (String(status ?? "")) {
    case "running":
      return "...";
    case "ok":
      return "ok";
    case "error":
      return "err";
    case "cancelled":
      return "cancelled";
    default:
      return "?";
  }
}

/** Nested args arrive as a JSON string; show them like MCP proxy headers. */
function compactCallArgs(raw: unknown): string {
  if (typeof raw !== "string") return "";
  if (raw.length <= 4_000) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return compactMcpProxyArgs(parsed as Record<string, unknown>, 80);
      }
    } catch {
      // Owner may clip long args; fall through to the plain inline form.
    }
  }
  return cleanInline(raw, 80);
}

/** One collapsed line per nested call: `ok name args duration cost`. */
function shortCallLine(call: NestedCall): string {
  const name = prettifyToolName(typeof call.name === "string" ? call.name : "");
  const args = compactCallArgs(call.args);
  const duration = formatCallDuration(call.durationMs);
  const cost = finiteNumber(call.cost);
  return [statusWord(call.status), name || "call", args, duration, cost !== undefined ? formatCodemodeCost(cost) : ""]
    .filter(Boolean)
    .join(" ");
}

export function stripScriptHeader(output: string): string {
  return output.replace(CODEMODE_SCRIPT_HEADER_RE, "");
}

/** Compact header: distinct nested tool names, then `· N lines`. */
export function codemodeReceiptArg(
  args: CodemodeArgs | undefined,
  budget: number,
): string {
  const cap = Math.max(8, budget);
  const lines = scriptLines(args?.code);
  const nonEmpty = lines.filter((line) => line.trim()).length;
  const refs = nestedToolRefs(args?.code).map(prettifyToolName).filter(Boolean);
  const count = nonEmpty ? ` · ${nonEmpty} line${nonEmpty === 1 ? "" : "s"}` : "";
  if (refs.length) {
    const head = refs.length > 3 ? [...refs.slice(0, 2), `+${refs.length - 2}`] : refs;
    return cleanInline(`${head.join(", ")}${count}`, cap);
  }
  const first = lines.map((line) => line.trim()).find(
    (line) => line && !line.startsWith("//"),
  );
  return cleanInline(`${first || "script"}${count}`, cap);
}

export const codemodeReceiptRenderers = toolRenderers<CodemodeArgs>({
  surface: CODEMODE_TOOL,
  title: CODEMODE_TOOL,
  arg: codemodeReceiptArg,
  stats(result) {
    const calls = callsOf(result);
    if (!calls.length) return "";
    const parts = [
      `${calls.length} call${calls.length === 1 ? "" : "s"}`,
    ];
    const failed = failedCount(calls);
    if (failed) parts.push(`${failed} failed`);
    const cost = totalCost(calls);
    if (cost !== undefined) parts.push(formatCodemodeCost(cost));
    return parts.join(" · ");
  },
  partialPreview(result) {
    return callsOf(result).slice(-3).map(shortCallLine);
  },
  preview(output, result) {
    const calls = callsOf(result);
    const path = fullOutputPathOf(result);
    const room = Math.max(0, 4 - (path ? 1 : 0));
    const callLines = calls.slice(-2).map(shortCallLine);
    const stripped = stripScriptHeader(output);
    const outLines = stripped
      ? stripped.split("\n").map((line) => line.trim()).filter(Boolean)
      : [];
    const shown = [...callLines, ...outLines].slice(0, room);
    if (path) shown.push(`full output: ${cleanInline(path, 200)}`);
    return shown.length ? boundedOutput(shown.join("\n"), 4, 1200) : [];
  },
  body(output, result, args) {
    const lines: string[] = [];
    const script = typeof args?.code === "string" ? args.code.trim() : "";
    if (script) {
      lines.push(...boundedOutput(script, 30, 4000));
      lines.push("");
    }
    const calls = callsOf(result);
    for (const call of calls.slice(0, 60)) {
      lines.push(shortCallLine(call));
      if (typeof call.error === "string" && call.error.trim()) {
        const first = call.error.split("\n")[0] ?? "";
        const clean = cleanInline(first, 200);
        if (clean) lines.push(`    ${clean}`);
      }
    }
    if (calls.length) lines.push("");
    const stripped = stripScriptHeader(output).trim();
    if (stripped) lines.push(...boundedOutput(stripped, 30, 6000));
    const path = fullOutputPathOf(result);
    if (path) lines.push(`full output: ${cleanInline(path, 200)}`);
    return lines.length ? boundedOutput(lines.join("\n"), 80) : [];
  },
  expandWhen: (result) => callsOf(result).length > 0,
});

/** Compact header: the search query. */
export function toolSearchReceiptArg(
  args: ToolSearchArgs | undefined,
  budget: number,
): string {
  return cleanInline(args?.query || "search", Math.max(8, budget));
}

function loadedTools(result: any): string[] {
  const loaded = detailsOf(result).loaded;
  if (!Array.isArray(loaded)) return [];
  return loaded
    .filter((name): name is string => typeof name === "string" && !!name)
    .map((name) => prettifyToolName(name))
    .filter(Boolean)
    .slice(0, 24);
}

export const toolSearchReceiptRenderers = toolRenderers<ToolSearchArgs>({
  surface: TOOL_SEARCH_TOOL,
  title: TOOL_SEARCH_TOOL,
  arg: toolSearchReceiptArg,
  stats(result) {
    const loaded = loadedTools(result);
    return loaded.length ? `${loaded.length} loaded` : "";
  },
  preview(output, result) {
    const loaded = loadedTools(result);
    if (!loaded.length) return output ? boundedOutput(output, 4, 1200) : [];
    const parts: string[] = [];
    let used = 0;
    for (const name of loaded) {
      const piece = cleanInline(name, 120);
      if (!piece) continue;
      if (used + piece.length + 2 > 400) {
        parts.push(`+${loaded.length - parts.length} more`);
        break;
      }
      parts.push(piece);
      used += piece.length + 2;
    }
    return parts.length ? [parts.join(", ")] : [];
  },
  body(output, result) {
    const loaded = loadedTools(result);
    const lines = loaded.length ? [`Loaded ${loaded.length}:`, ...loaded] : [];
    if (output) {
      if (lines.length) lines.push("");
      lines.push(...boundedOutput(output, 60));
    }
    return lines.length ? boundedOutput(lines.join("\n"), 80) : [];
  },
  expandWhen: (result) => loadedTools(result).length > 0,
});

/** Attach kit receipts to `codemode` (replacing owner chrome) and `tool_search`. */
export function installCodemodeReceipts(): void {
  if (!apexPresentationEnabled()) return;
  registerHeadlessReceipt(CODEMODE_TOOL, codemodeReceiptRenderers, {
    overrideOwned: true,
  });
  registerHeadlessReceipt(TOOL_SEARCH_TOOL, toolSearchReceiptRenderers);
  installHeadlessReceipts();
}

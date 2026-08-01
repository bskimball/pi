import {
  fromLspPosition,
  type Position,
  type PositionEncoding,
  type Range,
} from "./positions.ts";
import { formatLocation, uriToPath } from "./paths.ts";

const MAX_OUTPUT = 60_000;
const DEFAULT_LIMIT = 50;

export function boundText(text: string, limit = MAX_OUTPUT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
}

export function clampLimit(limit: number | undefined, fallback = DEFAULT_LIMIT, max = 200): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(limit)));
}

function asRange(value: unknown): Range | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as { start?: Position; end?: Position };
  if (!r.start || typeof r.start.line !== "number") return undefined;
  return {
    start: { line: r.start.line, character: r.start.character ?? 0 },
    end: r.end && typeof r.end.line === "number"
      ? { line: r.end.line, character: r.end.character ?? 0 }
      : { line: r.start.line, character: r.start.character ?? 0 },
  };
}

function locLine(uri: string, range: Range | undefined, cwdHint?: string): string {
  const path = uriToPath(uri);
  if (!range) return path;
  const { line, column } = fromLspPosition(range.start);
  return formatLocation(path, line, column);
}

/** Normalize Location | Location[] | LocationLink | LocationLink[]. */
export function formatLocations(result: unknown, limit?: number): string {
  const items = normalizeLocations(result);
  if (!items.length) return "No locations found.";
  const max = clampLimit(limit);
  const lines = items.slice(0, max).map((item, i) => {
    const head = `${i + 1}. ${locLine(item.uri, item.range)}`;
    if (item.origin && item.targetSelection) {
      return `${head} (selection ${fromLspPosition(item.targetSelection.start).line}:${fromLspPosition(item.targetSelection.start).column})`;
    }
    return head;
  });
  if (items.length > max) lines.push(`...and ${items.length - max} more`);
  return boundText(lines.join("\n"));
}

export interface NormalizedLocation {
  uri: string;
  range?: Range;
  origin?: boolean;
  targetSelection?: Range;
}

export function normalizeLocations(result: unknown): NormalizedLocation[] {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  const out: NormalizedLocation[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.targetUri === "string") {
      out.push({
        uri: obj.targetUri,
        range: asRange(obj.targetRange) ?? asRange(obj.targetSelectionRange),
        targetSelection: asRange(obj.targetSelectionRange),
        origin: true,
      });
      continue;
    }
    if (typeof obj.uri === "string") {
      out.push({ uri: obj.uri, range: asRange(obj.range) });
    }
  }
  return out;
}

export function formatHover(result: unknown): string {
  if (!result || typeof result !== "object") return "No hover information.";
  const hover = result as { contents?: unknown; range?: Range };
  const text = markupToString(hover.contents);
  if (!text.trim()) return "No hover information.";
  if (hover.range) {
    const s = fromLspPosition(hover.range.start);
    const e = fromLspPosition(hover.range.end);
    return boundText(`Range ${s.line}:${s.column}-${e.line}:${e.column}\n\n${text}`);
  }
  return boundText(text);
}

function markupToString(contents: unknown): string {
  if (contents == null) return "";
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents.map((c) => markupToString(c)).filter(Boolean).join("\n\n");
  }
  if (typeof contents === "object") {
    const obj = contents as { kind?: string; value?: string; language?: string };
    if (typeof obj.value === "string") {
      if (obj.language) return `\`\`\`${obj.language}\n${obj.value}\n\`\`\``;
      return obj.value;
    }
  }
  return String(contents);
}

export interface NormalizedSymbol {
  name: string;
  kind: number;
  detail?: string;
  uri?: string;
  range?: Range;
  selectionRange?: Range;
  containerName?: string;
  path: string;
}

const SYMBOL_KIND: Record<number, string> = {
  1: "File", 2: "Module", 3: "Namespace", 4: "Package", 5: "Class",
  6: "Method", 7: "Property", 8: "Field", 9: "Constructor", 10: "Enum",
  11: "Interface", 12: "Function", 13: "Variable", 14: "Constant", 15: "String",
  16: "Number", 17: "Boolean", 18: "Array", 19: "Object", 20: "Key",
  21: "Null", 22: "EnumMember", 23: "Struct", 24: "Event", 25: "Operator",
  26: "TypeParameter",
};

export function symbolKindName(kind: number): string {
  return SYMBOL_KIND[kind] ?? `Kind(${kind})`;
}

export function normalizeDocumentSymbols(
  result: unknown,
  documentUri: string,
): NormalizedSymbol[] {
  if (!Array.isArray(result)) return [];
  const out: NormalizedSymbol[] = [];

  const walk = (symbols: unknown[], container?: string) => {
    for (const raw of symbols) {
      if (!raw || typeof raw !== "object") continue;
      const s = raw as Record<string, unknown>;
      if (typeof s.name !== "string") continue;
      // DocumentSymbol has range + selectionRange; SymbolInformation has location.
      if (s.location && typeof s.location === "object") {
        const loc = s.location as { uri?: string; range?: Range };
        const uri = loc.uri ?? documentUri;
        out.push({
          name: s.name,
          kind: typeof s.kind === "number" ? s.kind : 0,
          detail: typeof s.detail === "string" ? s.detail : undefined,
          uri,
          range: asRange(loc.range),
          containerName: typeof s.containerName === "string" ? s.containerName : container,
          path: uriToPath(uri),
        });
      } else {
        const range = asRange(s.range);
        const selectionRange = asRange(s.selectionRange) ?? range;
        out.push({
          name: s.name,
          kind: typeof s.kind === "number" ? s.kind : 0,
          detail: typeof s.detail === "string" ? s.detail : undefined,
          uri: documentUri,
          range,
          selectionRange,
          containerName: container,
          path: uriToPath(documentUri),
        });
        if (Array.isArray(s.children) && s.children.length) {
          walk(s.children, s.name);
        }
      }
    }
  };

  walk(result);
  return out;
}

export function normalizeWorkspaceSymbols(result: unknown): NormalizedSymbol[] {
  if (!Array.isArray(result)) return [];
  const out: NormalizedSymbol[] = [];
  for (const raw of result) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    if (typeof s.name !== "string") continue;
    if (s.location && typeof s.location === "object") {
      const loc = s.location as { uri?: string; range?: Range };
      if (typeof loc.uri !== "string") continue;
      out.push({
        name: s.name,
        kind: typeof s.kind === "number" ? s.kind : 0,
        uri: loc.uri,
        range: asRange(loc.range),
        containerName: typeof s.containerName === "string" ? s.containerName : undefined,
        path: uriToPath(loc.uri),
      });
      continue;
    }
    // WorkspaceSymbol may use location.uri only without range
    if (typeof s.location === "object" && s.location && typeof (s.location as { uri?: string }).uri === "string") {
      const uri = (s.location as { uri: string }).uri;
      out.push({
        name: s.name,
        kind: typeof s.kind === "number" ? s.kind : 0,
        uri,
        path: uriToPath(uri),
        containerName: typeof s.containerName === "string" ? s.containerName : undefined,
      });
    }
  }
  return out;
}

export function formatSymbols(symbols: NormalizedSymbol[], limit?: number): string {
  if (!symbols.length) return "No symbols found.";
  const max = clampLimit(limit, 100, 500);
  const lines = symbols.slice(0, max).map((s, i) => {
    const kind = symbolKindName(s.kind);
    const where = s.range
      ? formatLocation(s.path, fromLspPosition(s.range.start).line, fromLspPosition(s.range.start).column)
      : s.path;
    const container = s.containerName ? ` in ${s.containerName}` : "";
    const detail = s.detail ? ` — ${s.detail}` : "";
    return `${i + 1}. [${kind}] ${s.name}${container}${detail}\n   ${where}`;
  });
  if (symbols.length > max) lines.push(`...and ${symbols.length - max} more`);
  return boundText(lines.join("\n"));
}

const DIAG_SEV: Record<number, string> = {
  1: "error",
  2: "warning",
  3: "information",
  4: "hint",
};

export function formatDiagnostics(
  diagnostics: unknown[],
  filePath: string,
  opts: { status: "received" | "unknown" | "pull"; limit?: number },
): string {
  if (opts.status === "unknown") {
    return boundText(
      `Diagnostics status: unknown (server did not publish diagnostics within the wait window).\n` +
      `Do not assume the file is clean. File: ${filePath}`,
    );
  }
  if (!diagnostics.length) {
    return `No diagnostics for ${filePath}.`;
  }
  const max = clampLimit(opts.limit, 100, 300);
  const lines = diagnostics.slice(0, max).map((raw, i) => {
    const d = raw as {
      range?: Range;
      severity?: number;
      source?: string;
      message?: string;
      code?: string | number;
    };
    const sev = DIAG_SEV[d.severity ?? 0] ?? "diagnostic";
    const pos = d.range
      ? `${fromLspPosition(d.range.start).line}:${fromLspPosition(d.range.start).column}`
      : "?";
    const src = d.source ? ` ${d.source}` : "";
    const code = d.code != null ? ` [${d.code}]` : "";
    return `${i + 1}. ${sev}${src}${code} ${filePath}:${pos}\n   ${d.message ?? ""}`;
  });
  if (diagnostics.length > max) lines.push(`...and ${diagnostics.length - max} more`);
  return boundText(lines.join("\n"));
}

export function formatSymbolSource(
  path: string,
  lines: string[],
  displayStartLine1: number,
  symbolStartLine1: number,
  symbolEndLine1: number,
  symbolName: string,
  kind: string,
): string {
  const numbered = lines.map((line, i) => {
    const n = displayStartLine1 + i;
    const mark = n >= symbolStartLine1 && n <= symbolEndLine1 ? ">" : " ";
    return `${String(n).padStart(6, " ")}${mark}| ${line}`;
  });
  return boundText(
    `[${kind}] ${symbolName} — ${path}:${symbolStartLine1}-${symbolEndLine1}\n\n${numbered.join("\n")}`,
  );
}

export function pickBestSymbol(
  symbols: NormalizedSymbol[],
  query: string,
): { match?: NormalizedSymbol; ambiguous?: NormalizedSymbol[] } {
  if (!symbols.length) return {};
  const q = query.trim();
  const exact = symbols.filter((s) => s.name === q);
  if (exact.length === 1) return { match: exact[0] };
  if (exact.length > 1) return { ambiguous: exact };

  const ci = symbols.filter((s) => s.name.toLowerCase() === q.toLowerCase());
  if (ci.length === 1) return { match: ci[0] };
  if (ci.length > 1) return { ambiguous: ci };

  const suffix = symbols.filter((s) => s.name === q || s.name.endsWith(`.${q}`) || s.name.endsWith(`/${q}`));
  if (suffix.length === 1) return { match: suffix[0] };
  if (suffix.length > 1) return { ambiguous: suffix };

  // Single partial only if unique
  const partial = symbols.filter((s) => s.name.includes(q));
  if (partial.length === 1) return { match: partial[0] };
  if (partial.length > 1) return { ambiguous: partial.slice(0, 20) };
  return {};
}

export function sliceLines(
  text: string,
  startLine0: number,
  endLine0: number,
  margin: number,
): { lines: string[]; startLine1: number; endLine1: number } {
  const all = text.split(/\r?\n/);
  const from = Math.max(0, startLine0 - margin);
  const to = Math.min(all.length - 1, endLine0 + margin);
  return {
    lines: all.slice(from, to + 1),
    startLine1: from + 1,
    endLine1: endLine0 + 1,
  };
}

export { fromLspPosition, type PositionEncoding };

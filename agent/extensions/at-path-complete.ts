// at-path-complete: scoped @ path listing that ignores gitignore.
//
// FFF and stock `fd` skip gitignored files, so `@files/` fuzzy-matches
// `skills/` instead of listing a local secrets folder. This overlay takes
// over only when the typed @ token already contains a `/`, then lists the
// on-disk directory with readdir. Bare `@foo` stays with FFF/stock.

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@earendil-works/pi-tui";

export const MAX_RESULTS = 20;

const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

export function toDisplayPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function findLastDelimiter(text: string): number {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (PATH_DELIMITERS.has(text[i] ?? "")) return i;
  }
  return -1;
}

function findUnclosedQuoteStart(text: string): number | null {
  let inQuotes = false;
  let quoteStart = -1;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '"') {
      inQuotes = !inQuotes;
      if (inQuotes) quoteStart = i;
    }
  }
  return inQuotes ? quoteStart : null;
}

function isTokenStart(text: string, index: number): boolean {
  return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? "");
}

export function extractAtPrefix(text: string): string | null {
  const quoteStart = findUnclosedQuoteStart(text);
  if (quoteStart !== null && quoteStart > 0 && text[quoteStart - 1] === "@") {
    if (!isTokenStart(text, quoteStart - 1)) return null;
    return text.slice(quoteStart - 1);
  }
  const lastDelimiterIndex = findLastDelimiter(text);
  const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;
  if (text[tokenStart] === "@") return text.slice(tokenStart);
  return null;
}

export function parseAtPrefix(prefix: string): { raw: string; quoted: boolean } {
  if (prefix.startsWith('@"')) return { raw: prefix.slice(2), quoted: true };
  if (prefix.startsWith("@")) return { raw: prefix.slice(1), quoted: false };
  return { raw: prefix, quoted: false };
}

export function isScopedAtQuery(raw: string): boolean {
  return toDisplayPath(raw).includes("/");
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

function resolveBaseDir(displayBase: string, cwd: string): string {
  const expanded = expandHome(displayBase);
  const native = expanded.replaceAll("/", sep);
  if (isAbsolute(native) || isAbsolute(expanded)) return resolve(native);
  return resolve(cwd, native);
}

function buildCompletionValue(path: string, quoted: boolean): string {
  const needsQuotes = quoted || path.includes(" ");
  return needsQuotes ? `@"${path}"` : `@${path}`;
}

function scoreName(name: string, query: string, isDirectory: boolean): number {
  if (!query) return isDirectory ? 2 : 1;
  const lowerName = name.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let score = 0;
  if (lowerName === lowerQuery) score = 100;
  else if (lowerName.startsWith(lowerQuery)) score = 80;
  else if (lowerName.includes(lowerQuery)) score = 50;
  else return 0;
  if (isDirectory) score += 10;
  return score;
}

export interface ScopedListing {
  directoryExists: boolean;
  items: AutocompleteItem[];
}

export function listScopedAtItems(
  rawQuery: string,
  cwd: string,
  quoted: boolean,
): ScopedListing {
  const normalized = toDisplayPath(rawQuery);
  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex === -1) return { directoryExists: false, items: [] };

  const displayBase = normalized.slice(0, slashIndex + 1);
  const query = normalized.slice(slashIndex + 1);
  const baseDir = resolveBaseDir(displayBase, cwd);

  try {
    if (!statSync(baseDir).isDirectory()) {
      return { directoryExists: false, items: [] };
    }
  } catch {
    return { directoryExists: false, items: [] };
  }

  let entries;
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return { directoryExists: true, items: [] };
  }

  const scored: Array<{
    item: AutocompleteItem;
    score: number;
    isDirectory: boolean;
    name: string;
  }> = [];

  for (const entry of entries) {
    if (entry.name === "." || entry.name === "..") continue;

    let isDirectory = entry.isDirectory();
    if (!isDirectory && entry.isSymbolicLink()) {
      try {
        isDirectory = statSync(join(baseDir, entry.name)).isDirectory();
      } catch {
        isDirectory = false;
      }
    }

    const score = scoreName(entry.name, query, isDirectory);
    if (query && score <= 0) continue;

    const displayPath = `${toDisplayPath(displayBase)}${entry.name}${isDirectory ? "/" : ""}`;
    scored.push({
      item: {
        value: buildCompletionValue(displayPath, quoted),
        label: `${entry.name}${isDirectory ? "/" : ""}`,
        description: displayPath,
      },
      score,
      isDirectory,
      name: entry.name,
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    directoryExists: true,
    items: scored.slice(0, MAX_RESULTS).map((entry) => entry.item),
  };
}

export function createAtPathProvider(
  current: AutocompleteProvider,
  getCwd: () => string,
): AutocompleteProvider {
  return {
    triggerCharacters: current.triggerCharacters,
    shouldTriggerFileCompletion: current.shouldTriggerFileCompletion?.bind(current),
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const currentLine = lines[cursorLine] || "";
      const prefix = extractAtPrefix(currentLine.slice(0, cursorCol));
      if (prefix && !options.signal.aborted) {
        const { raw, quoted } = parseAtPrefix(prefix);
        if (isScopedAtQuery(raw)) {
          const listed = listScopedAtItems(raw, getCwd(), quoted);
          if (listed.directoryExists) {
            if (listed.items.length === 0 || options.signal.aborted) return null;
            return { items: listed.items, prefix } satisfies AutocompleteSuggestions;
          }
        }
      }
      return current.getSuggestions(lines, cursorLine, cursorCol, options);
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
  };
}

function registerOverlay(ctx: ExtensionContext, getCwd: () => string): void {
  if (typeof ctx.ui.addAutocompleteProvider !== "function") return;
  ctx.ui.addAutocompleteProvider((current) => createAtPathProvider(current, getCwd));
}

export default function (pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT === "1") return;

  let activeCwd = process.cwd();

  pi.on("session_start", (_event, ctx) => {
    activeCwd = ctx.cwd;
  });

  // FFF wraps @ on session_start. Registering here, after that wrap,
  // makes the filesystem listing the outer provider for scoped paths.
  pi.on("resources_discover", (event, ctx) => {
    activeCwd = event.cwd || ctx.cwd;
    registerOverlay(ctx, () => activeCwd);
    return undefined;
  });
}

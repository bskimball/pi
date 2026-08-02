// web-search-ui: Apex tool receipts for the local web_search / fetch_content /
// get_search_content tools.
//
// Presentation only: web-specific specs + secret scrub + formatters. The
// generic receipt chrome lives in tool-receipt.ts (toolRenderers).

import {
  boundedOutput,
  toolRenderers,
  type ToolSpec,
  type ToolRenderState,
} from "./tool-receipt.ts";
import { cleanInline, formatTokens } from "./ui-common.ts";

export type { ToolRenderState as WebToolRenderState };
export type WebToolSpec<TArgs> = ToolSpec<TArgs>;
export { toolRenderers, toolRenderers as webToolRenderers };

const PREVIEW_LINES = 4;
const PREVIEW_CHARS = 1200;
const BODY_LINES = 80;

/* ------------------------------------------------------------------ */
/* Secret hygiene                                                      */
/* ------------------------------------------------------------------ */

/**
 * Defensive scrub for anything key-shaped that reaches a renderer. The tools
 * already redact on the error path; this guarantees the UI can never print a
 * credential even if an upstream body echoes one back. Only ever called on
 * text that has already been length-bounded.
 */
export function scrubSecrets(text: string): string {
  let result = text;
  const live = process.env.EXA_API_KEY?.trim();
  if (live && live.length >= 8) result = result.split(live).join("[REDACTED]");
  // Order matters: scrub Authorization/Bearer as one token first so the generic
  // key=value pass cannot leave the credential after a bare "Bearer".
  return result
    .replace(/\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/gi, "Bearer [REDACTED]")
    .replace(
      /(authorization)(\s*[:=]\s*)(?:Bearer\s+)?\S+/gi,
      "$1$2[REDACTED]",
    )
    .replace(
      /(["']?(?:x-api-key|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)([^\s,"'}]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /([?&](?:api[_-]?key|access_token|token|key|auth|signature|sig)=)[^&\s]+/gi,
      "$1[REDACTED]",
    );
}

/* ------------------------------------------------------------------ */
/* Shared formatting                                                   */
/* ------------------------------------------------------------------ */

function details(result: any): Record<string, unknown> {
  return result?.details && typeof result.details === "object"
    ? (result.details as Record<string, unknown>)
    : {};
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function plural(count: number, word: string, plural = `${word}s`): string {
  return `${count} ${count === 1 ? word : plural}`;
}

/** Host-first URL shortening: identity lives in the host, not the query string. */
export function shortUrl(raw: string, max = 48): string {
  const value = cleanInline(raw, 400);
  if (!value) return "";
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    return cleanInline(value, max);
  }
  const host = url.hostname.replace(/^www\./, "");
  if (host.length >= max) return cleanInline(host, max);
  const tail = `${url.pathname === "/" ? "" : url.pathname}${url.search}`;
  if (!tail) return host;
  const room = max - host.length;
  return tail.length <= room
    ? `${host}${tail}`
    : `${host}${tail.slice(0, Math.max(0, room - 1))}\u2026`;
}

export function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    return cleanInline(raw, 40);
  }
}

/** Keep the readable prefix of a responseId plus a short tail for disambiguation. */
export function shortId(raw: string, max = 16): string {
  const value = cleanInline(raw, 80);
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(4, max - 4))}\u2026`;
}

/** Drop the machine-facing responseId/instruction footer from displayed text. */
function stripSearchFooter(output: string): string {
  const index = output.lastIndexOf("\nresponseId:");
  return index >= 0 ? output.slice(0, index) : output;
}

/** Drop only the "use get_search_content..." instruction, keeping responseId. */
function stripInstructions(output: string): string {
  return output
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/^(Use get_search_content|Content is truncated;)/i.test(line.trim()),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function withScrub<TArgs>(spec: ToolSpec<TArgs>): ToolSpec<TArgs> {
  return { ...spec, scrub: scrubSecrets, bodyLines: BODY_LINES };
}

/* ------------------------------------------------------------------ */
/* web_search                                                          */
/* ------------------------------------------------------------------ */

interface SearchArgs {
  query?: string;
  queries?: string[];
  numResults?: number;
  recencyFilter?: string;
  domainFilter?: string[];
}

function searchQueries(args: SearchArgs): string[] {
  return [
    ...(args?.query?.trim() ? [args.query.trim()] : []),
    ...(Array.isArray(args?.queries) ? args.queries : [])
      .map((query) => String(query ?? "").trim())
      .filter(Boolean),
  ];
}

function quoted(text: string, max: number): string {
  const inner = cleanInline(text, Math.max(4, max - 2));
  return inner ? `"${inner}"` : "";
}

export const webSearchSpec: ToolSpec<SearchArgs> = withScrub({
  title: "web_search",
  arg(args, budget) {
    const queries = searchQueries(args);
    if (!queries.length) return "";
    if (queries.length === 1) return quoted(queries[0], budget);
    const label = plural(queries.length, "query", "queries");
    const room = budget - label.length - 1;
    const first = room > 6 ? quoted(queries[0], room) : "";
    return first ? `${label} ${first}` : label;
  },
  stats(result, args) {
    const info = details(result);
    const queryCount = num(info.queryCount) ?? searchQueries(args).length;
    const resultCount = num(info.resultCount);
    if (resultCount === undefined) {
      return queryCount > 1 ? plural(queryCount, "query", "queries") : "";
    }
    return queryCount > 1
      ? `${queryCount} queries \u00b7 ${plural(resultCount, "result")}`
      : plural(resultCount, "result");
  },
  preview(output) {
    const lines = stripSearchFooter(output)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(
        (line) => line && line !== "Exa search results:" && line !== "---",
      );
    const preview: string[] = [];
    for (
      let index = 0;
      index < lines.length && preview.length < PREVIEW_LINES;
      index++
    ) {
      const line = lines[index];
      if (/^Query:/.test(line)) {
        preview.push(line);
        continue;
      }
      const numbered = line.match(/^(\d+)\.\s*(.*)$/);
      if (!numbered) continue;
      // Exa emits "N. Title" then the bare URL on the next line; fold them into
      // one row so the preview stays inside its line budget.
      const next = lines[index + 1] ?? "";
      const url = /^https?:\/\//i.test(next) ? shortUrl(next, 60) : "";
      preview.push(
        url
          ? `${numbered[1]}. ${numbered[2]} \u2014 ${url}`
          : `${numbered[1]}. ${numbered[2]}`,
      );
      if (url) index++;
    }
    return preview.length
      ? preview
      : boundedOutput(stripSearchFooter(output), 3, PREVIEW_CHARS);
  },
  body(output) {
    return boundedOutput(stripInstructions(output), BODY_LINES);
  },
});

/* ------------------------------------------------------------------ */
/* fetch_content                                                       */
/* ------------------------------------------------------------------ */

interface FetchArgs {
  url?: string;
  urls?: string[];
}

function fetchUrls(args: FetchArgs): string[] {
  return [
    ...(args?.url?.trim() ? [args.url.trim()] : []),
    ...(Array.isArray(args?.urls) ? args.urls : [])
      .map((url) => String(url ?? "").trim())
      .filter(Boolean),
  ];
}

export const fetchContentSpec: ToolSpec<FetchArgs> = withScrub({
  title: "fetch_content",
  arg(args, budget) {
    const urls = fetchUrls(args);
    if (!urls.length) return "";
    if (urls.length === 1) return shortUrl(urls[0], budget);
    const label = plural(urls.length, "url");
    const room = budget - label.length - 1;
    const first = room > 6 ? hostOf(urls[0]) : "";
    return first ? `${label} ${cleanInline(first, room)}` : label;
  },
  stats(result) {
    const info = details(result);
    const pages = num(info.urlCount);
    const chars = num(info.contentLength);
    const parts: string[] = [];
    if (pages !== undefined && pages > 1) parts.push(plural(pages, "page"));
    if (chars !== undefined) parts.push(`${formatTokens(chars)} chars`);
    return parts.join(" \u00b7 ");
  },
  preview(output) {
    return stripSearchFooter(output)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 3);
  },
  body(output) {
    return boundedOutput(stripInstructions(output), BODY_LINES);
  },
});

/* ------------------------------------------------------------------ */
/* get_search_content                                                  */
/* ------------------------------------------------------------------ */

interface SliceArgs {
  responseId?: string;
  query?: string;
  queryIndex?: number;
  url?: string;
  urlIndex?: number;
  offset?: number;
  limit?: number;
}

export const getSearchContentSpec: ToolSpec<SliceArgs> = withScrub({
  title: "get_search_content",
  arg(args, budget) {
    const parts: string[] = [];
    const id = str(args?.responseId);
    if (id) parts.push(shortId(id, 16));
    const urlIndex = num(args?.urlIndex);
    const queryIndex = num(args?.queryIndex);
    if (urlIndex !== undefined) parts.push(`url#${urlIndex}`);
    else if (queryIndex !== undefined) parts.push(`q#${queryIndex}`);
    else if (str(args?.query)) parts.push(quoted(String(args.query), 28));
    else if (str(args?.url)) parts.push(hostOf(String(args.url)));
    return cleanInline(parts.join(" "), Math.max(8, budget));
  },
  stats(result) {
    const info = details(result);
    const offset = num(info.offset);
    const returned = num(info.returnedChars);
    const total = num(info.contentLength);
    if (offset === undefined || returned === undefined) return "";
    const end = offset + returned;
    const span = `${formatTokens(offset)}\u2013${formatTokens(end)}`;
    return total === undefined ? span : `${span}/${formatTokens(total)}`;
  },
  preview(output) {
    return boundedOutput(output, 3, PREVIEW_CHARS);
  },
});

// web-search-receipt: Apex chrome for the headless web-search tools.
//
// web-search.ts owns execute and the in-memory result store; Apex cannot
// import that extension. First registration wins the whole tool, so this
// skins receipts through the shared headless wrap.
//
// PI_APEX_UI=0 skips the wrap. Any existing presentation wins.

import { boundedOutput, toolRenderers } from "./tool-receipt.ts";
import { cleanInline } from "./ui-common.ts";
import { apexPresentationEnabled } from "./presentation.ts";
import {
  installHeadlessReceipts,
  registerHeadlessReceipt,
} from "./headless-receipts.ts";

type WebSearchArgs = {
  query?: string;
  queries?: string[];
  numResults?: number;
  includeContent?: boolean;
  recencyFilter?: string;
  domainFilter?: string[];
};

type FetchArgs = {
  url?: string;
  urls?: string[];
};

type GetContentArgs = {
  responseId?: string;
  query?: string;
  queryIndex?: number;
  url?: string;
  urlIndex?: number;
  offset?: number;
  limit?: number;
};

function firstLine(values: Array<string | undefined>, fallback = ""): string {
  for (const value of values) {
    const clean = cleanInline(value, 160);
    if (clean) return clean;
  }
  return fallback;
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function detailsOf(result: any): Record<string, unknown> {
  return result?.details && typeof result.details === "object"
    ? (result.details as Record<string, unknown>)
    : {};
}

/** Compact header: query text plus optional recency / domain / count extras. */
export function webSearchReceiptArg(
  args: WebSearchArgs | undefined,
  budget: number,
): string {
  const queries = [
    args?.query,
    ...(Array.isArray(args?.queries) ? args.queries : []),
  ]
    .map((value) => cleanInline(value, 120))
    .filter(Boolean);
  const extras: string[] = [];
  if (queries.length > 1) extras.push(`${queries.length} queries`);
  const recency = cleanInline(args?.recencyFilter, 16);
  if (recency) extras.push(recency);
  if (args?.includeContent) extras.push("content");
  const domains = Array.isArray(args?.domainFilter)
    ? args.domainFilter.filter(Boolean).length
    : 0;
  if (domains) extras.push(`${domains} domains`);
  const num = finiteNumber(args?.numResults);
  if (num !== undefined) extras.push(`${num}`);
  return cleanInline(
    [queries[0] ?? "search", extras.join(" ")].filter(Boolean).join(" "),
    Math.max(8, budget),
  );
}

export function fetchContentReceiptArg(
  args: FetchArgs | undefined,
  budget: number,
): string {
  const urls = [
    args?.url,
    ...(Array.isArray(args?.urls) ? args.urls : []),
  ]
    .map((value) => cleanInline(value, 160))
    .filter(Boolean);
  if (!urls.length) return "fetch";
  if (urls.length === 1) {
    return cleanInline(urls[0], Math.max(8, budget));
  }
  const host = hostOf(urls[0]);
  return cleanInline(
    `${host || urls[0]} +${urls.length - 1}`,
    Math.max(8, budget),
  );
}

export function getSearchContentReceiptArg(
  args: GetContentArgs | undefined,
  budget: number,
): string {
  const id = cleanInline(args?.responseId, 40);
  const selector = firstLine(
    [
      args?.query,
      args?.url,
      args?.queryIndex !== undefined ? `q${args.queryIndex}` : undefined,
      args?.urlIndex !== undefined ? `u${args.urlIndex}` : undefined,
    ],
    "",
  );
  const extras: string[] = [];
  const offset = finiteNumber(args?.offset);
  if (offset) extras.push(`@${offset}`);
  const limit = finiteNumber(args?.limit);
  if (limit !== undefined) extras.push(`${limit}`);
  return cleanInline(
    [id || "content", selector, extras.join(" ")].filter(Boolean).join(" "),
    Math.max(8, budget),
  );
}

export const webSearchReceiptRenderers = toolRenderers<WebSearchArgs>({
  surface: "web_search",
  title: "web_search",
  arg: webSearchReceiptArg,
  stats(result) {
    const details = detailsOf(result);
    const results = finiteNumber(details.resultCount);
    const queries = finiteNumber(details.queryCount);
    const parts: string[] = [];
    if (results !== undefined) {
      parts.push(`${results} result${results === 1 ? "" : "s"}`);
    }
    if (queries !== undefined && queries > 1) {
      parts.push(`${queries} queries`);
    }
    return parts.join(" · ");
  },
  preview(output) {
    return output ? boundedOutput(output, 4, 1200) : [];
  },
  body(output) {
    return output ? boundedOutput(output, 80) : [];
  },
});

export const fetchContentReceiptRenderers = toolRenderers<FetchArgs>({
  surface: "fetch_content",
  title: "fetch_content",
  arg: fetchContentReceiptArg,
  stats(result) {
    const details = detailsOf(result);
    const urls = finiteNumber(details.urlCount);
    const host = cleanInline(details.host, 40);
    const length = finiteNumber(details.contentLength);
    const parts: string[] = [];
    if (urls !== undefined && urls > 1) parts.push(`${urls} pages`);
    else if (host) parts.push(host);
    if (length !== undefined) parts.push(`${length} chars`);
    return parts.join(" · ");
  },
  preview(output) {
    return output ? boundedOutput(output, 4, 1200) : [];
  },
  body(output) {
    return output ? boundedOutput(output, 80) : [];
  },
});

export const getSearchContentReceiptRenderers = toolRenderers<GetContentArgs>({
  surface: "get_search_content",
  title: "get_search_content",
  arg: getSearchContentReceiptArg,
  stats(result) {
    const details = detailsOf(result);
    const returned = finiteNumber(details.returnedChars);
    const parts: string[] = [];
    if (returned !== undefined) parts.push(`${returned} chars`);
    if (details.truncated) parts.push("truncated");
    return parts.join(" · ");
  },
  preview(output) {
    return output ? boundedOutput(output, 4, 1200) : [];
  },
  body(output) {
    return output ? boundedOutput(output, 80) : [];
  },
});

/** Attach Apex receipts to the three headless web-search tools. */
export function installWebSearchReceipts(): void {
  if (!apexPresentationEnabled()) return;
  registerHeadlessReceipt("web_search", webSearchReceiptRenderers);
  registerHeadlessReceipt("fetch_content", fetchContentReceiptRenderers);
  registerHeadlessReceipt("get_search_content", getSearchContentReceiptRenderers);
  installHeadlessReceipts();
}

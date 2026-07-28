// Local Exa-only web search and plain HTTP content retrieval.
// Credentials are resolved at runtime and are never logged or persisted.

import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const EXA_SEARCH_URL = "https://api.exa.ai/search";
const REQUEST_TIMEOUT_MS = 60_000;
const STORE_TTL_MS = 60 * 60 * 1000;
const INLINE_LIMIT = 30_000;
const MAX_RESULTS = 20;
const MAX_OUTPUT = 60_000;

type SearchResult = { title: string; url: string; text: string };
type StoredResponse =
  | { kind: "search"; createdAt: number; queries: { query: string; results: SearchResult[] }[] }
  | { kind: "fetch"; createdAt: number; pages: { url: string; title: string; content: string }[] };

function textResult(text: string, details: Record<string, unknown> = {}, isError = false) {
  return { content: [{ type: "text" as const, text }], details, isError };
}

function bound(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated]`;
}

function redact(value: string, key?: string): string {
  let result = String(value ?? "");
  if (key) result = result.split(key).join("[REDACTED]");
  return result.replace(/x-api-key\s*[:=]\s*[^\s,;]+/gi, "x-api-key=[REDACTED]");
}

function configPath(): string {
  // Match the prior extension's config path: PI_CODING_AGENT_DIR, then XDG config, then ~/.pi.
  const root = process.env.PI_CODING_AGENT_DIR?.trim()
    || (process.env.XDG_CONFIG_HOME?.trim() ? join(process.env.XDG_CONFIG_HOME, "pi") : join(homedir(), ".pi"));
  return join(root, "web-search.json");
}

function expandEnv(value: string): string {
  const match = value.trim().match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/);
  if (!match) return value.trim();
  return process.env[match[1] || match[2] || ""]?.trim() || "";
}

function exaApiKey(): string | undefined {
  const environment = process.env.EXA_API_KEY?.trim();
  if (environment) return environment;
  try {
    const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as { exaApiKey?: unknown };
    return typeof parsed.exaApiKey === "string" ? expandEnv(parsed.exaApiKey) || undefined : undefined;
  } catch {
    return undefined;
  }
}

function requireKey(): { key: string } | { error: string } {
  const key = exaApiKey();
  return key
    ? { key }
    : { error: "Exa API key is required. Set EXA_API_KEY or add exaApiKey to web-search.json." };
}

function withTimeout(signal: AbortSignal | undefined): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Request timed out after 60 seconds.")), REQUEST_TIMEOUT_MS);
  return {
    signal: controller.signal,
    dispose: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); },
  };
}

async function request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  const timed = withTimeout(signal);
  try {
    return await fetch(url, { ...init, signal: timed.signal });
  } finally {
    timed.dispose();
  }
}

function validHttpUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal") return true;
  if (/^127\./.test(host) || /^0\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  const match = host.match(/^172\.(\d{1,3})\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
  return false;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code: string) => {
      const point = code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : parseInt(code, 10);
      return Number.isFinite(point) ? String.fromCodePoint(point) : "";
    });
}

function htmlToText(html: string): { title: string; content: string } {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = decodeHtml(titleMatch?.[1] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const content = decodeHtml(html
    .replace(/<\s*(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/\s*(p|div|h[1-6]|li|tr|article|section|main)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
  return { title, content };
}

async function publicHostname(hostname: string): Promise<boolean> {
  if (privateHost(hostname)) return false;
  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every((address) => !privateHost(address.address));
  } catch {
    // Let fetch report ordinary public DNS failures without treating them as SSRF.
    return true;
  }
}

async function fetchPage(rawUrl: string, signal?: AbortSignal): Promise<{ url: string; title: string; content: string }> {
  let url = validHttpUrl(rawUrl);
  if (!url) throw new Error("Only valid http(s) URLs are supported.");
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (!(await publicHostname(url.hostname))) throw new Error("URL targets a localhost, private, link-local, or metadata address.");
    const response = await request(url.toString(), { redirect: "manual", headers: { accept: "text/html, text/plain;q=0.9, */*;q=0.1" } }, signal);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect from ${url.toString()} has no location.`);
      url = validHttpUrl(new URL(location, url).toString());
      if (!url) throw new Error("Redirect target is not an http(s) URL.");
      continue;
    }
    if (!response.ok) throw new Error(`Fetch failed with HTTP ${response.status}.`);
    const raw = await response.text();
    const type = response.headers.get("content-type") || "";
    const parsed = /html|xml/i.test(type) ? htmlToText(raw) : { title: "", content: raw.replace(/\u0000/g, "").trim() };
    return { url: url.toString(), title: parsed.title || url.hostname, content: parsed.content || "(No readable text found.)" };
  }
  throw new Error("Too many redirects (maximum 5).");
}

function recencyStart(filter: string | undefined): string | undefined {
  const days = filter === "day" ? 1 : filter === "week" ? 7 : filter === "month" ? 31 : filter === "year" ? 365 : undefined;
  return days ? new Date(Date.now() - days * 86_400_000).toISOString() : undefined;
}

export default function (pi: ExtensionAPI): void {
  const store = new Map<string, StoredResponse>();
  const save = (entry: StoredResponse): string => {
    const now = Date.now();
    for (const [id, value] of store) if (now - value.createdAt > STORE_TTL_MS) store.delete(id);
    const id = `exa_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    store.set(id, entry);
    return id;
  };

  pi.registerTool({
    name: "web_search", label: "Web Search",
    description: "Search the web with Exa. Supports one query or multiple queries, result limits, content inclusion, recency, and domain filters.",
    parameters: Type.Object({
      query: Type.Optional(Type.String()), queries: Type.Optional(Type.Array(Type.String())),
      numResults: Type.Optional(Type.Number()), includeContent: Type.Optional(Type.Boolean()),
      recencyFilter: Type.Optional(Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")])),
      domainFilter: Type.Optional(Type.Array(Type.String())), provider: Type.Optional(Type.String()), workflow: Type.Optional(Type.String()),
    }), executionMode: "parallel",
    async execute(_id, params, signal) {
      const credential = requireKey();
      if ("error" in credential) return textResult(credential.error, {}, true);
      if (params.provider && !["exa", "auto"].includes(params.provider.toLowerCase())) return textResult(`Unsupported provider "${params.provider}". This local tool supports Exa only.`, {}, true);
      const queries = [...(params.query?.trim() ? [params.query.trim()] : []), ...(params.queries ?? []).map((q) => q.trim()).filter(Boolean)];
      if (!queries.length) return textResult("query or queries is required.", {}, true);
      const numResults = Math.min(MAX_RESULTS, Math.max(1, Math.floor(params.numResults ?? 5)));
      const domainFilter = params.domainFilter ?? [];
      const includeDomains = domainFilter.filter((domain) => !domain.startsWith("-")).map((domain) => domain.trim()).filter(Boolean);
      const excludeDomains = domainFilter.filter((domain) => domain.startsWith("-")).map((domain) => domain.slice(1).trim()).filter(Boolean);
      try {
        const groups: { query: string; results: SearchResult[] }[] = [];
        for (const query of queries) {
          const body: Record<string, unknown> = { query, numResults };
          if (params.includeContent) body.contents = { text: true };
          if (includeDomains.length) body.includeDomains = includeDomains;
          if (excludeDomains.length) body.excludeDomains = excludeDomains;
          const startPublishedDate = recencyStart(params.recencyFilter);
          if (startPublishedDate) body.startPublishedDate = startPublishedDate;
          const response = await request(EXA_SEARCH_URL, { method: "POST", headers: { "content-type": "application/json", "x-api-key": credential.key }, body: JSON.stringify(body) }, signal);
          if (!response.ok) throw new Error(`Exa search failed with HTTP ${response.status}: ${bound(await response.text(), 500)}`);
          const payload = await response.json() as { results?: Array<{ title?: string; url?: string; text?: string }> };
          groups.push({ query, results: (payload.results ?? []).map((item) => ({ title: item.title?.trim() || "Untitled", url: item.url?.trim() || "", text: item.text?.trim() || "" })) });
        }
        const responseId = save({ kind: "search", createdAt: Date.now(), queries: groups });
        const output = groups.map((group) => [
          `Query: ${group.query}`, "Exa search results:",
          ...(group.results.length ? group.results.map((result, index) => `${index + 1}. ${result.title}\n${result.url}${params.includeContent && result.text ? `\n${bound(result.text, 3_000)}` : ""}`) : ["No results found."]),
        ].join("\n\n")).join("\n\n---\n\n");
        return textResult(bound(`${output}\n\nresponseId: ${responseId}\nUse get_search_content with this responseId for stored result content.`, MAX_OUTPUT), { responseId, provider: "exa", queryCount: groups.length, numResults });
      } catch (error) {
        return textResult(`Exa search error: ${redact(error instanceof Error ? error.message : String(error), credential.key)}`, {}, true);
      }
    },
  });

  pi.registerTool({
    name: "fetch_content", label: "Fetch Content",
    description: "Fetch readable text from one or more public HTTP(S) pages. Stores complete fetched content temporarily for get_search_content.",
    parameters: Type.Object({
      url: Type.Optional(Type.String()), urls: Type.Optional(Type.Array(Type.String())), forceClone: Type.Optional(Type.Boolean()), prompt: Type.Optional(Type.String()), timestamp: Type.Optional(Type.String()), frames: Type.Optional(Type.Boolean()), model: Type.Optional(Type.String()),
    }), executionMode: "parallel",
    async execute(_id, params, signal) {
      const urls = [...(params.url?.trim() ? [params.url.trim()] : []), ...(params.urls ?? []).map((url) => url.trim()).filter(Boolean)];
      if (!urls.length) return textResult("url or urls is required.", {}, true);
      if (params.forceClone || params.frames || params.prompt || params.timestamp || params.model) return textResult("Video, GitHub-clone, frame, prompt, timestamp, and model extraction modes are unsupported. Provide plain public HTTP(S) URL(s).", {}, true);
      try {
        const pages = [];
        for (const url of urls) pages.push(await fetchPage(url, signal));
        const responseId = save({ kind: "fetch", createdAt: Date.now(), pages });
        if (pages.length === 1) {
          const page = pages[0]; const preview = bound(page.content, INLINE_LIMIT);
          return textResult(`# ${page.title}\nSource: ${page.url}\n\n${preview}\n\nresponseId: ${responseId}${preview.length < page.content.length ? "\nContent is truncated; use get_search_content with this responseId and offset." : ""}`, { responseId, provider: "local", contentLength: page.content.length });
        }
        return textResult(`Fetched ${pages.length} pages.\n${pages.map((page, index) => `${index + 1}. ${page.title} — ${page.url} (${page.content.length} chars)`).join("\n")}\n\nresponseId: ${responseId}\nUse get_search_content with this responseId and urlIndex to retrieve page text.`, { responseId, provider: "local", urlCount: pages.length });
      } catch (error) {
        return textResult(`Fetch error: ${redact(error instanceof Error ? error.message : String(error))}`, {}, true);
      }
    },
  });

  pi.registerTool({
    name: "get_search_content", label: "Get Search Content",
    description: "Retrieve a bounded slice of content stored by web_search or fetch_content using its responseId.",
    parameters: Type.Object({
      responseId: Type.String(), query: Type.Optional(Type.String()), queryIndex: Type.Optional(Type.Number()), url: Type.Optional(Type.String()), urlIndex: Type.Optional(Type.Number()), offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()),
    }), executionMode: "parallel",
    async execute(_id, params) {
      const entry = store.get(params.responseId);
      if (!entry || Date.now() - entry.createdAt > STORE_TTL_MS) { store.delete(params.responseId); return textResult("Unknown or expired responseId. Search and fetch content is retained in memory for about one hour.", {}, true); }
      const index = Math.max(0, Math.floor(entry.kind === "search" ? (params.queryIndex ?? (params.query ? entry.queries.findIndex((item) => item.query === params.query) : 0)) : (params.urlIndex ?? (params.url ? entry.pages.findIndex((item) => item.url === params.url) : 0))));
      let content: string;
      if (entry.kind === "search") {
        const group = entry.queries[index];
        if (!group) return textResult("queryIndex/query does not identify a stored search result.", {}, true);
        content = `Query: ${group.query}\n\n${group.results.map((result, resultIndex) => `${resultIndex + 1}. ${result.title}\n${result.url}\n\n${result.text || "(No content was requested for this result.)"}`).join("\n\n---\n\n")}`;
      } else {
        const page = entry.pages[index];
        if (!page) return textResult("urlIndex/url does not identify a stored fetched page.", {}, true);
        content = `# ${page.title}\nSource: ${page.url}\n\n${page.content}`;
      }
      const offset = Math.min(content.length, Math.max(0, Math.floor(params.offset ?? 0)));
      const limit = Math.min(INLINE_LIMIT, Math.max(1, Math.floor(params.limit ?? INLINE_LIMIT)));
      const slice = content.slice(offset, offset + limit);
      const nextOffset = offset + slice.length;
      return textResult(slice || "(No content at this offset.)", { responseId: params.responseId, contentLength: content.length, offset, limit, returnedChars: slice.length, nextOffset: nextOffset < content.length ? nextOffset : null, truncated: nextOffset < content.length });
    },
  });
}

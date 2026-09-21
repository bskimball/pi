// peek-tool-format: Pure argument and result formatters for the sub-agent
// peek overlay transcript replay. Correlates toolCall and toolResult records
// so tool lines display the same detailed substance as main-thread receipts.

import {
  bgKillReceiptArg,
  bgListReceiptArg,
  bgStartReceiptArg,
  bgStatusReceiptArg,
} from "../presentation/bg-process-receipt.ts";
import { browserAttachReceiptArg } from "../presentation/browser-attach-receipt.ts";
import {
  builtinGrepReceiptArg,
  builtinLsReceiptArg,
  builtinPathArg,
} from "../presentation/builtin-receipts.ts";
import {
  fffindReceiptArg,
  ffgrepReceiptArg,
} from "../presentation/fff-receipt.ts";
import { graphifyReceiptArg } from "../presentation/graphify-receipt.ts";
import { getHeadlessReceiptState } from "../presentation/headless-receipts.ts";
import {
  contactSupervisorReceiptArg,
  intercomReceiptArg,
} from "../presentation/intercom-receipt.ts";
import { jevReceiptArg } from "../presentation/jev-receipt.ts";
import { lspReceiptArg } from "../presentation/lsp-receipt.ts";
import {
  mcpReceiptArg,
  mcpScriptReceiptArg,
} from "../presentation/mcp-receipt.ts";
import {
  memoryListReceiptArg,
  memoryWriteReceiptArg,
} from "../presentation/memory-receipt.ts";
import { powershellReceiptArg } from "../presentation/powershell-receipt.ts";
import { safeTruncateToWidth } from "../presentation/safe-text-layout.ts";
import { cleanInline } from "../presentation/ui-common.ts";
import {
  fetchContentReceiptArg,
  getSearchContentReceiptArg,
  webSearchReceiptArg,
} from "../presentation/web-search-receipt.ts";

export interface CorrelatedToolCall {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

function formatCharCount(chars: number): string {
  if (chars >= 1_000) {
    const k = (chars / 1_000).toFixed(1).replace(/\.0$/, "");
    return `${k}k chars`;
  }
  return `${chars} chars`;
}

function finiteNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Format pure tool arguments with budget, using registered receipts or heuristics. */
export function formatToolArg(
  toolName: string,
  args: Record<string, unknown> | undefined,
  budget: number,
): string {
  if (!args || typeof args !== "object") return "";
  const safeBudget = Math.max(8, budget);

  // Check process-wide registry if a custom spec registered an arg formatter
  try {
    const state = getHeadlessReceiptState();
    const registered = state.registry.get(toolName) as { spec?: { arg?: (a: unknown, b: number) => string } } | undefined;
    if (typeof registered?.spec?.arg === "function") {
      const formatted = cleanInline(registered.spec.arg(args, safeBudget), safeBudget);
      if (formatted) return formatted;
    }
  } catch {
    // Fall through to known formatters
  }

  try {
    switch (toolName) {
      case "read":
      case "edit":
      case "write":
        return builtinPathArg(args as any, safeBudget);
      case "bash":
        return cleanInline(String(args.command ?? ""), safeBudget);
      case "web_search":
        return webSearchReceiptArg(args as any, safeBudget);
      case "fetch_content":
        return fetchContentReceiptArg(args as any, safeBudget);
      case "get_search_content":
        return getSearchContentReceiptArg(args as any, safeBudget);
      case "fffind":
        return fffindReceiptArg(args as any, safeBudget);
      case "ffgrep":
        return ffgrepReceiptArg(args as any, safeBudget);
      case "grep":
        return builtinGrepReceiptArg(args as any, safeBudget);
      case "ls":
        return builtinLsReceiptArg(args as any, safeBudget);
      case "powershell":
        return powershellReceiptArg(args as any, safeBudget);
      case "bg_start":
        return bgStartReceiptArg(args as any, safeBudget);
      case "bg_status":
        return bgStatusReceiptArg(args as any, safeBudget);
      case "bg_list":
        return bgListReceiptArg(args as any, safeBudget);
      case "bg_kill":
        return bgKillReceiptArg(args as any, safeBudget);
      case "intercom":
        return intercomReceiptArg(args as any, safeBudget);
      case "contact_supervisor":
        return contactSupervisorReceiptArg(args as any, safeBudget);
      case "graphify":
        return graphifyReceiptArg(args as any, safeBudget);
      case "browser_attach":
        return browserAttachReceiptArg(args as any, safeBudget);
      case "memory_list":
        return memoryListReceiptArg(args as any, safeBudget);
      case "memory_write":
        return memoryWriteReceiptArg(args as any, safeBudget);
      case "lsp":
        return lspReceiptArg(args as any, safeBudget);
      case "mcp":
        return mcpReceiptArg(args as any, safeBudget);
      case "mcpScript":
        return mcpScriptReceiptArg(args as any, safeBudget);
      case "jev":
        return jevReceiptArg(args as any, safeBudget);
      default:
        break;
    }
  } catch {
    // Best-effort; fall back to generic heuristics on unexpected args shape
  }

  // Generic fallback for custom, unknown, or proxy tools
  try {
    for (const key of ["path", "command", "query", "url", "pattern", "prompt", "task", "tool", "file"]) {
      const val = args[key];
      if (typeof val === "string" && val.trim()) {
        return cleanInline(val, safeBudget);
      }
    }
    const entries = Object.entries(args).filter(
      ([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean",
    );
    if (entries.length === 1 && entries[0]) {
      const [k, v] = entries[0];
      return cleanInline(`${k}: ${v}`, safeBudget);
    }
  } catch {
    return "";
  }
  return "";
}

/** Extract a compact summary string from tool result details or error content. */
export function formatResultSummary(
  _toolName: string,
  details: Record<string, unknown> | undefined,
  content: unknown,
  isError: boolean,
  budget: number,
): string | undefined {
  const safeBudget = Math.max(8, budget);

  if (isError) {
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item && typeof item === "object" && typeof (item as any).text === "string") {
          const firstLine = String((item as any).text).split(/\r?\n/)[0]?.trim();
          if (firstLine) return cleanInline(firstLine, safeBudget);
        }
      }
    } else if (typeof content === "string") {
      const firstLine = content.split(/\r?\n/)[0]?.trim();
      if (firstLine) return cleanInline(firstLine, safeBudget);
    }
    if (details) {
      const err = details.error ?? details.message;
      if (typeof err === "string" && err.trim()) {
        return cleanInline(err, safeBudget);
      }
    }
    return "failed";
  }

  if (!details || typeof details !== "object") return undefined;

  try {
    const parts: string[] = [];

    const resultCount = finiteNum(details.resultCount);
    if (resultCount !== undefined) {
      parts.push(`${resultCount} result${resultCount === 1 ? "" : "s"}`);
    }

    const totalMatched = finiteNum(details.totalMatched);
    if (totalMatched !== undefined) {
      parts.push(`${totalMatched} match${totalMatched === 1 ? "" : "es"}`);
    }

    const urlCount = finiteNum(details.urlCount);
    if (urlCount !== undefined && urlCount > 1) {
      parts.push(`${urlCount} pages`);
    }

    const host = cleanInline(details.host, 30);
    if (host && parts.length === 0) {
      parts.push(host);
    }

    const contentLength = finiteNum(details.contentLength);
    if (contentLength !== undefined) {
      parts.push(formatCharCount(contentLength));
    }

    const returnedChars = finiteNum(details.returnedChars);
    if (returnedChars !== undefined) {
      parts.push(formatCharCount(returnedChars));
    }

    const exitCode = finiteNum(details.exitCode);
    if (exitCode !== undefined) {
      parts.push(`exit ${exitCode}`);
    }

    const added = finiteNum(details.added);
    const removed = finiteNum(details.removed);
    if (added !== undefined && removed !== undefined) {
      parts.push(`+${added} -${removed}`);
    }

    if (details.truncated === true && !parts.includes("truncated")) {
      parts.push("truncated");
    }

    if (!parts.length) {
      const total = finiteNum(details.total ?? details.count);
      if (total !== undefined) parts.push(`${total}`);
    }

    if (parts.length > 0) {
      return safeTruncateToWidth(cleanInline(parts.join(" · "), safeBudget), safeBudget);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Bounded tail read of a worker session file for the session view. */
export const TRANSCRIPT_TAIL_BYTES = 32 * 1024;
export const TRANSCRIPT_TAIL_LINES = 160;

function boundedLength(value: unknown, cap: number): number {
  if (!Array.isArray(value)) return 0;
  return Math.max(0, Math.min(value.length, Math.max(0, Math.trunc(cap))));
}

export function transcriptLine(role: string, text: string): string | undefined {
  if (!text) return undefined;
  const speaker = role === "assistant" ? "worker" : role === "user" ? "lead" : role || "msg";
  return `${cleanInline(speaker, 12)}: ${cleanInline(text, 500)}`;
}

/**
 * Minimal transcript line formatter: role + text, tool calls with arguments
 * and correlated results. Correlates toolCall and toolResult records by id
 * so tool lines display argument substance and execution outcomes.
 */
export function formatTranscriptTail(text: string): string[] {
  const rawLines = text.split("\n");
  // Skip the trailing partial line a live worker may still be writing.
  const complete = text.endsWith("\n") ? rawLines : rawLines.slice(0, -1);
  const parsedEntries: Array<Record<string, unknown>> = [];
  for (const raw of complete) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        parsedEntries.push(parsed as Record<string, unknown>);
      }
    } catch {
      continue;
    }
  }

  // Correlate tool calls and their results by toolCallId across the tail
  const toolResults = new Map<string, {
    toolName: string;
    isError: boolean;
    details?: Record<string, unknown>;
    content?: unknown;
  }>();
  const toolCalls = new Map<string, {
    id: string;
    name: string;
    arguments?: Record<string, unknown>;
  }>();

  for (const entry of parsedEntries) {
    let message: Record<string, unknown> | undefined;
    try {
      const raw = entry.message;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        message = raw as Record<string, unknown>;
      }
    } catch {
      continue;
    }
    if (!message) continue;

    const role = String(message.role ?? "");
    if (role === "toolResult") {
      const toolCallId = String(message.toolCallId ?? "");
      const toolName = String(message.toolName ?? "");
      const isError = Boolean(message.isError);
      const details = message.details && typeof message.details === "object" && !Array.isArray(message.details)
        ? (message.details as Record<string, unknown>)
        : undefined;
      const content = message.content;
      if (toolCallId) {
        toolResults.set(toolCallId, { toolName, isError, details, content });
      }
    } else if (Array.isArray(message.content)) {
      const count = boundedLength(message.content, 32);
      for (let idx = 0; idx < count; idx++) {
        const part = (message.content as unknown[])[idx];
        if (part && typeof part === "object" && !Array.isArray(part)) {
          const p = part as Record<string, unknown>;
          if (p.type === "toolCall") {
            const id = String(p.id ?? "");
            const name = String(p.name ?? "");
            const args = p.arguments && typeof p.arguments === "object" && !Array.isArray(p.arguments)
              ? (p.arguments as Record<string, unknown>)
              : undefined;
            if (id) {
              toolCalls.set(id, { id, name, arguments: args });
            }
          }
        }
      }
    }
  }

  const out: string[] = [];
  for (const entry of parsedEntries) {
    const formatted = formatTranscriptEntry(entry, toolResults, toolCalls);
    if (formatted) out.push(formatted);
  }
  return out.slice(-TRANSCRIPT_TAIL_LINES);
}

export function formatTranscriptEntry(
  entry: Record<string, unknown>,
  toolResults?: Map<string, { toolName: string; isError: boolean; details?: Record<string, unknown>; content?: unknown }>,
  toolCalls?: Map<string, { id: string; name: string; arguments?: Record<string, unknown> }>,
): string | undefined {
  let message: Record<string, unknown> | undefined;
  try {
    const raw = entry.message;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      message = raw as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  if (!message) return undefined;
  const role = (() => {
    try {
      return String(message.role ?? "");
    } catch {
      return "";
    }
  })();
  if (role === "toolResult") {
    // If we have a matching toolCall, that call entry already rendered the tool name/arg/result inline
    // or we can format standalone results when no toolCall was captured in the tail
    const toolCallId = String(message.toolCallId ?? "");
    if (toolCallId && toolCalls?.has(toolCallId)) {
      return undefined; // Handled inline by assistant's toolCall part
    }
    const name = cleanInline((() => {
      try {
        return message.toolName ?? "";
      } catch {
        return "";
      }
    })(), 40);
    if (!name) return undefined;
    const isError = Boolean(message.isError);
    const details = message.details && typeof message.details === "object" && !Array.isArray(message.details)
      ? (message.details as Record<string, unknown>)
      : undefined;
    const summary = formatResultSummary(name, details, message.content, isError, 60);
    const mark = isError ? " \u00d7" : "";
    return `tool ${name}${summary ? ` · ${summary}` : ""}${mark}`;
  }
  const content = (() => {
    try {
      return message.content;
    } catch {
      return undefined;
    }
  })();
  if (typeof content === "string") {
    return transcriptLine(role, cleanInline(content, 120));
  }
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  const count = boundedLength(content, 32);
  for (let index = 0; index < count; index++) {
    let part: Record<string, unknown> | undefined;
    try {
      const raw = (content as unknown[])[index];
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        part = raw as Record<string, unknown>;
      }
    } catch {
      continue;
    }
    if (!part) continue;
    let kind = "";
    try {
      kind = String(part.type ?? "");
    } catch {
      continue;
    }
    if (kind === "text") {
      const text = cleanInline((() => {
        try {
          return part.text ?? "";
        } catch {
          return "";
        }
      })(), 200);
      if (text) parts.push(text);
    } else if (kind === "toolCall") {
      const id = String(part.id ?? "");
      const name = cleanInline((() => {
        try {
          return part.name ?? "";
        } catch {
          return "";
        }
      })(), 40);
      if (name) {
        const args = part.arguments && typeof part.arguments === "object" && !Array.isArray(part.arguments)
          ? (part.arguments as Record<string, unknown>)
          : undefined;
        const argText = formatToolArg(name, args, 50);
        const result = id ? toolResults?.get(id) : undefined;
        let summary = "";
        let errorMark = "";
        if (result) {
          const sum = formatResultSummary(name, result.details, result.content, result.isError, 50);
          if (sum) summary = ` · ${sum}`;
          if (result.isError) errorMark = " \u00d7";
        }
        const callLabel = argText ? `tool ${name} ${argText}` : `tool ${name}`;
        parts.push(`${callLabel}${summary}${errorMark}`);
      }
    }
  }
  if (!parts.length) return undefined;
  return transcriptLine(role, parts.join(" \u00b7 "));
}

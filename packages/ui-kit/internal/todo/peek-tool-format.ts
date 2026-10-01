// peek-tool-format: Pure argument formatter for the agents dock rows and
// worker activity summaries. The peek overlay transcript itself renders
// through Pi components (see peek-transcript.ts).

import {
  bgKillReceiptArg,
  bgListReceiptArg,
  bgStartReceiptArg,
  bgStatusReceiptArg,
} from "../presentation/bg-process-receipt.ts";
import { browserAttachReceiptArg } from "../presentation/browser-attach-receipt.ts";
import {
  builtinFindReceiptArg,
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
  memoryListReceiptArg,
  memoryWriteReceiptArg,
} from "../presentation/memory-receipt.ts";
import { powershellReceiptArg } from "../presentation/powershell-receipt.ts";
import { cleanInline } from "../presentation/ui-common.ts";
import {
  fetchContentReceiptArg,
  getSearchContentReceiptArg,
  webSearchReceiptArg,
} from "../presentation/web-search-receipt.ts";

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
      case "find":
        return builtinFindReceiptArg(args as any, safeBudget);
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


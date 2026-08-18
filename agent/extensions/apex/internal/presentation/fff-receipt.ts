// fff-receipt: Apex chrome for the installed pi-fff tools (fffind and ffgrep).
//
// pi-fff owns execute and registers its own renderCall/renderResult. Apex cannot
// import that extension. This replaces pi-fff presentation with compact Apex
// receipts via the shared headless wrap when Apex presentation is enabled.
//
// PI_APEX_UI=0 skips the wrap or falls back dynamically, leaving pi-fff's own
// presentation intact.

import { apexPresentationEnabled } from "./presentation.ts";
import { boundedOutput, toolRenderers } from "./tool-receipt.ts";
import { cleanInline } from "./ui-common.ts";
import {
  installHeadlessReceipts,
  registerHeadlessReceipt,
} from "./headless-receipts.ts";

export const FFF_FIND_TOOL = "fffind";
export const FFF_GREP_TOOL = "ffgrep";

export type FffindArgs = {
  pattern?: string;
  path?: string;
  exclude?: string | string[];
  limit?: number;
  cursor?: string;
};

export type FfgrepArgs = {
  pattern?: string;
  path?: string;
  exclude?: string | string[];
  caseSensitive?: boolean;
  context?: number;
  limit?: number;
  cursor?: string;
};

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function finiteInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : undefined;
}

function detailsOf(result: any): Record<string, unknown> {
  return result?.details && typeof result.details === "object"
    ? (result.details as Record<string, unknown>)
    : {};
}

function formatExclude(exclude: unknown): string {
  if (Array.isArray(exclude)) {
    const list = exclude
      .map((item) => cleanInline(item, 40))
      .filter(Boolean);
    if (!list.length) return "";
    return `!${list.join(",")}`;
  }
  if (typeof exclude === "string") {
    const cleaned = cleanInline(exclude, 60);
    if (!cleaned) return "";
    return cleaned.startsWith("!") ? cleaned : `!${cleaned}`;
  }
  return "";
}

/**
 * Compact header for filename searches:
 * `pattern [path] [!exclude] [limit N] [continued]`
 */
export function fffindReceiptArg(
  args: FffindArgs | undefined,
  budget: number,
): string {
  const pattern = cleanInline(args?.pattern, 80);
  const path = cleanInline(args?.path, 80).replace(/\\/g, "/");
  const exclude = formatExclude(args?.exclude);

  const extras: string[] = [];
  const limit = finiteInt(args?.limit);
  if (limit !== undefined) extras.push(`limit ${limit}`);
  const cursor = cleanInline(args?.cursor, 40);
  if (cursor) extras.push("continued");

  const parts = [pattern || (path ? "" : "find"), path, exclude, extras.join(" ")].filter(
    Boolean,
  );
  return cleanInline(parts.join(" "), Math.max(8, budget));
}

/**
 * Compact header for content greps:
 * `pattern [path] [case-sensitive] [ctx N] [limit N] [continued] [!exclude]`
 */
export function ffgrepReceiptArg(
  args: FfgrepArgs | undefined,
  budget: number,
): string {
  const pattern = cleanInline(args?.pattern, 80);
  const path = cleanInline(args?.path, 80).replace(/\\/g, "/");
  const exclude = formatExclude(args?.exclude);

  const extras: string[] = [];
  if (args?.caseSensitive === true) extras.push("case-sensitive");
  const context = finiteInt(args?.context);
  if (context !== undefined && context > 0) extras.push(`ctx ${context}`);
  const limit = finiteInt(args?.limit);
  if (limit !== undefined) extras.push(`limit ${limit}`);
  const cursor = cleanInline(args?.cursor, 40);
  if (cursor) extras.push("continued");

  const parts = [pattern || (path ? "" : "grep"), path, extras.join(" "), exclude].filter(
    Boolean,
  );
  return cleanInline(parts.join(" "), Math.max(8, budget));
}

export const fffindReceiptRenderers = toolRenderers<FffindArgs>({
  surface: FFF_FIND_TOOL,
  title: FFF_FIND_TOOL,
  arg: fffindReceiptArg,
  stats(result) {
    const details = detailsOf(result);
    const matched = finiteNumber(details.totalMatched);
    const files = finiteNumber(details.totalFiles);
    const pageIndex = finiteInt(details.pageIndex);
    const hasMore = Boolean(details.hasMore);

    const parts: string[] = [];
    if (matched !== undefined) {
      parts.push(`${matched} match${matched === 1 ? "" : "es"}`);
    }
    if (files !== undefined && files > 0 && files !== matched) {
      parts.push(`${files} indexed`);
    }
    if (pageIndex !== undefined && pageIndex >= 0) {
      parts.push(`page ${pageIndex + 1}`);
    }
    if (hasMore) {
      parts.push("has more");
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

export const ffgrepReceiptRenderers = toolRenderers<FfgrepArgs>({
  surface: FFF_GREP_TOOL,
  title: FFF_GREP_TOOL,
  arg: ffgrepReceiptArg,
  stats(result) {
    const details = detailsOf(result);
    const matched = finiteNumber(details.totalMatched);
    const files = finiteNumber(details.totalFiles);

    const parts: string[] = [];
    if (matched !== undefined) {
      parts.push(`${matched} match${matched === 1 ? "" : "es"}`);
    }
    if (files !== undefined && files > 0) {
      parts.push(`${files} indexed`);
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

/** Attach Apex receipts to pi-fff ToolExecutionComponent instances. */
export function installFffReceipts(): void {
  if (!apexPresentationEnabled()) return;
  registerHeadlessReceipt(FFF_FIND_TOOL, fffindReceiptRenderers, {
    overrideOwned: true,
  });
  registerHeadlessReceipt(FFF_GREP_TOOL, ffgrepReceiptRenderers, {
    overrideOwned: true,
  });
  installHeadlessReceipts();
}

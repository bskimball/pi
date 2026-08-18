// memory-receipt: Apex chrome for the headless continual-memory tools.
//
// continual-memory.ts owns execute and the store; Apex cannot import that
// extension. First registration wins the whole tool, so this skins receipts
// through the shared headless ToolExecutionComponent wrap.
//
// PI_APEX_UI=0 skips the wrap. Any existing presentation wins.

import { boundedOutput, toolRenderers } from "./tool-receipt.ts";
import { cleanInline } from "./ui-common.ts";
import { apexPresentationEnabled } from "./presentation.ts";
import {
  installHeadlessReceipts,
  registerHeadlessReceipt,
} from "./headless-receipts.ts";

export const MEMORY_LIST_TOOL = "memory_list";
export const MEMORY_WRITE_TOOL = "memory_write";

type MemoryListArgs = {
  scope?: string;
  kind?: string;
};

type MemoryWriteArgs = {
  action?: string;
  scope?: string;
  kind?: string;
  id?: string;
  title?: string;
};

function detailsOf(result: any): Record<string, unknown> {
  return result?.details && typeof result.details === "object"
    ? (result.details as Record<string, unknown>)
    : {};
}

/** Compact header: `all` / `global memory` / `local prompt`. */
export function memoryListReceiptArg(
  args: MemoryListArgs | undefined,
  budget: number,
): string {
  const scope = cleanInline(args?.scope, 16) || "all";
  const kind = cleanInline(args?.kind, 16);
  return cleanInline(
    kind ? `${scope} ${kind}` : scope,
    Math.max(8, budget),
  );
}

/** Compact header: `create global memory title` / `delete local id`. */
export function memoryWriteReceiptArg(
  args: MemoryWriteArgs | undefined,
  budget: number,
): string {
  const action = cleanInline(args?.action, 16) || "write";
  const scope = cleanInline(args?.scope, 16) || "global";
  const kind = cleanInline(args?.kind, 16);
  const id = cleanInline(args?.id, 40);
  const title = cleanInline(args?.title, 60);
  const subject =
    action === "delete" ? id || title : title || id;
  return cleanInline(
    [action, scope, kind, subject].filter(Boolean).join(" "),
    Math.max(8, budget),
  );
}

export const memoryListReceiptRenderers = toolRenderers<MemoryListArgs>({
  surface: MEMORY_LIST_TOOL,
  title: MEMORY_LIST_TOOL,
  arg: memoryListReceiptArg,
  stats(result) {
    return cleanInline(detailsOf(result).message, 40);
  },
  preview(output) {
    return output ? boundedOutput(output, 4, 1200) : [];
  },
  body(output) {
    return output ? boundedOutput(output, 80) : [];
  },
});

export const memoryWriteReceiptRenderers = toolRenderers<MemoryWriteArgs>({
  surface: MEMORY_WRITE_TOOL,
  title: MEMORY_WRITE_TOOL,
  arg: memoryWriteReceiptArg,
  preview(output) {
    return output ? boundedOutput(output, 3, 1200) : [];
  },
  body(output) {
    return output ? boundedOutput(output, 80) : [];
  },
});

/** Attach Apex receipts to memory_list and memory_write. */
export function installMemoryReceipts(): void {
  if (!apexPresentationEnabled()) return;
  registerHeadlessReceipt(MEMORY_LIST_TOOL, memoryListReceiptRenderers);
  registerHeadlessReceipt(MEMORY_WRITE_TOOL, memoryWriteReceiptRenderers);
  installHeadlessReceipts();
}

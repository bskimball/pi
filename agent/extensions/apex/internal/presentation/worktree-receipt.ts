// worktree-receipt: Apex chrome for the headless worktree tool.
//
// worktree.ts owns execution and stays independently removable. Apex skins its
// ToolExecutionComponent through the shared headless receipt wrapper.
//
// PI_APEX_UI=0 skips the wrap. Any existing presentation wins.

import { boundedOutput, toolRenderers } from "./tool-receipt.ts";
import { cleanInline } from "./ui-common.ts";
import { apexPresentationEnabled } from "./presentation.ts";
import {
  installHeadlessReceipts,
  registerHeadlessReceipt,
} from "./headless-receipts.ts";

export const WORKTREE_RECEIPT_TOOL = "worktree";

type WorktreeArgs = {
  operation?: string;
  path?: string;
  branch?: string;
  force?: boolean;
  paths?: string[];
};

/** Compact operation summary without exposing the boxed JSON argument shape. */
export function worktreeReceiptArg(
  args: WorktreeArgs | undefined,
  budget: number,
): string {
  const operation = cleanInline(args?.operation, 16) || "worktree";
  const subject =
    operation === "add"
      ? cleanInline(args?.branch || args?.path, 120)
      : cleanInline(args?.path, 120);
  const force = operation === "remove" && args?.force ? "force" : "";
  const assigned = Array.isArray(args?.paths) && args.paths.length
    ? `${args.paths.length} path${args.paths.length === 1 ? "" : "s"}`
    : "";
  return cleanInline(
    [operation, subject, force, assigned].filter(Boolean).join(" "),
    Math.max(8, budget),
  );
}

export const worktreeReceiptRenderers = toolRenderers<WorktreeArgs>({
  surface: WORKTREE_RECEIPT_TOOL,
  title: WORKTREE_RECEIPT_TOOL,
  arg: worktreeReceiptArg,
  preview(output) {
    return output ? boundedOutput(output, 4, 1200) : [];
  },
  body(output) {
    return output ? boundedOutput(output, 80) : [];
  },
});

/** Attach Apex receipts to worktree ToolExecutionComponent instances. */
export function installWorktreeReceipts(): void {
  if (!apexPresentationEnabled()) return;
  registerHeadlessReceipt(WORKTREE_RECEIPT_TOOL, worktreeReceiptRenderers);
  installHeadlessReceipts();
}

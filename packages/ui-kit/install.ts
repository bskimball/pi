import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installBgProcessReceipts } from "./internal/presentation/bg-process-receipt.ts";
import { installBrowserAttachReceipts } from "./internal/presentation/browser-attach-receipt.ts";
import { installBuiltinReceipts } from "./internal/presentation/builtin-receipts.ts";
import { installFffReceipts } from "./internal/presentation/fff-receipt.ts";
import { installGraphifyReceipts } from "./internal/presentation/graphify-receipt.ts";
import { installIntercomReceipts } from "./internal/presentation/intercom-receipt.ts";
import { installLspReceipts } from "./internal/presentation/lsp-receipt.ts";
import { installMcpReceipts } from "./internal/presentation/mcp-receipt.ts";
import { installMemoryReceipts } from "./internal/presentation/memory-receipt.ts";
import { installPowerShellReceipts } from "./internal/presentation/powershell-receipt.ts";
import { installRenderSafety } from "./internal/presentation/render-safety.ts";
import { installSkillInvocationChrome } from "./internal/presentation/skill-invocation.ts";
import { installWebSearchReceipts } from "./internal/presentation/web-search-receipt.ts";
import { installWorktreeReceipts } from "./internal/presentation/worktree-receipt.ts";
import { installApexOwnedTools, installBuiltinTools } from "./builtin-tools.ts";

const g = globalThis as typeof globalThis & {
  __piUiKitTools?: boolean;
  __piUiKitPresentation?: boolean;
};

/** Todo tools + bash/write adapters. Safe to call from every UI extension. */
export function installSharedTools(pi: ExtensionAPI): void {
  if (g.__piUiKitTools) return;
  g.__piUiKitTools = true;
  installApexOwnedTools(pi);
  installBuiltinTools(pi);
}

/** One ToolExecutionComponent wrap. Safe to call from every UI extension. */
export function installSharedPresentation(pi: ExtensionAPI): void {
  if (g.__piUiKitPresentation) return;
  g.__piUiKitPresentation = true;
  installRenderSafety();
  installBuiltinReceipts();
  installSkillInvocationChrome();
  installFffReceipts();
  installGraphifyReceipts();
  installIntercomReceipts(pi);
  installLspReceipts();
  installMemoryReceipts();
  installPowerShellReceipts();
  installWebSearchReceipts();
  installWorktreeReceipts();
  installBrowserAttachReceipts();
  installMcpReceipts();
  installBgProcessReceipts(pi);
}

export function resetUiKitInstallForTests(): void {
  g.__piUiKitTools = false;
  g.__piUiKitPresentation = false;
}

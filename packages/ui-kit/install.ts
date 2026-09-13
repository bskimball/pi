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
import { claimSharedTools, resetUiKitOnceForTests, uiKitShared } from "./once.ts";

/** Todo tools + bash/write adapters. First UI extension's `pi` owns them process-wide. */
export function installSharedTools(pi: ExtensionAPI): void {
  if (!claimSharedTools(pi)) return;
  installApexOwnedTools(pi);
  installBuiltinTools(pi);
}

/** One ToolExecutionComponent wrap. Safe to call from every UI extension. */
export function installSharedPresentation(pi: ExtensionAPI): void {
  const shared = uiKitShared();
  if (shared.presentation) return;
  shared.presentation = true;
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
  resetUiKitOnceForTests();
}

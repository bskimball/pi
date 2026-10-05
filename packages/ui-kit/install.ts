import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installBgProcessReceipts } from "./internal/presentation/bg-process-receipt.ts";
import { installBrowserAttachReceipts } from "./internal/presentation/browser-attach-receipt.ts";
import { installBuiltinReceipts } from "./internal/presentation/builtin-receipts.ts";
import { installCodemodeReceipts } from "./internal/presentation/codemode-receipt.ts";
import { installFffReceipts } from "./internal/presentation/fff-receipt.ts";
import { installGraphifyReceipts } from "./internal/presentation/graphify-receipt.ts";
import { installIntercomReceipts } from "./internal/presentation/intercom-receipt.ts";
import { installJevReceipts } from "./internal/presentation/jev-receipt.ts";
import { installLspReceipts } from "./internal/presentation/lsp-receipt.ts";
import { installMcpReceipts } from "./internal/presentation/mcp-receipt.ts";
import { installMemoryReceipts } from "./internal/presentation/memory-receipt.ts";
import { installPowerShellReceipts } from "./internal/presentation/powershell-receipt.ts";
import { getHeadlessReceiptState, installHeadlessReceipts } from "./internal/presentation/headless-receipts.ts";
import { installRenderSafety } from "./internal/presentation/render-safety.ts";
import { installSkillInvocationChrome } from "./internal/presentation/skill-invocation.ts";
import { installWebSearchReceipts } from "./internal/presentation/web-search-receipt.ts";
import { installWorktreeReceipts } from "./internal/presentation/worktree-receipt.ts";
import { installKitOwnedTools, installBuiltinTools } from "./builtin-tools.ts";
import { claimSharedTools, resetUiKitOnceForTests, uiKitShared } from "./once.ts";

/** Todo tools + bash/write adapters. First UI extension's `pi` owns them process-wide. */
export function installSharedTools(pi: ExtensionAPI): void {
  if (!claimSharedTools(pi)) return;
  // A public resolver belongs to the runtime, even when another skin is active
  // or chrome is off. Empty registrations simply pass through to Pi.
  installHeadlessReceipts(pi);
  installKitOwnedTools(pi);
  installBuiltinTools(pi);
}

/** One public tool renderer resolver. Safe to call from every UI extension. */
export function installSharedPresentation(pi: ExtensionAPI): void {
  const shared = uiKitShared();
  if (shared.presentation) return;
  shared.presentation = true;
  installHeadlessReceipts(pi);
  installRenderSafety();
  installBuiltinReceipts();
  installCodemodeReceipts();
  installMcpReceipts();
  installSkillInvocationChrome();
  installFffReceipts();
  installGraphifyReceipts();
  installIntercomReceipts(pi);
  installJevReceipts();
  installLspReceipts();
  installMemoryReceipts();
  installPowerShellReceipts();
  installWebSearchReceipts();
  installWorktreeReceipts();
  installBrowserAttachReceipts();
  installBgProcessReceipts(pi);
}

export function resetUiKitInstallForTests(): void {
  resetUiKitOnceForTests();
  getHeadlessReceiptState().owner = undefined;
}

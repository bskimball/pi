// browser-attach-receipt: Apex chrome for the headless browser_attach tool.
//
// prompt-commands owns execute and the model-facing handoff prompt. Apex cannot
// import that extension. First registration wins the whole tool, so this skins
// receipts through the shared headless ToolExecutionComponent wrap.
//
// PI_APEX_UI=0 skips the wrap. Any existing presentation wins. Collapsed and
// expanded views show the connect excerpt, not the full custom browser prompt.

import { boundedOutput, toolRenderers } from "./tool-receipt.ts";
import { cleanInline } from "./ui-common.ts";
import { apexPresentationEnabled } from "./presentation.ts";
import {
  installHeadlessReceipts,
  registerHeadlessReceipt,
} from "./headless-receipts.ts";

export const BROWSER_ATTACH_TOOL = "browser_attach";

type BrowserAttachArgs = {
  task?: string;
};

const CONNECT_PREVIEW_RE = /^(status:|STATUS:|Mode:|Port:|Tabs:)/;

/** Generated connect block: a `[Connect step]` heading followed by `status:`. */
const CONNECT_BLOCK_RE = /\[Connect step\]\s*\nstatus:/i;

/** Model-facing handoff after the generated connect block; keep that excerpt. */
export function browserAttachConnectExcerpt(output: string): string {
  const match = CONNECT_BLOCK_RE.exec(output);
  if (match?.index !== undefined) return output.slice(match.index).trim();
  const start = output.indexOf("[Connect step]");
  return start >= 0 ? output.slice(start).trim() : output;
}

/** Collapsed lines: connect status fields, not the custom-prompt preamble. */
export function browserAttachPreviewLines(output: string): string[] {
  const excerpt = browserAttachConnectExcerpt(output);
  if (!excerpt) return [];
  const keys = excerpt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => CONNECT_PREVIEW_RE.test(line));
  if (keys.length) return keys.slice(0, 4);
  return boundedOutput(excerpt, 4, 1200);
}

/** Compact header: the task/URL, or `attach` when none was given. */
export function browserAttachReceiptArg(
  args: BrowserAttachArgs | undefined,
  budget: number,
): string {
  return cleanInline(args?.task, Math.max(8, budget)) || "attach";
}

export const browserAttachReceiptRenderers = toolRenderers<BrowserAttachArgs>({
  surface: BROWSER_ATTACH_TOOL,
  title: BROWSER_ATTACH_TOOL,
  arg: browserAttachReceiptArg,
  preview(output) {
    return output ? browserAttachPreviewLines(output) : [];
  },
  body(output) {
    if (!output) return [];
    return boundedOutput(browserAttachConnectExcerpt(output), 80);
  },
});

/** Attach Apex receipts to browser_attach ToolExecutionComponent instances. */
export function installBrowserAttachReceipts(): void {
  if (!apexPresentationEnabled()) return;
  registerHeadlessReceipt(BROWSER_ATTACH_TOOL, browserAttachReceiptRenderers);
  installHeadlessReceipts();
}

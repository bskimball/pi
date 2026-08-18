// powershell-receipt: Apex chrome for the headless powershell tool.
//
// powershell.ts owns execute and stays independently removable. Apex cannot
// import that extension. First registration wins the whole tool, so this skins
// receipts through the shared headless ToolExecutionComponent wrap.
//
// PI_APEX_UI=0 skips the wrap. Any existing powershell presentation
// (renderCall, renderResult, or a non-default renderShell) wins.

import { boundedOutput, toolRenderers } from "./tool-receipt.ts";
import { cleanInline } from "./ui-common.ts";
import { apexPresentationEnabled } from "./presentation.ts";
import {
  componentOwnsPresentation,
  installHeadlessReceipts,
  registerHeadlessReceipt,
} from "./headless-receipts.ts";

export const POWERSHELL_RECEIPT_TOOL = "powershell";

type PowerShellArgs = {
  command?: string;
  timeout?: number;
};

type PowerShellComponent = {
  toolName?: string;
  toolDefinition?: {
    renderCall?: unknown;
    renderResult?: unknown;
    renderShell?: unknown;
    [key: string]: unknown;
  };
  builtInToolDefinition?: {
    renderCall?: unknown;
    renderResult?: unknown;
    renderShell?: unknown;
    [key: string]: unknown;
  };
};

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function detailsOf(result: any): Record<string, unknown> {
  return result?.details && typeof result.details === "object"
    ? (result.details as Record<string, unknown>)
    : {};
}

/**
 * Compact header argument: first statement, optional `+N lines`, optional
 * timeout. Multi-line scripts never dump the whole body into the title.
 */
export function powershellReceiptArg(
  args: PowerShellArgs | undefined,
  budget: number,
): string {
  const lines = String(args?.command ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const extra = Math.max(0, lines.length - 1);
  const extras: string[] = [];
  if (extra > 0) extras.push(`+${extra} ${extra === 1 ? "line" : "lines"}`);
  const timeout = finiteNumber(args?.timeout);
  if (timeout !== undefined) extras.push(`${timeout}s`);
  return cleanInline(
    [lines[0] || "powershell", extras.join(" ")].filter(Boolean).join(" "),
    Math.max(8, budget),
  );
}

export const powershellReceiptRenderers = toolRenderers<PowerShellArgs>({
  surface: POWERSHELL_RECEIPT_TOOL,
  title: POWERSHELL_RECEIPT_TOOL,
  arg: powershellReceiptArg,
  stats(result) {
    const details = detailsOf(result);
    const parts: string[] = [];
    if (details.aborted) parts.push("aborted");
    else if (details.timedOut) parts.push("timed out");
    else {
      const exit = finiteNumber(details.exitCode);
      if (exit !== undefined) parts.push(`exit ${exit}`);
      else if (details.exitCode === null) parts.push("exit null");
    }
    if (details.truncated) parts.push("truncated");
    const name = powershellExecutableName(details.executable);
    if (name) parts.push(name);
    return parts.join(" · ");
  },
  preview(output) {
    return output ? boundedOutput(output, 3, 1200) : [];
  },
  body(output) {
    return output ? boundedOutput(output, 80) : [];
  },
});

/** Basename of a PowerShell executable path, clipped after the last slash. */
export function powershellExecutableName(value: unknown): string {
  const raw = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!raw) return "";
  const slash = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
  return cleanInline(slash >= 0 ? raw.slice(slash + 1) : raw, 40);
}

/** True when powershell already declared any presentation contract. */
export function powershellOwnsPresentation(
  component: PowerShellComponent,
): boolean {
  return componentOwnsPresentation(component);
}

/** Attach Apex receipts to powershell ToolExecutionComponent instances. */
export function installPowerShellReceipts(): void {
  if (!apexPresentationEnabled()) return;
  registerHeadlessReceipt(POWERSHELL_RECEIPT_TOOL, powershellReceiptRenderers);
  installHeadlessReceipts();
}

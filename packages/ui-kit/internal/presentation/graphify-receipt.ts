// graphify-receipt: Apex chrome for the headless graphify tool.
//
// Graphify owns execute and status; Apex cannot import that extension. First
// registration wins the whole tool, so this skins receipts through the shared
// headless ToolExecutionComponent wrap instead of re-registering the tool.
//
// PI_APEX_UI=0 skips the wrap. Any existing graphify presentation
// (renderCall, renderResult, or a non-default renderShell) wins.

import { boundedOutput, toolRenderers } from "./tool-receipt.ts";
import { cleanInline } from "./ui-common.ts";
import { apexPresentationEnabled } from "./presentation.ts";
import {
  componentOwnsPresentation,
  installHeadlessReceipts,
  registerHeadlessReceipt,
} from "./headless-receipts.ts";

export const GRAPHIFY_RECEIPT_TOOL = "graphify";

type GraphifyArgs = {
  operation?: string;
  question?: string;
  mode?: string;
  budget?: number;
  from?: string;
  to?: string;
  concept?: string;
  scope?: string;
};

type GraphifyComponent = {
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

function operationOf(args: GraphifyArgs | undefined): string {
  const raw = String(args?.operation ?? "").trim().toLowerCase();
  if (raw === "path" || raw === "explain" || raw === "query") return raw;
  return "query";
}

/** Compact header argument: `query How does X work?` / `path Auth -> Db`. */
export function graphifyReceiptArg(
  args: GraphifyArgs | undefined,
  budget: number,
): string {
  const op = operationOf(args);
  let subject = "";
  if (op === "path") {
    const from = cleanInline(args?.from, 80);
    const to = cleanInline(args?.to, 80);
    subject = from && to ? `${from} -> ${to}` : from || to;
  } else if (op === "explain") {
    subject = cleanInline(args?.concept, 120);
  } else {
    subject = cleanInline(args?.question, 120);
  }

  const extras: string[] = [];
  if (op === "query") {
    const mode = String(args?.mode ?? "").trim().toLowerCase();
    if (mode && mode !== "bfs") extras.push(mode);
    const scope = String(args?.scope ?? "").trim();
    if (scope) extras.push(scope);
    if (typeof args?.budget === "number" && Number.isFinite(args.budget)) {
      extras.push(String(Math.floor(args.budget)));
    }
  }

  const parts = [op, subject, extras.join(" ")].filter(Boolean);
  return cleanInline(parts.join(" "), Math.max(8, budget));
}

export const graphifyReceiptRenderers = toolRenderers<GraphifyArgs>({
  surface: GRAPHIFY_RECEIPT_TOOL,
  title: GRAPHIFY_RECEIPT_TOOL,
  arg: graphifyReceiptArg,
  preview(output) {
    return output ? boundedOutput(output, 3, 1200) : [];
  },
  body(output) {
    return output ? boundedOutput(output, 80) : [];
  },
});

/** True when graphify already declared any presentation contract. */
export function graphifyOwnsPresentation(component: GraphifyComponent): boolean {
  return componentOwnsPresentation(component);
}

/** Attach Apex receipts to graphify ToolExecutionComponent instances. */
export function installGraphifyReceipts(): void {
  if (!apexPresentationEnabled()) return;
  registerHeadlessReceipt(GRAPHIFY_RECEIPT_TOOL, graphifyReceiptRenderers);
  installHeadlessReceipts();
}

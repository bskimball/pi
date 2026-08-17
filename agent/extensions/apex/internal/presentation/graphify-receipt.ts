// graphify-receipt: Apex chrome for the headless graphify tool.
//
// Graphify owns execute and status; Apex cannot import that extension. First
// registration wins the whole tool, so this skins receipts by wrapping
// ToolExecutionComponent getters instead of re-registering the tool.
//
// PI_APEX_UI=0 skips the wrap. Any existing graphify presentation
// (renderCall, renderResult, or a non-default renderShell) wins.

import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { boundedOutput, toolRenderers } from "./tool-receipt.ts";
import { cleanInline } from "./ui-common.ts";

export const GRAPHIFY_RECEIPT_TOOL = "graphify";

const INSTALL_KEY = Symbol.for("pi.apex.graphifyReceipts.installed");

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

type GraphifyPresentation = {
  renderCall?: unknown;
  renderResult?: unknown;
  renderShell?: unknown;
  [key: string]: unknown;
};

type GraphifyComponent = {
  toolName?: string;
  toolDefinition?: GraphifyPresentation;
  builtInToolDefinition?: GraphifyPresentation;
};

function findOwnMethod(
  start: object,
  name: string,
): { target: Record<string, unknown>; method: (...args: never[]) => unknown } | undefined {
  let current: object | null = start;
  while (current && current !== Object.prototype) {
    const candidate = (current as Record<string, unknown>)[name];
    if (typeof candidate === "function") {
      return {
        target: current as Record<string, unknown>,
        method: candidate as (...args: never[]) => unknown,
      };
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

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

function isGraphifyComponent(component: { toolName?: string }): boolean {
  return component.toolName === GRAPHIFY_RECEIPT_TOOL;
}

function definitionOwnsPresentation(definition: {
  renderCall?: unknown;
  renderResult?: unknown;
  renderShell?: unknown;
  [key: string]: unknown;
} | undefined): boolean {
  if (!definition) return false;
  if (typeof definition.renderCall === "function") return true;
  if (typeof definition.renderResult === "function") return true;
  return definition.renderShell != null && definition.renderShell !== "default";
}

/** True when graphify already declared any presentation contract. */
export function graphifyOwnsPresentation(component: GraphifyComponent): boolean {
  return (
    definitionOwnsPresentation(component.toolDefinition) ||
    definitionOwnsPresentation(component.builtInToolDefinition)
  );
}

function shouldAttachApexReceipts(component: GraphifyComponent): boolean {
  return isGraphifyComponent(component) && !graphifyOwnsPresentation(component);
}

/** Attach Apex receipts to graphify ToolExecutionComponent instances. */
export function installGraphifyReceipts(): void {
  if (process.env.PI_APEX_UI === "0") return;
  const proto = ToolExecutionComponent.prototype as object & {
    [INSTALL_KEY]?: boolean;
  };
  if (proto[INSTALL_KEY]) return;

  const call = findOwnMethod(proto, "getCallRenderer");
  const result = findOwnMethod(proto, "getResultRenderer");
  const shell = findOwnMethod(proto, "getRenderShell");
  const hasRenderer = findOwnMethod(proto, "hasRendererDefinition");
  if (!call || !result || !shell || !hasRenderer) return;

  call.target.getCallRenderer = function getGraphifyCallRenderer(
    this: GraphifyComponent,
  ) {
    const existing = call.method.call(this);
    if (shouldAttachApexReceipts(this) && existing == null) {
      return graphifyReceiptRenderers.renderCall;
    }
    return existing;
  };

  result.target.getResultRenderer = function getGraphifyResultRenderer(
    this: GraphifyComponent,
  ) {
    const existing = result.method.call(this);
    if (shouldAttachApexReceipts(this) && existing == null) {
      return graphifyReceiptRenderers.renderResult;
    }
    return existing;
  };

  shell.target.getRenderShell = function getGraphifyRenderShell(
    this: GraphifyComponent,
  ) {
    const existing = shell.method.call(this);
    if (shouldAttachApexReceipts(this)) return "self";
    return existing;
  };

  hasRenderer.target.hasRendererDefinition = function hasGraphifyRendererDefinition(
    this: object,
  ) {
    if (shouldAttachApexReceipts(this as GraphifyComponent)) return true;
    return hasRenderer.method.call(this);
  };

  proto[INSTALL_KEY] = true;
}

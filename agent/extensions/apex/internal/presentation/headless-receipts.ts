// headless-receipts: Apex chrome for tools owned by other extensions.
//
// Those extensions own execute and stay independently removable. First
// registration wins the whole tool, so Apex cannot re-register them. This
// skins receipts by wrapping ToolExecutionComponent getters instead.
//
// PI_APEX_UI=0 skips the wrap. Any existing presentation on a tool
// (renderCall, renderResult, or a non-default renderShell) wins.

import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { apexPresentationEnabled } from "./presentation.ts";

const INSTALL_KEY = Symbol.for("pi.apex.headlessReceipts.installed");
const RECEIPTS_KEY = Symbol.for("pi.apex.headlessReceipts.registry");

export type HeadlessRenderers = {
  renderCall: unknown;
  renderResult: unknown;
};

type HeadlessPresentation = {
  renderCall?: unknown;
  renderResult?: unknown;
  renderShell?: unknown;
  [key: string]: unknown;
};

type HeadlessComponent = {
  toolName?: string;
  toolDefinition?: HeadlessPresentation;
  builtInToolDefinition?: HeadlessPresentation;
};

type HeadlessReceiptGlobal = typeof globalThis & {
  [RECEIPTS_KEY]?: Map<string, HeadlessRenderers>;
};

// Extension reloads create a new module instance while the process-wide
// ToolExecutionComponent prototype remains wrapped. Keep the registry on the
// global symbol table so that existing wrappers see receipts registered by the
// reloaded Apex module.
const receiptGlobal = globalThis as HeadlessReceiptGlobal;
const receipts =
  receiptGlobal[RECEIPTS_KEY] ??
  (receiptGlobal[RECEIPTS_KEY] = new Map<string, HeadlessRenderers>());

export function findOwnMethod(
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

export function definitionOwnsPresentation(definition: HeadlessPresentation | undefined): boolean {
  if (!definition) return false;
  if (typeof definition.renderCall === "function") return true;
  if (typeof definition.renderResult === "function") return true;
  return definition.renderShell != null && definition.renderShell !== "default";
}

/** True when the tool already declared any presentation contract. */
export function componentOwnsPresentation(component: HeadlessComponent): boolean {
  return (
    definitionOwnsPresentation(component.toolDefinition) ||
    definitionOwnsPresentation(component.builtInToolDefinition)
  );
}

export function receiptFor(toolName: string | undefined): HeadlessRenderers | undefined {
  if (!toolName) return undefined;
  return receipts.get(toolName);
}

/** Register Apex receipts for one headless tool. Last register for a name wins. */
export function registerHeadlessReceipt(
  toolName: string,
  renderers: HeadlessRenderers,
): void {
  receipts.set(toolName, renderers);
}

function shouldAttachApexReceipts(component: HeadlessComponent): HeadlessRenderers | undefined {
  const renderers = receiptFor(component.toolName);
  if (!renderers) return undefined;
  if (componentOwnsPresentation(component)) return undefined;
  return renderers;
}

/** Attach registered Apex receipts to matching ToolExecutionComponent instances. */
export function installHeadlessReceipts(): void {
  if (!apexPresentationEnabled()) return;
  const proto = ToolExecutionComponent.prototype as object & {
    [INSTALL_KEY]?: boolean;
  };
  if (proto[INSTALL_KEY]) return;

  const call = findOwnMethod(proto, "getCallRenderer");
  const result = findOwnMethod(proto, "getResultRenderer");
  const shell = findOwnMethod(proto, "getRenderShell");
  const hasRenderer = findOwnMethod(proto, "hasRendererDefinition");
  if (!call || !result || !shell || !hasRenderer) return;

  call.target.getCallRenderer = function getHeadlessCallRenderer(
    this: HeadlessComponent,
  ) {
    const existing = call.method.call(this);
    const renderers = shouldAttachApexReceipts(this);
    if (renderers && existing == null) return renderers.renderCall;
    return existing;
  };

  result.target.getResultRenderer = function getHeadlessResultRenderer(
    this: HeadlessComponent,
  ) {
    const existing = result.method.call(this);
    const renderers = shouldAttachApexReceipts(this);
    if (renderers && existing == null) return renderers.renderResult;
    return existing;
  };

  shell.target.getRenderShell = function getHeadlessRenderShell(
    this: HeadlessComponent,
  ) {
    const existing = shell.method.call(this);
    if (shouldAttachApexReceipts(this)) return "self";
    return existing;
  };

  hasRenderer.target.hasRendererDefinition = function hasHeadlessRendererDefinition(
    this: object,
  ) {
    if (shouldAttachApexReceipts(this as HeadlessComponent)) return true;
    return hasRenderer.method.call(this);
  };

  proto[INSTALL_KEY] = true;
}

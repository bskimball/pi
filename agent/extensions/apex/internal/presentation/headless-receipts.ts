// headless-receipts: Apex chrome for tools owned by other extensions.
//
// Those extensions own execute and stay independently removable. First
// registration wins the whole tool, so Apex cannot re-register them. This
// skins receipts by wrapping ToolExecutionComponent getters instead.
//
// PI_APEX_UI=0 skips the wrap or dynamically falls back to original tool
// presentation when toggled after installation. Any existing presentation on a
// tool (renderCall, renderResult, or a non-default renderShell) wins unless a
// receipt explicitly opts into overrideOwned upon registration.

import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { apexPresentationEnabled } from "./presentation.ts";

export const HEADLESS_STATE_KEY = Symbol.for("pi.apex.headlessReceipts.state");
export const RECEIPTS_KEY = Symbol.for("pi.apex.headlessReceipts.registry");
const LEGACY_INSTALL_KEY = Symbol.for("pi.apex.headlessReceipts.installed");

export const HEADLESS_WRAPPER_VERSION = 1;

export type HeadlessReceiptOptions = {
  overrideOwned?: boolean;
};

export type HeadlessRenderers = {
  renderCall: unknown;
  renderResult: unknown;
};

export type RegisteredReceipt = HeadlessRenderers & {
  overrideOwned: boolean;
};

export type HeadlessPresentation = {
  renderCall?: unknown;
  renderResult?: unknown;
  renderShell?: unknown;
  [key: string]: unknown;
};

export type HeadlessComponent = {
  toolName?: string;
  toolDefinition?: HeadlessPresentation;
  builtInToolDefinition?: HeadlessPresentation;
};

export type HeadlessReceiptState = {
  version: number;
  installed: boolean;
  legacyWrapped: boolean;
  registry: Map<string, RegisteredReceipt>;
  originals: {
    getCallRenderer?: (this: HeadlessComponent) => unknown;
    getResultRenderer?: (this: HeadlessComponent) => unknown;
    getRenderShell?: (this: HeadlessComponent) => unknown;
    hasRendererDefinition?: (this: object) => boolean;
  };
  shouldAttach?: (component: HeadlessComponent) => RegisteredReceipt | undefined;
};

type HeadlessReceiptGlobal = typeof globalThis & {
  [HEADLESS_STATE_KEY]?: HeadlessReceiptState;
  [RECEIPTS_KEY]?: Map<string, RegisteredReceipt>;
};

type HeadlessPrototype = object & {
  [LEGACY_INSTALL_KEY]?: boolean;
};

// Extension reloads create a new module instance while the process-wide
// ToolExecutionComponent prototype remains wrapped. Keep a global state object
// on the global symbol table so that existing wrappers consult current decision
// behavior and preserved registrations across reloads without stacking closures.
export function getHeadlessReceiptState(): HeadlessReceiptState {
  const g = globalThis as HeadlessReceiptGlobal;
  let state = g[HEADLESS_STATE_KEY];
  if (!state) {
    const existingRegistry = g[RECEIPTS_KEY] as Map<string, RegisteredReceipt> | undefined;
    state = {
      version: HEADLESS_WRAPPER_VERSION,
      installed: false,
      legacyWrapped: Boolean(
        (ToolExecutionComponent.prototype as HeadlessPrototype)[LEGACY_INSTALL_KEY],
      ),
      registry: existingRegistry ?? new Map<string, RegisteredReceipt>(),
      originals: {},
    };
    g[HEADLESS_STATE_KEY] = state;
    g[RECEIPTS_KEY] = state.registry;
  }
  return state;
}

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

export function receiptFor(toolName: string | undefined): RegisteredReceipt | undefined {
  if (!toolName) return undefined;
  return getHeadlessReceiptState().registry.get(toolName);
}

/** Register Apex receipts for one headless tool. Last register for a name wins. */
export function registerHeadlessReceipt(
  toolName: string,
  renderers: HeadlessRenderers,
  options?: HeadlessReceiptOptions,
): void {
  const state = getHeadlessReceiptState();
  const overrideOwned =
    options?.overrideOwned ??
    Boolean((renderers as { overrideOwned?: boolean }).overrideOwned);
  state.registry.set(toolName, {
    renderCall: renderers.renderCall,
    renderResult: renderers.renderResult,
    overrideOwned,
  });
}

export function shouldAttachApexReceipts(
  component: HeadlessComponent,
): RegisteredReceipt | undefined {
  if (!apexPresentationEnabled()) return undefined;
  const toolName = component.toolName;
  if (!toolName) return undefined;
  const state = getHeadlessReceiptState();
  const renderers = state.registry.get(toolName);
  if (!renderers) return undefined;
  if (!renderers.overrideOwned && componentOwnsPresentation(component)) return undefined;
  return renderers;
}

function callOriginal<T>(
  state: HeadlessReceiptState,
  component: HeadlessComponent,
  original: ((this: HeadlessComponent) => T) | undefined,
): T | undefined {
  if (!original) return undefined;
  if (apexPresentationEnabled() || !state.legacyWrapped || !component.toolName) {
    return original.call(component);
  }

  // The pre-state wrapper captured the shared registry and did not dynamically
  // honor PI_APEX_UI. Suppress only this tool's legacy receipt while delegating
  // during the one-time in-process migration, then restore it immediately.
  const registered = state.registry.get(component.toolName);
  if (!registered) return original.call(component);
  state.registry.delete(component.toolName);
  try {
    return original.call(component);
  } finally {
    state.registry.set(component.toolName, registered);
  }
}

// Keep global state decision logic up-to-date with current module version
const moduleState = getHeadlessReceiptState();
moduleState.version = Math.max(moduleState.version, HEADLESS_WRAPPER_VERSION);
moduleState.shouldAttach = shouldAttachApexReceipts;

/** Attach registered Apex receipts to matching ToolExecutionComponent instances. */
export function installHeadlessReceipts(): void {
  const state = getHeadlessReceiptState();
  state.shouldAttach = shouldAttachApexReceipts;

  if (!apexPresentationEnabled()) return;
  if (state.installed) return;

  const proto = ToolExecutionComponent.prototype as object;
  const call = findOwnMethod(proto, "getCallRenderer");
  const result = findOwnMethod(proto, "getResultRenderer");
  const shell = findOwnMethod(proto, "getRenderShell");
  const hasRenderer = findOwnMethod(proto, "hasRendererDefinition");
  if (!call || !result || !shell || !hasRenderer) return;

  state.originals = {
    getCallRenderer: call.method as (this: HeadlessComponent) => unknown,
    getResultRenderer: result.method as (this: HeadlessComponent) => unknown,
    getRenderShell: shell.method as (this: HeadlessComponent) => unknown,
    hasRendererDefinition: hasRenderer.method as (this: object) => boolean,
  };

  call.target.getCallRenderer = function getHeadlessCallRenderer(
    this: HeadlessComponent,
  ) {
    const s = getHeadlessReceiptState();
    const existing = callOriginal(s, this, s.originals.getCallRenderer);
    const decision = s.shouldAttach
      ? s.shouldAttach(this)
      : shouldAttachApexReceipts(this);
    if (decision && (existing == null || decision.overrideOwned)) {
      return decision.renderCall;
    }
    return existing;
  };

  result.target.getResultRenderer = function getHeadlessResultRenderer(
    this: HeadlessComponent,
  ) {
    const s = getHeadlessReceiptState();
    const existing = callOriginal(s, this, s.originals.getResultRenderer);
    const decision = s.shouldAttach
      ? s.shouldAttach(this)
      : shouldAttachApexReceipts(this);
    if (decision && (existing == null || decision.overrideOwned)) {
      return decision.renderResult;
    }
    return existing;
  };

  shell.target.getRenderShell = function getHeadlessRenderShell(
    this: HeadlessComponent,
  ) {
    const s = getHeadlessReceiptState();
    const existing = callOriginal(s, this, s.originals.getRenderShell);
    const decision = s.shouldAttach
      ? s.shouldAttach(this)
      : shouldAttachApexReceipts(this);
    if (decision) return "self";
    return existing;
  };

  hasRenderer.target.hasRendererDefinition = function hasHeadlessRendererDefinition(
    this: object,
  ) {
    const s = getHeadlessReceiptState();
    const decision = s.shouldAttach
      ? s.shouldAttach(this as HeadlessComponent)
      : shouldAttachApexReceipts(this as HeadlessComponent);
    if (decision) return true;
    return callOriginal(
      s,
      this as HeadlessComponent,
      s.originals.hasRendererDefinition as
        | ((this: HeadlessComponent) => boolean)
        | undefined,
    ) ?? false;
  };

  state.installed = true;
}

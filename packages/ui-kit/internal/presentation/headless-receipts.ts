// headless-receipts: Apex chrome for tools owned by other extensions.
//
// Those extensions own execute and stay independently removable. First
// registration wins the whole tool, so Apex cannot re-register them. This
// skins receipts by wrapping ToolExecutionComponent getters instead.
//
// Two copies of that class exist at runtime: the one extensions import
// (dist/index.js) and the one the bundled live TUI instantiates
// (dist/bundle). Patching only the imported copy leaves every
// wrap-dependent receipt on owner chrome, so both prototypes are wrapped.
//
// PI_APEX_UI=0 skips the wrap or dynamically falls back to original tool
// presentation when toggled after installation. Any existing presentation on a
// tool (renderCall, renderResult, or a non-default renderShell) wins unless a
// receipt explicitly opts into overrideOwned upon registration.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { apexPresentationEnabled } from "./presentation.ts";
import { reportRenderFailure } from "./tool-receipt.ts";

export const HEADLESS_STATE_KEY = Symbol.for("pi.apex.headlessReceipts.state");
export const RECEIPTS_KEY = Symbol.for("pi.apex.headlessReceipts.registry");
const LEGACY_INSTALL_KEY = Symbol.for("pi.apex.headlessReceipts.installed");

export const HEADLESS_WRAPPER_VERSION = 3;

export type HeadlessReceiptOptions = {
  overrideOwned?: boolean;
  suppressOwnedWhenDisabled?: boolean;
};

export type HeadlessRenderers = {
  renderCall: unknown;
  renderResult: unknown;
};

export type RegisteredReceipt = HeadlessRenderers & {
  overrideOwned: boolean;
  suppressOwnedWhenDisabled?: boolean;
};

export type RegisteredPrefix = {
  prefix: string;
  resolve: (toolName: string) => RegisteredReceipt;
};

export type HeadlessRendererFactory = (
  toolName: string,
) => HeadlessRenderers;

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

export type HeadlessOriginals = {
  getCallRenderer?: (this: HeadlessComponent) => unknown;
  getResultRenderer?: (this: HeadlessComponent) => unknown;
  getRenderShell?: (this: HeadlessComponent) => unknown;
  hasRendererDefinition?: (this: object) => boolean;
};

export type LiveBundleState = "pending" | "patched" | "absent" | "failed";

export type HeadlessReceiptState = {
  version: number;
  installed: boolean;
  legacyWrapped: boolean;
  registry: Map<string, RegisteredReceipt>;
  prefixes: RegisteredPrefix[];
  originals: HeadlessOriginals;
  /** Pristine methods per wrapped prototype (imported copy + bundled copy). */
  protoOriginals: Map<object, HeadlessOriginals>;
  /** Outcome of the attempt to wrap the bundled live copy. */
  liveBundle: LiveBundleState;
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
      prefixes: [],
      originals: {},
      protoOriginals: new Map(),
      liveBundle: "pending",
    };
    g[HEADLESS_STATE_KEY] = state;
    g[RECEIPTS_KEY] = state.registry;
  }
  // Prefix matchers arrived after the state shape; a process-wide state born
  // under an older module instance will not have the field yet.
  if (!state.prefixes) state.prefixes = [];
  if (!state.protoOriginals) state.protoOriginals = new Map();
  if (!state.liveBundle) state.liveBundle = "pending";
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

function toRegisteredReceipt(
  renderers: HeadlessRenderers,
  options?: HeadlessReceiptOptions,
): RegisteredReceipt {
  const overrideOwned =
    options?.overrideOwned ??
    Boolean((renderers as { overrideOwned?: boolean }).overrideOwned);
  const suppressOwnedWhenDisabled = options?.suppressOwnedWhenDisabled ?? false;
  return {
    renderCall: renderers.renderCall,
    renderResult: renderers.renderResult,
    overrideOwned,
    suppressOwnedWhenDisabled,
  };
}

/** Register Apex receipts for one headless tool. Last register for a name wins. */
export function registerHeadlessReceipt(
  toolName: string,
  renderers: HeadlessRenderers,
  options?: HeadlessReceiptOptions,
): void {
  getHeadlessReceiptState().registry.set(
    toolName,
    toRegisteredReceipt(renderers, options),
  );
}

/**
 * Register Apex receipts for every tool whose name starts with `prefix`.
 * Second-chance match only: exact keys always win, and among prefixes the
 * longest match wins. Last register for a prefix wins. Accepts either a fixed
 * renderers object or a factory that builds one from the matched tool name
 * (used when the name itself carries display data, e.g. `mcp__<server>`).
 */
export function registerHeadlessReceiptPrefix(
  prefix: string,
  renderers: HeadlessRenderers | HeadlessRendererFactory,
  options?: HeadlessReceiptOptions,
): void {
  const state = getHeadlessReceiptState();
  const resolve =
    typeof renderers === "function"
      ? (toolName: string) => toRegisteredReceipt(renderers(toolName), options)
      : () => toRegisteredReceipt(renderers, options);
  const existing = state.prefixes.findIndex((entry) => entry.prefix === prefix);
  if (existing === -1) state.prefixes.push({ prefix, resolve });
  else state.prefixes[existing] = { prefix, resolve };
}

function matchPrefixReceipt(
  state: HeadlessReceiptState,
  toolName: string,
): RegisteredReceipt | undefined {
  let best: RegisteredPrefix | undefined;
  let bestLength = -1;
  for (const entry of state.prefixes) {
    if (
      entry.prefix.length > bestLength &&
      toolName.startsWith(entry.prefix)
    ) {
      best = entry;
      bestLength = entry.prefix.length;
    }
  }
  return best?.resolve(toolName);
}

function shouldSuppressOwnedPresentation(
  component: HeadlessComponent,
): boolean {
  if (apexPresentationEnabled() || !component.toolName) return false;
  const state = getHeadlessReceiptState();
  const receipt =
    state.registry.get(component.toolName) ??
    matchPrefixReceipt(state, component.toolName);
  return Boolean(receipt?.suppressOwnedWhenDisabled);
}

export function shouldAttachApexReceipts(
  component: HeadlessComponent,
): RegisteredReceipt | undefined {
  if (!apexPresentationEnabled()) return undefined;
  const toolName = component.toolName;
  if (!toolName) return undefined;
  const state = getHeadlessReceiptState();
  const renderers =
    state.registry.get(toolName) ?? matchPrefixReceipt(state, toolName);
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

// Keep process-global decision logic current across extension module reloads.
const moduleState = getHeadlessReceiptState();
moduleState.shouldAttach = shouldAttachApexReceipts;

/**
 * Wrap one ToolExecutionComponent prototype so registered headless receipts
 * attach to the instances it creates. The decision logic stays process-global
 * (state.shouldAttach + registry), but pristine methods are captured per
 * prototype: the class extensions import (dist/index.js) is a different
 * object from the class the bundled live TUI instantiates (dist/bundle), and
 * each copy needs its own originals. Returns false — and logs once to
 * pi-render.log — when the target lacks the expected getters, instead of
 * silently leaving owner chrome in place. Exported for tests: pass a
 * stand-in prototype to prove a second copy gets wrapped.
 */
export function wrapToolExecutionPrototype(
  proto: object,
  state: HeadlessReceiptState = getHeadlessReceiptState(),
): boolean {
  const call = findOwnMethod(proto, "getCallRenderer");
  const result = findOwnMethod(proto, "getResultRenderer");
  const shell = findOwnMethod(proto, "getRenderShell");
  const hasRenderer = findOwnMethod(proto, "hasRendererDefinition");
  if (!call || !result || !shell || !hasRenderer) {
    reportRenderFailure(
      "headless-receipts",
      new Error(
        "ToolExecutionComponent prototype is missing getCallRenderer/getResultRenderer/getRenderShell/hasRendererDefinition; kit receipts cannot attach to tools rendered by this copy.",
      ),
    );
    return false;
  }

  // First install captures the pristine methods. Afterwards the
  // process-global state already holds them: prefer the stored set (an older
  // wrapper may already be installed on this prototype), then the legacy
  // single-copy originals on a version upgrade, and only then the methods
  // just found. Never mistake our own wrappers for pristine methods.
  let originals = state.protoOriginals.get(proto);
  if (!originals) {
    const isPrimary = proto === (ToolExecutionComponent.prototype as object);
    if (isPrimary && state.installed && state.originals.getCallRenderer) {
      originals = state.originals;
    } else {
      originals = {
        getCallRenderer: call.method as (this: HeadlessComponent) => unknown,
        getResultRenderer: result.method as (this: HeadlessComponent) => unknown,
        getRenderShell: shell.method as (this: HeadlessComponent) => unknown,
        hasRendererDefinition: hasRenderer.method as (this: object) => boolean,
      };
      if (isPrimary && !state.installed) state.originals = originals;
    }
    state.protoOriginals.set(proto, originals);
  }

  call.target.getCallRenderer = function getHeadlessCallRenderer(
    this: HeadlessComponent,
  ) {
    const s = getHeadlessReceiptState();
    const existing = callOriginal(s, this, originals.getCallRenderer);
    if (shouldSuppressOwnedPresentation(this)) return undefined;
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
    const existing = callOriginal(s, this, originals.getResultRenderer);
    if (shouldSuppressOwnedPresentation(this)) return undefined;
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
    const existing = callOriginal(s, this, originals.getRenderShell);
    if (shouldSuppressOwnedPresentation(this)) return "default";
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
      originals.hasRendererDefinition as
        | ((this: HeadlessComponent) => boolean)
        | undefined,
    ) ?? false;
  };

  return true;
}

/**
 * File URL of the bundled core entry that owns the live component copies, if
 * this install has one. Derived from the already-resolved core entry so it
 * works regardless of where Pi is installed; undefined on unbundled runtimes
 * (SDK/tests without a bundle).
 */
export function resolveLiveBundleEntryUrl(): string | undefined {
  let entry: string;
  try {
    entry = import.meta.resolve("@earendil-works/pi-coding-agent");
  } catch {
    return undefined;
  }
  const suffix = "/dist/index.js";
  if (!entry.endsWith(suffix)) return undefined;
  const candidate = `${entry.slice(0, -suffix.length)}/dist/bundle/index.js`;
  let path: string;
  try {
    path = fileURLToPath(candidate);
  } catch {
    return undefined;
  }
  return existsSync(path) ? candidate : undefined;
}

/**
 * Import the bundled core entry (the module object behind dist/bundle).
 * Shared by every kit surface that must patch the live copies of core
 * classes instead of the dist/index.js copies extensions import. Resolves to
 * undefined when this install has no bundle; throws when the bundle exists
 * but cannot be imported (callers log that loudly: it means live rendering
 * is out of the kit's reach).
 */
export function importLiveBundleModule(): Promise<Record<string, unknown>> {
  const url = resolveLiveBundleEntryUrl();
  if (!url)
    return Promise.reject(new Error("No bundled core entry in this install."));
  return import(url) as Promise<Record<string, unknown>>;
}

/**
 * Wrap the bundled copy of ToolExecutionComponent that the live TUI
 * instantiates. The class extensions import (dist/index.js) is a different
 * object, so the primary wrap alone never intercepts a rendered component.
 * Fire-and-forget: install stays synchronous; a missing bundle (dev/test)
 * silently skips, anything else that fails is logged once to pi-render.log.
 * Exported for tests: await it to prove the genuine bundled copy gets wrapped.
 */
export async function patchLiveBundlePrototype(
  state: HeadlessReceiptState,
): Promise<void> {
  if (state.liveBundle !== "pending") return;
  if (!resolveLiveBundleEntryUrl()) {
    state.liveBundle = "absent";
    return;
  }
  let exported: unknown;
  try {
    exported = (await importLiveBundleModule()).ToolExecutionComponent;
  } catch (error) {
    state.liveBundle = "failed";
    reportRenderFailure("headless-receipts", error);
    return;
  }
  const proto =
    typeof exported === "function"
      ? (exported as { prototype?: unknown }).prototype
      : undefined;
  if (!proto || typeof proto !== "object") {
    state.liveBundle = "failed";
    reportRenderFailure(
      "headless-receipts",
      new Error(
        "Bundled core entry does not export ToolExecutionComponent; kit receipts cannot attach to live tool calls.",
      ),
    );
    return;
  }
  if (proto === (ToolExecutionComponent.prototype as object)) {
    // Unbundled runtime: the primary wrap already covers it.
    state.liveBundle = "patched";
    return;
  }
  state.liveBundle = wrapToolExecutionPrototype(proto, state)
    ? "patched"
    : "failed";
}

/** Attach registered Apex receipts to matching ToolExecutionComponent instances. */
export function installHeadlessReceipts(): void {
  const state = getHeadlessReceiptState();
  state.shouldAttach = shouldAttachApexReceipts;

  // A disabled clean startup must not add a process-wide presentation wrap.
  // An older installed wrap must still be upgraded so v2 can suppress stale
  // owned presentation and restore stock Pi chrome while Apex is disabled.
  if (!apexPresentationEnabled() && !state.installed) return;
  if (
    state.installed &&
    state.version >= HEADLESS_WRAPPER_VERSION &&
    state.liveBundle !== "pending"
  )
    return;

  // v2 wrapped exactly one prototype (the imported copy). The helper prefers
  // the stored pristine originals, so the upgrade path replaces stale
  // wrappers without touching them.
  if (!wrapToolExecutionPrototype(ToolExecutionComponent.prototype as object, state))
    return;

  state.version = HEADLESS_WRAPPER_VERSION;
  state.installed = true;
  void patchLiveBundlePrototype(state);
}

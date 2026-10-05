// Receipt selection through Pi's public tool renderer resolver. Tool owners keep execution.
import type { ExtensionAPI, ToolRenderers, ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import { apexPresentationEnabled } from "./presentation.ts";

export const HEADLESS_STATE_KEY = Symbol.for("pi.apex.headlessReceipts.state");
export const RECEIPTS_KEY = Symbol.for("pi.apex.headlessReceipts.registry");

export type HeadlessReceiptOptions = { overrideOwned?: boolean; suppressOwnedWhenDisabled?: boolean };
export type HeadlessRenderers = { renderCall: unknown; renderResult: unknown };
export type RegisteredReceipt = HeadlessRenderers & { overrideOwned: boolean; suppressOwnedWhenDisabled?: boolean };
export type RegisteredPrefix = { prefix: string; resolve: (toolName: string) => RegisteredReceipt };
export type HeadlessRendererFactory = (toolName: string) => HeadlessRenderers;
export type HeadlessPresentation = { renderCall?: unknown; renderResult?: unknown; renderShell?: unknown; [key: string]: unknown };
export type HeadlessComponent = { toolName?: string; toolDefinition?: HeadlessPresentation; builtInToolDefinition?: HeadlessPresentation };
export type HeadlessReceiptState = {
  registry: Map<string, RegisteredReceipt>;
  prefixes: RegisteredPrefix[];
  seenDefinitions: Map<string, HeadlessPresentation>;
  // Runtime APIs become invalid on reload, so registration is generation-scoped.
  owner?: ExtensionAPI;
};
type ReceiptGlobal = typeof globalThis & {
  [HEADLESS_STATE_KEY]?: HeadlessReceiptState;
  [RECEIPTS_KEY]?: Map<string, RegisteredReceipt>;
};

export function getHeadlessReceiptState(): HeadlessReceiptState {
  const global = globalThis as ReceiptGlobal;
  const state = global[HEADLESS_STATE_KEY] ??= {
    registry: global[RECEIPTS_KEY] ?? new Map<string, RegisteredReceipt>(),
    prefixes: [],
    seenDefinitions: new Map(),
  };
  state.prefixes ??= [];
  state.seenDefinitions ??= new Map();
  global[RECEIPTS_KEY] = state.registry;
  return state;
}

export function rememberedToolDefinition(name: string): HeadlessPresentation | undefined {
  return getHeadlessReceiptState().seenDefinitions.get(name);
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


/** Public resolver shared by the transcript and our read-only Agents peek. */
export const resolveHeadlessToolRenderers: ToolRendererResolver = (toolName, next) => {
  const state = getHeadlessReceiptState();
  const owned = next();
  if (definitionOwnsPresentation(owned as HeadlessPresentation | undefined)) {
    if (state.seenDefinitions.has(toolName) || state.seenDefinitions.size < 256) {
      state.seenDefinitions.set(toolName, owned as HeadlessPresentation);
    }
  }
  const registered = () => state.registry.get(toolName) ?? matchPrefixReceipt(state, toolName);
  if (!registered()) return owned;
  // Pi keeps this object on the row. Getters let already-created rows honor a
  // live /ui switch without wrapping Pi's component methods.
  const selected = (): ToolRenderers | undefined => {
    const receipt = registered();
    if (!apexPresentationEnabled()) {
      return receipt?.suppressOwnedWhenDisabled ? undefined : owned;
    }
    if (!receipt || (!receipt.overrideOwned && definitionOwnsPresentation(owned as HeadlessPresentation | undefined))) {
      return owned;
    }
    return { renderCall: receipt.renderCall, renderResult: receipt.renderResult, renderShell: "self" } as ToolRenderers;
  };
  return {
    get renderCall() { return selected()?.renderCall; },
    get renderResult() { return selected()?.renderResult; },
    get renderShell() { return selected()?.renderShell ?? "default"; },
  };
};

/** One public resolver per active extension runtime, including chrome-off startup. */
export function installHeadlessReceipts(pi: ExtensionAPI): void {
  const state = getHeadlessReceiptState();
  if (state.owner) {
    try {
      state.owner.getFlag("__pi_receipts_probe");
      return;
    } catch {
      // The old extension runtime was invalidated by /reload or session replacement.
    }
  }
  pi.registerToolRenderer(resolveHeadlessToolRenderers);
  state.seenDefinitions.clear();
  state.owner = pi;
}

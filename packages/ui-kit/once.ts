import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Interned key so every jiti copy of the kit shares one bag (moduleCache: false). */
const SHARED_KEY = Symbol.for("pi.ui-kit.shared");

type SharedBag = {
  toolsPi?: ExtensionAPI;
  presentation: boolean;
  hostListeners: boolean;
  chromeClear: boolean;
  hosts: Map<string, unknown>;
  landings: Map<string, unknown>;
};

type ProcessBag = NodeJS.Process & { [SHARED_KEY]?: SharedBag };

function bag(): SharedBag {
  const proc = process as ProcessBag;
  let shared = proc[SHARED_KEY];
  if (!shared) {
    shared = {
      presentation: false,
      hostListeners: false,
      chromeClear: false,
      hosts: new Map(),
      landings: new Map(),
    };
    proc[SHARED_KEY] = shared;
  }
  return shared;
}

export function uiKitShared(): SharedBag {
  return bag();
}

/**
 * `api.getFlag` calls assertActive (loader.js createExtensionAPI). After
 * `/reload` or session replacement the previous runtime is invalidate()d, so
 * probing the stored claimant throws and this generation may re-claim.
 * Live claimants must still dedupe apex/claude/hal on one runtime.
 */
function claimantIsStale(pi: ExtensionAPI | undefined): boolean {
  if (!pi) return true;
  try {
    pi.getFlag("__pi_ui_kit_probe");
    return false;
  } catch {
    return true;
  }
}

/** Drop generation-scoped once-flags when the stored `pi` is gone or stale. Keep hosts/landings. */
export function releaseStaleUiKitClaimant(): void {
  const shared = bag();
  if (!claimantIsStale(shared.toolsPi)) return;
  if (!shared.toolsPi && !shared.presentation && !shared.hostListeners) return;
  shared.toolsPi = undefined;
  shared.presentation = false;
  shared.hostListeners = false;
}

/** True once: first caller registers kit tools/shortcuts/commands on its `pi`. */
export function claimSharedTools(pi: ExtensionAPI): boolean {
  releaseStaleUiKitClaimant();
  const shared = bag();
  if (shared.toolsPi) return false;
  shared.toolsPi = pi;
  return true;
}

export function resetUiKitOnceForTests(): void {
  const proc = process as ProcessBag;
  delete proc[SHARED_KEY];
}

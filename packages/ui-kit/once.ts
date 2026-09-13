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

/** True once: first caller registers kit tools/shortcuts/commands on its `pi`. */
export function claimSharedTools(pi: ExtensionAPI): boolean {
  const shared = bag();
  if (shared.toolsPi) return false;
  shared.toolsPi = pi;
  return true;
}

export function resetUiKitOnceForTests(): void {
  const proc = process as ProcessBag;
  delete proc[SHARED_KEY];
}

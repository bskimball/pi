// Temporary: adds claude-sonnet-5-5 to the claude-bridge provider until pi-ai's
// Anthropic catalog ships it (pi-claude-bridge mirrors that catalog and has no
// model config). Once the catalog has the id this becomes a no-op and says so;
// delete this file then.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

const PROVIDER_ID = "claude-bridge";
const MODEL_ID = "claude-sonnet-5-5";
const SHIM_PATH = "agent/extensions/claude-bridge-sonnet-5-5.ts";

type BridgeModel = { id: string; [key: string]: unknown };

export function withSonnet55<T extends BridgeModel>(models: T[]): T[] {
  if (models.some(m => m.id === MODEL_ID)) return models;
  const base = models.find(m => m.id === "claude-sonnet-5") ?? models[0];
  if (!base) return models;
  return [
    ...models,
    {
      ...base,
      id: MODEL_ID,
      name: "Claude Sonnet 5.5",
      // The bridge serves ids it has not measured at 200K (bare id, no [1m]);
      // the registered window must match what it requests.
      contextWindow: 200_000,
      maxTokens: 128_000,
    },
  ];
}

export default function (pi: ExtensionAPI) {
  const obsolete = getBuiltinModels("anthropic").some(m => m.id === MODEL_ID);
  let notified = false;

  const augment = (ctx: ExtensionContext) => {
    const config = ctx.modelRegistry.getRegisteredProviderConfig(PROVIDER_ID);
    if (!config?.models?.length) return;
    const next = withSonnet55(config.models);
    // Pi validates the registration on its own, so resend the bridge's api/streamSimple.
    if (next !== config.models) pi.registerProvider(PROVIDER_ID, { ...config, models: next });
  };

  pi.on("session_start", (_event, ctx) => {
    if (!obsolete) {
      augment(ctx);
    } else if (!notified) {
      notified = true;
      ctx.ui.notify(`pi-ai now ships ${MODEL_ID}; delete ${SHIM_PATH}.`, "info");
    }
  });

  // A later bridge instance registers in its own session_start, which runs after
  // this one (local extensions load before packages); catch it before the first turn.
  pi.on("agent_start", (_event, ctx) => {
    if (!obsolete) augment(ctx);
  });
}

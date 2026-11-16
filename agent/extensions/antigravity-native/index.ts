import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { AntigravityRuntime } from "pi-agy-acp/src/runtime.ts";
import { defaults } from "pi-agy-acp/src/config.ts";
import { runCommand } from "pi-agy-acp/src/host.ts";
import { streamPi } from "pi-agy-acp/src/pi-stream.ts";
import { createHost } from "./host.ts";
import { ReplayCheckpoints } from "./context.ts";

function modelConfigs(runtime: AntigravityRuntime): ProviderModelConfig[] {
  return runtime.catalog.list().map((model) => {
    const efforts = runtime.catalog.effortsFor(model.id);
    return {
      id: model.id, name: model.name, input: ["text", "image"], reasoning: efforts.length > 0,
      thinkingLevelMap: {
        off: null, minimal: null, low: efforts.includes("low") ? "low" : null,
        medium: efforts.includes("medium") ? "medium" : null,
        high: efforts.includes("high") ? "high" : null, xhigh: null, max: null,
      },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: runtime.contextWindowFor(model.id), maxTokens: 65536,
    };
  });
}

export default async function (pi: ExtensionAPI) {
  let registered = false;
  let refreshing = false;
  const checkpoints = new ReplayCheckpoints(process.env.PI_SUBAGENT === "1");
  let models: ProviderModelConfig[] = [];
  let active: ReturnType<typeof createRuntime> | undefined;

  function createRuntime() {
    const home = mkdtempSync(join(tmpdir(), `pi-antigravity-${process.pid}-`));
    const host = createHost();
    const runtime = new AntigravityRuntime({
      config: { ...defaults, provider: "antigravity", displayName: "Antigravity (native ACP)", home, defaultEffort: "medium" },
      spawnAcp: host.spawnAcp, runCommand,
      log: { info() {}, warn() {} },
      onModelsChanged() {
        models = modelConfigs(runtime);
        if (registered && !refreshing) register();
      },
    });
    return {
      runtime,
      async dispose() {
        await runtime.dispose();
        await host.waitForShutdown();
        rmSync(home, { recursive: true, force: true });
      },
    };
  }

  async function discover(options?: { force?: boolean; signal?: AbortSignal }) {
    // Help/list-models have no session_shutdown. Discovery must own its cleanup.
    const handle = active ?? createRuntime();
    const temporary = handle !== active;
    refreshing = true;
    try {
      await handle.runtime.warmup(options);
      models = modelConfigs(handle.runtime);
    } finally {
      refreshing = false;
      if (temporary) await handle.dispose();
    }
  }

  function register() {
    pi.registerProvider("antigravity", {
      name: "Antigravity (native ACP)", api: "antigravity-native-acp",
      baseUrl: "acp://local", apiKey: "local-agy", models,
      streamSimple: (model, context, options) => streamPi({
        stream: (request) => {
          active ??= createRuntime();
          return active.runtime.stream(checkpoints.prepare(request));
        },
      }, model, context, options),
      refreshModels: async (context) => {
        if (context?.allowNetwork !== false) await discover({ force: context?.force, signal: context?.signal });
        return models;
      },
    });
  }

  await discover();
  register();
  registered = true;
  pi.on("session_shutdown", async () => {
    await active?.dispose();
    active = undefined;
    checkpoints.clear();
  });
  pi.on("session_tree", () => { checkpoints.reset(false); return active?.runtime.resetConversations(); });
  pi.on("session_compact", () => { checkpoints.reset(); return active?.runtime.resetConversations(); });
  pi.on("session_start", () => {
    checkpoints.clear();
    return active?.runtime.resetConversations();
  });
  pi.on("agent_settled", (_event, ctx) => {
    active?.runtime.settleSession(ctx.sessionManager.getSessionId());
  });
}

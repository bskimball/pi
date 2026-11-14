import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { normalizeContext, type TranscriptContext } from "@earendil-works/pi-ai";
import { AntigravityRuntime } from "pi-agy-acp/src/runtime.ts";
import { defaults } from "pi-agy-acp/src/config.ts";
import { runCommand } from "pi-agy-acp/src/host.ts";
import { streamPi } from "pi-agy-acp/src/pi-stream.ts";
import { createHost } from "./host.ts";

export function withoutPiInstructions(context: TranscriptContext): TranscriptContext {
  return normalizeContext({
    messages: context.messages.map((message) => message.role === "system"
      ? {
          role: "system", content: "", timestamp: message.timestamp,
          toolsAdded: message.toolsAdded, toolsRemoved: message.toolsRemoved,
        }
      : message),
  });
}

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
  let modeInstructions = "";
  let models: ProviderModelConfig[] = [];
  let active: ReturnType<typeof createRuntime> | undefined;

  function createRuntime() {
    const home = mkdtempSync(join(tmpdir(), `pi-antigravity-${process.pid}-`));
    const host = createHost();
    const runtime = new AntigravityRuntime({
      config: { ...defaults, provider: "antigravity", displayName: "Antigravity (native ACP)", home },
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
          // Only the mode owner's card may enter ACP, including after payload hooks.
          return active.runtime.stream({
            model: request.model,
            messages: request.messages.filter((message) => message.role !== "system"),
            system: modeInstructions || undefined,
            tools: request.tools, sessionId: request.sessionId, signal: request.signal,
            reasoningEffort: request.reasoningEffort,
          });
        },
      }, model, withoutPiInstructions(context), options),
      refreshModels: async (context) => {
        if (context?.allowNetwork !== false) await discover({ force: context?.force, signal: context?.signal });
        return models;
      },
    });
  }

  await discover();
  register();
  registered = true;
  const unsubscribeGuidance = pi.events.on("pi:modes:guidance", (payload) => {
    const guidance = payload as { mode?: string; instructions?: unknown } | undefined;
    modeInstructions = guidance && ["apex", "apex-orchestrate", "fusion"].includes(guidance.mode ?? "")
      && typeof guidance.instructions === "string" ? guidance.instructions : "";
  });
  pi.on("session_shutdown", async () => {
    unsubscribeGuidance();
    await active?.dispose();
    active = undefined;
  });
  pi.on("session_tree", () => active?.runtime.resetConversations());
  pi.on("session_compact", () => active?.runtime.resetConversations());
  pi.on("session_start", () => {
    modeInstructions = "";
    return active?.runtime.resetConversations();
  });
  pi.on("agent_settled", (_event, ctx) => {
    active?.runtime.settleSession(ctx.sessionManager.getSessionId());
  });
}

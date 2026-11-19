import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { AntigravityRuntime } from "pi-agy-acp/src/runtime.ts";
import { defaults } from "pi-agy-acp/src/config.ts";
import { runCommand } from "pi-agy-acp/src/host.ts";
import { streamPi } from "pi-agy-acp/src/pi-stream.ts";
import type { StreamChunk } from "pi-agy-acp/src/protocol.ts";
import { createHost } from "./host.ts";
import { ReplayCheckpoints } from "./context.ts";

const PROVIDER_ID = "agy-acp";

function normalizeUsageChunk(chunk: StreamChunk): StreamChunk {
  if (chunk.type !== "usage") return chunk;
  const u = chunk.usage;
  const promptTokens = u.inputTokens + (u.cacheReadTokens ?? 0);
  if (promptTokens <= u.totalTokens) return chunk;
  // ACP reports cumulative multi-step input/cacheRead totals while totalTokens is single-call occupancy.
  // Scale prompt buckets to totalTokens so Pi's silent-overflow check (input + cacheRead > contextWindow)
  // does not falsely trigger compaction on long tool-call turns.
  const cacheReadTokens = u.cacheReadTokens ? Math.floor((u.cacheReadTokens / promptTokens) * u.totalTokens) : 0;
  return {
    type: "usage",
    usage: {
      ...u,
      inputTokens: u.totalTokens - cacheReadTokens,
      cacheReadTokens,
    },
  };
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
      // ACP learns the actual window from inference; Pi needs a nonzero window before the first turn.
      contextWindow: runtime.contextWindowFor(model.id) || (model.id.startsWith("gpt-oss-120b") ? 131072 : 256000),
      maxTokens: 65536,
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
      config: { ...defaults, provider: PROVIDER_ID, displayName: "Antigravity (native ACP)", home, defaultEffort: "medium" },
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

  async function discover(options?: { force?: boolean; signal?: AbortSignal; tolerateTimeout?: boolean }) {
    // Help/list-models have no session_shutdown. Discovery must own its cleanup.
    const handle = active ?? createRuntime();
    const temporary = handle !== active;
    refreshing = true;
    try {
      await handle.runtime.warmup(options).then(() => {
        models = modelConfigs(handle.runtime);
      }, (error: unknown) => {
        if (!options?.tolerateTimeout || error !== options.signal?.reason) throw error;
      });
    } finally {
      refreshing = false;
      if (temporary) await handle.dispose();
    }
  }

  function register() {
    pi.registerProvider(PROVIDER_ID, {
      name: "Antigravity (native ACP)", api: "antigravity-native-acp",
      baseUrl: "acp://local", apiKey: "local-agy", models,
      streamSimple: (model, context, options) => streamPi({
        async *stream(request) {
          active ??= createRuntime();
          for await (const chunk of active.runtime.stream(checkpoints.prepare(request))) {
            yield normalizeUsageChunk(chunk);
          }
        },
      }, model, context, options),
      refreshModels: async (context) => {
        if (context?.allowNetwork !== false) await discover({ force: context?.force, signal: context?.signal });
        return models;
      },
    });
  }

  // Keep first-launch model selection working without inheriting ACP's two-minute RPC deadline.
  await discover({ signal: AbortSignal.timeout(10_000), tolerateTimeout: true });
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

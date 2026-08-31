import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LATEST_RESULT_CHARS,
  MAX_LIVE_WORKERS,
  WorkerRuntime,
  canStartWorker,
  countLiveWorkers,
  isModelFallbackError,
  shouldRetryModelFallback,
  splitQualifiedModel,
  type RuntimeEventWorker,
  type WorkerRuntimeEventHooks,
} from "../worker-runtime.ts";
import { ActivityLedger } from "../activity-ledger.ts";

describe("async worker model fallback policy", () => {
  const retryable = {
    hasNextAttempt: true,
    fallbackInProgress: false,
    killReason: undefined,
    resultText: "",
    modelError: "503: auth_unavailable",
    activitiesStarted: 0,
  };

  it("retries a clean provider/model failure", () => {
    assert.equal(shouldRetryModelFallback(retryable), true);
  });

  it("classifies only provider/model availability failures", () => {
    assert.equal(isModelFallbackError("503: auth_unavailable"), true);
    assert.equal(isModelFallbackError("No API key found for provider"), true);
    assert.equal(isModelFallbackError("429: too many requests"), true);
    assert.equal(isModelFallbackError("Model not found: provider/id"), true);
    assert.equal(isModelFallbackError("tool execution failed"), false);
    assert.equal(isModelFallbackError("context window exceeded"), false);
    assert.equal(isModelFallbackError("abort requested"), false);
  });

  it("does not replay after output, tools, kills, non-model errors, or the last model", () => {
    assert.equal(
      shouldRetryModelFallback({ ...retryable, resultText: "partial result" }),
      false,
    );
    assert.equal(
      shouldRetryModelFallback({ ...retryable, activitiesStarted: 1 }),
      false,
    );
    assert.equal(
      shouldRetryModelFallback({ ...retryable, killReason: "abort requested" }),
      false,
    );
    assert.equal(
      shouldRetryModelFallback({ ...retryable, hasNextAttempt: false }),
      false,
    );
    assert.equal(
      shouldRetryModelFallback({ ...retryable, modelError: undefined }),
      false,
    );
    assert.equal(
      shouldRetryModelFallback({
        ...retryable,
        modelError: "implementation failed",
      }),
      false,
    );
  });

  it("splits provider-qualified model identifiers", () => {
    assert.deepEqual(splitQualifiedModel("local-proxy/claude-opus-5"), {
      provider: "local-proxy",
      modelId: "claude-opus-5",
    });
    assert.deepEqual(
      splitQualifiedModel("cloudflare-workers-ai/@cf/zai-org/glm-5.2"),
      {
        provider: "cloudflare-workers-ai",
        modelId: "@cf/zai-org/glm-5.2",
      },
    );
    assert.equal(splitQualifiedModel("bare-model"), undefined);
    assert.equal(splitQualifiedModel(undefined), undefined);
  });
});

describe("WorkerRuntime control plane", () => {
  function worker(
    overrides: Partial<RuntimeEventWorker> = {},
  ): RuntimeEventWorker {
    return {
      countsTowardCap: true,
      closed: false,
      lifecycle: "running",
      phase: "model",
      updatedAt: 0,
      renderVersion: 0,
      fallbackEpoch: 0,
      fallbackInProgress: false,
      fallbackAwaitingAgentStart: false,
      ledger: new ActivityLedger(),
      errors: [],
      generation: 1,
      generationStartedAt: Date.now(),
      turns: 0,
      maxTurns: 3,
      pendingSteer: 0,
      pendingFollowUp: 0,
      pendingUi: new Map(),
      latestAssistantText: "",
      latestResult: "",
      modelAttemptUsedTools: false,
      exitCode: null,
      ...overrides,
    };
  }

  function hooks(
    overrides: Partial<WorkerRuntimeEventHooks<RuntimeEventWorker>> = {},
  ): WorkerRuntimeEventHooks<RuntimeEventWorker> {
    return {
      normalizeToolName: (name) => String(name ?? "").slice(0, 40),
      summarizeToolArgs: (args) => JSON.stringify(args ?? {}),
      extractAssistantText: (message) =>
        String((message as { text?: string }).text ?? ""),
      shouldRetryFallback: () => false,
      retryFallback: async () => "exhausted",
      ...overrides,
    };
  }

  it("counts cap-holding workers until closed, at MAX_LIVE_WORKERS", () => {
    assert.equal(MAX_LIVE_WORKERS, 3);
    const cap = (n: number) =>
      Array.from({ length: n }, () => ({ countsTowardCap: true, closed: false }));
    assert.equal(canStartWorker(cap(4)), true);
    assert.equal(canStartWorker(cap(5)), false);
    const holding = [
      { countsTowardCap: true, closed: false },
      { countsTowardCap: true, closed: false },
      { countsTowardCap: true, closed: false },
      { countsTowardCap: true, closed: false },
      { countsTowardCap: true, closed: false },
    ];
    holding[4] = { countsTowardCap: true, closed: true };
    assert.equal(countLiveWorkers(holding), 4);
    assert.equal(canStartWorker(holding), true);
    holding[3] = { countsTowardCap: false, closed: false };
    assert.equal(countLiveWorkers(holding), 3);
  });

  it("owns capacity, ordered pruning, bounded errors, and subscribers", () => {
    const runtime = new WorkerRuntime<RuntimeEventWorker>({
      maxErrors: 2,
      maxSettled: 1,
      normalizeError: (message) => message.toUpperCase(),
    });
    const first = worker({ lifecycle: "settled", countsTowardCap: false });
    const second = worker({ lifecycle: "failed", countsTowardCap: false });
    const live = worker();
    runtime.workers.set("first", first);
    runtime.workers.set("live", live);
    runtime.workers.set("second", second);
    assert.equal(runtime.liveCount(), 1);
    assert.equal(runtime.canStart(), true);
    runtime.pruneSettled();
    assert.equal(runtime.workers.has("first"), false);
    assert.equal(runtime.workers.has("second"), true);
    assert.equal(runtime.workers.has("live"), true);

    let notifications = 0;
    live.subscribers = new Set([() => notifications++]);
    runtime.pushError(live, "one");
    runtime.pushError(live, "two");
    runtime.pushError(live, "three");
    runtime.notify(live);
    assert.deepEqual(live.errors, ["TWO", "THREE"]);
    assert.equal(notifications, 1);
    assert.equal(live.renderVersion, 1);
  });

  it("does not repaint pinned cards for streamed worker deltas", () => {
    const runtime = new WorkerRuntime<RuntimeEventWorker>();
    let invalidations = 0;
    let subscriberCalls = 0;
    const item = worker({ pinnedInvalidate: () => invalidations++ });
    item.subscribers = new Set([() => subscriberCalls++]);
    const eventHooks = hooks();

    for (let index = 0; index < 2_000; index++) {
      runtime.handleEvent(
        item,
        { type: "message_update", delta: `token-${index}` },
        eventHooks,
      );
      runtime.handleEvent(
        item,
        { type: "tool_execution_update", toolCallId: "call", output: index },
        eventHooks,
      );
      runtime.handleEvent(
        item,
        { type: "bash_execution_update", toolCallId: "call", output: index },
        eventHooks,
      );
    }

    assert.equal(invalidations, 0);
    assert.equal(subscriberCalls, 0);
    assert.equal(item.renderVersion, 0);

    runtime.handleEvent(item, { type: "turn_start" }, eventHooks);
    assert.equal(invalidations, 1);
    assert.equal(subscriberCalls, 1);
    assert.equal(item.renderVersion, 1);
    runtime.clearTimers(item);
  });

  it("publishes one pinned repaint per non-streaming lifecycle event", () => {
    const runtime = new WorkerRuntime<RuntimeEventWorker>();
    let repaintRequests = 0;
    const item = worker({ pinnedInvalidate: () => repaintRequests++ });
    const eventHooks = hooks();

    for (let index = 0; index < 250; index++) {
      runtime.handleEvent(
        item,
        {
          type: "tool_execution_start",
          toolCallId: `call-${index}`,
          toolName: "read",
        },
        eventHooks,
      );
      runtime.handleEvent(
        item,
        { type: "tool_execution_end", toolCallId: `call-${index}` },
        eventHooks,
      );
    }

    assert.equal(repaintRequests, 500);
    assert.equal(item.renderVersion, 500);
    runtime.clearTimers(item);
  });

  it("stores only a bounded tail of assistant result text", () => {
    const runtime = new WorkerRuntime<RuntimeEventWorker>();
    const item = worker();
    const huge = "x".repeat(LATEST_RESULT_CHARS + 4_000);
    runtime.handleEvent(
      item,
      {
        type: "message_end",
        message: { role: "assistant", text: huge },
      },
      hooks(),
    );
    assert.equal(item.latestAssistantText.length, LATEST_RESULT_CHARS);
    assert.equal(item.latestResult, item.latestAssistantText);
    assert.equal(item.latestResult, "x".repeat(LATEST_RESULT_CHARS));
    runtime.clearTimers(item);
  });

  it("keeps a stream-delta tail when the final message_end is stubbed", () => {
    const runtime = new WorkerRuntime<RuntimeEventWorker>();
    const item = worker();
    runtime.handleEvent(
      item,
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hello " },
      },
      hooks(),
    );
    runtime.handleEvent(
      item,
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "world" },
      },
      hooks(),
    );
    assert.equal(item.latestAssistantText, "hello world");
    runtime.handleEvent(
      item,
      { type: "message_end", truncated: true },
      hooks(),
    );
    assert.equal(item.latestResult, "hello world");
    runtime.clearTimers(item);
  });

  it("keeps only a bounded tail from a huge text_delta", () => {
    const runtime = new WorkerRuntime<RuntimeEventWorker>();
    const item = worker();
    runtime.handleEvent(
      item,
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: `keep-${"x".repeat(LATEST_RESULT_CHARS + 8_000)}`,
        },
      },
      hooks(),
    );
    assert.equal(item.latestAssistantText.length, LATEST_RESULT_CHARS);
    assert.equal(item.latestAssistantText.endsWith("x".repeat(80)), true);
    assert.equal(item.latestAssistantText.startsWith("keep-"), false);
    runtime.clearTimers(item);
  });

  it("derives idle phase from the activity ledger", () => {
    const runtime = new WorkerRuntime<RuntimeEventWorker>();
    const item = worker();
    runtime.armIdle(item);
    assert.equal(item.phase, "model");
    runtime.clearIdle(item);
    item.ledger.start("bash", "test", "call");
    runtime.armIdle(item);
    assert.equal(item.phase, "tool");
    runtime.clearIdle(item);
    item.ledger.end("call");
    item.lifecycle = "compacting";
    runtime.armIdle(item);
    assert.equal(item.phase, "compacting");
    runtime.clearIdle(item);
  });

  it("cooperatively aborts without force killing a settled worker", async () => {
    const runtime = new WorkerRuntime<RuntimeEventWorker>({ abortGraceMs: 20 });
    const item = worker();
    item.client = {
      isClosed: false,
      async request() {
        item.lifecycle = "settled";
        return { success: true };
      },
      closeStdin() {},
    };
    const result = await runtime.abortAndEscalate(item);
    assert.deepEqual(result, {
      cooperative: true,
      settled: true,
      escalated: false,
      exited: false,
    });
    assert.equal(item.killReason, "abort requested");
  });

  it("owns RPC tool, message, queue, UI, retry, and compaction transitions", () => {
    const runtime = new WorkerRuntime<RuntimeEventWorker>();
    const item = worker();
    const eventHooks = hooks();

    runtime.handleEvent(
      item,
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "npm test" },
      },
      eventHooks,
    );
    assert.equal(item.modelAttemptUsedTools, true);
    assert.equal(item.phase, "tool");
    assert.equal(item.ledger.runningCount, 1);

    runtime.handleEvent(
      item,
      { type: "tool_execution_end", toolCallId: "call-1", isError: false },
      eventHooks,
    );
    assert.equal(item.phase, "model");
    assert.equal(item.ledger.runningCount, 0);

    runtime.handleEvent(
      item,
      {
        type: "message_end",
        message: { role: "assistant", text: "final", stopReason: "stop" },
      },
      eventHooks,
    );
    assert.equal(item.latestAssistantText, "final");
    assert.equal(item.latestResult, "final");

    runtime.handleEvent(
      item,
      { type: "queue_update", steering: [1, 2], followUp: [1] },
      eventHooks,
    );
    assert.equal(item.pendingSteer, 2);
    assert.equal(item.pendingFollowUp, 1);

    runtime.handleEvent(
      item,
      {
        type: "extension_ui_request",
        id: "question-1",
        method: "confirm",
        title: "Proceed?",
      },
      eventHooks,
    );
    assert.equal(item.pendingUi.get("question-1")?.expectsReply, true);

    runtime.handleEvent(item, { type: "auto_retry_start" }, eventHooks);
    assert.equal(item.lifecycle, "retrying");
    assert.equal(item.phase, "retry");
    runtime.handleEvent(
      item,
      { type: "auto_retry_end", success: false, finalError: "retry failed" },
      eventHooks,
    );
    assert.equal(item.lifecycle, "running");
    assert.equal(item.errors.at(-1), "retry failed");

    runtime.handleEvent(item, { type: "compaction_start" }, eventHooks);
    assert.equal(item.lifecycle, "compacting");
    assert.equal(item.phase, "compacting");
    runtime.handleEvent(
      item,
      { type: "compaction_end", aborted: true },
      eventHooks,
    );
    assert.equal(item.lifecycle, "running");
    assert.equal(item.errors.at(-1), "compaction aborted");
    runtime.clearTimers(item);
  });

  it("does not re-arm idle after the turn limit force-kills a worker", () => {
    const runtime = new WorkerRuntime<RuntimeEventWorker>();
    const item = worker({ maxTurns: 0 });
    runtime.handleEvent(item, { type: "turn_start" }, hooks());
    assert.equal(item.killReason, "exceeded 0 turns");
    assert.equal(item.idleTimer, undefined);
  });

  it("settles a generation and delegates only circuit and notification policy", () => {
    const runtime = new WorkerRuntime<RuntimeEventWorker>();
    const item = worker({
      latestAssistantText: "completed result",
      pendingSteer: 2,
      pendingFollowUp: 1,
    });
    item.ledger.start("bash", "test", "call");
    let notifications = 0;
    item.subscribers = new Set([() => notifications++]);
    let successful = 0;
    let settled = 0;
    runtime.handleEvent(
      item,
      { type: "agent_settled" },
      hooks({
        onSuccessfulSettlement: () => successful++,
        afterSettlementNotify: () => settled++,
      }),
    );

    assert.equal(item.lifecycle, "settled");
    assert.equal(item.phase, "none");
    assert.equal(item.latestResult, "completed result");
    assert.equal(item.pendingSteer, 0);
    assert.equal(item.pendingFollowUp, 0);
    assert.equal(item.ledger.runningCount, 0);
    assert.equal(item.ledger.snapshot().at(-1)?.status, "completed");
    assert.equal(successful, 1);
    assert.equal(settled, 1);
    assert.equal(notifications, 1);
  });

  it("fails settlement when an eligible fallback chain is exhausted", async () => {
    const runtime = new WorkerRuntime<RuntimeEventWorker>();
    const item = worker({ modelError: "503 provider unavailable" });
    let failures = 0;
    runtime.handleEvent(
      item,
      { type: "agent_settled" },
      hooks({
        shouldRetryFallback: () => true,
        retryFallback: async () => "exhausted",
        onFailedSettlement: () => failures++,
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(item.lifecycle, "failed");
    assert.equal(item.errors.at(-1), "503 provider unavailable");
    assert.equal(failures, 1);
  });

  it("starts a clean follow-up generation", () => {
    const runtime = new WorkerRuntime<RuntimeEventWorker>();
    const item = worker({
      lifecycle: "settled",
      generationSettledAt: Date.now(),
      turns: 3,
      pendingSteer: 2,
      pendingFollowUp: 1,
      latestAssistantText: "old assistant text",
      latestResult: "old",
      modelError: "old error",
      circuitFailureAttempt: 0,
      modelAttemptUsedTools: true,
      killReason: "old reason",
      exitCode: 7,
    });
    item.pendingUi.set("old-question", {
      id: "old-question",
      method: "confirm",
      receivedAt: Date.now(),
      expectsReply: true,
    });
    runtime.startGeneration(item);
    assert.equal(item.lifecycle, "running");
    assert.equal(item.generation, 2);
    assert.equal(item.generationSettledAt, undefined);
    assert.equal(item.turns, 0);
    assert.equal(item.pendingSteer, 0);
    assert.equal(item.pendingFollowUp, 0);
    assert.equal(item.pendingUi.size, 0);
    assert.equal(item.latestAssistantText, "");
    assert.equal(item.latestResult, "");
    assert.equal(item.modelError, undefined);
    assert.equal(item.modelAttemptUsedTools, false);
    assert.equal(item.killReason, undefined);
    assert.equal(item.exitCode, null);
    runtime.clearTimers(item);
  });

  it("resets state when agent_start begins a queued follow-up generation", () => {
    const runtime = new WorkerRuntime<RuntimeEventWorker>();
    const item = worker({
      lifecycle: "settled",
      turns: 2,
      pendingFollowUp: 1,
      latestAssistantText: "old assistant text",
      latestResult: "old result",
      modelError: "old error",
      modelAttemptUsedTools: true,
      generationSettledAt: Date.now(),
    });
    item.pendingUi.set("old-question", {
      id: "old-question",
      method: "input",
      receivedAt: Date.now(),
      expectsReply: true,
    });
    runtime.handleEvent(item, { type: "agent_start" }, hooks());
    assert.equal(item.lifecycle, "running");
    assert.equal(item.generation, 2);
    assert.equal(item.turns, 0);
    assert.equal(item.pendingFollowUp, 0);
    assert.equal(item.pendingUi.size, 0);
    assert.equal(item.latestAssistantText, "");
    assert.equal(item.latestResult, "");
    assert.equal(item.modelError, undefined);
    assert.equal(item.modelAttemptUsedTools, false);
    runtime.clearTimers(item);
  });

  it("starts a new generation when a failed live worker receives follow-up", () => {
    const runtime = new WorkerRuntime<RuntimeEventWorker>();
    const item = worker({
      lifecycle: "failed",
      latestResult: "failed result",
      modelError: "provider failed",
      generationSettledAt: Date.now(),
    });
    runtime.handleEvent(item, { type: "agent_start" }, hooks());
    assert.equal(item.lifecycle, "running");
    assert.equal(item.generation, 2);
    assert.equal(item.latestResult, "");
    assert.equal(item.modelError, undefined);
    runtime.clearTimers(item);
  });

  it("ignores exhausted fallback completion from an older generation", async () => {
    const runtime = new WorkerRuntime<RuntimeEventWorker>();
    const item = worker({ modelError: "503 provider unavailable" });
    let resolveFallback!: (result: "exhausted") => void;
    const fallback = new Promise<"exhausted">((resolve) => {
      resolveFallback = resolve;
    });
    runtime.handleEvent(
      item,
      { type: "agent_settled" },
      hooks({
        shouldRetryFallback: () => true,
        retryFallback: () => fallback,
      }),
    );
    runtime.startGeneration(item);
    resolveFallback("exhausted");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(item.lifecycle, "running");
    assert.equal(item.generation, 2);
    assert.equal(item.errors.length, 0);
    runtime.clearTimers(item);
  });

  it("owns transport-exit settlement, cap release, and pruning", () => {
    const runtime = new WorkerRuntime<RuntimeEventWorker>({ maxSettled: 1 });
    const old = worker({
      lifecycle: "settled",
      countsTowardCap: false,
      exitCode: 0,
    });
    const item = worker();
    runtime.workers.set("old", old);
    runtime.workers.set("current", item);
    let failed = 0;
    let observedCap: boolean | undefined;
    let observedClient: unknown = "unset";
    item.client = {
      isClosed: true,
      async request() {
        return { success: false };
      },
      closeStdin() {},
    };
    item.subscribers = new Set([
      () => {
        observedCap = item.countsTowardCap;
        observedClient = item.client;
      },
    ]);
    runtime.handleExit(
      item,
      7,
      "process exited (code=7)",
      hooks({ onFailedSettlement: () => failed++ }),
    );
    assert.equal(item.lifecycle, "failed");
    assert.equal(item.exitCode, 7);
    assert.equal(item.countsTowardCap, false);
    assert.equal(item.client, undefined);
    assert.equal(item.errors.at(-1), "process exited (code=7)");
    assert.equal(failed, 1);
    assert.equal(observedCap, false);
    assert.equal(observedClient, undefined);
    assert.equal(runtime.workers.has("old"), false);
    assert.equal(runtime.workers.has("current"), true);
  });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import asyncTask from "./async-task.ts";
import ampTask from "./amp-task.ts";
import { discoverAgents } from "./runtime/agent-discovery.ts";
import { ActivityLedger } from "./runtime/activity-ledger.ts";
import {
  FUSION_CHAIN_PROMPT_CAP,
  FUSION_REUSE_CONTEXT_TOKENS,
  FusionLifecycle,
  applySidekickModel,
  fusionChainNudge,
  fusionIdentityFromState,
  fusionIdentityReceipt,
  fusionContextGuardReceipt,
  fusionContextGuardSteer,
  fusionContextOverLimit,
  fusionModelId,
} from "./runtime/fusion-lifecycle.ts";

function fusionHarness(
  pair: any = { lead: { provider: "p", modelId: "l", thinking: "medium" }, sidekick: { provider: "p", modelId: "s", thinking: "low" } },
) {
  const workers: any[] = [];
  const parked: string[] = [];
  const settled: Array<{ id: string; error: string }> = [];
  const started: string[] = [];
  const notified: string[] = [];
  const errored: string[] = [];
  const aborted: string[] = [];
  let branch: any[] = [];
  const lifecycle = new FusionLifecycle<any>({
    listWorkers: () => workers,
    startGeneration: (w: any) => { started.push(w.id); w.generation = (w.generation ?? 1) + 1; w.lifecycle = "running"; },
    settleFailed: (w: any, error: string) => { settled.push({ id: w.id, error }); w.lifecycle = "failed"; },
    parkWorker: (w: any, reason: string) => { parked.push(`${w.id}:${reason}`); w.closed = true; w.lifecycle = "closed"; },
    abortAndPark: async (w: any, reason: string) => { aborted.push(w.id); if (!w.closed) { parked.push(`${w.id}:${reason}`); w.closed = true; w.lifecycle = "closed"; } },
    notify: (w: any) => notified.push(w.id),
    pushError: (w: any, message: string) => errored.push(`${w.id}:${message}`),
    readBranch: () => branch,
  }, pair);
  const fusionWorker = (overrides: any = {}) => ({
    id: "task_1",
    fusion: true,
    closed: false,
    lifecycle: "settled",
    generation: 2,
    cwd: "/w",
    model: "p/s",
    thinking: "low",
    modelAttempts: ["p/s"],
    modelAttemptIndex: 0,
    fusionParentSessionId: "parent-1",
    sessionFile: "/s.jsonl",
    client: { isClosed: false, request: async () => ({ success: true }) },
    ...overrides,
  });
  return {
    workers, parked, settled, started, notified, errored, aborted,
    lifecycle,
    setBranch: (entries: any[]) => { branch = entries; },
    fusionWorker,
  };
}

const transcriptBranch = (sessionFile: string) => [
  { type: "custom", customType: "fusion-sidekick-session", data: { parentSessionId: "parent-1", sessionFile, cwd: "/w" } },
];

test("Fusion discovers the renamed sidekick profile without the old alias", () => {
  const agents = discoverAgents();
  assert.equal(agents.has("sidekick"), true);
  assert.equal(agents.get("sidekick")?.file.replaceAll("\\", "/").endsWith("agent/agents/sidekick.md"), true);
  assert.equal(agents.has("fusion-sidekick"), false);
});

test("Fusion identity receipts separate configuration from child-reported point-in-time state", () => {
  const pair = { lead: { provider: "p", modelId: "l", thinking: "high" }, sidekick: { provider: "p", modelId: "s", thinking: "low" } };
  const observed = fusionIdentityFromState({ success: true, data: { model: { provider: "q", id: "actual" }, thinkingLevel: "medium" } });
  assert.deepEqual(observed, { model: "q/actual", thinking: "medium" });
  assert.deepEqual(fusionIdentityReceipt(pair, observed), [
    "configured sidekick: p/s (thinking low)",
    "child-reported now: q/actual (thinking medium)",
    "warning: child-reported identity differs from configured sidekick",
  ]);
  assert.deepEqual(fusionIdentityReceipt(pair, undefined), [
    "configured sidekick: p/s (thinking low)",
    "child-reported now: unknown (readback unavailable)",
  ]);
  assert.equal(fusionIdentityFromState({ success: false, data: { model: { provider: "p", id: "s" } } }), undefined, "failed readback never presents the configured request as observed");
  const matching = fusionIdentityFromState({ success: true, data: { model: { provider: "p", id: "s" }, thinkingLevel: "low" } });
  assert.deepEqual(fusionIdentityReceipt(pair, matching), [
    "configured sidekick: p/s (thinking low)",
    "child-reported now: p/s (thinking low)",
  ]);
  for (const data of [{}, { model: { id: "s" } }, { model: { provider: "p" } }]) {
    const partial = fusionIdentityFromState({ success: true, data });
    assert.deepEqual(fusionIdentityReceipt(pair, partial), [
      "configured sidekick: p/s (thinking low)",
      "child-reported now: unknown (thinking unknown)",
    ], "incomplete identity is unknown, not a failed readback or a mismatch");
  }
});

test("Fusion runtime rejects roster dispatch and preserves an existing busy gate", async () => {
  const prior = process.env.PI_BEHAVIOR_MODE;
  const priorSidekick = process.env.PI_FUSION_SIDEKICK;
  process.env.PI_BEHAVIOR_MODE = "fusion";
  delete process.env.PI_FUSION_SIDEKICK;
  const handlers = new Map<string, Function[]>();
  const bus = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const emitBus = (name: string, payload: any) => { for (const fn of bus.get(name) ?? []) fn(payload); };
  // wrapToolDefinition copies description/parameters; mutating the registered object
  // is not enough unless registerTool runs again and re-wraps.
  let wrapped: { description: string; agent: string } | undefined;
  const snapshotWrap = (tool: any) => {
    if (tool?.name !== "task_start") return;
    wrapped = {
      description: tool.description as string,
      agent: tool.parameters.properties.agent.description as string,
    };
  };
  const pi: any = {
    registerTool: (tool: any) => { tools.set(tool.name, tool); snapshotWrap(tool); },
    registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
    on(name: string, fn: Function) { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
    events: { on(name: string, fn: Function) { bus.set(name, [...bus.get(name) ?? [], fn]); } },
    getThinkingLevel: () => "medium",
  };
  try {
    asyncTask(pi); ampTask(pi);
    const ctx: any = { cwd: process.cwd(), hasUI: false, ui: { setWidget() {} } };
    const blocked = await tools.get("task_start").execute("call", { agent: "machinist", prompt: "write a file" }, undefined, undefined, ctx);
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /only for sidekick/);
    const oldName = await tools.get("task_start").execute("call", { agent: "fusion-sidekick", prompt: "write a file" }, undefined, undefined, ctx);
    assert.equal(oldName.isError, true);
    assert.match(oldName.content[0].text, /Unknown agent "fusion-sidekick"/);
    const acceptedName = await tools.get("task_start").execute("call", { agent: "sidekick", prompt: "write a file" }, undefined, undefined, ctx);
    assert.equal(acceptedName.isError, true);
    assert.match(acceptedName.content[0].text, /Fusion sidekick configuration is unavailable/);
    const sync = await tools.get("task").execute("call", { agent: "machinist", prompt: "write a file" }, undefined, undefined, ctx);
    assert.equal(sync.isError, true);
    assert.match(sync.content[0].text, /Apex-only/);
    for (const agent of ["librarian", "stevedore", "oracle", "picasso"]) {
      const allowedSync = await tools.get("task").execute("call", { agent, prompt: "do work" }, AbortSignal.abort(), undefined, ctx);
      const text = allowedSync.content?.[0]?.text ?? "";
      assert.doesNotMatch(text, /Apex-only|Synchronous task spawning is disabled/);
    }
    const chain = await tools.get("task_chain").execute("call", { steps: [{ agent: "machinist", prompt: "write a file" }] }, undefined, undefined, ctx);
    assert.equal(chain.isError, true);
    const busy = { busy: true }; emitBus("pi:modes:query-busy", busy); assert.equal(busy.busy, true);
    const idle = { busy: false }; emitBus("pi:modes:query-busy", idle); assert.equal(idle.busy, false);
    assert.equal(handlers.get("tool_call")!.map(fn => fn({ toolName: "task", input: {} })).find(Boolean), undefined);
    for (const toolName of ["task_chain", "task_rebind"]) {
      const result = handlers.get("tool_call")!.map(fn => fn({ toolName, input: {} })).find(Boolean);
      assert.equal(result.block, true);
    }
    const advertised = () => tools.get("task_start");
    const agentParam = () => advertised().parameters.properties.agent.description as string;
    const wrappedAgent = () => wrapped?.agent ?? "";
    assert.match(advertised().description, /sidekick/);
    assert.doesNotMatch(advertised().description, /machinist|scout|artisan/);
    assert.match(advertised().description, /librarian|stevedore|oracle|picasso/);
    assert.match(agentParam(), /sidekick/);
    assert.doesNotMatch(agentParam(), /machinist|scout|artisan/);
    assert.match(wrapped?.description ?? "", /sidekick/);
    assert.doesNotMatch(wrapped?.description ?? "", /machinist|scout|artisan/);
    assert.match(wrappedAgent(), /sidekick/);
    emitBus("pi:modes:changed", { mode: "apex" });
    process.env.PI_BEHAVIOR_MODE = "apex";
    assert.match(advertised().description, /machinist|advisor|librarian|scout/);
    assert.doesNotMatch(advertised().description, /- (strategist|researcher|author|clerk):/);
    assert.doesNotMatch(advertised().description, /- sidekick:/);
    assert.match(agentParam(), /advisor|librarian|scout/);
    assert.doesNotMatch(agentParam(), /strategist|researcher|author|clerk/);
    assert.doesNotMatch(agentParam(), /sidekick/);
    assert.match(wrapped?.description ?? "", /machinist/);
    assert.match(wrappedAgent(), /machinist/);
    assert.match(tools.get("task").description, /Issue multiple task calls/);
    assert.match(tools.get("task").description, /advisor|librarian|scout/);
    assert.doesNotMatch(tools.get("task").description, /- (strategist|researcher|author|clerk):/);
    assert.doesNotMatch(tools.get("task").description, /- sidekick:/);
    assert.match(tools.get("task").parameters.properties.agent.description, /advisor|librarian|scout/);
    assert.doesNotMatch(tools.get("task").parameters.properties.agent.description, /strategist|researcher|author|clerk/);
    assert.doesNotMatch(tools.get("task").parameters.properties.agent.description, /sidekick/);
    assert.doesNotMatch(tools.get("task_chain").parameters.properties.steps.items.properties.agent.description, /strategist|researcher|author|clerk/);
    assert.doesNotMatch(tools.get("task_chain").parameters.properties.steps.items.properties.agent.description, /sidekick/);
    const apexSyncSidekick = await tools.get("task").execute("call", { agent: "sidekick", prompt: "do work" }, undefined, undefined, ctx);
    assert.equal(apexSyncSidekick.isError, true);
    assert.match(apexSyncSidekick.content[0].text, /Fusion-only.*switch to Fusion/);
    const apexAsyncSidekick = await tools.get("task_start").execute("call", { agent: "sidekick", prompt: "do work" }, undefined, undefined, ctx);
    assert.equal(apexAsyncSidekick.isError, true);
    assert.match(apexAsyncSidekick.content[0].text, /Fusion.*only.*switch to Fusion/);
    emitBus("pi:modes:changed", { mode: "utopia" });
    process.env.PI_BEHAVIOR_MODE = "utopia";
    assert.match(advertised().description, /sidekick/);
    assert.match(advertised().description, /machinist|advisor|librarian|scout/);
    assert.match(agentParam(), /sidekick/);
    assert.match(agentParam(), /machinist|advisor|librarian|scout/);
    const utopiaSyncSidekick = await tools.get("task").execute("call", { agent: "sidekick", prompt: "do work" }, undefined, undefined, ctx);
    assert.equal(utopiaSyncSidekick.isError, true, "sidekick remains async task_start only even in Utopia");
    emitBus("pi:modes:changed", { mode: "apex" });
    process.env.PI_BEHAVIOR_MODE = "apex";
    const apexChainSidekick = await tools.get("task_chain").execute("call", { steps: [{ agent: "sidekick", prompt: "do work" }] }, undefined, undefined, ctx);
    assert.equal(apexChainSidekick.isError, true);
    assert.match(apexChainSidekick.content[0].text, /Fusion-only.*step 1.*switch to Fusion|Fusion-only.*switch to Fusion.*step 1/);
    const apexSyncCrew = await tools.get("task").execute("call", { agent: "clerk", prompt: "do work" }, undefined, undefined, ctx);
    assert.equal(apexSyncCrew.isError, true);
    assert.match(apexSyncCrew.content[0].text, /Work-only.*switch to Work/);
    const apexAsyncCrew = await tools.get("task_start").execute("call", { agent: "clerk", prompt: "do work" }, undefined, undefined, ctx);
    assert.equal(apexAsyncCrew.isError, true);
    assert.match(apexAsyncCrew.content[0].text, /Work-only.*switch to Work/);
    const apexChainCrew = await tools.get("task_chain").execute("call", { steps: [{ agent: "clerk", prompt: "do work" }] }, undefined, undefined, ctx);
    assert.equal(apexChainCrew.isError, true);
    assert.match(apexChainCrew.content[0].text, /Work-only.*step 1.*switch to Work|Work-only.*switch to Work.*step 1/);
    emitBus("pi:modes:changed", { mode: "pi" });
    process.env.PI_BEHAVIOR_MODE = "pi";
    assert.match(advertised().description, /only when the user names that specialist/);
    assert.doesNotMatch(advertised().description, /Use it when work benefits from separate specialist context/);
    assert.match(advertised().description, /advisor|librarian|scout/);
    assert.doesNotMatch(advertised().description, /- (strategist|researcher|author|clerk):/);
    assert.doesNotMatch(advertised().description, /- sidekick:/);
    assert.match(agentParam(), /In Pi mode, dispatch only when the user names that specialist/);
    assert.doesNotMatch(agentParam(), /after delegation is justified|strategist|researcher|author|clerk/);
    assert.match(tools.get("task").description, /only when the user names that specialist/);
    assert.match(tools.get("task").description, /advisor|librarian|scout/);
    assert.doesNotMatch(tools.get("task").description, /- (strategist|researcher|author|clerk):/);
    assert.doesNotMatch(tools.get("task").description, /- sidekick:/);
    assert.match(tools.get("task").parameters.properties.agent.description, /In Pi mode, dispatch only when the user names that specialist/);
    assert.doesNotMatch(tools.get("task").parameters.properties.agent.description, /strategist|researcher|author|clerk/);
    assert.doesNotMatch(tools.get("task").parameters.properties.agent.description, /sidekick/);
    const piSyncCrew = await tools.get("task").execute("call", { agent: "researcher", prompt: "do work" }, undefined, undefined, ctx);
    assert.equal(piSyncCrew.isError, true);
    assert.match(piSyncCrew.content[0].text, /Work-only.*switch to Work/);
    const piAsyncCrew = await tools.get("task_start").execute("call", { agent: "researcher", prompt: "do work" }, undefined, undefined, ctx);
    assert.equal(piAsyncCrew.isError, true);
    assert.match(piAsyncCrew.content[0].text, /Work-only.*switch to Work/);
    emitBus("pi:modes:changed", { mode: "fusion" });
    assert.match(advertised().description, /sidekick/);
    assert.doesNotMatch(advertised().description, /machinist|scout|artisan/);
    assert.match(advertised().description, /librarian|stevedore|oracle|picasso/);
    assert.match(agentParam(), /sidekick/);
    assert.doesNotMatch(agentParam(), /machinist|scout|artisan/);
    assert.match(wrapped?.description ?? "", /sidekick/);
    assert.doesNotMatch(wrapped?.description ?? "", /machinist|scout|artisan/);
    assert.match(wrappedAgent(), /sidekick/);
    assert.doesNotMatch(wrappedAgent(), /machinist|scout|artisan/);

    emitBus("pi:modes:changed", { mode: "work" });
    assert.match(advertised().description, /Work crew specialist/);
    assert.match(advertised().description, /strategist/);
    assert.doesNotMatch(advertised().description, /sidekick/);
    assert.match(agentParam(), /One of: strategist, researcher, author, clerk/);
    assert.match(advertised().description, /all email drafting and substantive email rewriting/);
    assert.match(advertised().description, /Email reading, factual extraction, and summarization remain inline unless another trigger fires/);
    assert.match(agentParam(), /Always route email drafting and substantive email rewriting to author/);
    assert.match(agentParam(), /other human-readable or kindly worded prose to author when separate context pays/);
    assert.match(advertised().description, /- author: Work prose specialist \(Flo, kindly intergalactic flamingo\)/);
    const workAsync = await tools.get("task_start").execute("call", { agent: "machinist", prompt: "write a file" }, undefined, undefined, ctx);
    assert.equal(workAsync.isError, true);
    assert.match(workAsync.content[0].text, /Work permits task_start only for strategist, researcher, author, clerk/);
    process.env.PI_BEHAVIOR_MODE = "work";
    const workSync = await tools.get("task").execute("call", { agent: "machinist", prompt: "do work" }, AbortSignal.abort(), undefined, ctx);
    assert.equal(workSync.isError, true);
    assert.match(workSync.content?.[0]?.text ?? "", /Work permits synchronous task only for/);
    const workCrewSync = await tools.get("task").execute("call", { agent: "author", prompt: "write kind prose" }, AbortSignal.abort(), undefined, ctx);
    assert.doesNotMatch(workCrewSync.content?.[0]?.text ?? "", /Work permits synchronous task only for|Synchronous task spawning is disabled/);
    assert.match(tools.get("task").description, /Work crew specialist/);
    assert.match(tools.get("task").description, /all email drafting and substantive email rewriting/);
    assert.match(tools.get("task").description, /Email reading, factual extraction, and summarization remain inline unless another trigger fires/);
    assert.match(tools.get("task").parameters.properties.agent.description, /Always route email drafting and substantive email rewriting to author/);
    assert.match(tools.get("task").parameters.properties.agent.description, /other human-readable or kindly worded prose to author when separate context pays/);

    assert.equal(handlers.get("tool_call")!.map(fn => fn({ toolName: "intercom", input: {} })).find(Boolean), undefined);
  } finally {
    for (const fn of handlers.get("session_shutdown") ?? []) fn({}, {});
    if (prior === undefined) delete process.env.PI_BEHAVIOR_MODE; else process.env.PI_BEHAVIOR_MODE = prior;
    if (priorSidekick === undefined) delete process.env.PI_FUSION_SIDEKICK; else process.env.PI_FUSION_SIDEKICK = priorSidekick;
  }
});

test("Fusion sidekick cannot spawn or replace the lead's todo list", () => {
  const previous = process.env.PI_FUSION_SIDEKICK;
  process.env.PI_FUSION_SIDEKICK = "1";
  let gate: Function | undefined;
  const pi: any = { registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, events: { on() {} }, on(name: string, fn: Function) { if (name === "tool_call") gate = fn; } };
  try {
    asyncTask(pi);
    for (const toolName of ["task", "task_start", "task_chain", "todo_write", "intercom"]) assert.equal(gate!({ toolName }).block, true);
    assert.equal(gate!({ toolName: "read" }), undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_FUSION_SIDEKICK; else process.env.PI_FUSION_SIDEKICK = previous;
  }
});

test("FusionLifecycle reuses a settled transcript and parks dead transports", async () => {
  const h = fusionHarness();
  assert.deepEqual(await h.lifecycle.reuse("do it", {}, 1000), { kind: "none" });
  const requests: string[] = [];
  const settled = h.fusionWorker({
    client: {
      isClosed: false,
      request: async (command: Record<string, unknown>) => {
        requests.push(String(command.type));
        return command.type === "get_state"
          ? { success: true, data: { model: { provider: "p", id: "observed" }, thinkingLevel: "medium" } }
          : { success: true };
      },
    },
  });
  h.workers.push(settled);
  assert.equal(h.lifecycle.find(), settled);
  const reused: any = await h.lifecycle.reuse("do it", {}, 1000);
  assert.equal(reused.kind, "reused");
  assert.deepEqual(reused.observed, { model: "p/observed", thinking: "medium" });
  assert.deepEqual(requests, ["prompt", "get_state"], "reuse receipt reads child state after prompt acceptance");
  assert.deepEqual(h.started, ["task_1"]);
  assert.equal(settled.initialPrompt, "do it");
  assert.equal(settled.generation, 3);
  settled.lifecycle = "running";
  const busy: any = await h.lifecycle.reuse("disjoint clean unit", {}, 1000);
  assert.equal(busy.kind, "none", "a busy sidekick leaves room for a disjoint spawn");
  assert.deepEqual(h.started, ["task_1"], "active worker takes no new generation");
  assert.deepEqual(h.lifecycle.live().map((w: any) => w.id), ["task_1"]);
  const second = h.fusionWorker({ id: "task_2", sessionFile: "/s2.jsonl" });
  h.workers.push(second);
  const reusedSecond: any = await h.lifecycle.reuse("next clean unit", {}, 1000);
  assert.equal(reusedSecond.kind, "reused");
  assert.equal(reusedSecond.worker.id, "task_2");
  assert.deepEqual(h.started, ["task_1", "task_2"]);
  assert.equal(h.lifecycle.owns("task_2"), true);
  assert.equal(h.lifecycle.owns("task_9"), false);
  assert.equal(h.lifecycle.gateLead("task_send", "task_2"), undefined, "every sidekick is a valid task_* target");
  h.workers.splice(h.workers.indexOf(second), 1);
  settled.lifecycle = "failed";
  settled.client.isClosed = true;
  const parked: any = await h.lifecycle.reuse("again", {}, 1000);
  assert.equal(parked.kind, "parked");
  assert.ok(h.parked.some(entry => entry.startsWith("task_1:")), "dead transport parked for resume");
  assert.equal(h.lifecycle.find(), undefined, "parked worker leaves the designated slot");
  assert.equal(fusionModelId(h.lifecycle.configured), "p/s");
});

test("FusionLifecycle restarts units and hard-stops corrections at the cap", async () => {
  const h = fusionHarness();
  const worker = h.fusionWorker();
  h.workers.push(worker);
  const first: any = await h.lifecycle.reuse("do it", {}, 1000);
  assert.equal(first.kind, "reused");
  assert.equal(worker.fusionChainPrompts, 1, "reuse starts a new unit at prompt 1");
  assert.equal(h.lifecycle.chainPromptBlock(worker), undefined);
  const nudge = h.lifecycle.noteChainPrompt(worker);
  assert.equal(worker.fusionChainPrompts, FUSION_CHAIN_PROMPT_CAP);
  assert.match(nudge!, /\[fusion\] task_1 has taken 2 prompts/);
  assert.match(nudge!, /unit is now closed/);
  assert.match(nudge!, /task_start/);
  assert.doesNotMatch(nudge!, /\n/, "nudge is a single line");
  assert.equal(h.lifecycle.chainPromptBlock(worker), nudge, "further prompts are blocked");
  // A fresh assignment restarts the unit instead of inheriting the budget.
  worker.lifecycle = "settled";
  const second: any = await h.lifecycle.reuse("next unit", {}, 1000);
  assert.equal(second.kind, "reused");
  assert.equal(worker.fusionChainPrompts, 1, "new unit restarts the prompt budget");
});

test("FusionLifecycle chain counting tolerates workers that predate the counter", () => {
  const h = fusionHarness();
  const worker = h.fusionWorker();
  delete worker.fusionChainPrompts;
  assert.match(h.lifecycle.noteChainPrompt(worker)!, /has taken 2 prompts/, "unknown chain reads as prompt 1, then fills the budget");
  assert.equal(worker.fusionChainPrompts, 2);
  assert.equal(fusionChainNudge("task_9", 2), "[fusion] task_9 has taken 2 prompts in this unit (1 assignment + 1 correction). This unit is now closed to further prompts: reassess the contract, then use task_start for a new unit on the persistent sidekick, or take the work back after settle/abort.");
});

test("FusionLifecycle parks oversized idle context and reuses smaller or unknown context", async () => {
  for (const tokens of [undefined, FUSION_REUSE_CONTEXT_TOKENS]) {
    const h = fusionHarness();
    h.workers.push(h.fusionWorker({ latestContextTokens: tokens }));
    assert.equal((await h.lifecycle.reuse("next unit", {}, 1000)).kind, "reused");
    assert.deepEqual(h.parked, []);
    assert.deepEqual(h.started, ["task_1"]);
  }
  const h = fusionHarness();
  h.workers.push(h.fusionWorker({ latestContextTokens: FUSION_REUSE_CONTEXT_TOKENS + 1 }));
  assert.deepEqual(await h.lifecycle.reuse("clean unit", {}, 1000), {
    kind: "fresh", priorContextTokens: FUSION_REUSE_CONTEXT_TOKENS + 1,
  });
  assert.equal(h.started.length, 0);
  assert.ok(h.parked.some(entry => entry.startsWith("task_1:")));
  assert.equal(h.lifecycle.find(), undefined);
});

test("Fusion prefers an eligible idle worker over an oversized one", async () => {
  const h = fusionHarness();
  h.workers.push(h.fusionWorker({ latestContextTokens: FUSION_REUSE_CONTEXT_TOKENS + 1 }));
  h.workers.push(h.fusionWorker({ id: "task_2", latestContextTokens: FUSION_REUSE_CONTEXT_TOKENS }));
  const result = await h.lifecycle.reuse("next unit", {}, 1000);
  assert.equal(result.kind, "reused");
  assert.equal((result as any).worker.id, "task_2");
  assert.deepEqual(h.parked, []);
});

test("restored context limit decision treats unknown and boundary size as reusable", () => {
  assert.equal(fusionContextOverLimit(undefined), false);
  assert.equal(fusionContextOverLimit(FUSION_REUSE_CONTEXT_TOKENS), false);
  assert.equal(fusionContextOverLimit(FUSION_REUSE_CONTEXT_TOKENS + 1), true);
});

test("FusionLifecycle fresh context keeps idle sidekicks warm until capacity is needed", async () => {
  const h = fusionHarness();
  // No sidekick yet: a declared-fresh unit still must not resume a transcript.
  assert.deepEqual(await h.lifecycle.reuse("clean unit", { context: "fresh" }, 1000), { kind: "fresh" });
  const idle = h.fusionWorker({ latestContextTokens: 20_000 });
  const heavier = h.fusionWorker({ id: "task_2", sessionFile: "/s2.jsonl", latestContextTokens: 70_000 });
  h.workers.push(idle, heavier);
  const fresh: any = await h.lifecycle.reuse("unrelated unit", { context: "fresh" }, 1000);
  assert.equal(fresh.kind, "fresh", "fresh is never silently downgraded to reuse");
  assert.deepEqual(h.started, [], "idle sidekicks take no new generation on a fresh spawn");
  assert.deepEqual(h.parked, [], "fresh keeps existing idle sidekicks warm in the pool");
  assert.equal(h.lifecycle.find(), idle, "warm sidekick remains available for the next unit");
  // Omitting context continues the earliest warm sidekick.
  const reused: any = await h.lifecycle.reuse("follow-on unit", {}, 1000);
  assert.equal(reused.kind, "reused");
  assert.equal(reused.worker.id, "task_1");
  // When the caller needs a slot at the 5-worker cap, parkIdleForCapacity evicts the largest idle transcript.
  idle.lifecycle = "settled";
  const evicted = h.lifecycle.parkIdleForCapacity();
  assert.equal(evicted?.id, "task_2", "largest idle transcript parked first");
  assert.ok(h.parked.some((entry: string) => entry.startsWith("task_2:")));
  assert.equal(idle.closed, false, "smaller warm transcript kept");
});

test("FusionLifecycle reuse workerId targets a specific warm sidekick and rejects invalid targets", async () => {
  const h = fusionHarness();
  const w1 = h.fusionWorker({ id: "task_1", sessionFile: "/s1.jsonl" });
  const w2 = h.fusionWorker({ id: "task_2", sessionFile: "/s2.jsonl" });
  h.workers.push(w1, w2);

  // Target the second idle worker explicitly instead of the earliest.
  const targeted: any = await h.lifecycle.reuse("continue w2", { workerId: "task_2" }, 1000);
  assert.equal(targeted.kind, "reused");
  assert.equal(targeted.worker.id, "task_2");

  // Targeting a busy worker fails closed with a clear remedy instead of picking w1.
  const busyTarget: any = await h.lifecycle.reuse("collide w2", { workerId: "task_2" }, 1000);
  assert.equal(busyTarget.kind, "conflict");
  assert.match(busyTarget.reason, /task_2 is still running its unit/);

  // Combining reuse target with context: "fresh" is a contradiction.
  const freshConflict: any = await h.lifecycle.reuse("contradiction", { workerId: "task_1", context: "fresh" }, 1000);
  assert.equal(freshConflict.kind, "conflict");
  assert.match(freshConflict.reason, /cannot be combined with context: "fresh"/);

  // Unknown or closed worker id is rejected.
  const unknownTarget: any = await h.lifecycle.reuse("missing", { workerId: "task_99" }, 1000);
  assert.equal(unknownTarget.kind, "conflict");
  assert.match(unknownTarget.reason, /task_99 is not an open sidekick/);
});

test("fusionContextGuardSteer and fusionContextGuardReceipt format ~100k handoff guidance", () => {
  const steer = fusionContextGuardSteer(118_400);
  assert.match(steer, /~118k tokens, past the 100k unit budget/);
  assert.match(steer, /settle now with your report/);
  assert.match(steer, /path:line/);
  const receipt = fusionContextGuardReceipt("task_3");
  assert.match(receipt, /\[fusion\] context guard: task_3 passed the 100k unit budget/);
  assert.match(receipt, /context: "fresh"/);
});

test("FusionLifecycle reuse conflicts name truthful remedies and validates report contracts", async () => {
  const h = fusionHarness();
  h.workers.push(h.fusionWorker());
  const model = await h.lifecycle.reuse("x", { model: "q/other" }, 1000) as any;
  assert.equal(model.kind, "conflict");
  assert.match(model.reason, /\/mode configure/);
  assert.doesNotMatch(model.reason, /task_close/);
  const thinking = await h.lifecycle.reuse("x", { thinking: "xhigh" }, 1000) as any;
  assert.equal(thinking.kind, "conflict");
  assert.match(thinking.reason, /thinking are owned by \/mode configure/);
  const fork = await h.lifecycle.reuse("x", { context: "fork" }, 1000) as any;
  assert.equal(fork.kind, "conflict");
  assert.match(fork.reason, /cannot fork a transcript/);
  assert.doesNotMatch(fork.reason, /task_close/);
  const cwd = await h.lifecycle.reuse("x", { cwd: "/other" }, 1000) as any;
  assert.equal(cwd.kind, "none", "a different cwd may spawn a disjoint sidekick");
  const badSchema = await h.lifecycle.reuse("x", { reportSchema: "not json" }, 1000) as any;
  assert.equal(badSchema.kind, "invalid");
  assert.match(badSchema.reason, /Invalid reportSchema/);
  const schema = '{"type":"object","properties":{"done":{"type":"boolean"}}}';
  const sent: Array<Record<string, unknown>> = [];
  h.workers[0].client = { isClosed: false, request: async (command: Record<string, unknown>) => { sent.push(command); return { success: true }; } };
  const ok: any = await h.lifecycle.reuse("x", { reportSchema: schema }, 1000);
  assert.equal(ok.kind, "reused");
  assert.equal(ok.worker.reportSchema, schema, "per-generation contract applied, not narrowed");
  assert.equal(ok.worker.reportStatus, "missing");
  assert.equal(ok.worker.initialPrompt, "x", "stored prompt stays raw");
  assert.match(String(sent[0]?.message ?? ""), /```report/, "contract instruction reaches the child alongside the prompt");
});

test("FusionLifecycle holds the single-writer gate on prompt transport failure", async () => {
  const h = fusionHarness();
  const throwing = h.fusionWorker({
    client: { isClosed: false, request: async () => { throw new Error("socket timeout"); } },
  });
  h.workers.push(throwing);
  const failed: any = await h.lifecycle.reuse("go", {}, 1000);
  assert.equal(failed.kind, "failed");
  assert.match(failed.reason, /prompt failed: socket timeout/);
  assert.deepEqual(h.aborted, ["task_1"], "abort-and-park ran");
  assert.deepEqual(h.settled, [], "generation never settled-released on unknown transport fate");
  assert.equal(throwing.closed, true);
  const rejecting = h.fusionWorker({
    id: "task_2",
    client: { isClosed: false, request: async () => ({ success: false, error: "denied" }) },
  });
  h.workers.push(rejecting);
  const denied: any = await h.lifecycle.acceptPrompt(rejecting, rejecting.client, "go", 1000);
  assert.equal(denied.kind, "failed");
  assert.match(denied.reason, /prompt rejected: denied/);
  assert.deepEqual(h.settled, [{ id: "task_2", error: "denied" }], "known rejection settles");
  assert.deepEqual(h.aborted, ["task_1"]);
});

test("FusionLifecycle parks, isolates, restores transcripts, and gates through one owner", () => {
  const h = fusionHarness();
  const settled = h.fusionWorker();
  const live = h.fusionWorker({ id: "task_2", lifecycle: "running" });
  const foreign = h.fusionWorker({ id: "task_3", fusionParentSessionId: "other-parent" });
  h.workers.push(settled, live, foreign);
  h.lifecycle.isolateSession("parent-1");
  assert.ok(h.parked.some(entry => entry.startsWith("task_3:")), "foreign session parked");
  assert.ok(!h.parked.some(entry => entry.startsWith("task_1:")), "same session kept");
  const settledTwin = h.fusionWorker({ id: "task_4" });
  h.workers.push(settledTwin);
  h.lifecycle.parkForModeLeave();
  assert.ok(h.parked.some(entry => entry.startsWith("task_1:")), "settled parks on mode leave");
  assert.ok(h.parked.some(entry => entry.startsWith("task_4:")), "every settled sidekick parks on mode leave");
  assert.ok(!h.parked.some(entry => entry.startsWith("task_2:")), "live worker keeps running");
  const lookupBranch = [
    { type: "custom", customType: "fusion-sidekick-session", data: { parentSessionId: "parent-1", sessionFile: "/old.jsonl", cwd: "/w" } },
    { type: "message" },
    { type: "custom", customType: "fusion-sidekick-session", data: { parentSessionId: "parent-1", sessionFile: "/new.jsonl", sessionId: "s", cwd: "/w" } },
  ];
  assert.deepEqual(h.lifecycle.findTranscript(lookupBranch, "parent-1"), { parentSessionId: "parent-1", sessionFile: "/new.jsonl", sessionId: "s", cwd: "/w" });
  assert.deepEqual(h.lifecycle.findTranscript(lookupBranch, "parent-1", new Set(["/new.jsonl"])), { parentSessionId: "parent-1", sessionFile: "/old.jsonl", sessionId: undefined, cwd: "/w" }, "attached transcripts are never shared");
  assert.equal(h.lifecycle.findTranscript(lookupBranch, "missing"), undefined);
  assert.equal(h.lifecycle.findTranscript(lookupBranch, undefined), undefined);
  assert.equal(h.lifecycle.gateSidekick("task_start"), "Fusion sidekick cannot dispatch agents, write the lead's plan, or coordinate peer sessions.");
  assert.equal(h.lifecycle.gateSidekick("read"), undefined);
  assert.equal(h.lifecycle.gateLead("task", "task_2"), undefined);
  assert.equal(h.lifecycle.gateLead("task_chain", "task_2"), "Fusion permits only its sidekicks.");
  assert.equal(h.lifecycle.gateLead("task_send", "task_9"), undefined, "unknown ids fall through so the tool reports Unknown worker truthfully");
  assert.equal(h.lifecycle.gateLead("task_send", "task_2"), undefined);
  assert.equal(h.lifecycle.gateLead("edit", undefined), undefined, "lead edit allowed while worker is live");
  assert.equal(h.lifecycle.gateLead("bash", undefined), undefined, "lead bash allowed while worker is live");
  settled.lifecycle = "settled";
  live.lifecycle = "settled";
  foreign.lifecycle = "settled";
  assert.equal(h.lifecycle.gateLead("edit", undefined), undefined, "lead edit allowed after settle");
  assert.equal(h.lifecycle.gateLead("bash", undefined), undefined, "lead bash allowed after settle");
});

test("Fusion gate keeps parked sidekicks operable while non-sidekicks stay rejected", () => {
  const h = fusionHarness();
  const sidekick = h.fusionWorker({ id: "task_3", generation: 2 });
  const ordinary = h.fusionWorker({ id: "task_4", fusion: false, fusionParentSessionId: undefined });
  h.workers.push(sidekick, ordinary);
  // Reuse parking (dead transport / oversized context), session isolation,
  // and mode leave all park via closeWorker: the sidekick stays owned.
  h.lifecycle.isolateSession("other-parent");
  assert.equal(sidekick.closed, true, "sidekick parked by isolation");
  assert.equal(ordinary.closed, false, "non-sidekick untouched by isolation");
  assert.equal(h.lifecycle.owns("task_3"), true, "parking never un-owns the lead's sidekick");
  assert.equal(h.lifecycle.owns("task_4"), false);
  assert.equal(h.lifecycle.owns("task_9"), false);
  for (const tool of ["task_close", "task_send", "task_wait", "task_abort", "task_status"]) {
    assert.equal(h.lifecycle.gateLead(tool, "task_3"), undefined, `${tool} on a parked sidekick stays reachable so the tool reports truthful state`);
    assert.equal(
      h.lifecycle.gateLead(tool, "task_4"),
      "Fusion task operations are scoped to its sidekicks.",
      `${tool} on a known non-sidekick stays rejected`,
    );
    assert.equal(
      h.lifecycle.gateLead(tool, ["task_3", "task_4"]),
      "Fusion task operations are scoped to its sidekicks.",
      `${tool} with ids array containing a non-sidekick stays rejected`,
    );
    assert.equal(
      h.lifecycle.gateLead(tool, ["task_3", "task_9"]),
      undefined,
      `${tool} with ids array of sidekicks and unknown ids is allowed through`,
    );
    assert.equal(h.lifecycle.gateLead(tool, "task_9"), undefined, `${tool} on an unknown worker falls through to the tool's Unknown report`);
    assert.equal(h.lifecycle.gateLead(tool, undefined), undefined, `${tool} without an id falls through to the tool's id-required report`);
  }
  assert.equal(h.lifecycle.gateLead("task_chain", "task_3"), "Fusion permits only its sidekicks.");
  assert.equal(h.lifecycle.gateLead("task_rebind", "task_3"), "Fusion permits only its sidekicks.");
  assert.equal(h.lifecycle.gateLead("task_start", undefined), undefined);
  assert.equal(h.lifecycle.gateLead("task_list", undefined), undefined);
});

test("FusionLifecycle configure applies sequentially and rolls back through one path", async () => {
  const h = fusionHarness();
  const calls: string[] = [];
  const worker = h.fusionWorker({
    client: {
      isClosed: false,
      request: async (command: Record<string, unknown>) => { calls.push(String(command.type)); return { success: true }; },
    },
  });
  h.workers.push(worker);
  const next = { lead: { provider: "p", modelId: "l2", thinking: "high" }, sidekick: { provider: "p", modelId: "s2", thinking: "high" } };
  const event: any = { fusion: next };
  h.lifecycle.attachConfigure(event);
  assert.equal(event.acknowledged, true);
  assert.equal(typeof event.rollback, "function");
  await event.promise;
  assert.deepEqual(calls, ["set_model", "set_thinking_level"]);
  assert.equal(worker.model, "p/s2");
  assert.equal(worker.thinking, "high");
  assert.deepEqual(worker.modelAttempts, ["p/s2"]);
  calls.length = 0;
  await event.rollback!();
  assert.deepEqual(calls, ["set_model", "set_thinking_level"], "single robust restore path");
  assert.equal(worker.model, "p/s");
  assert.equal(worker.thinking, "low");
  assert.deepEqual(worker.modelAttempts, ["p/s"]);
  assert.deepEqual(h.lifecycle.configured, { lead: { provider: "p", modelId: "l", thinking: "medium" }, sidekick: { provider: "p", modelId: "s", thinking: "low" } });
});

test("FusionLifecycle configure compensates partial apply and reports dead-target rollback", async () => {
  const h = fusionHarness();
  const worker = h.fusionWorker({
    client: {
      isClosed: false,
      request: async (command: Record<string, unknown>) =>
        command.type === "set_thinking_level" ? { success: false, error: "thinking denied" } : { success: true },
    },
  });
  h.workers.push(worker);
  const event: any = { fusion: { lead: { provider: "p", modelId: "l", thinking: "medium" }, sidekick: { provider: "p", modelId: "s2", thinking: "high" } } };
  h.lifecycle.attachConfigure(event);
  await assert.rejects(event.promise, /thinking update rejected \(thinking denied\); model restored/);
  assert.match(event.error, /thinking update rejected/);
  await assert.rejects(event.rollback!(), /thinking update rejected/, "cached identity must not hide failed remote restoration");
  worker.client.isClosed = true;
  h.setBranch(transcriptBranch("/s.jsonl"));
  await event.rollback!();
  assert.ok(h.parked.some(entry => entry.startsWith("task_1:")), "dead target parked preserving transcript");
  const h2 = fusionHarness();
  const live2 = h2.fusionWorker();
  h2.workers.push(live2);
  const doomed: any = { fusion: { lead: { provider: "p", modelId: "l", thinking: "medium" }, sidekick: { provider: "p", modelId: "s3", thinking: "high" } } };
  h2.lifecycle.attachConfigure(doomed);
  await doomed.promise;
  live2.client.isClosed = true;
  h2.setBranch([]);
  await assert.rejects(doomed.rollback!(), /no persisted transcript/);
  assert.ok(h2.parked.some(entry => entry.startsWith("task_1:")), "unverifiable target still parked");
});

test("Fusion sidekick model updates apply sequentially with compensation", async () => {
  const calls: Array<{ command: Record<string, unknown> }> = [];
  const ok = { success: true };
  const applier = { isClosed: false, request: async (command: Record<string, unknown>) => { calls.push({ command }); return ok; } };
  const applied = await applySidekickModel(applier, { provider: "p", modelId: "m", thinking: "high" }, { modelId: "q/old" });
  assert.deepEqual(applied, { model: "p/m", thinking: "high" });
  assert.deepEqual(calls.map(call => call.command.type), ["set_model", "set_thinking_level"]);

  calls.length = 0;
  await applySidekickModel(applier, { provider: "p", modelId: "m" }, { modelId: "q/old" });
  assert.deepEqual(calls.map(call => call.command.type), ["set_model"]);

  const modelReject = { isClosed: false, request: async () => ({ success: false, error: "nope" }) };
  await assert.rejects(applySidekickModel(modelReject, { provider: "p", modelId: "m", thinking: "high" }, { modelId: "q/old" }), /model update rejected: nope/);

  const modelThrow = { isClosed: false, request: async () => { throw new Error("boom"); } };
  await assert.rejects(applySidekickModel(modelThrow, { provider: "p", modelId: "m" }, undefined), /model update rejected: boom/);

  const thinkCalls: Array<{ type: unknown; level?: unknown; provider?: unknown; modelId?: unknown }> = [];
  const thinkReject = {
    isClosed: false,
    request: async (command: Record<string, unknown>) => {
      thinkCalls.push({ type: command.type, level: command.level, provider: command.provider, modelId: command.modelId });
      if (command.type === "set_thinking_level" && command.level === "high") return { success: false, error: "thinking denied" };
      return { success: true };
    },
  };
  await assert.rejects(
    applySidekickModel(thinkReject, { provider: "p", modelId: "m", thinking: "high" }, { modelId: "q/old", thinking: "low" }),
    /thinking update rejected \(thinking denied\); model restored; thinking restored/,
  );
  assert.deepEqual(thinkCalls, [
    { type: "set_model", level: undefined, provider: "p", modelId: "m" },
    { type: "set_thinking_level", level: "high", provider: undefined, modelId: undefined },
    { type: "set_model", level: undefined, provider: "q", modelId: "old" },
    { type: "set_thinking_level", level: "low", provider: undefined, modelId: undefined },
  ]);

  const unrestorable = { isClosed: false, request: async (command: Record<string, unknown>) => command.type === "set_model" ? { success: true } : { success: false, error: "denied" } };
  await assert.rejects(
    applySidekickModel(unrestorable, { provider: "p", modelId: "m", thinking: "high" }, { modelId: "default model" }),
    /not restorable/,
  );
});

test("Fusion lead discovery tool results do not append a discovery-count nudge", () => {
  const prior = process.env.PI_BEHAVIOR_MODE;
  const priorSidekick = process.env.PI_FUSION_SIDEKICK;
  process.env.PI_BEHAVIOR_MODE = "fusion";
  delete process.env.PI_FUSION_SIDEKICK;
  const handlers = new Map<string, Function[]>();
  const pi: any = {
    registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
    on(name: string, fn: Function) { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
    events: { on() {} },
    getThinkingLevel: () => "medium",
  };
  try {
    asyncTask(pi);
    const fireToolResult = (toolName: string, content: any[] = [{ type: "text", text: "ok" }]) => {
      const event = { toolName, content, isError: false };
      for (const fn of handlers.get("tool_result") ?? []) {
        const out = fn(event) as any;
        if (out) return out;
      }
      return undefined;
    };
    for (const fn of handlers.get("agent_start") ?? []) fn();
    for (const tool of ["read", "grep", "ls", "find", "bash", "ffgrep", "fffind", "lsp", "powershell", "read", "bash", "fffind"]) {
      assert.equal(fireToolResult(tool), undefined, `${tool}: no discovery-count nudge`);
    }
  } finally {
    if (prior === undefined) delete process.env.PI_BEHAVIOR_MODE; else process.env.PI_BEHAVIOR_MODE = prior;
    if (priorSidekick === undefined) delete process.env.PI_FUSION_SIDEKICK; else process.env.PI_FUSION_SIDEKICK = priorSidekick;
  }
});

test("Fusion delivers a one-shot compaction nudge on the next lead tool result", () => {
  const prior = process.env.PI_BEHAVIOR_MODE;
  const priorSidekick = process.env.PI_FUSION_SIDEKICK;
  process.env.PI_BEHAVIOR_MODE = "fusion";
  delete process.env.PI_FUSION_SIDEKICK;
  const handlers = new Map<string, Function[]>();
  const pi: any = {
    registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
    on(name: string, fn: Function) { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
    events: { on() {} },
    getThinkingLevel: () => "medium",
  };
  try {
    asyncTask(pi);
    const fireToolResult = (toolName: string) => {
      const event = { toolName, content: [{ type: "text", text: "ok" }], isError: false };
      for (const fn of handlers.get("tool_result") ?? []) {
        const out = fn(event) as any;
        if (out) return out;
      }
      return undefined;
    };
    const compact = () => { for (const fn of handlers.get("session_compact") ?? []) fn({}); };
    assert.equal(fireToolResult("read"), undefined, "no nudge before any compaction");
    compact();
    const first = fireToolResult("edit");
    assert.ok(first, "non-discovery tools also deliver the compaction nudge");
    assert.equal(first.content.length, 2, "nudge appended, original blocks kept");
    assert.match(first.content[1].text, /^\[fusion\] session compacted/);
    assert.match(first.content[1].text, /\/mode configure/);
    assert.equal(first.content[1].text.includes("\n"), false, "nudge is a single line");
    assert.equal(fireToolResult("read"), undefined, "one-shot: cleared on delivery");
  } finally {
    if (prior === undefined) delete process.env.PI_BEHAVIOR_MODE; else process.env.PI_BEHAVIOR_MODE = prior;
    if (priorSidekick === undefined) delete process.env.PI_FUSION_SIDEKICK; else process.env.PI_FUSION_SIDEKICK = priorSidekick;
  }
});

test("Fusion configure handshake acknowledges synchronously and requires a pair", async () => {
  const prior = process.env.PI_BEHAVIOR_MODE;
  process.env.PI_BEHAVIOR_MODE = "fusion";
  const bus = new Map<string, Function>();
  const pi: any = {
    registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
    on() {}, events: { on(name: string, fn: Function) { bus.set(name, fn); } },
    getThinkingLevel: () => "medium",
  };
  try {
    asyncTask(pi);
    const configure = bus.get("pi:fusion:configure")!;
    const missing: any = {};
    configure(missing);
    assert.equal(missing.error, "Fusion pair configuration is required.");
    assert.equal(missing.acknowledged, undefined);
    const pair = { lead: { provider: "p", modelId: "l", thinking: "medium" }, sidekick: { provider: "p", modelId: "s", thinking: "low" } };
    const request: any = { fusion: pair };
    configure(request);
    assert.equal(request.acknowledged, true);
    assert.equal(typeof request.rollback, "function");
    assert.equal(request.promise, undefined, "no live worker means nothing to update");
    assert.equal(request.error, undefined);
    await request.rollback();
  } finally {
    if (prior === undefined) delete process.env.PI_BEHAVIOR_MODE; else process.env.PI_BEHAVIOR_MODE = prior;
  }
});

test("Apex Orchestrate strips regular-mode carve-outs and routes visual work to artisan", () => {
  const prior = process.env.PI_BEHAVIOR_MODE;
  process.env.PI_BEHAVIOR_MODE = "apex";
  const bus = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const emitBus = (name: string, payload: any) => { for (const fn of bus.get(name) ?? []) fn(payload); };
  const pi: any = {
    registerTool: (tool: any) => { tools.set(tool.name, tool); },
    registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
    on() {},
    events: { on(name: string, fn: Function) { bus.set(name, [...bus.get(name) ?? [], fn]); } },
    getThinkingLevel: () => "medium",
  };
  try {
    asyncTask(pi); ampTask(pi);
    const taskStart = () => tools.get("task_start");
    const taskStartAgent = () => taskStart().parameters.properties.agent.description as string;
    const task = () => tools.get("task");
    const taskAgent = () => task().parameters.properties.agent.description as string;

    // Regular apex keeps the inline-biasing carve-outs verbatim.
    assert.match(taskStart().description, /Multi-file, long-running, or frontend work may remain inline in regular mode\./);
    assert.match(taskStart().description, /Ordinary frontend implementation stays with the lead in regular mode\./);
    assert.match(taskStart().description, /Long or multi-file work alone is not a reason to delegate in regular mode\./);
    assert.match(taskStart().description, /Not for UI or prose deliverables\./);
    assert.match(taskStartAgent(), /substantial visual design work needing separate creative judgment to artisan/);
    assert.match(taskStartAgent(), /independent separable non-visual implementation slices to machinist/);
    assert.match(task().description, /Ordinary frontend implementation stays with the lead in regular mode\./);
    assert.match(taskAgent(), /substantial visual design work needing separate creative judgment to artisan/);

    emitBus("pi:modes:changed", { mode: "apex-orchestrate" });

    // Orchestrate drops every "in regular mode" carve-out and routes visual/UI to artisan.
    for (const text of [taskStart().description, taskStartAgent(), task().description, taskAgent()]) {
      assert.doesNotMatch(text, /in regular mode/);
    }
    assert.match(taskStart().description, /In this mode substantial implementation slices go to specialists; all visual and UI implementation goes to artisan, not machinist\./);
    assert.match(taskStart().description, /Not for UI or prose deliverables\./);
    assert.match(taskStartAgent(), /all visual and UI implementation slices, including mechanical or appearance-preserving ones, to artisan/);
    assert.match(taskStartAgent(), /non-visual implementation slices to machinist/);
    assert.match(task().description, /all visual and UI implementation goes to artisan, not machinist/);
    assert.match(taskAgent(), /all visual and UI implementation slices, including mechanical or appearance-preserving ones, to artisan/);

    // The orchestrate catalog keeps the same roster, minus carve-outs.
    assert.match(taskStart().description, /- artisan:/);
    assert.match(taskStart().description, /- machinist:/);
    assert.doesNotMatch(taskStart().description, /- sidekick:/);
    assert.doesNotMatch(taskStart().description, /- (strategist|researcher|author|clerk):/);

    emitBus("pi:modes:changed", { mode: "apex" });

    // Leaving orchestrate restores the regular-mode sentences unchanged.
    assert.match(taskStart().description, /Multi-file, long-running, or frontend work may remain inline in regular mode\./);
    assert.match(taskStart().description, /Ordinary frontend implementation stays with the lead in regular mode\./);
    assert.match(taskStartAgent(), /substantial visual design work needing separate creative judgment to artisan/);
  } finally {
    if (prior === undefined) delete process.env.PI_BEHAVIOR_MODE; else process.env.PI_BEHAVIOR_MODE = prior;
  }
});

test("Orchestrate inline backstop classifies specialist work per turn", () => {
  const prior = process.env.PI_BEHAVIOR_MODE;
  const priorSidekick = process.env.PI_FUSION_SIDEKICK;
  const priorSubagent = process.env.PI_SUBAGENT;
  process.env.PI_BEHAVIOR_MODE = "apex-orchestrate";
  delete process.env.PI_SUBAGENT;
  delete process.env.PI_FUSION_SIDEKICK;
  const handlers = new Map<string, Function[]>();
  const bus = new Map<string, Function[]>();
  const emitBus = (name: string, payload: any) => { for (const fn of bus.get(name) ?? []) fn(payload); };
  const pi: any = {
    registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
    on(name: string, fn: Function) { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
    events: { on(name: string, fn: Function) { bus.set(name, [...bus.get(name) ?? [], fn]); } },
    getThinkingLevel: () => "medium",
  };
  try {
    asyncTask(pi);
    const fireToolResult = (toolName: string, content: any[] = [{ type: "text", text: "ok" }], input: any = {}) => {
      const event = { toolName, content, input, isError: false };
      for (const fn of handlers.get("tool_result") ?? []) {
        const out = fn(event) as any;
        if (out) return out;
      }
      return undefined;
    };
    const fireToolCall = (toolName: string) => {
      for (const fn of handlers.get("tool_call") ?? []) fn({ toolName, input: {} });
    };
    const fireAgentStart = () => {
      for (const fn of handlers.get("agent_start") ?? []) fn();
    };
    const nudgeText = (out: any) => out?.content?.at(-1)?.text as string | undefined;

    fireAgentStart();
    assert.equal(fireToolResult("edit"), undefined, "1st inline edit: no nudge");
    const second = fireToolResult("write");
    assert.ok(second, "2nd inline edit nudges");
    assert.equal(second.content.length, 2, "nudge appended, original blocks kept");
    assert.equal(second.content[1].type, "text", "nudge is a text block");
    const text = nudgeText(second);
    assert.match(text!, /^\[orchestrate\] 2 inline implementation calls this turn/);
    assert.match(text!, /task_start/);
    assert.match(text!, /live writer/, "same files stay with the writer already in flight");
    assert.equal(text!.includes("\n"), false, "nudge is a single line");
    assert.equal(fireToolResult("edit"), undefined, "3rd inline edit: no nudge");
    assert.match(nudgeText(fireToolResult("write"))!, /^\[orchestrate\] 4 inline implementation calls this turn/, "second nudge at 4");

    fireAgentStart();
    for (let i = 0; i < 5; i++) assert.equal(fireToolResult("read"), undefined);
    assert.match(nudgeText(fireToolResult("bash", undefined, { command: "cat agent/skills/agent-browser/SKILL.md" }))!, /6 inline discovery calls.*scout/, "browser skill read is discovery, not live-page");
    for (const command of ["git status", "echo ok 2>&1", "echo ok > /dev/null"]) assert.equal(fireToolResult("bash", undefined, { command }), undefined);
    assert.equal(fireToolResult("bg_start"), undefined);
    assert.equal(fireToolResult("edit"), undefined, "counter untouched by discovery");
    assert.match(nudgeText(fireToolResult("edit"))!, /^\[orchestrate\] 2 inline implementation calls this turn/, "nudge fires on the 2nd edit after discovery");

    fireAgentStart();
    assert.match(nudgeText(fireToolResult("browser_attach"))!, /1 inline live-page calls.*inspector/);
    assert.match(nudgeText(fireToolResult("bash", undefined, { command: "agent-browser --cdp 29300 snapshot" }))!, /2 inline live-page calls.*inspector/);
    assert.match(nudgeText(fireToolResult("bash", undefined, { command: "cd repo && TOKEN=x npx agent-browser --cdp 29300 snapshot" }))!, /3 inline live-page calls.*inspector/);
    fireAgentStart();
    assert.equal(fireToolResult("bash", undefined, { command: "npm run lint" }), undefined);
    assert.match(nudgeText(fireToolResult("bash", undefined, { command: "vp test" }))!, /2 inline gates calls.*stevedore/);
    fireAgentStart();
    assert.equal(fireToolResult("bash", undefined, { command: "cat > file <<EOF" }), undefined);
    assert.match(nudgeText(fireToolResult("powershell", undefined, { command: "Set-Content file value" }))!, /2 inline implementation calls.*machinist/);

    fireToolCall("task_start");
    assert.equal(fireToolResult("edit"), undefined, "dispatch resets implementation count");
    assert.match(nudgeText(fireToolResult("write"))!, /2 inline implementation calls/, "nudge resumes 2 edits after task_start");

    fireToolCall("task_send");
    assert.equal(fireToolResult("edit"), undefined, "task_send resets too");
    assert.match(nudgeText(fireToolResult("edit"))!, /2 inline implementation calls/, "nudge resumes 2 edits after task_send");

    fireAgentStart();
    assert.equal(fireToolResult("edit"), undefined, "new user turn resets");
    assert.match(nudgeText(fireToolResult("edit"))!, /2 inline implementation calls/, "nudge resumes 2 edits into the new turn");

    for (const mode of ["apex", "pi", "work", "fusion"]) {
      emitBus("pi:modes:changed", { mode });
      fireAgentStart();
      for (let i = 0; i < 4; i++) assert.equal(fireToolResult("edit"), undefined, `no nudge in ${mode} mode`);
    }
    emitBus("pi:modes:changed", { mode: "apex-orchestrate" });
    process.env.PI_FUSION_SIDEKICK = "1";
    fireAgentStart();
    for (let i = 0; i < 4; i++) assert.equal(fireToolResult("edit"), undefined, "no nudge for the sidekick itself");
    delete process.env.PI_FUSION_SIDEKICK;
    process.env.PI_SUBAGENT = "1";
    fireAgentStart();
    for (const [tool, input] of [["edit", {}], ["write", {}], ["browser_attach", {}], ["bash", { command: "agent-browser snapshot" }], ["bash", { command: "npm run lint" }], ["bash", { command: "vp test" }], ...Array.from({ length: 6 }, () => ["read", {}])] as [string, any][]) {
      assert.equal(fireToolResult(tool, undefined, input), undefined, `subagent cannot dispatch ${tool}`);
    }
    delete process.env.PI_SUBAGENT;
    fireAgentStart();
    assert.equal(fireToolResult("edit"), undefined);
    assert.match(nudgeText(fireToolResult("edit"))!, /2 inline implementation calls/, "lead nudges again after subagent check");
  } finally {
    for (const fn of handlers.get("session_shutdown") ?? []) fn({}, {});
    if (prior === undefined) delete process.env.PI_BEHAVIOR_MODE; else process.env.PI_BEHAVIOR_MODE = prior;
    if (priorSidekick === undefined) delete process.env.PI_FUSION_SIDEKICK; else process.env.PI_FUSION_SIDEKICK = priorSidekick;
    if (priorSubagent === undefined) delete process.env.PI_SUBAGENT; else process.env.PI_SUBAGENT = priorSubagent;
  }
});

test("Utopia ignores retained Fusion pair so sidekicks route dynamically under Hydra scope", async () => {
  const priorMode = process.env.PI_BEHAVIOR_MODE;
  const priorTier = process.env.PI_HYDRA_TIER;
  const priorScope = process.env.PI_HYDRA_SCOPE;
  process.env.PI_BEHAVIOR_MODE = "utopia";
  process.env.PI_HYDRA_TIER = "high";
  process.env.PI_HYDRA_SCOPE = "openai";
  const bus = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  let hydraRouteQueried = false;
  const emitBus = (name: string, payload: any) => { for (const fn of bus.get(name) ?? []) fn(payload); };
  const pi: any = {
    registerTool: (tool: any) => { tools.set(tool.name, tool); },
    registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
    on() {},
    events: {
      on(name: string, fn: Function) { bus.set(name, [...bus.get(name) ?? [], fn]); },
      emit(name: string, payload: any) {
        if (name === "pi:hydra:subagent-route") {
          hydraRouteQueried = true;
          payload.scope = "openai";
          payload.scopeExhausted = true;
          payload.models = [];
          payload.fallbackModels = [];
        }
        emitBus(name, payload);
      },
    },
    getThinkingLevel: () => "medium",
  };
  try {
    asyncTask(pi);
    const stalePair = {
      lead: { provider: "claude-bridge", modelId: "claude-opus-5-5", thinking: "high" },
      sidekick: { provider: "claude-bridge", modelId: "claude-haiku-5-5", thinking: "low" },
    };
    emitBus("pi:modes:changed", { mode: "utopia", fusion: stalePair });
    const res = await tools.get("task_start").execute(
      "call_1",
      { agent: "sidekick", prompt: "test unit" },
      undefined,
      undefined,
      { cwd: process.cwd(), sessionManager: { getSessionId: () => "s1", getBranch: () => [] } },
    );
    const text = res.content?.[0]?.text ?? "";
    assert.equal(hydraRouteQueried, true, "Utopia sidekick queries dynamic Hydra subagent router instead of forcing retained Fusion pair");
    assert.doesNotMatch(text, /excludes the configured Fusion sidekick/, "does not reject on retained Fusion pair in Utopia");
    assert.match(text, /Hydra scope "openai" has no available model for sidekick/);

    // Non-sidekick agents reject `reuse` upfront.
    const nonSidekickReuse = await tools.get("task_start").execute(
      "call_2",
      { agent: "scout", prompt: "scan", reuse: "task_1" },
      undefined,
      undefined,
      { cwd: process.cwd(), sessionManager: { getSessionId: () => "s1", getBranch: () => [] } },
    );
    assert.equal(nonSidekickReuse.isError, true);
    assert.match(nonSidekickReuse.content[0].text, /reuse applies only to sidekick units/);

    // task_wait validates id / ids and rejects generation with multiple ids.
    const missingId = await tools.get("task_wait").execute(
      "call_3",
      {},
      undefined,
      undefined,
      { cwd: process.cwd() },
    );
    assert.equal(missingId.isError, true);
    assert.match(missingId.content[0].text, /id or ids is required/);

    const genMulti = await tools.get("task_wait").execute(
      "call_4",
      { ids: ["task_1", "task_2"], generation: 1 },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );
    assert.equal(genMulti.isError, true);
    assert.match(genMulti.content[0].text, /generation applies to a single id/);
  } finally {
    if (priorMode === undefined) delete process.env.PI_BEHAVIOR_MODE; else process.env.PI_BEHAVIOR_MODE = priorMode;
    if (priorTier === undefined) delete process.env.PI_HYDRA_TIER; else process.env.PI_HYDRA_TIER = priorTier;
    if (priorScope === undefined) delete process.env.PI_HYDRA_SCOPE; else process.env.PI_HYDRA_SCOPE = priorScope;
  }
});

test("task_wait ids enforces settle-any collection, mixed-cooldown rejection, and Fusion worker-scope gating", async () => {
  const priorMode = process.env.PI_BEHAVIOR_MODE;
  process.env.PI_BEHAVIOR_MODE = "apex";
  const handlers = new Map<string, Function[]>();
  const bus = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const emitBus = (name: string, payload: any) => { for (const fn of bus.get(name) ?? []) fn(payload); };
  let capturedWorkers: any[] = [];
  const pi: any = {
    registerTool: (tool: any) => { tools.set(tool.name, tool); },
    registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
    on(name: string, fn: Function) { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
    events: { on(name: string, fn: Function) { bus.set(name, [...bus.get(name) ?? [], fn]); } },
    getThinkingLevel: () => "medium",
  };
  try {
    asyncTask(pi);
    // Intercept Map.prototype.values once during pi:fusion:configure to seed the internal worker map.
    let workerMap: Map<string, any> | undefined;
    const origValues = Map.prototype.values;
    Map.prototype.values = new Proxy(origValues, {
      apply(target, thisArg: Map<string, any>, argArray) {
        if (!workerMap) workerMap = thisArg;
        return Reflect.apply(target, thisArg, argArray);
      },
    });
    try {
      const cfg: any = {
        fusion: {
          lead: { provider: "p", modelId: "l", thinking: "high" },
          sidekick: { provider: "p", modelId: "s", thinking: "low" },
        },
      };
      emitBus("pi:fusion:configure", cfg);
    } finally {
      Map.prototype.values = origValues;
    }
    assert.ok(workerMap, "captured internal worker map");

    const makeSyntheticWorker = (id: string, overrides: Record<string, unknown> = {}): any => ({
      instanceId: `inst-${id}`,
      id,
      agent: "sidekick",
      mission: `mission ${id}`,
      cwd: process.cwd(),
      model: "p/s",
      thinking: "low",
      initialPrompt: "go",
      modelAttempts: ["p/s"],
      modelAttemptIndex: 0,
      fallbackReplaySafe: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      timeoutMs: 60_000,
      sessionDir: "/tmp",
      notifiedGeneration: 0,
      waiters: [] as Array<{ generation: number; resolve: (snapshot: any) => void }>,
      pendingUi: new Map(),
      parsedReport: null,
      reportStatus: "none" as const,
      countsTowardCap: true,
      closed: false,
      lifecycle: "running" as const,
      phase: "model" as const,
      renderVersion: 0,
      fallbackEpoch: 0,
      fallbackInProgress: false,
      fallbackAwaitingAgentStart: false,
      ledger: new ActivityLedger(),
      errors: [] as string[],
      generation: 1,
      generationStartedAt: Date.now(),
      turns: 1,
      maxTurns: 20,
      pendingSteer: 0,
      pendingFollowUp: 0,
      latestAssistantText: "",
      latestResult: "",
      modelAttemptUsedTools: false,
      exitCode: null,
      fusion: true,
      ...overrides,
    });

    const w1 = makeSyntheticWorker("task_1");
    const w2 = makeSyntheticWorker("task_2");
    const nonSidekick = makeSyntheticWorker("task_3", {
      agent: "scout",
      fusion: false,
      lifecycle: "settled",
      latestResult: "scout report",
    });
    workerMap!.set(w1.instanceId, w1);
    workerMap!.set(w2.instanceId, w2);
    workerMap!.set(nonSidekick.instanceId, nonSidekick);
    capturedWorkers = [w1, w2, nonSidekick];

    const ctx: any = { cwd: process.cwd(), getContextUsage: () => undefined };
    const taskWait = tools.get("task_wait");

    // 1. Mixed-cooldown rejection: if task_1 is in post-timeout cooldown and task_2 is not,
    // task_wait({ ids: ["task_1", "task_2"] }) must reject upfront instead of silently ignoring task_1.
    w1.lastWaitTimeoutAt = Date.now();
    w1.lastWaitTimeoutSec = 600;
    w1.lastWaitGeneration = 1;
    const mixedCooldown = await taskWait.execute("wait_cooldown", { ids: ["task_1", "task_2"] }, undefined, undefined, ctx);
    assert.equal(mixedCooldown.isError, true, "mixed cooldown must fail closed rather than silently dropping task_1");
    assert.match(mixedCooldown.content[0].text, /task_1 same-generation re-wait is blocked/i);
    assert.equal(w1.waiters.length, 0);
    assert.equal(w2.waiters.length, 0);

    // Clear cooldown and verify settle-any returns whichever worker settles first, then skips it on the next call.
    w1.lastWaitTimeoutAt = undefined;
    w1.lastWaitTimeoutSec = undefined;
    w1.lastWaitGeneration = undefined;

    const firstWaitPromise = taskWait.execute("wait_wave_1", { ids: ["task_1", "task_2"] }, undefined, undefined, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(w1.waiters.length, 1, "waiter registered on task_1");
    assert.equal(w2.waiters.length, 1, "waiter registered on task_2");

    // Settle w2 first.
    w2.lifecycle = "settled";
    w2.latestResult = "w2 finished first";
    for (const waiter of w2.waiters.splice(0)) {
      waiter.resolve({
        generation: 1,
        lifecycle: "settled",
        startedAt: w2.generationStartedAt,
        settledAt: Date.now(),
        turns: 2,
        resultText: "w2 finished first",
        exitCode: 0,
      });
    }
    const firstSettled = await firstWaitPromise;
    assert.equal(firstSettled.isError, false);
    assert.match(firstSettled.content[0].text, /task_2 settled \(generation 1\)/);
    assert.match(firstSettled.content[0].text, /others: task_1 running\. Call task_wait with ids \[task_1\]/);
    assert.equal(w1.waiters.length, 0, "losing waiter on task_1 detached cleanly without aborting task_1");
    assert.equal(w1.lifecycle, "running", "task_1 keeps running");

    // Settle w1, then call task_wait with the full wave ["task_1", "task_2"]: task_2 is skipped as already collected.
    w1.lifecycle = "settled";
    w1.latestResult = "w1 finished second";
    const secondSettled = await taskWait.execute("wait_wave_2", { ids: ["task_1", "task_2"] }, undefined, undefined, ctx);
    assert.equal(secondSettled.isError, false);
    assert.match(secondSettled.content[0].text, /task_1 already settled/);
    assert.match(secondSettled.content[0].text, /others: task_2 collected\. Every listed worker is now collected\./);

    // Calling again when all are collected returns the all-collected message.
    const allCollected = await taskWait.execute("wait_wave_3", { ids: ["task_1", "task_2"] }, undefined, undefined, ctx);
    assert.equal(allCollected.isError, false);
    assert.match(allCollected.content[0].text, /Every listed worker is already collected/);

    // 2. Fusion mode worker-scope gate: non-sidekick task_3 is rejected via both id and ids.
    emitBus("pi:modes:changed", {
      mode: "fusion",
      fusion: {
        lead: { provider: "p", modelId: "l", thinking: "high" },
        sidekick: { provider: "p", modelId: "s", thinking: "low" },
      },
    });
    const fireToolCall = (toolName: string, input: any) => {
      for (const fn of handlers.get("tool_call") ?? []) {
        const res = fn({ toolName, input });
        if (res) return res;
      }
      return undefined;
    };
    const singleGate = fireToolCall("task_wait", { id: "task_3" });
    assert.equal(singleGate?.block, true);
    assert.match(singleGate?.reason ?? "", /scoped to its sidekicks/);

    const multiGate = fireToolCall("task_wait", { ids: ["task_1", "task_3"] });
    assert.equal(multiGate?.block, true, "tool_call gate blocks non-sidekick inside ids array");
    assert.match(multiGate?.reason ?? "", /scoped to its sidekicks/);

    const directExecGate = await taskWait.execute("wait_fusion_scope", { ids: ["task_1", "task_3"] }, undefined, undefined, ctx);
    assert.equal(directExecGate.isError, true, "task_wait execute also enforces Fusion scope on ids array");
    assert.match(directExecGate.content[0].text, /scoped to its sidekicks/);
  } finally {
    for (const w of capturedWorkers) w.closed = true;
    if (priorMode === undefined) delete process.env.PI_BEHAVIOR_MODE; else process.env.PI_BEHAVIOR_MODE = priorMode;
  }
});

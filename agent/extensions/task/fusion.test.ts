import assert from "node:assert/strict";
import { test } from "node:test";
import asyncTask from "./async-task.ts";
import ampTask from "./amp-task.ts";
import { discoverAgents } from "./runtime/agent-discovery.ts";
import {
  FusionLifecycle,
  applySidekickModel,
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

test("Fusion runtime rejects roster dispatch and preserves an existing busy gate", async () => {
  const prior = process.env.PI_BEHAVIOR_MODE;
  const priorSidekick = process.env.PI_FUSION_SIDEKICK;
  process.env.PI_BEHAVIOR_MODE = "fusion";
  delete process.env.PI_FUSION_SIDEKICK;
  const handlers = new Map<string, Function[]>();
  const bus = new Map<string, Function>();
  const tools = new Map<string, any>();
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
    events: { on(name: string, fn: Function) { bus.set(name, fn); } },
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
    const busy = { busy: true }; bus.get("pi:modes:query-busy")!(busy); assert.equal(busy.busy, true);
    const idle = { busy: false }; bus.get("pi:modes:query-busy")!(idle); assert.equal(idle.busy, false);
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
    bus.get("pi:modes:changed")!({ mode: "apex" });
    assert.match(advertised().description, /machinist/);
    assert.match(agentParam(), /machinist/);
    assert.match(wrapped?.description ?? "", /machinist/);
    assert.match(wrappedAgent(), /machinist/);
    bus.get("pi:modes:changed")!({ mode: "fusion" });
    assert.match(advertised().description, /sidekick/);
    assert.doesNotMatch(advertised().description, /machinist|scout|artisan/);
    assert.match(advertised().description, /librarian|stevedore|oracle|picasso/);
    assert.match(agentParam(), /sidekick/);
    assert.doesNotMatch(agentParam(), /machinist|scout|artisan/);
    assert.match(wrapped?.description ?? "", /sidekick/);
    assert.doesNotMatch(wrapped?.description ?? "", /machinist|scout|artisan/);
    assert.match(wrappedAgent(), /sidekick/);
    assert.doesNotMatch(wrappedAgent(), /machinist|scout|artisan/);

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
  const settled = h.fusionWorker();
  h.workers.push(settled);
  assert.equal(h.lifecycle.find(), settled);
  const reused: any = await h.lifecycle.reuse("do it", {}, 1000);
  assert.equal(reused.kind, "reused");
  assert.deepEqual(h.started, ["task_1"]);
  assert.equal(settled.initialPrompt, "do it");
  assert.equal(settled.generation, 3);
  settled.lifecycle = "running";
  const active: any = await h.lifecycle.reuse("again", {}, 1000);
  assert.equal(active.kind, "active");
  assert.deepEqual(h.started, ["task_1"], "active worker takes no new generation");
  settled.lifecycle = "failed";
  settled.client.isClosed = true;
  const parked: any = await h.lifecycle.reuse("again", {}, 1000);
  assert.equal(parked.kind, "parked");
  assert.ok(h.parked.some(entry => entry.startsWith("task_1:")), "dead transport parked for resume");
  assert.equal(h.lifecycle.find(), undefined, "parked worker leaves the designated slot");
  assert.equal(fusionModelId(h.lifecycle.configured), "p/s");
});

test("FusionLifecycle reuse conflicts name truthful remedies and validates report contracts", async () => {
  const h = fusionHarness();
  h.workers.push(h.fusionWorker());
  const model = await h.lifecycle.reuse("x", { model: "q/other" }, 1000) as any;
  assert.equal(model.kind, "conflict");
  assert.match(model.reason, /\/mode configure/);
  assert.doesNotMatch(model.reason, /task_close/);
  const fork = await h.lifecycle.reuse("x", { context: "fork" }, 1000) as any;
  assert.equal(fork.kind, "conflict");
  assert.match(fork.reason, /new parent session/);
  assert.doesNotMatch(fork.reason, /task_close/);
  const cwd = await h.lifecycle.reuse("x", { cwd: "/other" }, 1000) as any;
  assert.equal(cwd.kind, "conflict");
  assert.match(cwd.reason, /task_close task_1/);
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
  h.lifecycle.parkForModeLeave();
  assert.ok(h.parked.some(entry => entry.startsWith("task_1:")), "settled parks on mode leave");
  assert.ok(!h.parked.some(entry => entry.startsWith("task_2:")), "live worker keeps running");
  const lookupBranch = [
    { type: "custom", customType: "fusion-sidekick-session", data: { parentSessionId: "parent-1", sessionFile: "/old.jsonl", cwd: "/w" } },
    { type: "message" },
    { type: "custom", customType: "fusion-sidekick-session", data: { parentSessionId: "parent-1", sessionFile: "/new.jsonl", sessionId: "s", cwd: "/w" } },
  ];
  assert.deepEqual(h.lifecycle.findTranscript(lookupBranch, "parent-1"), { parentSessionId: "parent-1", sessionFile: "/new.jsonl", sessionId: "s", cwd: "/w" });
  assert.equal(h.lifecycle.findTranscript(lookupBranch, "missing"), undefined);
  assert.equal(h.lifecycle.findTranscript(lookupBranch, undefined), undefined);
  assert.equal(h.lifecycle.gateSidekick("task_start"), "Fusion sidekick cannot dispatch agents, write the lead's plan, or coordinate peer sessions.");
  assert.equal(h.lifecycle.gateSidekick("read"), undefined);
  assert.equal(h.lifecycle.gateLead("task", "task_2"), undefined);
  assert.equal(h.lifecycle.gateLead("task_chain", "task_2"), "Fusion permits only its designated sidekick.");
  assert.equal(h.lifecycle.gateLead("task_send", "task_9"), "Fusion task operations are scoped to its designated sidekick.");
  assert.equal(h.lifecycle.gateLead("task_send", "task_2"), undefined);
  assert.equal(h.lifecycle.gateLead("edit", undefined), undefined, "lead edit allowed while worker is live");
  assert.equal(h.lifecycle.gateLead("bash", undefined), undefined, "lead bash allowed while worker is live");
  settled.lifecycle = "settled";
  live.lifecycle = "settled";
  foreign.lifecycle = "settled";
  assert.equal(h.lifecycle.gateLead("edit", undefined), undefined, "lead edit allowed after settle");
  assert.equal(h.lifecycle.gateLead("bash", undefined), undefined, "lead bash allowed after settle");
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

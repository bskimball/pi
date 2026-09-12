import assert from "node:assert/strict";
import { test } from "node:test";
import asyncTask from "./async-task.ts";
import ampTask from "./amp-task.ts";
import { discoverAgents } from "./runtime/agent-discovery.ts";

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
  const pi: any = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
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
    const chain = await tools.get("task_chain").execute("call", { steps: [{ agent: "machinist", prompt: "write a file" }] }, undefined, undefined, ctx);
    assert.equal(chain.isError, true);
    const busy = { busy: true }; bus.get("pi:modes:query-busy")!(busy); assert.equal(busy.busy, true);
    const idle = { busy: false }; bus.get("pi:modes:query-busy")!(idle); assert.equal(idle.busy, false);
    for (const toolName of ["task", "task_chain", "task_rebind", "intercom"]) {
      const result = handlers.get("tool_call")!.map(fn => fn({ toolName, input: {} })).find(Boolean);
      assert.equal(result.block, true);
    }
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

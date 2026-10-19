import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerModes } from "../prompt-commands/modes.ts";
import { initialPreferences, restoreMode } from "../prompt-commands/mode-state.ts";
import { FusionModelPicker, pickFusionModel } from "../prompt-commands/model-picker.ts";

const theme = { fg: (_key: string, text: string) => text } as Theme;
const models = Array.from({ length: 50 }, (_, index) => ({ provider: "local-proxy", id: `model-${String(index).padStart(2, "0")}`, name: `Model ${index}` })) as Model<Api>[];

function picker(scope = new Set<string>(), previous?: string) {
  let selected: Model<Api> | undefined;
  let completed = false;
  let rows = 24;
  const view = new FusionModelPicker("Fusion sidekick model", models, scope, previous, theme, () => rows, model => { selected = model; completed = true; });
  return { view, get selected() { return selected; }, get completed() { return completed; }, resize: (height: number) => { rows = height; } };
}

test("scrolls beyond the first viewport with arrows and pages while keeping selection visible", () => {
  const state = picker();
  assert.doesNotMatch(state.view.render(100).join("\n"), /model-30/);
  for (let index = 0; index < 30; index++) state.view.handleInput("\u001b[B");
  let output = state.view.render(100);
  assert.match(output.join("\n"), /model-30/);
  assert.match(output.join("\n"), /31\/50/);
  assert.ok(output.length <= 14);
  state.view.handleInput("\u001b[6~");
  assert.match(state.view.render(100).join("\n"), /model-38/);
  state.view.handleInput("\u001b[5~");
  state.view.handleInput("\r");
  assert.equal(state.selected?.id, "model-30");
});

test("search finds models outside the initial viewport and cancellation is non-selecting", () => {
  const state = picker();
  state.view.handleInput("model-49");
  assert.match(state.view.render(100).join("\n"), /model-49/);
  assert.doesNotMatch(state.view.render(100).join("\n"), /model-00/);
  state.view.handleInput("\r");
  assert.equal(state.selected?.id, "model-49");
  const canceled = picker();
  canceled.view.handleInput("\u001b");
  assert.equal(canceled.completed, true);
  assert.equal(canceled.selected, undefined);
});

test("uses configured scope with Tab to all configured models and seeds current role", () => {
  const state = picker(new Set(["local-proxy/model-02"]), "local-proxy/model-49");
  assert.match(state.view.render(100).join("\n"), /your model scope/);
  assert.doesNotMatch(state.view.render(100).join("\n"), /model-49/);
  state.view.handleInput("\t");
  assert.match(state.view.render(100).join("\n"), /all configured providers/);
  assert.match(state.view.render(100).join("\n"), /model-49/);
  state.view.handleInput("\r");
  assert.equal(state.selected?.id, "model-49");
});

test("resizes its viewport, bounds row widths, and handles no matches without selecting", () => {
  const state = picker();
  state.resize(16);
  for (const width of [50, 80, 120]) {
    const lines = state.view.render(width);
    assert.ok(lines.length <= 16);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }
  state.view.handleInput("no such model zzz");
  for (const width of [50, 80, 120]) {
    const lines = state.view.render(width);
    assert.match(lines.join("\n"), /No matching models/);
    assert.ok(lines.length <= 16);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }
  state.view.handleInput("\r");
  assert.equal(state.completed, false);
});

test("RPC selection offers configured provider/model identities through select, without refresh or input", async () => {
  const available = [...models].reverse();
  let refreshed = 0;
  let offered: string[] = [];
  let answer: string | undefined = "local-proxy/model-49";
  const ctx: any = {
    mode: "rpc", modelRegistry: { refresh: async () => { refreshed++; }, getAvailable: () => available },
    ui: { select: async (_title: string, options: string[]) => { offered = options; return answer; }, input: async () => assert.fail("input must not be used"), notify() {} },
  };
  assert.equal(await pickFusionModel(ctx, "Fusion lead"), available[0], "returns the exact model object");
  assert.equal(offered.length, models.length);
  assert.equal(offered[0], "local-proxy/model-00", "sorted by provider/id");
  await pickFusionModel(ctx, "Fusion lead", { provider: "local-proxy", modelId: "model-30" });
  assert.equal(offered[0], "local-proxy/model-30", "prior selection first");
  assert.equal(offered[1], "local-proxy/model-00");
  answer = undefined;
  assert.equal(await pickFusionModel(ctx, "Fusion lead"), undefined, "cancel returns undefined");
  assert.equal(refreshed, 0, "the registry snapshot is used without refresh");
  const warnings: string[] = [];
  ctx.modelRegistry.getAvailable = () => [];
  ctx.ui.notify = (text: string) => warnings.push(text);
  assert.equal(await pickFusionModel(ctx, "Fusion lead"), undefined);
  assert.match(warnings.join("\n"), /No models available/);
});

test("fusion-set changes only its role and rolls back failed asynchronous configuration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-fusion-set-"));
  const saved = { ...process.env };
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_SUBAGENT;
  const path = join(dir, "mode-settings.json");
  const pair = { lead: { provider: "configured", modelId: "Lead", thinking: "high" }, sidekick: { provider: "configured", modelId: "Side", thinking: "low" } };
  writeFileSync(path, JSON.stringify({ ...initialPreferences(), mode: "fusion", fusion: pair }));
  try {
    const commands: any = {}, handlers: any = {}, notices: string[] = [], statuses: any = {};
    const available = ["Lead", "Side", "Org/New", "Plain"].map(id => ({ provider: "configured", id, reasoning: id !== "Plain" }));
    let thinking = "high", busy = false, failure = "", rollbacks = 0, requests = 0;
    let pending: (() => void) | undefined;
    const ctx: any = { mode: "rpc", hasUI: true, model: available[0], isIdle: () => !busy,
      modelRegistry: { find: (provider: string, id: string) => available.find(m => m.provider === provider && m.id === id), getAvailable: () => available },
      sessionManager: { getBranch: () => [] },
      ui: { setStatus: (key: string, value: any) => { statuses[key] = value; }, notify: (text: string) => notices.push(text) } };
    const pi: any = { registerCommand: (name: string, spec: any) => { commands[name] = spec.handler; }, on: (name: string, fn: any) => { (handlers[name] ??= []).push(fn); },
      getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, appendEntry() {},
      getThinkingLevel: () => thinking, setThinkingLevel: (value: string) => { thinking = value; },
      setModel: async (model: any) => { ctx.model = model; return true; },
      events: { emit: (name: string, request: any) => {
        if (name !== "pi:fusion:configure") return;
        requests++;
        if (failure === "missing") return;
        request.acknowledged = true;
        request.rollback = async () => { rollbacks++; };
        request.promise = failure === "async" ? Promise.reject(new Error("configure rejected")) : failure === "pending" ? new Promise<void>(resolve => { pending = resolve; }) : Promise.resolve();
      } } };
    registerModes(pi, "", "", "", "");
    await handlers.session_start[0]({ reason: "new" }, ctx);
    const run = (args: string) => commands.mode(args, ctx);
    const published = () => JSON.parse(statuses["fusion-pair"]);
    await run("fusion-set sidekick model configured/Org/New");
    assert.deepEqual(published(), { lead: pair.lead, sidekick: { ...pair.sidekick, modelId: "Org/New" } });
    assert.equal(ctx.model.id, "Lead");
    await run("fusion-set sidekick thinking medium");
    const side = published().sidekick;
    await run("fusion-set lead model configured/Org/New");
    assert.deepEqual(published().sidekick, side);
    assert.equal(thinking, "high");
    await run("fusion-set lead thinking low");
    assert.equal(thinking, "low");
    assert.deepEqual(published().sidekick, side);
    await run("fusion-set sidekick model configured/Plain");
    assert.equal(published().sidekick.thinking, "off");
    const before = readFileSync(path, "utf8"), status = statuses["fusion-pair"], count = requests;
    for (const args of ["fusion-set sidekick model configured/missing", "fusion-set lead thinking nonsense", "fusion-set other model configured/Lead"]) await run(args);
    busy = true;
    await run("fusion-set lead model configured/Lead");
    busy = false;
    assert.equal(requests, count);
    for (failure of ["async", "missing"]) {
      await run("fusion-set lead model configured/Lead");
      assert.equal(readFileSync(path, "utf8"), before);
      assert.equal(statuses["fusion-pair"], status);
      assert.equal(ctx.model.id, "Org/New");
      assert.equal(thinking, "low");
    }
    assert.equal(rollbacks, 1);
    failure = "pending";
    const change = run("fusion-set sidekick thinking off");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(readFileSync(path, "utf8"), before, "no save before async acknowledgment completes");
    assert.equal(statuses["fusion-pair"], status);
    await run("fusion-set lead thinking high");
    pending!();
    await change;
    assert.equal(thinking, "low", "concurrent change was rejected");
    failure = "";
    await run("pi");
    const inactiveCount = requests;
    await run("fusion-set lead thinking high");
    assert.equal(requests, inactiveCount);
    assert.match(notices.join("\n"), /Unsupported thinking level/);
    assert.match(notices.join("\n"), /active, configured Fusion/);
    assert.match(notices.join("\n"), /did not acknowledge/);
    assert.match(notices.join("\n"), /configure rejected/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session_start honors explicit CLI --model/--thinking flags and trailing model_change entries instead of reverting to stale mode preferences", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mode-startup-model-"));
  const savedEnv = { ...process.env };
  const savedArgv = [...process.argv];
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_SUBAGENT;
  const path = join(dir, "mode-settings.json");
  writeFileSync(path, JSON.stringify({
    ...initialPreferences(),
    mode: "apex",
    models: { apex: { provider: "openai", modelId: "gpt-6.1-sol", thinking: "medium" } },
  }));
  try {
    const handlers: Record<string, Function[]> = {};
    const appended: Array<{ type: string; data: any }> = [];
    const available = [
      { provider: "openai", id: "gpt-6.1-sol", reasoning: true },
      { provider: "antigravity", id: "gemini-4-argon", reasoning: true },
    ];
    let thinking = "high";
    const ctx: any = {
      mode: "rpc",
      hasUI: true,
      model: available[1],
      isIdle: () => true,
      modelRegistry: {
        find: (provider: string, id: string) => available.find(m => m.provider === provider && m.id === id),
        getAvailable: () => available,
      },
      sessionManager: {
        getBranch: () => [
          { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
          {
            type: "custom",
            customType: "behavior-mode",
            data: { mode: "apex", models: { apex: { provider: "openai", modelId: "gpt-6.1-sol", thinking: "medium" } } },
          },
        ],
      },
      ui: { setStatus() {}, notify() {} },
    };
    const pi: any = {
      registerCommand() {},
      on: (name: string, fn: Function) => { (handlers[name] ??= []).push(fn); },
      getAllTools: () => [],
      getActiveTools: () => [],
      setActiveTools() {},
      appendEntry: (type: string, data: any) => { appended.push({ type, data }); },
      getThinkingLevel: () => thinking,
      setThinkingLevel: (value: string) => { thinking = value; },
      setModel: async (model: any) => { ctx.model = model; return true; },
      events: { emit() {} },
    };
    process.argv = ["node", "pi", "--mode", "rpc", "--provider", "antigravity", "--model", "gemini-4-argon", "--thinking", "high"];
    registerModes(pi, "", "", "", "");
    await handlers.session_start[0]({ reason: "startup" }, ctx);

    assert.equal(ctx.model.provider, "antigravity");
    assert.equal(ctx.model.id, "gemini-4-argon");
    assert.equal(thinking, "high");
    assert.deepEqual(appended.at(-1)?.data.models.apex, {
      provider: "antigravity",
      modelId: "gemini-4-argon",
      thinking: "high",
    });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).models.apex, {
      provider: "antigravity",
      modelId: "gemini-4-argon",
      thinking: "high",
    });

    const restoredWithTrailingModel = restoreMode([
      {
        type: "custom",
        customType: "behavior-mode",
        data: { mode: "apex", models: { apex: { provider: "openai", modelId: "gpt-6.1-sol", thinking: "medium" } } },
      },
      { type: "model_change", provider: "antigravity", modelId: "gemini-4-argon" },
      { type: "thinking_level_change", thinkingLevel: "high" },
    ], initialPreferences(), false);
    assert.deepEqual(restoredWithTrailingModel.models.apex, {
      provider: "antigravity",
      modelId: "gemini-4-argon",
      thinking: "high",
    });
  } finally {
    process.argv = savedArgv;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(dir, { recursive: true, force: true });
  }
});

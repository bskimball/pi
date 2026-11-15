import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTransitionController } from "../prompt-commands/transition-controller.ts";
import { registerModes } from "../prompt-commands/modes.ts";
import { initialPreferences, type Preferences } from "../prompt-commands/mode-state.ts";

test("transition leases reject overlapping work and stale completion; restoration waits for ownership", async () => {
  const state = createTransitionController();
  const first = state.begin("switching")!;
  assert.equal(state.begin("routing"), undefined);
  let restored = false;
  const pending = state.acquire("restoring").then(token => { restored = true; return token; });
  await Promise.resolve();
  assert.equal(restored, false);
  state.end(first + 99);
  assert.equal(state.busy, true);
  state.end(first);
  const second = await pending;
  state.end(first);
  assert.equal(state.busy, true);
  state.end(second);
  assert.equal(state.busy, false);
});

test("model repair and manual selection cannot clear recovery failure", () => {
  const state = createTransitionController();
  state.modelBlocked = "model failed";
  state.recoveryBlocked = "rollback failed";
  state.manualPin = true;
  state.failedLead = "openai/lead";
  state.modelBlocked = false;
  assert.equal(state.recoveryBlocked, "rollback failed");
  assert.equal(state.manualPin, true);
  assert.equal(state.failedLead, "openai/lead");
  state.manualPin = false;
  state.failedLead = undefined;
  state.recoveryBlocked = false;
  assert.equal(state.recoveryBlocked, false);
});

function fixture(prefs: Partial<Preferences> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "pi-mode-transitions-"));
  const savedEnv = { ...process.env };
  process.env.PI_CODING_AGENT_DIR = directory;
  delete process.env.PI_SUBAGENT;
  const path = join(directory, "mode-settings.json");
  writeFileSync(path, JSON.stringify({ ...initialPreferences(), ...prefs }));
  const handlers: Record<string, Function[]> = {};
  const listeners: Record<string, Function[]> = {};
  const commands: Record<string, Function> = {};
  const entries: any[] = [];
  const notices: string[] = [];
  let thinking = "high";
  let activeTools = ["read"];
  let theme = "apex-dark";
  const model = { provider: "configured", id: "lead", reasoning: true };
  const ctx: any = {
    hasUI: true, mode: "rpc", model, isIdle: () => true,
    modelRegistry: { find: () => model, getAvailable: () => [model] },
    sessionManager: { getBranch: () => [] },
    ui: {
      get theme() { return { name: theme }; },
      setTheme: (name: string) => { theme = name; return { success: true }; },
      setStatus() {}, notify: (message: string) => notices.push(message),
    },
  };
  const pi: any = {
    registerCommand: (name: string, spec: any) => { commands[name] = spec.handler; },
    on: (name: string, fn: Function) => { (handlers[name] ??= []).push(fn); },
    appendEntry: (_type: string, data: any) => entries.push(structuredClone(data)),
    getAllTools: () => [{ name: "read" }], getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => { activeTools = tools; },
    getThinkingLevel: () => thinking, setThinkingLevel: (value: string) => { thinking = value; },
    setModel: async (value: any) => { ctx.model = value; return true; },
    events: {
      on: (name: string, fn: Function) => { (listeners[name] ??= []).push(fn); },
      emit: (name: string, value: unknown) => { for (const fn of listeners[name] ?? []) fn(value); },
    },
  };
  registerModes(pi, "apex card", "orchestrate card", "fusion card", "work card");
  return {
    ctx, pi, handlers, entries, notices, path,
    run: (command: string, value: string) => commands[command](value, ctx),
    get theme() { return theme; },
    blockSave() { mkdirSync(`${path}.${process.pid}.tmp`); },
    unblockSave() { rmSync(`${path}.${process.pid}.tmp`, { recursive: true, force: true }); },
    preferences: () => JSON.parse(readFileSync(path, "utf8")),
    close() {
      for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
      Object.assign(process.env, savedEnv);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("Hydra tier and Jippity scope save failures restore session state and block input until repair", async () => {
  for (const [command, args] of [["mode", "hydra off"], ["jippity", "off"]]) {
    const f = fixture({ hydra: "high", hydraScope: "openai" });
    try {
      const before = f.preferences();
      f.blockSave();
      await f.run(command, args);
      assert.deepEqual(f.preferences(), before);
      assert.equal(f.entries.at(-1).hydra, "high");
      assert.equal(f.entries.at(-1).hydraScope, "openai");
      assert.equal(process.env.PI_HYDRA_SCOPE, "openai");
      assert.equal(f.handlers.input[0]({}, f.ctx)?.action, "handled");
      f.unblockSave();
      await f.run("mode", "pi");
      assert.equal(f.handlers.input[0]({}, f.ctx), undefined);
      assert.equal(f.preferences().mode, "pi");
      assert.equal(f.preferences().hydra, undefined);
    } finally { f.close(); }
  }
});

test("presentation save failure restores theme and exact chrome environment; retry commits independently", async () => {
  const f = fixture();
  try {
    const before = f.preferences();
    const env = [process.env.PI_UI_CHROME, process.env.PI_APEX_UI, process.env.PI_UI_SKIN];
    f.blockSave();
    await f.run("ui", "hal");
    assert.deepEqual(f.preferences(), before);
    assert.equal(f.theme, "apex-dark");
    assert.deepEqual([process.env.PI_UI_CHROME, process.env.PI_APEX_UI, process.env.PI_UI_SKIN], env);
    assert.match(f.notices.join("\n"), /UI switch failed/);
    f.unblockSave();
    await f.run("ui", "hal");
    assert.equal(f.theme, "hal-dark");
    assert.equal(f.preferences().ui, "hal");
    assert.equal(f.preferences().mode, before.mode);
    assert.equal(process.env.PI_UI_SKIN, "hal");
  } finally { f.close(); }
});

test("mode transition blocks presentation and session restoration waits for the in-flight model apply", async () => {
  const f = fixture({ models: { apex: { provider: "configured", modelId: "lead", thinking: "high" } } });
  try {
    let release!: () => void;
    let calls = 0;
    f.pi.setModel = async () => { if (++calls === 1) await new Promise<void>(resolve => { release = resolve; }); return true; };
    const switching = f.run("mode", "pi");
    await Promise.resolve();
    const restoring = f.handlers.session_start[0]({ reason: "new" }, f.ctx);
    await f.run("ui", "hal");
    assert.equal(calls, 1);
    assert.equal(f.preferences().ui, "apex");
    release();
    await Promise.all([switching, restoring]);
    assert.equal(f.preferences().mode, "pi");
    await f.run("ui", "hal");
    assert.equal(f.preferences().ui, "hal");
  } finally { f.close(); }
});

test("failed session reconstruction releases restoration lease so mode repair remains available", async () => {
  const f = fixture();
  try {
    writeFileSync(f.path, "invalid json");
    await f.handlers.session_start[0]({ reason: "new" }, f.ctx);
    assert.equal(f.handlers.input[0]({}, f.ctx)?.action, "handled");
    writeFileSync(f.path, JSON.stringify(initialPreferences()));
    await f.run("mode", "pi");
    assert.equal(f.preferences().mode, "pi");
    assert.equal(f.handlers.input[0]({}, f.ctx), undefined);
  } finally { f.close(); }
});

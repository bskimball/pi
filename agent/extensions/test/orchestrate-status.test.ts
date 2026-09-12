import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import promptCommands, { REGULAR_SYSTEM_BLOCK, ORCHESTRATE_SYSTEM_BLOCK, FUSION_SYSTEM_BLOCK } from "../prompt-commands.ts";
import { restoreMode, initialPreferences, toolsForMode } from "../prompt-commands/mode-state.ts";

test("legacy modes restore without adopting a new global default", () => {
  const prefs = initialPreferences(); prefs.mode = "pi";
  assert.equal(restoreMode([], prefs, false).mode, "apex");
  assert.equal(restoreMode([], prefs, true).mode, "pi");
  assert.equal(restoreMode([{ type: "custom", customType: "orchestrate-mode", data: { enabled: true } }], prefs, false).mode, "apex-orchestrate");
});
test("Pi exposes built-in default tools; Fusion excludes roster dispatch but keeps coordination", () => {
  const tools = ["read", "write", "edit", "bash", "task", "task_chain", "task_start", "todo_write", "intercom", "fffind", "ffgrep"];
  assert.deepEqual(toolsForMode("pi", tools), ["read", "write", "edit", "bash"]);
  assert.deepEqual(toolsForMode("fusion", tools), ["read", "write", "edit", "bash", "task_start", "todo_write", "intercom", "fffind", "ffgrep"]);
});
test("mode commands switch prompts, enforce idle, persist and restore, and change UI independently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-modes-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldChild = process.env.PI_SUBAGENT;
  const oldMode = process.env.PI_BEHAVIOR_MODE;
  const oldUi = process.env.PI_APEX_UI;
  const oldSkin = process.env.PI_UI_SKIN;
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_SUBAGENT;
  try {
    const commands: Record<string, any> = {};
    const handlers: Record<string, any[]> = {};
    const entries: any[] = [];
    let active: string[] = [];
    const allTools = ["read", "write", "edit", "bash", "task_start"];
    let busy = false;
    let workerBusy = false;
    const notices: string[] = [];
    const ctx: any = { cwd: dir, hasUI: true, isIdle: () => !busy,
      sessionManager: { getEntries: () => entries, getBranch: () => entries },
      ui: { theme: { name: "apex-dark" }, setStatus() {}, notify: (text: string) => notices.push(text), setTheme(name: string) { this.theme.name = name; return { success: true }; } },
    };
    const pi: any = {
      registerCommand: (name: string, spec: any) => { commands[name] = spec.handler; }, registerTool() {}, registerShortcut() {},
      on: (name: string, handler: any) => { (handlers[name] ??= []).push(handler); },
      events: { emit(name: string, data: any) { if (name === "pi:modes:query-busy" && workerBusy) data.busy = true; } },
      appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
      getAllTools: () => allTools.map(name => ({ name })),
      getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; }, getThinkingLevel: () => "medium", setThinkingLevel() {},
    };
    promptCommands(pi);
    const emit = async (name: string, event: any = {}) => { let result; for (const handler of handlers[name] ?? []) result = await handler(event, ctx); return result; };
    await emit("session_start", { reason: "new" });
    const prompt = () => emit("before_agent_start", { systemPrompt: "Apex base", systemPromptOptions: { cwd: dir, toolSnippets: { read: "Read files" } } });
    assert.equal((await prompt()).systemPrompt, "Apex base" + REGULAR_SYSTEM_BLOCK);
    await commands.orchestrate("on", ctx);
    assert.equal((await prompt()).systemPrompt, "Apex base" + ORCHESTRATE_SYSTEM_BLOCK);
    busy = true;
    await commands.mode("pi", ctx);
    assert.equal(process.env.PI_BEHAVIOR_MODE, "apex-orchestrate");
    busy = false; workerBusy = true;
    await commands.mode("pi", ctx);
    assert.equal(process.env.PI_BEHAVIOR_MODE, "apex-orchestrate");
    workerBusy = false;
    await commands.mode("pi", ctx);
    assert.match((await prompt()).systemPrompt, /^You are an expert coding assistant operating inside pi/);
    assert.doesNotMatch((await prompt()).systemPrompt, /Apex base|Strict orchestrator/);
    assert.deepEqual(active, ["read", "write", "edit", "bash"]);
    allTools.push("fffind", "ffgrep", "intercom");
    await commands.mode("apex", ctx);
    assert.deepEqual(active, ["read", "write", "edit", "bash", "task_start", "fffind", "ffgrep", "intercom"]);
    entries.push({ type: "custom", customType: "behavior-mode", data: { mode: "fusion", models: {}, fusion: { lead: { provider: "configured", modelId: "lead", thinking: "medium" }, sidekick: { provider: "configured", modelId: "sidekick", thinking: "low" } } } });
    ctx.modelRegistry = { find: () => ({ provider: "configured", id: "lead" }) };
    pi.setModel = async () => true;
    await emit("session_start", { reason: "resume" });
    assert.equal(process.env.PI_BEHAVIOR_MODE, "fusion");
    const fused = (await prompt()).systemPrompt;
    assert.equal(fused, "Apex base" + FUSION_SYSTEM_BLOCK);
    assert.doesNotMatch(fused, /^You are an expert coding assistant operating inside pi/);
    assert.doesNotMatch(fused, /Regular mode \(active\)|Strict orchestrator mode \(active\)/);
    await commands.mode("pi", ctx);
    assert.deepEqual(active, ["read", "write", "edit", "bash"]);
    await commands.ui("pi", ctx);
    assert.equal(process.env.PI_APEX_UI, "0");
    assert.equal(process.env.PI_BEHAVIOR_MODE, "pi");
    ctx.ui.theme.name = "light";
    await commands.ui("apex", ctx);
    assert.equal(ctx.ui.theme.name, "apex-dark");
    await commands.ui("pi", ctx);
    assert.equal(ctx.ui.theme.name, "light");
    await commands.ui("claude", ctx);
    assert.equal(process.env.PI_APEX_UI, "1");
    assert.equal(process.env.PI_UI_SKIN, "claude");
    assert.equal(ctx.ui.theme.name, "claude-dark");
    await commands.ui("apex", ctx);
    assert.equal(process.env.PI_APEX_UI, "1");
    assert.equal(process.env.PI_UI_SKIN, "apex");
    assert.equal(ctx.ui.theme.name, "apex-dark");
    await commands.ui("pi", ctx);
    assert.equal(process.env.PI_APEX_UI, "0");
    assert.equal(process.env.PI_UI_SKIN, "apex");
    assert.equal(ctx.ui.theme.name, "light");
    const savedUi = JSON.parse(readFileSync(join(dir, "mode-settings.json"), "utf8"));
    assert.equal(savedUi.ui, "pi");
    assert.equal(savedUi.themes.claude, "claude-dark");
    assert.equal(savedUi.themes.apex, "apex-dark");
    assert.equal(savedUi.themes.pi, "light");
    assert.equal(JSON.parse(readFileSync(join(dir, "mode-settings.json"), "utf8")).mode, "pi");
    assert.ok(notices.some(text => text.includes("Stop active")));
    const catalog = [
      { provider: "configured", id: "lead", reasoning: false },
      { provider: "configured", id: "not-in-available-snapshot", reasoning: false },
    ];
    let refreshed = false;
    const shown: string[] = [];
    ctx.mode = "tui";
    ctx.scopedModels = [];
    ctx.modelRegistry = {
      async refresh() { refreshed = true; },
      getAll() { return catalog; },
      getAvailable() { assert.equal(refreshed, true); return catalog.slice(0, 1); },
      find: () => undefined,
    };
    ctx.ui.custom = async (factory: Function) => new Promise(resolve => {
      const picker = factory({ terminal: { rows: 24 } }, { fg: (_key: string, text: string) => text }, {}, resolve);
      shown.push(picker.render(100).join("\n"));
      picker.handleInput("\r");
    });
    ctx.ui.select = async () => "off";
    await commands.mode("configure", ctx);
    assert.equal(shown.length, 2);
    for (const view of shown) {
      assert.match(view, /lead/);
      assert.doesNotMatch(view, /not-in-available-snapshot/);
    }
    assert.equal(process.env.PI_BEHAVIOR_MODE, "pi", "unavailable selection leaves prior mode intact");
    const prefsPath = join(dir, "mode-settings.json");
    const otherSession = JSON.parse(readFileSync(prefsPath, "utf8"));
    otherSession.mode = "fusion"; otherSession.ui = "apex";
    writeFileSync(prefsPath, JSON.stringify(otherSession));
    await emit("session_shutdown");
    const afterShutdown = JSON.parse(readFileSync(prefsPath, "utf8"));
    assert.equal(afterShutdown.mode, "fusion");
    assert.equal(afterShutdown.ui, "apex");
    entries.push({ type: "custom", customType: "behavior-mode", data: { mode: "fusion", models: {}, fusion: { lead: { provider: "missing", modelId: "unavailable", thinking: "high" }, sidekick: { provider: "missing", modelId: "sidekick", thinking: "low" } } } });
    ctx.modelRegistry = { find: () => undefined };
    await emit("session_start", { reason: "resume" });
    assert.deepEqual(await emit("input", { text: "continue" }), { action: "handled" });
  } finally {
    for (const [key, value] of Object.entries({ PI_CODING_AGENT_DIR: oldDir, PI_SUBAGENT: oldChild, PI_BEHAVIOR_MODE: oldMode, PI_APEX_UI: oldUi, PI_UI_SKIN: oldSkin })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

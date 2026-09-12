import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import promptCommands, { REGULAR_SYSTEM_BLOCK, ORCHESTRATE_SYSTEM_BLOCK, FUSION_SYSTEM_BLOCK, WORK_SYSTEM_PROMPT } from "../prompt-commands.ts";
import { restoreMode, initialPreferences, toolsForMode } from "../prompt-commands/mode-state.ts";

const builderUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "core/system-prompt.js")).href;
const { buildSystemPrompt } = await import(builderUrl) as { buildSystemPrompt: (options: any) => string };

test("legacy modes restore without adopting a new global default", () => {
  const prefs = initialPreferences(); prefs.mode = "pi";
  assert.equal(restoreMode([], prefs, false).mode, "apex");
  assert.equal(restoreMode([], prefs, true).mode, "pi");
  assert.equal(restoreMode([{ type: "custom", customType: "orchestrate-mode", data: { enabled: true } }], prefs, false).mode, "apex-orchestrate");
});
test("Pi exposes built-in default tools; collaboration modes exclude chain/rebind while Work keeps the full roster", () => {
  const tools = ["read", "write", "edit", "bash", "task", "task_chain", "task_rebind", "task_start", "todo_write", "intercom", "fffind", "ffgrep"];
  const collaborationTools = ["read", "write", "edit", "bash", "task", "task_start", "todo_write", "intercom", "fffind", "ffgrep"];
  assert.deepEqual(toolsForMode("pi", tools), ["read", "write", "edit", "bash"]);
  assert.deepEqual(toolsForMode("fusion", tools), collaborationTools);
  assert.deepEqual(toolsForMode("work", tools), collaborationTools);
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
      events: { emit(name: string, data: any) { if (name === "pi:modes:query-busy" && workerBusy) data.busy = true; if (name === "pi:fusion:configure") { data.acknowledged = true; data.promise = Promise.resolve(); } } },
      appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
      getAllTools: () => allTools.map(name => ({ name })),
      getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; }, getThinkingLevel: () => "medium", setThinkingLevel() {},
    };
    promptCommands(pi);
    const emit = async (name: string, event: any = {}) => { let result; for (const handler of handlers[name] ?? []) result = await handler(event, ctx); return result; };
    await emit("session_start", { reason: "new" });
    const prompt = (systemPrompt = "Apex base") => emit("before_agent_start", {
      systemPrompt,
      systemPromptOptions: {
        cwd: dir,
        toolSnippets: { read: "Read files" },
        promptGuidelines: ["Use the workspace capability contract"],
        contextFiles: [{ path: "AGENTS.md", content: "Project boundary applies." }],
      },
    });
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
    await commands.mode("work", ctx);
    assert.equal(process.env.PI_BEHAVIOR_MODE, "work");
    const workBaseline = buildSystemPrompt({
      cwd: dir,
      toolSnippets: { read: "Read files" },
      promptGuidelines: ["Use the workspace capability contract"],
      contextFiles: [{ path: "AGENTS.md", content: "Project boundary applies." }],
    });
    const workPrompt = (await prompt(workBaseline)).systemPrompt;
    assert.match(workPrompt, /operations-first lead/);
    assert.match(workPrompt, /Work mode \(active\)/);
    assert.doesNotMatch(workPrompt, /Apex base|Fusion mode \(active\)/);
    assert.match(workPrompt, /Active tool guidance[\s\S]*Read files/, "Work retains active tool snippets");
    assert.match(workPrompt, /Active tool rules[\s\S]*Use the workspace capability contract/, "Work retains extension prompt guidelines");
    assert.match(workPrompt, /<project_context>[\s\S]*Project boundary applies\./, "Work builder retains project context");
    assert.match(workPrompt, /Current working directory:/, "Work builder retains prompt composition");
    const workOptions = {
      cwd: dir,
      toolSnippets: { read: "Read files" },
      promptGuidelines: ["Use the workspace capability contract"],
      customPrompt: "Coding-first base that Work must replace.",
      appendSystemPrompt: "Caller-provided instruction.",
      contextFiles: [{ path: "AGENTS.md", content: "Project boundary applies." }],
    };
    const stockBaseline = buildSystemPrompt(workOptions);
    const memorySuffix = "\n\n## Continual memory\nMemory-like dynamic context.";
    const retainedDynamic = await emit("before_agent_start", { systemPrompt: stockBaseline + memorySuffix, systemPromptOptions: workOptions });
    assert.match(retainedDynamic.systemPrompt, /Memory-like dynamic context\./, "Work retains a prior extension's dynamic suffix");
    assert.equal(retainedDynamic.systemPrompt.split("Memory-like dynamic context.").length - 1, 1, "dynamic suffix is retained once");
    assert.match(retainedDynamic.systemPrompt, /Caller-provided instruction\./, "Work preserves caller append instructions");
    assert.doesNotMatch(retainedDynamic.systemPrompt, /^You are an expert coding assistant operating inside pi/, "Work does not restore the stock coding base");
    assert.doesNotMatch(retainedDynamic.systemPrompt, /Coding-first base that Work must replace/);
    assert.equal(WORK_SYSTEM_PROMPT.includes("operations-first lead"), true);
    await commands.mode("pi", ctx);
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
    await commands.ui("hal", ctx);
    assert.equal(process.env.PI_APEX_UI, "1");
    assert.equal(process.env.PI_UI_SKIN, "hal");
    assert.equal(ctx.ui.theme.name, "hal-dark");
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
    assert.equal(savedUi.themes.hal, "hal-dark");
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

test("mode switch failure after tool change restores prior tools, model, env, and prefs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-modes-recovery-"));
  const saved = { dir: process.env.PI_CODING_AGENT_DIR, sub: process.env.PI_SUBAGENT, mode: process.env.PI_BEHAVIOR_MODE };
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_SUBAGENT;
  try {
    const commands: Record<string, any> = {};
    const handlers: Record<string, any[]> = {};
    const entries: any[] = [];
    let active: string[] = [];
    const allTools = ["read", "write", "edit", "bash", "task_start", "task"];
    const notices: string[] = [];
    const setModelCalls: any[] = [];
    let failToolsOnce = false;
    const ctx: any = { cwd: dir, hasUI: true, isIdle: () => true,
      model: { provider: "configured", id: "lead" },
      modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
      sessionManager: { getEntries: () => entries, getBranch: () => entries },
      ui: { theme: { name: "apex-dark" }, setStatus() {}, notify: (text: string) => notices.push(text), setTheme(name: string) { this.theme.name = name; return { success: true }; } },
    };
    const pi: any = {
      registerCommand: (name: string, spec: any) => { commands[name] = spec.handler; }, registerTool() {}, registerShortcut() {},
      on: (name: string, handler: any) => { (handlers[name] ??= []).push(handler); },
      events: { emit() {} },
      appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
      getAllTools: () => allTools.map(name => ({ name })),
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => { if (failToolsOnce) { failToolsOnce = false; throw new Error("tools unavailable"); } active = names; },
      getThinkingLevel: () => "medium", setThinkingLevel() {},
      setModel: async (model: any) => { setModelCalls.push(model); return true; },
    };
    promptCommands(pi);
    const emit = async (name: string, event: any = {}) => { let result; for (const handler of handlers[name] ?? []) result = await handler(event, ctx); return result; };
    await emit("session_start", { reason: "new" });
    await commands.mode("pi", ctx);
    assert.deepEqual(active, ["read", "write", "edit", "bash"]);
    assert.equal(process.env.PI_BEHAVIOR_MODE, "pi");
    failToolsOnce = true;
    await commands.mode("apex", ctx);
    assert.match(notices[notices.length - 1], /Mode switch to Apex failed.*restored Pi/);
    assert.deepEqual(active, ["read", "write", "edit", "bash"], "prior Pi tool set restored");
    assert.equal(process.env.PI_BEHAVIOR_MODE, "pi", "mode env restored");
    const prompt = await emit("before_agent_start", { systemPrompt: "Apex base", systemPromptOptions: { cwd: dir } });
    assert.match(prompt.systemPrompt, /^You are an expert coding assistant operating inside pi/, "still Pi prompt");
    const lastEntry = [...entries].reverse().find(entry => entry.customType === "behavior-mode");
    assert.equal(lastEntry.data.mode, "pi", "compensation entry reflects restored state");
    assert.equal(JSON.parse(readFileSync(join(dir, "mode-settings.json"), "utf8")).mode, "pi", "prefs default untouched");
    assert.equal(await emit("input", { text: "go" }), undefined, "clean recovery does not block input");
  } finally {
    for (const [key, value] of Object.entries({ PI_CODING_AGENT_DIR: saved.dir, PI_SUBAGENT: saved.sub, PI_BEHAVIOR_MODE: saved.mode })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed fusion configure runs sidekick rollback and restores the lead", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-modes-rollback-"));
  const saved = { dir: process.env.PI_CODING_AGENT_DIR, sub: process.env.PI_SUBAGENT, mode: process.env.PI_BEHAVIOR_MODE };
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_SUBAGENT;
  try {
    const commands: Record<string, any> = {};
    const handlers: Record<string, any[]> = {};
    const entries: any[] = [];
    let active: string[] = [];
    const allTools = ["read", "write", "edit", "bash", "task_start", "task"];
    const notices: string[] = [];
    const thinkingLevels: string[] = [];
    const fusionHandlers: Array<(request: any) => void> = [];
    let rollbackCalls = 0;
    const pair = { lead: { provider: "configured", modelId: "lead", thinking: "high" }, sidekick: { provider: "configured", modelId: "sidekick", thinking: "low" } };
    const ctx: any = { cwd: dir, hasUI: true, isIdle: () => true,
      model: { provider: "configured", id: "lead" },
      modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
      sessionManager: { getEntries: () => entries, getBranch: () => entries },
      ui: { theme: { name: "apex-dark" }, setStatus() {}, notify: (text: string) => notices.push(text), setTheme(name: string) { this.theme.name = name; return { success: true }; } },
    };
    const pi: any = {
      registerCommand: (name: string, spec: any) => { commands[name] = spec.handler; }, registerTool() {}, registerShortcut() {},
      on: (name: string, handler: any) => { (handlers[name] ??= []).push(handler); },
      events: { emit(name: string, data: any) { if (name === "pi:fusion:configure") for (const fn of fusionHandlers) fn(data); }, on(name: string, fn: any) { if (name === "pi:fusion:configure") fusionHandlers.push(fn); } },
      appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
      getAllTools: () => allTools.map(name => ({ name })),
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => { active = names; },
      getThinkingLevel: () => thinkingLevels[thinkingLevels.length - 1] ?? "medium",
      setThinkingLevel(level: string) { thinkingLevels.push(level); },
      setModel: async () => true,
    };
    // Fake task side of the handshake: acknowledge, attach rollback, then fail.
    fusionHandlers.push((request: any) => {
      request.acknowledged = true;
      request.rollback = async () => { rollbackCalls += 1; };
      request.promise = Promise.reject(new Error("sidekick down"));
    });
    promptCommands(pi);
    const emit = async (name: string, event: any = {}) => { let result; for (const handler of handlers[name] ?? []) result = await handler(event, ctx); return result; };
    entries.push({ type: "custom", customType: "behavior-mode", data: { mode: "apex", models: {}, fusion: pair } });
    await emit("session_start", { reason: "resume" });
    await commands.mode("fusion", ctx);
    assert.equal(rollbackCalls, 1, "sidekick rollback ran");
    assert.match(notices[notices.length - 1], /Mode switch to Fusion failed.*sidekick down.*restored Apex/);
    assert.deepEqual(active, allTools, "prior Apex tool set restored");
    assert.equal(process.env.PI_BEHAVIOR_MODE, "apex");
    assert.equal(thinkingLevels[thinkingLevels.length - 1], "medium", "lead thinking restored");
    const prompt = await emit("before_agent_start", { systemPrompt: "Apex base", systemPromptOptions: { cwd: dir } });
    assert.equal(prompt.systemPrompt, "Apex base" + REGULAR_SYSTEM_BLOCK, "still Regular prompt");
  } finally {
    for (const [key, value] of Object.entries({ PI_CODING_AGENT_DIR: saved.dir, PI_SUBAGENT: saved.sub, PI_BEHAVIOR_MODE: saved.mode })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing fusion acknowledgement fails without applying anything", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-modes-handshake-"));
  const saved = { dir: process.env.PI_CODING_AGENT_DIR, sub: process.env.PI_SUBAGENT, mode: process.env.PI_BEHAVIOR_MODE };
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_SUBAGENT;
  try {
    const commands: Record<string, any> = {};
    const handlers: Record<string, any[]> = {};
    const entries: any[] = [];
    let active: string[] = [];
    const allTools = ["read", "write", "edit", "bash", "task_start", "task"];
    const notices: string[] = [];
    let configureSeen = 0;
    const pair = { lead: { provider: "configured", modelId: "lead", thinking: "high" }, sidekick: { provider: "configured", modelId: "sidekick", thinking: "low" } };
    const ctx: any = { cwd: dir, hasUI: true, isIdle: () => true,
      model: { provider: "configured", id: "lead" },
      modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
      sessionManager: { getEntries: () => entries, getBranch: () => entries },
      ui: { theme: { name: "apex-dark" }, setStatus() {}, notify: (text: string) => notices.push(text), setTheme(name: string) { this.theme.name = name; return { success: true }; } },
    };
    const pi: any = {
      registerCommand: (name: string, spec: any) => { commands[name] = spec.handler; }, registerTool() {}, registerShortcut() {},
      on: (name: string, handler: any) => { (handlers[name] ??= []).push(handler); },
      events: { emit(name: string) { if (name === "pi:fusion:configure") configureSeen += 1; }, on() {} },
      appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
      getAllTools: () => allTools.map(name => ({ name })),
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => { active = names; },
      getThinkingLevel: () => "medium", setThinkingLevel() {},
      setModel: async () => true,
    };
    promptCommands(pi);
    const emit = async (name: string, event: any = {}) => { let result; for (const handler of handlers[name] ?? []) result = await handler(event, ctx); return result; };
    entries.push({ type: "custom", customType: "behavior-mode", data: { mode: "apex", models: {}, fusion: pair } });
    await emit("session_start", { reason: "resume" });
    const before = [...active];
    await commands.mode("fusion", ctx);
    assert.equal(configureSeen, 1);
    assert.match(notices[notices.length - 1], /did not acknowledge/);
    assert.deepEqual(active, before, "tools untouched");
    assert.equal(process.env.PI_BEHAVIOR_MODE, "apex");
  } finally {
    for (const [key, value] of Object.entries({ PI_CODING_AGENT_DIR: saved.dir, PI_SUBAGENT: saved.sub, PI_BEHAVIOR_MODE: saved.mode })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("incomplete recovery blocks input until a later /mode succeeds; /model cannot clear it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-modes-blocked-"));
  const saved = { dir: process.env.PI_CODING_AGENT_DIR, sub: process.env.PI_SUBAGENT, mode: process.env.PI_BEHAVIOR_MODE };
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_SUBAGENT;
  try {
    const commands: Record<string, any> = {};
    const handlers: Record<string, any[]> = {};
    const entries: any[] = [];
    let active: string[] = [];
    const allTools = ["read", "write", "edit", "bash", "task_start", "task"];
    const notices: string[] = [];
    let toolsBroken = false;
    let failOnce = false;
    const ctx: any = { cwd: dir, hasUI: true, isIdle: () => true,
      model: { provider: "configured", id: "lead" },
      modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
      sessionManager: { getEntries: () => entries, getBranch: () => entries },
      ui: { theme: { name: "apex-dark" }, setStatus() {}, notify: (text: string) => notices.push(text), setTheme(name: string) { this.theme.name = name; return { success: true }; } },
    };
    const pi: any = {
      registerCommand: (name: string, spec: any) => { commands[name] = spec.handler; }, registerTool() {}, registerShortcut() {},
      on: (name: string, handler: any) => { (handlers[name] ??= []).push(handler); },
      events: { emit() {} },
      appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
      getAllTools: () => allTools.map(name => ({ name })),
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => { if (toolsBroken || failOnce) { failOnce = false; throw new Error("tools unavailable"); } active = names; },
      getThinkingLevel: () => "medium", setThinkingLevel() {},
      setModel: async () => true,
    };
    promptCommands(pi);
    const emit = async (name: string, event: any = {}) => { let result; for (const handler of handlers[name] ?? []) result = await handler(event, ctx); return result; };
    await emit("session_start", { reason: "new" });
    toolsBroken = true;
    await commands.mode("pi", ctx);
    assert.match(notices[notices.length - 1], /recovery is incomplete/);
    assert.deepEqual(await emit("input", { text: "go" }), { action: "handled" }, "input blocked");
    assert.match(notices[notices.length - 1], /recovery is incomplete/);
    await emit("model_select", { model: { provider: "configured", id: "other" }, source: "user" });
    assert.deepEqual(await emit("input", { text: "go" }), { action: "handled" }, "/model does not clear recovery block");
    failOnce = true;
    toolsBroken = false;
    await commands.mode("pi", ctx);
    assert.match(notices[notices.length - 1], /still in effect/, "cleanly compensated failure preserves the block");
    assert.deepEqual(await emit("input", { text: "go" }), { action: "handled" }, "block still enforced");
    await commands.mode("pi", ctx);
    assert.equal(await emit("input", { text: "go" }), undefined, "successful /mode clears the block");
    assert.deepEqual(active, ["read", "write", "edit", "bash"]);
  } finally {
    for (const [key, value] of Object.entries({ PI_CODING_AGENT_DIR: saved.dir, PI_SUBAGENT: saved.sub, PI_BEHAVIOR_MODE: saved.mode })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mode recovery repairs the persisted desired lead, not the half-applied actual model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-modes-repair-"));
  const saved = { dir: process.env.PI_CODING_AGENT_DIR, sub: process.env.PI_SUBAGENT, mode: process.env.PI_BEHAVIOR_MODE };
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_SUBAGENT;
  try {
    const commands: Record<string, any> = {};
    const handlers: Record<string, any[]> = {};
    const entries: any[] = [];
    let active: string[] = [];
    const allTools = ["read", "write", "edit", "bash", "task_start", "task"];
    const notices: string[] = [];
    const thinkingLevels: string[] = [];
    const fusionHandlers: Array<(request: any) => void> = [];
    const pair = { lead: { provider: "configured", modelId: "lead", thinking: "high" }, sidekick: { provider: "configured", modelId: "sidekick", thinking: "low" } };
    const ctx: any = { cwd: dir, hasUI: true, isIdle: () => true,
      model: { provider: "configured", id: "lead" },
      modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
      sessionManager: { getEntries: () => entries, getBranch: () => entries },
      ui: { theme: { name: "apex-dark" }, setStatus() {}, notify: (text: string) => notices.push(text), setTheme(name: string) { this.theme.name = name; return { success: true }; } },
    };
    const pi: any = {
      registerCommand: (name: string, spec: any) => { commands[name] = spec.handler; }, registerTool() {}, registerShortcut() {},
      on: (name: string, handler: any) => { (handlers[name] ??= []).push(handler); },
      events: { emit(name: string, data: any) { if (name === "pi:fusion:configure") for (const fn of fusionHandlers) fn(data); }, on(name: string, fn: any) { if (name === "pi:fusion:configure") fusionHandlers.push(fn); } },
      appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
      getAllTools: () => allTools.map(name => ({ name })),
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => { active = names; },
      getThinkingLevel: () => "medium",
      setThinkingLevel(level: string) { thinkingLevels.push(level); },
      setModel: async () => true,
    };
    fusionHandlers.push((request: any) => {
      request.acknowledged = true;
      request.promise = Promise.reject(new Error("sidekick down"));
    });
    promptCommands(pi);
    const emit = async (name: string, event: any = {}) => { let result; for (const handler of handlers[name] ?? []) result = await handler(event, ctx); return result; };
    // Stored desired Apex lead wants "low"; the live session actually runs "medium".
    entries.push({ type: "custom", customType: "behavior-mode", data: { mode: "apex", models: { apex: { provider: "configured", modelId: "lead", thinking: "low" } }, fusion: pair } });
    await emit("session_start", { reason: "resume" });
    await commands.mode("fusion", ctx);
    assert.equal(thinkingLevels[thinkingLevels.length - 1], "low", "recovery repairs the desired lead, not the actual model");
    assert.equal(process.env.PI_BEHAVIOR_MODE, "apex");
  } finally {
    for (const [key, value] of Object.entries({ PI_CODING_AGENT_DIR: saved.dir, PI_SUBAGENT: saved.sub, PI_BEHAVIOR_MODE: saved.mode })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("successful switch records the actual Pi thinking level in staged state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-modes-clamp-"));
  const saved = { dir: process.env.PI_CODING_AGENT_DIR, sub: process.env.PI_SUBAGENT, mode: process.env.PI_BEHAVIOR_MODE };
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_SUBAGENT;
  try {
    const commands: Record<string, any> = {};
    const handlers: Record<string, any[]> = {};
    const entries: any[] = [];
    let active: string[] = [];
    const allTools = ["read", "write", "edit", "bash", "task_start", "task"];
    const notices: string[] = [];
    const fusionHandlers: Array<(request: any) => void> = [];
    // Pair asks for "high" but Pi clamps to "medium" (getThinkingLevel).
    const pair = { lead: { provider: "configured", modelId: "lead", thinking: "high" }, sidekick: { provider: "configured", modelId: "sidekick", thinking: "low" } };
    const ctx: any = { cwd: dir, hasUI: true, isIdle: () => true,
      model: { provider: "configured", id: "lead" },
      modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
      sessionManager: { getEntries: () => entries, getBranch: () => entries },
      ui: { theme: { name: "apex-dark" }, setStatus() {}, notify: (text: string) => notices.push(text), setTheme(name: string) { this.theme.name = name; return { success: true }; } },
    };
    const pi: any = {
      registerCommand: (name: string, spec: any) => { commands[name] = spec.handler; }, registerTool() {}, registerShortcut() {},
      on: (name: string, handler: any) => { (handlers[name] ??= []).push(handler); },
      events: { emit(name: string, data: any) { if (name === "pi:fusion:configure") for (const fn of fusionHandlers) fn(data); }, on(name: string, fn: any) { if (name === "pi:fusion:configure") fusionHandlers.push(fn); } },
      appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
      getAllTools: () => allTools.map(name => ({ name })),
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => { active = names; },
      getThinkingLevel: () => "medium",
      setThinkingLevel() {},
      setModel: async () => true,
    };
    fusionHandlers.push((request: any) => { request.acknowledged = true; request.promise = Promise.resolve(); });
    promptCommands(pi);
    const emit = async (name: string, event: any = {}) => { let result; for (const handler of handlers[name] ?? []) result = await handler(event, ctx); return result; };
    entries.push({ type: "custom", customType: "behavior-mode", data: { mode: "apex", models: {}, fusion: pair } });
    await emit("session_start", { reason: "resume" });
    await commands.mode("fusion", ctx);
    assert.equal(process.env.PI_BEHAVIOR_MODE, "fusion");
    const lastEntry = [...entries].reverse().find(entry => entry.customType === "behavior-mode");
    assert.equal(lastEntry.data.fusion.lead.thinking, "medium", "persisted lead matches actual clamped level");
  } finally {
    for (const [key, value] of Object.entries({ PI_CODING_AGENT_DIR: saved.dir, PI_SUBAGENT: saved.sub, PI_BEHAVIOR_MODE: saved.mode })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unreadable mode preferences abort the switch before any change", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-modes-prefs-"));
  const saved = { dir: process.env.PI_CODING_AGENT_DIR, sub: process.env.PI_SUBAGENT, mode: process.env.PI_BEHAVIOR_MODE };
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_SUBAGENT;
  try {
    const commands: Record<string, any> = {};
    const handlers: Record<string, any[]> = {};
    const entries: any[] = [];
    let active: string[] = [];
    const allTools = ["read", "write", "edit", "bash", "task_start", "task"];
    const notices: string[] = [];
    const ctx: any = { cwd: dir, hasUI: true, isIdle: () => true,
      model: { provider: "configured", id: "lead" },
      modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
      sessionManager: { getEntries: () => entries, getBranch: () => entries },
      ui: { theme: { name: "apex-dark" }, setStatus() {}, notify: (text: string) => notices.push(text), setTheme(name: string) { this.theme.name = name; return { success: true }; } },
    };
    const pi: any = {
      registerCommand: (name: string, spec: any) => { commands[name] = spec.handler; }, registerTool() {}, registerShortcut() {},
      on: (name: string, handler: any) => { (handlers[name] ??= []).push(handler); },
      events: { emit() {} },
      appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
      getAllTools: () => allTools.map(name => ({ name })),
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => { active = names; },
      getThinkingLevel: () => "medium", setThinkingLevel() {},
      setModel: async () => true,
    };
    promptCommands(pi);
    const emit = async (name: string, event: any = {}) => { let result; for (const handler of handlers[name] ?? []) result = await handler(event, ctx); return result; };
    await emit("session_start", { reason: "new" });
    writeFileSync(join(dir, "mode-settings.json"), "{broken");
    const before = [...active];
    await commands.mode("pi", ctx);
    assert.match(notices[notices.length - 1], /preferences unreadable/);
    assert.deepEqual(active, before, "tools untouched");
    assert.equal(process.env.PI_BEHAVIOR_MODE, "apex", "env untouched");
  } finally {
    for (const [key, value] of Object.entries({ PI_CODING_AGENT_DIR: saved.dir, PI_SUBAGENT: saved.sub, PI_BEHAVIOR_MODE: saved.mode })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

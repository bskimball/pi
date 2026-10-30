import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import promptCommands, { REGULAR_SYSTEM_BLOCK, ORCHESTRATE_SYSTEM_BLOCK, FUSION_SYSTEM_BLOCK, WORK_SYSTEM_PROMPT, PI_SYSTEM_BLOCK } from "../prompt-commands.ts";
import { registerPresentationSwitch } from "../prompt-commands/presentation-switch.ts";
import { registerModes } from "../prompt-commands/modes.ts";
import { defaultUsagePath, readUsageCounts, USAGE_WINDOW_MS } from "../prompt-commands/hydra/usage.ts";
import { restoreMode, readPreferences, initialPreferences, toolsForFusion, toolsForMode, toolsForWork } from "../prompt-commands/mode-state.ts";
import { matchAaMetrics, parseAaModelPage, parseAaModelsHtml, parseDesignArenaLeaderboard, SEED_AA_MODELS } from "../prompt-commands/hydra/aa-sync.ts";
import { parseCredentialsResponse, quotaMultiplierForModel } from "../prompt-commands/hydra/quota-sync.ts";
import { rankModelsForHydra } from "../prompt-commands/hydra/scorer.ts";

const builderUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "core/system-prompt.js")).href;
const { buildSystemPrompt } = await import(builderUrl) as { buildSystemPrompt: (options: any) => string };

test("legacy modes restore without adopting a new global default", () => {
  const prefs = initialPreferences(); prefs.mode = "pi";
  assert.equal(restoreMode([], prefs, false).mode, "apex");
  assert.equal(restoreMode([], prefs, true).mode, "pi");
  assert.equal(restoreMode([{ type: "custom", customType: "orchestrate-mode", data: { enabled: true } }], prefs, false).mode, "apex-orchestrate");
});
test("stored orchestrate global default starts new sessions in Apex", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-orchestrate-default-"));
  try {
    const path = join(dir, "mode-settings.json");
    writeFileSync(path, JSON.stringify({ ...initialPreferences(), mode: "apex-orchestrate" }));
    const prefs = readPreferences(path);
    assert.equal(restoreMode([], prefs, true).mode, "apex");
    assert.equal(restoreMode([{ type: "custom", customType: "behavior-mode", data: { mode: "apex-orchestrate", models: {} } }], prefs, false).mode, "apex-orchestrate");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("Pi keeps installed extension tools; Fusion and Work exclude chain/rebind from active tools", () => {
  const tools = ["read", "write", "edit", "bash", "task", "task_chain", "task_rebind", "task_start", "todo_write", "intercom", "fffind", "ffgrep"];
  const collaborationTools = ["read", "write", "edit", "bash", "task", "task_start", "todo_write", "intercom", "fffind", "ffgrep"];
  assert.deepEqual(toolsForMode("pi", tools), tools);
  assert.deepEqual(toolsForMode("apex", tools), tools);
  assert.deepEqual(toolsForFusion(tools), collaborationTools);
  assert.deepEqual(toolsForWork(tools), collaborationTools);
  assert.deepEqual(toolsForMode("fusion", tools), toolsForFusion(tools));
  assert.deepEqual(toolsForMode("work", tools), toolsForWork(tools));
});
test("custom UI switches replace stale themes with their canonical live theme", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-ui-themes-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldChild = process.env.PI_SUBAGENT;
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_SUBAGENT;
  try {
    writeFileSync(join(dir, "mode-settings.json"), JSON.stringify({
      mode: "pi", models: {}, ui: "pi",
      themes: { pi: "light", apex: "stale-apex", claude: "stale-claude", hal: "stale-hal" },
    }));
    const commands: Record<string, any> = {};
    const handlers: Record<string, any[]> = {};
    const pi: any = {
      registerCommand: (name: string, spec: any) => { commands[name] = spec.handler; },
      on: (name: string, handler: any) => { (handlers[name] ??= []).push(handler); },
      events: { emit() {} },
    };
    const ctx: any = {
      hasUI: true, isIdle: () => true,
      ui: { theme: { name: "light" }, setTheme(name: string) { this.theme.name = name; return { success: true }; }, notify() {} },
    };
    registerPresentationSwitch(pi);
    for (const [ui, theme] of [["apex", "apex-dark"], ["claude", "claude-dark"], ["hal", "hal-dark"]]) {
      await commands.ui(ui, ctx);
      assert.equal(ctx.ui.theme.name, theme);
    }
    let saved = JSON.parse(readFileSync(join(dir, "mode-settings.json"), "utf8"));
    assert.deepEqual(saved.themes, { pi: "light", apex: "apex-dark", claude: "claude-dark", hal: "hal-dark" });
    writeFileSync(join(dir, "mode-settings.json"), JSON.stringify({ ...saved, ui: "hal", themes: { ...saved.themes, hal: "stale-hal" } }));
    for (const handler of handlers.session_start) handler({ reason: "resume" }, ctx);
    saved = JSON.parse(readFileSync(join(dir, "mode-settings.json"), "utf8"));
    assert.equal(ctx.ui.theme.name, "hal-dark");
    assert.equal(saved.themes.hal, "hal-dark");
  } finally {
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldChild === undefined) delete process.env.PI_SUBAGENT; else process.env.PI_SUBAGENT = oldChild;
    rmSync(dir, { recursive: true, force: true });
  }
});
test("mode commands switch prompts, enforce idle, persist and restore, and change UI independently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-modes-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldChild = process.env.PI_SUBAGENT;
  const oldMode = process.env.PI_BEHAVIOR_MODE;
  const oldUi = process.env.PI_APEX_UI;
  const oldChrome = process.env.PI_UI_CHROME;
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
    const statuses = new Map<string, string | undefined>();
    const pairStatus = () => { const text = statuses.get("fusion-pair"); return text === undefined ? undefined : JSON.parse(text); };
    const ctx: any = { cwd: dir, mode: "rpc", hasUI: true, isIdle: () => !busy,
      sessionManager: { getEntries: () => entries, getBranch: () => entries },
      ui: { theme: { name: "apex-dark" }, setStatus: (key: string, text: string | undefined) => { statuses.set(key, text); }, notify: (text: string) => notices.push(text), setTheme(name: string) { this.theme.name = name; return { success: true }; } },
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
    assert.ok(statuses.has("fusion-pair") && pairStatus() === undefined, "non-Fusion startup clears the structured pair");
    const prompt = async (systemPrompt = "Apex base") => {
      const options = {
        cwd: dir,
        toolSnippets: { read: "Read files" },
        promptGuidelines: ["Use the workspace capability contract"],
        contextFiles: [{ path: "AGENTS.md", content: "Project boundary applies." }],
      };
      await emit("before_agent_start", { systemPrompt, systemPromptOptions: options });
      return { systemPrompt: buildSystemPrompt(options) };
    };
    assert.match((await prompt()).systemPrompt, /Regular mode \(active\)/);
    await commands.orchestrate("on", ctx);
    assert.match((await prompt()).systemPrompt, /Strict orchestrator mode \(active\)/);
    const globalPath = join(dir, "mode-settings.json");
    assert.equal(JSON.parse(readFileSync(globalPath, "utf8")).mode, "apex", "orchestrate on leaves global default unchanged");
    await emit("model_select", { source: "user", model: { provider: "session", id: "orchestrator" } });
    assert.equal(JSON.parse(readFileSync(globalPath, "utf8")).models["apex-orchestrate"].modelId, "orchestrator", "orchestrate model preference still persists");
    assert.equal(JSON.parse(readFileSync(globalPath, "utf8")).mode, "apex");
    ctx.modelRegistry = { find: () => ({ provider: "session", id: "orchestrator" }) };
    pi.setModel = async () => true;
    await emit("session_start", { reason: "resume" });
    assert.equal(process.env.PI_BEHAVIOR_MODE, "apex-orchestrate", "session entry restores orchestrate");
    await commands.orchestrate("off", ctx);
    assert.equal(process.env.PI_BEHAVIOR_MODE, "apex");
    await commands.mode("apex-orchestrate", ctx);
    assert.equal(JSON.parse(readFileSync(globalPath, "utf8")).mode, "apex", "mode shortcut is also session-only");
    busy = true;
    await commands.mode("pi", ctx);
    assert.equal(process.env.PI_BEHAVIOR_MODE, "apex-orchestrate");
    busy = false; workerBusy = true;
    await commands.mode("pi", ctx);
    assert.equal(process.env.PI_BEHAVIOR_MODE, "apex-orchestrate");
    workerBusy = false;
    await commands.mode("pi", ctx);
    const piPrompt = (await prompt()).systemPrompt;
    assert.match(piPrompt, /^You are an expert coding assistant operating inside pi/);
    assert.match(piPrompt, /Pi mode \(active\)/);
    assert.match(piPrompt, /explicit user direction only/);
    assert.doesNotMatch(piPrompt, /Apex base|Strict orchestrator|Regular mode \(active\)/);
    assert.ok(PI_SYSTEM_BLOCK.includes("Pi mode (active)"));
    assert.deepEqual(active, ["read", "write", "edit", "bash", "task_start"]);
    allTools.push("fffind", "ffgrep", "intercom");
    await commands.mode("apex", ctx);
    const warningCount = notices.length;
    await emit("context_with_system", { messages: [
      { role: "system", content: "", sections: { addendum: PI_SYSTEM_BLOCK }, timestamp: 1 },
      { role: "system", content: "", sections: { addendum: REGULAR_SYSTEM_BLOCK }, timestamp: 2 },
    ] });
    assert.equal(notices.length, warningCount, "Pi→Apex section patch does not warn based on historical Pi head");
    assert.deepEqual(active, ["read", "write", "edit", "bash", "task_start", "fffind", "ffgrep", "intercom"]);
    const prefsPath = join(dir, "mode-settings.json");
    const newerGlobalPair = {
      lead: { provider: "global", modelId: "newer-lead", thinking: "high" },
      sidekick: { provider: "global", modelId: "newer-sidekick", thinking: "medium" },
    };
    const beforeResume = JSON.parse(readFileSync(prefsPath, "utf8"));
    beforeResume.fusion = newerGlobalPair;
    beforeResume.models.fusion = newerGlobalPair.lead;
    writeFileSync(prefsPath, JSON.stringify(beforeResume));
    entries.push({ type: "custom", customType: "behavior-mode", data: { mode: "fusion", models: { fusion: { provider: "stale", modelId: "lead", thinking: "off" } }, fusion: { lead: { provider: "configured", modelId: "lead", thinking: "medium" }, sidekick: { provider: "configured", modelId: "sidekick", thinking: "low" } } } });
    ctx.modelRegistry = { find: () => undefined };
    await emit("session_start", { reason: "resume" });
    const unavailableEntry = [...entries].reverse().find(entry => entry.customType === "behavior-mode");
    assert.deepEqual(unavailableEntry.data.models.fusion, unavailableEntry.data.fusion.lead, "unavailable model still records the authoritative requested pair");
    assert.deepEqual(await emit("input", {}), { action: "handled" }, "unavailable model continues blocking input");
    assert.deepEqual(JSON.parse(readFileSync(prefsPath, "utf8")).fusion, newerGlobalPair, "failed restore preserves global defaults");
    ctx.modelRegistry = { find: () => ({ provider: "configured", id: "lead" }) };
    pi.setModel = async () => true;
    await emit("session_start", { reason: "resume" });
    assert.equal(process.env.PI_BEHAVIOR_MODE, "fusion");
    const restoredEntry = [...entries].reverse().find(entry => entry.customType === "behavior-mode");
    assert.deepEqual(restoredEntry.data.models.fusion, restoredEntry.data.fusion.lead, "successful restore normalizes session Fusion metadata");
    assert.deepEqual(pairStatus(), restoredEntry.data.fusion, "Fusion startup publishes the structured pair");
    let persisted = JSON.parse(readFileSync(prefsPath, "utf8"));
    assert.deepEqual(persisted.fusion, newerGlobalPair, "implicit session restore preserves newer global Fusion defaults");
    assert.deepEqual(persisted.models.fusion, newerGlobalPair.lead);
    const fused = (await prompt()).systemPrompt;
    assert.match(fused, /Fusion mode \(active\)/);
    assert.match(fused, /^You are an expert coding assistant operating inside pi/, "Fusion preserves stock base without a custom prompt");
    assert.doesNotMatch(fused, /Regular mode \(active\)|Strict orchestrator mode \(active\)/);
    await commands.mode("fusion", ctx);
    persisted = JSON.parse(readFileSync(prefsPath, "utf8"));
    assert.deepEqual(persisted.fusion, restoredEntry.data.fusion, "explicit Fusion activation updates global defaults to the selected session pair");
    assert.deepEqual(persisted.models.fusion, restoredEntry.data.fusion.lead);
    assert.deepEqual(pairStatus(), persisted.fusion, "successful Fusion switch publishes the pair");
    await emit("model_select", { source: "user", model: { provider: "override", id: "lead" } });
    persisted = JSON.parse(readFileSync(prefsPath, "utf8"));
    assert.deepEqual(persisted.fusion.lead, { provider: "override", modelId: "lead", thinking: "medium" }, "explicit /model updates the authoritative global lead");
    assert.deepEqual(persisted.models.fusion, persisted.fusion.lead);
    assert.deepEqual(pairStatus(), persisted.fusion, "model selection republishes the pair");
    await emit("thinking_level_select", { level: "high" });
    persisted = JSON.parse(readFileSync(prefsPath, "utf8"));
    assert.equal(persisted.fusion.lead.thinking, "high", "thinking selection persists through the authoritative pair");
    assert.deepEqual(persisted.models.fusion, persisted.fusion.lead);
    assert.deepEqual(pairStatus(), persisted.fusion, "thinking selection republishes the pair");
    await commands.mode("pi", ctx);
    assert.ok(statuses.has("fusion-pair") && pairStatus() === undefined, "leaving Fusion clears the structured pair");
    ctx.mode = "tui";
    statuses.delete("fusion-pair");
    await commands.mode("fusion", ctx);
    assert.equal(statuses.has("fusion-pair"), false, "TUI never receives the raw JSON status");
    await commands.mode("pi", ctx);
    ctx.mode = "rpc";
    assert.deepEqual(active, ["read", "write", "edit", "bash", "task_start", "fffind", "ffgrep", "intercom"]);
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
    assert.match(workPrompt, /Always route email drafting and substantive email rewriting through Flo, regardless of length or expected editorial benefit/);
    assert.match(workPrompt, /Email reading, factual extraction, and summarization remain inline unless another routing trigger fires/);
    assert.match(workPrompt, /For other prose, auto-route when prose is the deliverable and separate editorial context will improve it/);
    assert.doesNotMatch(workPrompt, /Apex base|Fusion mode \(active\)/);
    assert.match(workPrompt, /Active tool guidance[\s\S]*Read files/, "Work retains active tool snippets");
    assert.match(workPrompt, /Active tool rules[\s\S]*Use the workspace capability contract/, "Work retains extension prompt guidelines");
    assert.match(workPrompt, /<project_context>[\s\S]*Project boundary applies\./, "Work builder retains project context");
    assert.match(workPrompt, /<cwd>/, "Work builder retains prompt composition");
    const workOptions = {
      cwd: dir,
      toolSnippets: { read: "Read files" },
      promptGuidelines: ["Use the workspace capability contract"],
      customPrompt: "Coding-first base that Work must replace.",
      appendSystemPrompt: "Caller-provided instruction.",
      contextFiles: [{ path: "AGENTS.md", content: "Project boundary applies." }],
    };
    await emit("before_agent_start", { systemPrompt: buildSystemPrompt(workOptions), systemPromptOptions: workOptions });
    const retainedDynamic = buildSystemPrompt(workOptions);
    assert.match(retainedDynamic, /Caller-provided instruction\./, "Work preserves caller append instructions");
    assert.doesNotMatch(retainedDynamic, /^You are an expert coding assistant operating inside pi/, "Work does not restore the stock coding base");
    assert.doesNotMatch(retainedDynamic, /Coding-first base that Work must replace/);
    assert.equal(WORK_SYSTEM_PROMPT.includes("operations-first lead"), true);
    await commands.mode("pi", ctx);
    writeFileSync(join(dir, "mode-settings.json"), JSON.stringify({
      mode: "pi",
      models: {},
      ui: "pi",
      themes: { pi: "light", apex: "stale-apex", claude: "stale-claude", hal: "stale-hal" },
    }));
    ctx.ui.theme.name = "light";
    await commands.ui("pi", ctx);
    assert.equal(process.env.PI_APEX_UI, "0");
    assert.equal(process.env.PI_UI_CHROME, "0");
    assert.equal(process.env.PI_BEHAVIOR_MODE, "pi");
    ctx.ui.theme.name = "light";
    await commands.ui("apex", ctx);
    assert.equal(ctx.ui.theme.name, "apex-dark");
    await commands.ui("pi", ctx);
    assert.equal(ctx.ui.theme.name, "light");
    await commands.ui("claude", ctx);
    assert.equal(process.env.PI_APEX_UI, "1");
    assert.equal(process.env.PI_UI_CHROME, "1");
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
    assert.equal(savedUi.themes.claude, "claude-dark", "Claude ignores stale remembered themes");
    assert.equal(savedUi.themes.hal, "hal-dark", "HAL ignores stale remembered themes");
    assert.equal(savedUi.themes.apex, "apex-dark", "Apex ignores stale remembered themes");
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
      getAvailable() { assert.equal(refreshed, false, "picker uses the startup registry snapshot without refresh"); return catalog.slice(0, 1); },
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
    for (const [key, value] of Object.entries({ PI_CODING_AGENT_DIR: oldDir, PI_SUBAGENT: oldChild, PI_BEHAVIOR_MODE: oldMode, PI_APEX_UI: oldUi, PI_UI_CHROME: oldChrome, PI_UI_SKIN: oldSkin })) {
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
    assert.deepEqual(active, allTools);
    assert.equal(process.env.PI_BEHAVIOR_MODE, "pi");
    failToolsOnce = true;
    await commands.mode("apex", ctx);
    assert.match(notices[notices.length - 1], /Mode switch to Apex failed.*restored Pi/);
    assert.deepEqual(active, allTools, "prior Pi tool set restored");
    assert.equal(process.env.PI_BEHAVIOR_MODE, "pi", "mode env restored");
    const options = { cwd: dir };
    await emit("before_agent_start", { systemPrompt: "Apex base", systemPromptOptions: options });
    assert.match(buildSystemPrompt(options), /^You are an expert coding assistant operating inside pi/, "still Pi prompt");
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
    const options = { cwd: dir };
    await emit("before_agent_start", { systemPrompt: "Apex base", systemPromptOptions: options });
    assert.match(buildSystemPrompt(options), /Regular mode \(active\)/, "still Regular prompt");
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
    assert.deepEqual(active, allTools);
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
    assert.deepEqual(lastEntry.data.models.fusion, lastEntry.data.fusion.lead, "session metadata follows the authoritative lead");
    const savedPrefs = JSON.parse(readFileSync(join(dir, "mode-settings.json"), "utf8"));
    assert.deepEqual(savedPrefs.models.fusion, savedPrefs.fusion.lead, "global metadata follows the configured global pair");
    assert.match(notices[notices.length - 1], /Lead configured\/lead \(medium\); sidekick configured\/sidekick \(low\)/);
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

test("non-Work modes scope project-context Work crew routing to Work mode", () => {
  for (const block of [REGULAR_SYSTEM_BLOCK, ORCHESTRATE_SYSTEM_BLOCK, FUSION_SYSTEM_BLOCK, PI_SYSTEM_BLOCK]) {
    assert.match(block, /AGENTS\.md or other project context/);
  }
  assert.match(FUSION_SYSTEM_BLOCK, /applies only in Work mode/);
  assert.match(FUSION_SYSTEM_BLOCK, /HAL Desktop UI/);
  assert.match(WORK_SYSTEM_PROMPT, /researcher \(Oscar\)/);
});

test("Hydra stats scorer ranks AA models, respects quota/circuit health, and switches or holds cache-sticky models via /mode hydra", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hydra-"));
  const saved = {
    dir: process.env.PI_CODING_AGENT_DIR,
    sub: process.env.PI_SUBAGENT,
    mode: process.env.PI_BEHAVIOR_MODE,
    hydra: process.env.PI_HYDRA_TIER,
  };
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_SUBAGENT;
  try {
    // 1. AA metrics matching & HTML extraction (preserves generation identity)
    assert.equal(matchAaMetrics("claude-opus-5-5", SEED_AA_MODELS)?.slug, "claude-opus-5-5");
    assert.equal(matchAaMetrics("claude-opus-4-6", SEED_AA_MODELS), undefined, "does not alias older generation onto Opus 5.5 metrics");
    assert.equal(matchAaMetrics("gpt-6.1-sol", SEED_AA_MODELS)?.slug, "gpt-6-1-sol");
    assert.equal(matchAaMetrics("@cf/zai-org/glm-5.3", SEED_AA_MODELS)?.slug, "glm-5-3");

    const sampleHtml = `<script>self.__next_f.push([1,"{\\"initialModels\\":[{\\"slug\\":\\"claude-opus-5-5\\",\\"name\\":\\"Claude Opus 5.5\\",\\"intelligenceIndex\\":58.4,\\"capabilities\\":{\\"engineering\\":64.6},\\"frontierCode20\\":0.46,\\"terminalBench40\\":0.60,\\"timescaleData\\":{\\"medianOutputSpeed\\":98.3,\\"medianTimeToFirstChunk\\":688},\\"price1mBlended7To2To1\\":2.94,\\"contextWindowTokens\\":1000000,\\"isReasoning\\":true}]}"])</script>`;
    const parsedHtml = parseAaModelsHtml(sampleHtml);
    assert.equal(parsedHtml.length, 1);
    assert.equal(parsedHtml[0]?.slug, "claude-opus-5-5");

    // Individual model pages (for models AA leaves off the listing) carry the full measurement set.
    const pageHtml = `<script>self.__next_f.push([1,"{\\"model\\":{\\"description\\":\\"braces } { in text\\",\\"slug\\":\\"gemini-4-argon\\",\\"name\\":\\"Gemini 4 Argon\\",\\"intelligenceIndex\\":50.4,\\"omniscienceHallucinationRate\\":0.04,\\"gdpval\\":1631,\\"aa3dElo\\":1152,\\"personalityBench\\":{\\"indexScores\\":{\\"expressiveness\\":82.7,\\"slop\\":70.3}}}}"])</script>`;
    const argonPage = parseAaModelPage(pageHtml, "gemini-4-argon");
    assert.equal(argonPage?.hallucinationRate, 0.04);
    assert.equal(argonPage?.gdpvalElo, 1631);
    assert.deepEqual(argonPage?.personality, { expressiveness: 82.7, slop: 70.3 });

    const daMap = parseDesignArenaLeaderboard(
      {
        data: [
          { modelId: "gpt-6-astra", elo: 1390 },
          { modelId: "claude-opus-5-5", elo: 1385 },
          { modelId: "gpt-6.1-sol", elo: 1359 },
          { modelId: "cortado", elo: 1298 },
        ],
      },
      { models: { cortado: { displayName: "GLM-5.3" } } },
    );
    assert.equal(daMap.get("gpt-6-astra"), 1390);
    assert.equal(daMap.get("claude-opus-5-5"), 1385);
    assert.equal(daMap.get("gpt-6-1-sol"), 1359);
    assert.equal(daMap.get("glm-5-3"), 1298, "resolves Design Arena codenames via registry displayName");

    // 2. Quota & circuit filtering (including mixed disabled + cooldown credentials)
    const creds = parseCredentialsResponse({
      files: [
        { quota_provider: "anthropic", remaining_percent: 3, cooldowns: [], disabled: false, success: 10, failed: 0 },
        { quota_provider: "openai", remaining_percent: 85, cooldowns: [], disabled: false, success: 12, failed: 0 },
        { quota_provider: "xai", remaining_percent: 85, cooldowns: [], disabled: true, success: 5, failed: 0 },
        { quota_provider: "xai", remaining_percent: 0, cooldowns: [{ reason: "quota" }], disabled: false, success: 5, failed: 2 },
      ],
    });
    const quotaSnap = { schema: 1 as const, updatedAt: Date.now(), source: "live" as const, providers: creds };
    assert.equal(quotaMultiplierForModel("claude-bridge", "claude-opus-5-5", "high", new Set(), quotaSnap).multiplier, 0, "exhausted (<5%) quota is skipped");
    assert.equal(quotaMultiplierForModel("xai", "grok-4.7", "high", new Set(), quotaSnap).multiplier, 0, "mixed disabled + cooling-down credentials cannot manufacture a healthy provider");
    assert.equal(quotaMultiplierForModel("openai", "gpt-6-astra", "high", new Set(["openai/gpt-6-astra"]), quotaSnap).multiplier, 0, "open circuit is skipped");
    assert.equal(quotaMultiplierForModel("openai", "gpt-6.1-sol", "high", new Set(), quotaSnap).multiplier, 1);

    // Real CPA shape: provider names like "claude", quota under quota.signals, unavailable flag.
    const cpaCreds = parseCredentialsResponse({
      files: [
        { provider: "claude", quota: { signals: { weekly: { remaining_percent: 30 } } }, cooldowns: [], disabled: false, success: 3, failed: 1 },
        { provider: "xai", quota: { signals: {} }, cooldowns: [], disabled: false, unavailable: true, success: 0, failed: 0 },
      ],
    });
    assert.equal(cpaCreds.anthropic?.remainingPercent, 30, "reads remaining percent from CPA quota signals");
    const cpaExhausted = parseCredentialsResponse({
      files: [{ provider: "claude", quota: { signals: { weekly: { remaining_percent: 1 } } }, cooldowns: [], disabled: false, success: 3, failed: 1 }],
    });
    assert.equal(cpaExhausted.anthropic?.remainingPercent, 1, "nested remaining_percent keeps percent semantics below 5");
    assert.equal(quotaMultiplierForModel("claude-bridge", "claude-opus-5-5", "standard", new Set(), { schema: 1, updatedAt: 0, source: "live", providers: cpaExhausted }).multiplier, 0, "exhausted signal quota excludes the family");
    assert.equal(cpaCreds.xai?.inCooldown, true, "unavailable credential counts as cooling down");

    const catalogModels: any[] = [
      { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5 (API)", reasoning: true },
      { provider: "google", id: "gemini-4-carbon", name: "Gemini 4 Carbon (API)", reasoning: true },
      { provider: "github-copilot", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5 (Copilot)", reasoning: true },
      { provider: "opencode", id: "claude-opus-5-5", name: "Claude Opus 5.5 (OpenCode)", reasoning: true },
      { provider: "claude-bridge", id: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true },
      { provider: "openai", id: "gpt-6-astra", name: "GPT-6 Astra", reasoning: true },
      { provider: "openai", id: "gpt-6.1-sol", name: "GPT-6.1 Sol", reasoning: true },
      { provider: "local-proxy", id: "claude-haiku-5-5", name: "Claude Haiku 5.5", reasoning: true },
    ];

    const rankedWithAnthropicExhausted = rankModelsForHydra({
      models: catalogModels,
      catalog: SEED_AA_MODELS,
      quota: quotaSnap,
      openCircuits: new Set(),
      tier: "max",
    });
    assert.equal(
      rankedWithAnthropicExhausted.some(r => ["anthropic", "google", "github-copilot", "opencode"].includes(r.model.provider)),
      false,
      "excludes anthropic, google, github-copilot, and opencode API/excluded providers",
    );
    assert.equal(rankedWithAnthropicExhausted[0]?.key, "openai/gpt-6-astra", "falls over to healthy OpenAI frontier when Anthropic quota is exhausted");

    // Subscription balancing: frontier coding prefers Opus with no history, then cycles to the
    // larger OpenAI subscription once Anthropic carries more than its capacity share of recent turns.
    const frontierSignal = { reasoningDepth: 3, depthConfidence: 0.9, domain: "coding" as const, domainConfidence: 0.9 };
    const healthyQuota = { schema: 1 as const, updatedAt: 0, source: "none" as const, providers: {} };
    const balanceBase = { models: catalogModels, catalog: SEED_AA_MODELS, quota: healthyQuota, openCircuits: new Set<string>(), tier: "standard" as const, signal: frontierSignal };
    const planModels: any[] = [
      { provider: "antigravity", id: "gemini-4-carbon", reasoning: true },
      { provider: "openai", id: "gpt-6-astra", reasoning: true },
      { provider: "claude-bridge", id: "claude-opus-5-5", reasoning: true },
      { provider: "muse-code", id: "muse-wonder-1.0", reasoning: true },
    ];
    const equalMetrics = planModels.map(model => ({
      ...SEED_AA_MODELS[0]!,
      slug: matchAaMetrics(model.id, SEED_AA_MODELS)!.slug,
    }));
    const planRanked = rankModelsForHydra({
      ...balanceBase,
      models: planModels,
      catalog: equalMetrics,
      signal: { reasoningDepth: 2.6, depthConfidence: 1, domain: "conversation", domainConfidence: 1 },
      usage: { google: 20, openai: 20, anthropic: 20, meta: 20 },
    });
    const scoreFor = (provider: string) => planRanked.find(candidate => candidate.model.provider === provider)!.finalScore;
    assert.equal(scoreFor("antigravity"), scoreFor("openai"), "Google and OpenAI have equal usage targets");
    assert.equal(scoreFor("openai"), scoreFor("claude-bridge"), "Claude is not penalized for its lower subscription price");
    assert.equal(scoreFor("claude-bridge"), scoreFor("muse-code"), "Muse has an equal target without a conversation bonus");
    assert.equal(rankModelsForHydra(balanceBase)[0]?.key, "claude-bridge/claude-opus-5-5", "frontier coding picks the strongest model without usage history");
    const ordinaryOptions = { ...balanceBase, signal: { ...frontierSignal, reasoningDepth: 2.2 } };
    assert.equal(rankModelsForHydra(ordinaryOptions)[0]?.key, "openai/gpt-6.1-sol", "ordinary implementation prefers efficient Sol within the quality band");
    assert.equal(rankModelsForHydra({ ...ordinaryOptions, currentModelKey: "openai/gpt-6-astra", cacheWarm: true })[0]?.key, "openai/gpt-6.1-sol", "Astra cache stickiness does not erase Sol's efficiency advantage");
    assert.equal(rankModelsForHydra({ ...ordinaryOptions, usage: { openai: 40, anthropic: 4 } })[0]?.key, "claude-bridge/claude-opus-5-5", "underused Claude gets suitable implementation work");
    assert.equal(rankModelsForHydra({ ...ordinaryOptions, tier: "max" })[0]?.key, "claude-bridge/claude-opus-5-5", "max mode preserves frontier quality rather than optimizing cost");
    const openaiOnly = catalogModels.filter(model => model.provider === "openai");
    assert.equal(rankModelsForHydra({ ...balanceBase, models: openaiOnly })[0]?.key, "openai/gpt-6-astra", "deep work selects Astra over Sol in the OpenAI pool");

    // UI/design domain (and Artisan) uses Design Arena rankings + design affinity so work routes to
    // Claude, Astra, or Antigravity and excludes Sol from the quality band.
    const designModels = [
      ...catalogModels,
      { provider: "antigravity", id: "gemini-4-argon", name: "Gemini 4 Argon", reasoning: true },
    ];
    const designSignal = { reasoningDepth: 2.4, depthConfidence: 0.9, domain: "design" as const, domainConfidence: 0.9 };
    const designBase = { ...balanceBase, models: designModels, signal: designSignal };
    const designRanked = rankModelsForHydra(designBase);
    const designEligibleKeys = designRanked.filter(r => r.meetsQuality).map(r => r.key);
    assert.deepEqual(
      designEligibleKeys,
      ["claude-bridge/claude-opus-5-5", "openai/gpt-6-astra", "antigravity/gemini-4-argon"],
      "design domain admits Claude, Astra, and Antigravity while excluding Sol from the quality band",
    );
    assert.equal(
      designRanked.find(r => r.key === "openai/gpt-6.1-sol")?.meetsQuality,
      false,
      "Sol does not meet the design quality bar",
    );
    assert.equal(
      rankModelsForHydra({ ...designBase, currentModelKey: "openai/gpt-6.1-sol", cacheWarm: true })[0]?.key,
      "claude-bridge/claude-opus-5-5",
      "design turn switches away from a warm Sol session",
    );
    assert.equal(
      rankModelsForHydra({ ...designBase, usage: { anthropic: 10 } })[0]?.key,
      "openai/gpt-6-astra",
      "design work cycles from Claude to Astra (never Sol) when Claude carries recent calls",
    );
    assert.equal(
      rankModelsForHydra({ ...designBase, usage: { anthropic: 10, openai: 10 } })[0]?.key,
      "antigravity/gemini-4-argon",
      "design work cycles to Antigravity when Claude and OpenAI carry recent calls",
    );
    assert.deepEqual(
      rankModelsForHydra({ ...designBase, models: openaiOnly, currentModelKey: "openai/gpt-6.1-sol", cacheWarm: true })
        .filter(r => r.meetsQuality)
        .map(r => r.key),
      ["openai/gpt-6-astra"],
      "in OpenAI-only scope, only Astra meets the design quality bar",
    );
    assert.equal(
      rankModelsForHydra({ ...designBase, models: openaiOnly, openCircuits: new Set(["openai/gpt-6-astra"]) })
        .find(r => r.key === "openai/gpt-6.1-sol")?.meetsQuality,
      false,
      "even when Astra is unavailable, Sol remains below the design quality floor",
    );
    assert.equal(
      rankModelsForHydra({ ...ordinaryOptions, usage: { anthropic: 3 } })[0]?.model.provider,
      "openai",
      "smoothed subscription balancing cycles coding work to OpenAI after 3 consecutive Anthropic turns",
    );
    const subGateModels: any[] = [
      { provider: "claude-bridge", id: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true },
      { provider: "muse-code", id: "muse-wonder-1.0", name: "Muse Wonder", reasoning: true },
      { provider: "xai", id: "grok-4.7", name: "Grok 4.7", reasoning: true },
    ];
    assert.equal(
      rankModelsForHydra({ ...balanceBase, models: subGateModels, usage: { anthropic: 5 } })[0]?.key,
      "claude-bridge/claude-opus-5-5",
      "early usage balancing does not relax the starvation quality gate to promote sub-0.85x models after 5 turns",
    );
    assert.equal(matchAaMetrics("muse-spark-1.3-contributor", SEED_AA_MODELS)?.slug, "muse-spark-1-3");
    assert.equal(matchAaMetrics("muse-spark-1.2-contributor", SEED_AA_MODELS), undefined, "does not borrow Spark 1.3 metrics for 1.2");
    const sparkModels = ["muse-spark-1.3", "muse-spark-1.3-contributor"].map(id => ({ provider: "muse-code", id, name: id, reasoning: true }));
    const sparkRanked = rankModelsForHydra({ ...balanceBase, models: sparkModels as any[], currentModelKey: "muse-code/muse-spark-1.3", cacheWarm: true });
    assert.equal(sparkRanked.length, 1, "Spark 1.3 twins resolve to the contributor variant without a catalog sync");
    assert.equal(sparkRanked[0]?.key, "muse-code/muse-spark-1.3-contributor");
    assert.equal(sparkRanked[0]?.aa.codingScore, 35, "uses Spark 1.3's published measurements, not Spark Open's");
    const contributorModels: any[] = [
      { provider: "muse-code", id: "muse-wonder-1.0", name: "Muse Wonder", reasoning: true },
      { provider: "muse-code", id: "muse-wonder-1.0-contributor", name: "Muse Wonder Contributor", reasoning: true },
    ];
    assert.equal(
      rankModelsForHydra({ ...balanceBase, models: contributorModels })[0]?.key,
      "muse-code/muse-wonder-1.0-contributor",
      "Hydra prefers the Muse contributor variant over its identical non-contributor twin",
    );
    assert.equal(
      rankModelsForHydra({ ...balanceBase, models: contributorModels, currentModelKey: "muse-code/muse-wonder-1.0", cacheWarm: true })[0]?.key,
      "muse-code/muse-wonder-1.0-contributor",
      "contributor preference beats cache stickiness on the non-contributor twin when Jev signalled the turn",
    );
    assert.equal(
      rankModelsForHydra({ ...balanceBase, models: contributorModels, signal: undefined, currentModelKey: "muse-code/muse-wonder-1.0", cacheWarm: true })[0]?.key,
      "muse-code/muse-wonder-1.0-contributor",
      "contributor preference beats warm-cache stickiness on the non-contributor twin without a Jev signal",
    );
    assert.equal(
      rankModelsForHydra({ ...balanceBase, models: [...subGateModels, { provider: "muse-code", id: "muse-wonder-1.0-contributor", name: "Muse Wonder Contributor", reasoning: true }], usage: { anthropic: 5 } })[0]?.key,
      "claude-bridge/claude-opus-5-5",
      "contributor selection does not override the frontier quality gate",
    );
    for (const signal of [frontierSignal, { reasoningDepth: 1.5, depthConfidence: 1, domain: "conversation" as const, domainConfidence: 1 }, undefined]) {
      const options = { ...balanceBase, signal, currentModelKey: "muse-code/muse-wonder-1.0", cacheWarm: true };
      const baseline = rankModelsForHydra({ ...options, models: [...catalogModels, contributorModels[0]] });
      const withContributor = rankModelsForHydra({ ...options, models: [...catalogModels, ...contributorModels] });
      assert.deepEqual(
        withContributor.map(candidate => [candidate.key.replace(/-contributor$/, ""), candidate.finalScore]),
        baseline.map(candidate => [candidate.key, candidate.finalScore]),
        "contributor selection changes only the Muse variant, not scores or cross-model order",
      );
    }
    assert.equal(
      rankModelsForHydra({ ...balanceBase, models: contributorModels, openCircuits: new Set(["muse-code/muse-wonder-1.0-contributor"]) })[0]?.key,
      "muse-code/muse-wonder-1.0",
      "unhealthy contributor falls back to the base Muse variant",
    );
    assert.equal(
      rankModelsForHydra({ ...balanceBase, models: contributorModels, scopedKeys: new Set(["muse-code/muse-wonder-1.0"]) })[0]?.key,
      "muse-code/muse-wonder-1.0",
      "variant selection respects the explicit model scope",
    );
    assert.equal(
      rankModelsForHydra({ ...ordinaryOptions, usage: { anthropic: 40, openai: 4 } })[0]?.model.provider,
      "openai",
      "over-used Anthropic subscription cycles ordinary work to OpenAI",
    );
    // Quota tilt: with Anthropic at 45% and OpenAI at 95%, the most-quota good-enough model wins;
    // with Anthropic exhausted (3%), bridge models drop out of the ranking entirely.
    const entry = (provider: string, remainingPercent: number) => ({ provider, remainingPercent, inCooldown: false, disabled: false, successCount: 9, failureCount: 0 });
    const quotaTilt = { schema: 1 as const, updatedAt: 0, source: "live" as const, providers: { anthropic: entry("anthropic", 45), openai: entry("openai", 95) } };
    assert.equal(rankModelsForHydra({ ...ordinaryOptions, quota: quotaTilt })[0]?.key, "openai/gpt-6.1-sol", "quota and efficiency favor Sol among good-enough models");
    const quotaExhausted = { schema: 1 as const, updatedAt: 0, source: "live" as const, providers: { anthropic: entry("anthropic", 3), openai: entry("openai", 95) } };
    assert.equal(rankModelsForHydra({ ...balanceBase, quota: quotaExhausted }).some(r => r.model.provider === "claude-bridge"), false, "exhausted family is excluded, not just deprioritized");

    const withArgon = [...catalogModels, { provider: "antigravity", id: "gemini-4-argon", name: "Gemini 4 Argon", reasoning: true }];
    assert.equal(
      rankModelsForHydra({
        ...balanceBase,
        models: withArgon,
        signal: { reasoningDepth: 2.2, depthConfidence: 0.7, domain: "research", domainConfidence: 0.7 },
        usage: { anthropic: 20, openai: 20 },
      })[0]?.key,
      "antigravity/gemini-4-argon",
      "an unused large subscription is not starved once others carry recent turns",
    );

    // 3. End-to-end /mode hydra command & Jev turn signal routing
    const commands: Record<string, any> = {};
    const handlers: Record<string, any[]> = {};
    const eventListeners: Record<string, any[]> = {};
    const entries: any[] = [];
    const notices: string[] = [];
    const statuses = new Map<string, string | undefined>();
    let currentThinking = "medium";
    let allowFusionAck = true;
    let setModelDelayMs = 0;
    const haikuModel = catalogModels.find(m => m.id === "claude-haiku-5-5")!;
    const solModel = catalogModels.find(m => m.id === "gpt-6.1-sol")!;
    const ctx: any = {
      cwd: dir,
      mode: "tui",
      hasUI: true,
      isIdle: () => true,
      model: haikuModel, // start on haiku 5.5
      scopedModels: [],
      modelRegistry: {
        getAvailable: () => catalogModels,
        find: (provider: string, id: string) => catalogModels.find(m => m.provider === provider && m.id === id),
      },
      sessionManager: { getEntries: () => entries, getBranch: () => entries },
      ui: {
        theme: { name: "apex-dark" },
        setStatus: (key: string, text: string | undefined) => { statuses.set(key, text); },
        notify: (text: string) => notices.push(text),
        setTheme(name: string) { this.theme.name = name; return { success: true }; },
      },
    };
    const registeredProviders = new Map<string, any>();
    const pi: any = {
      registerCommand: (name: string, spec: any) => { commands[name] = spec.handler; },
      registerProvider: (name: string, config: any) => { registeredProviders.set(name, config); },
      registerTool() {},
      registerShortcut() {},
      on: (name: string, handler: any) => { (handlers[name] ??= []).push(handler); },
      events: {
        on: (name: string, fn: any) => { (eventListeners[name] ??= []).push(fn); },
        emit: (name: string, data: any) => {
          if (name === "pi:fusion:configure" && allowFusionAck) {
            data.acknowledged = true;
            data.promise = Promise.resolve();
          }
          for (const fn of eventListeners[name] ?? []) fn(data);
        },
      },
      appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
      getAllTools: () => [{ name: "read" }],
      getActiveTools: () => ["read"],
      setActiveTools() {},
      getThinkingLevel: () => currentThinking,
      setThinkingLevel: (lvl: string) => { currentThinking = lvl; },
      setModel: async (m: any) => {
        if (setModelDelayMs > 0) await new Promise(r => setTimeout(r, setModelDelayMs));
        ctx.model = m;
        return true;
      },
    };
    promptCommands(pi);
    for (const excluded of ["anthropic", "google", "google-gemini-cli", "github-copilot", "opencode"]) {
      assert.deepEqual(registeredProviders.get(excluded), { models: [] }, `suppresses built-in models for excluded provider ${excluded}`);
    }
    for (const h of handlers.session_start ?? []) await h({ reason: "new" }, ctx);

    await commands.mode("hydra max", ctx);
    assert.equal(process.env.PI_HYDRA_TIER, "max");
    assert.equal(statuses.get("hydra"), "hydra:max");
    assert.equal(ctx.model.id, "claude-opus-5-5", "Hydra max selects top AA intelligence/coding model");

    // Fresh session (no message entries in branch yet): Jev turn-signal runs before prompt-commands'
    // before_agent_start handler and its model/thinking choice must not be overwritten by the fallback check.
    await commands.mode("hydra high", ctx);
    assert.equal(ctx.model.id, "claude-opus-5-5");
    const firstTurnPayload: any = { reasoningDepth: 1.2, depthConfidence: 0.9, domain: "fast_edit", domainConfidence: 0.9, ctx };
    pi.events.emit("pi:jev:turn-signal", firstTurnPayload);
    await firstTurnPayload.promise;
    for (const h of handlers.before_agent_start ?? []) {
      await h({ prompt: "quick status check", systemPromptOptions: {} }, ctx);
    }
    assert.equal(ctx.model.id, "claude-haiku-5-5", "prompt-commands before_agent_start preserves Jev's first-turn selection on an empty branch");
    assert.equal(currentThinking, "low");

    // Simulate warm session cache: add a recent message entry, then emit a low-depth Jev signal in hydra:high.
    // Hydra should dynamically down-shift from frontier Opus to a faster workhorse model and populate payload outcome fields.
    ctx.model = catalogModels.find(m => m.id === "claude-opus-5-5")!;
    currentThinking = "high";
    entries.push({ type: "message", role: "user", content: "hi", timestamp: Date.now() });
    const lowPayload: any = { reasoningDepth: 1.2, depthConfidence: 0.9, domain: "fast_edit", domainConfidence: 0.9, ctx };
    pi.events.emit("pi:jev:turn-signal", lowPayload);
    await lowPayload.promise;
    assert.equal(ctx.model.id, "claude-haiku-5-5", "Jev fast_edit signal down-shifts Hydra high to fast model");
    assert.equal(lowPayload.selectedModel, "local-proxy/claude-haiku-5-5", "turn-signal payload reports selected model for Jev receipt");
    assert.equal(lowPayload.selectedThinking, "low", "turn-signal payload reports selected thinking level");
    assert.equal(lowPayload.switchedModel, true);
    assert.match(notices.at(-1) ?? "", /Jev Hydra \(high\): local-proxy\/claude-haiku-5-5 \(low\)/, "emits visible UI notification on Jev Hydra turn routing");

    // High-confidence shallow research lookup (depth 1.749 < 1.75, domainConfidence 0.84) routes to fast model (Haiku / low),
    // while low-confidence research (domainConfidence 0.28) floors above the fast tier (capable model / medium).
    await commands.mode("hydra standard", ctx);
    const shallowResearchPayload: any = { reasoningDepth: 1.749, depthConfidence: 0.83, domain: "research", domainConfidence: 0.84, ctx };
    pi.events.emit("pi:jev:turn-signal", shallowResearchPayload);
    await shallowResearchPayload.promise;
    assert.equal(ctx.model.id, "claude-haiku-5-5", "shallow high-confidence research lookup selects fast model");
    assert.equal(currentThinking, "low");

    const ambiguousResearchPayload: any = { reasoningDepth: 1.0, depthConfidence: 0.69, domain: "research", domainConfidence: 0.28, ctx };
    pi.events.emit("pi:jev:turn-signal", ambiguousResearchPayload);
    await ambiguousResearchPayload.promise;
    assert.notEqual(ctx.model.id, "claude-haiku-5-5", "low-confidence research prompt floors above the fast model");
    assert.equal(currentThinking, "medium");

    // Coding domain with underscored depth (1.4, low confidence 0.48) must NOT pick Haiku/low;
    // it floors to a capable coding model at medium thinking.
    ctx.model = catalogModels.find(m => m.id === "gpt-6-astra")!;
    const codingPayload: any = { reasoningDepth: 1.4, depthConfidence: 0.48, domain: "coding", domainConfidence: 0.52, ctx };
    pi.events.emit("pi:jev:turn-signal", codingPayload);
    await codingPayload.promise;
    assert.equal(ctx.model.id, "gpt-6.1-sol", "ordinary coding switches a warm Astra session to efficient Sol, not lightweight Haiku");
    assert.equal(currentThinking, "medium", "coding domain uses at least medium thinking");

    // Even immediately after an ordinary coding turn that selected Sol, Artisan subagent routing
    // uses the design domain (never inheriting coding/Sol) and selects Claude/Astra/Antigravity.
    const artisanAfterCoding: any = { agent: "artisan", ctx };
    pi.events.emit("pi:hydra:subagent-route", artisanAfterCoding);
    assert.equal(artisanAfterCoding.models?.[0], "claude-bridge/claude-opus-5-5", "Artisan routes via design profile rather than inheriting coding Sol");
    assert.equal(artisanAfterCoding.models?.includes("openai/gpt-6.1-sol"), false, "Artisan fallback chain excludes Sol");
    assert.equal(artisanAfterCoding.thinking, "high");

    // Direct UI/design turn switches a warm Sol session onto a design-capable model.
    const designPayload: any = { reasoningDepth: 2.2, depthConfidence: 0.85, domain: "design", domainConfidence: 0.9, ctx };
    pi.events.emit("pi:jev:turn-signal", designPayload);
    await designPayload.promise;
    assert.ok(["claude-opus-5-5", "gpt-6-astra"].includes(ctx.model.id), "design turn switches off warm Sol onto Opus or Astra");

    // Machinist (non-visual coding specialist) does not inherit a design turn signal from the lead.
    const machinistAfterDesign: any = { agent: "machinist", ctx };
    pi.events.emit("pi:hydra:subagent-route", machinistAfterDesign);
    assert.equal(machinistAfterDesign.models?.includes("openai/gpt-6.1-sol"), true, "Machinist stays on non-visual coding domain after a lead design turn");

    // Complex coding (depth >= 2.85) in hydra:standard runs on a frontier model (high); a warm cache
    // may hold an already-selected frontier model when the leader's margin is below the switch threshold.
    const complexCodingPayload: any = { reasoningDepth: 2.85, depthConfidence: 0.9, domain: "coding", domainConfidence: 0.9, ctx };
    pi.events.emit("pi:jev:turn-signal", complexCodingPayload);
    await complexCodingPayload.promise;
    assert.ok(["claude-opus-5-5", "gpt-6-astra"].includes(ctx.model.id), "complex coding (depth >= 2.85) runs on a frontier model even in standard tier");
    assert.equal(currentThinking, "high", "complex coding in standard tier escalates thinking to high");

    // Subagent Hydra routing via pi:hydra:subagent-route selects fast models for inspector and frontier for oracle.
    const inspectorRoute: any = { agent: "inspector", ctx };
    pi.events.emit("pi:hydra:subagent-route", inspectorRoute);
    assert.equal(inspectorRoute.models?.[0], "local-proxy/claude-haiku-5-5", "inspector routes to fast model under Hydra");
    assert.equal(inspectorRoute.thinking, "low");

    const oracleRoute: any = { agent: "oracle", ctx };
    pi.events.emit("pi:hydra:subagent-route", oracleRoute);
    assert.equal(oracleRoute.models?.[0], "claude-bridge/claude-opus-5-5", "oracle routes to the strongest reasoning model without a subscription-price penalty");
    assert.equal(oracleRoute.thinking, "high");

    // Delayed setModel via pi:jev:turn-signal must finish before payload.promise resolves.
    await commands.mode("hydra max", ctx);
    ctx.model = haikuModel; // haiku 5.5
    setModelDelayMs = 25;
    const upgradePayload: any = { reasoningDepth: 3.9, depthConfidence: 0.95, domain: "reasoning", domainConfidence: 0.95, ctx };
    pi.events.emit("pi:jev:turn-signal", upgradePayload);
    assert.ok(upgradePayload.promise instanceof Promise, "listener attaches promise to event payload");
    await upgradePayload.promise;
    setModelDelayMs = 0;
    assert.ok(["claude-opus-5-5", "gpt-6-astra"].includes(ctx.model.id), "delayed setModel completes before turn-signal promise resolves");

    // Resumed session with recent ISO message timestamp (<30m old) stays cache-warm; expired ISO timestamp (>30m old) re-routes.
    ctx.model = haikuModel; // haiku 5.5
    entries.splice(0, entries.length, {
      type: "message",
      role: "user",
      content: "recent turn",
      timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
    }, {
      type: "custom",
      customType: "behavior-mode",
      data: { mode: "apex", models: { apex: { provider: "local-proxy", modelId: "claude-haiku-5-5", thinking: "low" } }, hydra: "max" },
    });
    for (const h of handlers.session_start ?? []) await h({ reason: "resume" }, ctx);
    assert.equal(ctx.model.id, "claude-haiku-5-5", "recent ISO timestamp keeps resumed session cache-warm");

    entries.splice(0, entries.length, {
      type: "message",
      role: "user",
      content: "old turn",
      timestamp: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    }, {
      type: "custom",
      customType: "behavior-mode",
      data: { mode: "apex", models: { apex: { provider: "local-proxy", modelId: "claude-haiku-5-5", thinking: "low" } }, hydra: "max" },
    });
    for (const h of handlers.session_start ?? []) await h({ reason: "resume" }, ctx);
    assert.ok(["claude-opus-5-5", "gpt-6-astra"].includes(ctx.model.id), "resumed session with expired ISO timestamp re-routes on session_start");

    // Fusion unacknowledged sidekick configure rolls back the live lead model during Hydra routing,
    // and incomplete rollback blocks input until a later /mode succeeds.
    await commands.mode("hydra off", ctx);
    ctx.mode = "rpc";
    ctx.ui.select = async () => "high";
    ctx.modelRegistry.getAvailable = () => catalogModels;
    ctx.model = solModel;
    entries.push({
      type: "custom",
      customType: "behavior-mode",
      data: {
        mode: "fusion",
        models: { fusion: { provider: "openai", modelId: "gpt-6.1-sol", thinking: "high" } },
        fusion: {
          lead: { provider: "openai", modelId: "gpt-6.1-sol", thinking: "high" },
          sidekick: { provider: "local-proxy", modelId: "claude-haiku-5-5", thinking: "low" },
        },
      },
    });
    for (const h of handlers.session_start ?? []) await h({ reason: "resume" }, ctx);
    assert.equal(ctx.model.id, "gpt-6.1-sol");
    allowFusionAck = false;
    await commands.mode("hydra max", ctx);
    assert.equal(ctx.model.id, "gpt-6.1-sol", "unacknowledged Fusion sidekick configuration rolls back the live lead model");

    // Now simulate model restore failure during rollback -> input must be blocked by recoveryBlocked.
    const origFind = ctx.modelRegistry.find;
    ctx.modelRegistry.find = (provider: string, id: string) =>
      id === "gpt-6.1-sol" ? undefined : origFind(provider, id);
    await commands.mode("hydra max", ctx);
    let inputResult: any;
    for (const h of handlers.input ?? []) inputResult = await h({ text: "hello" }, ctx);
    assert.deepEqual(inputResult, { action: "handled" }, "incomplete Hydra rollback blocks input");
    ctx.modelRegistry.find = origFind;
    allowFusionAck = true;
    await commands.mode("hydra max", ctx); // successful /mode hydra clears recoveryBlocked

    // /jippity restricts Hydra (lead and subagents) to OpenAI models; /jippity off restores every subscription.
    await commands.jippity("on", ctx);
    assert.equal(ctx.model.provider, "openai", "jippity routes the lead to an OpenAI model");
    assert.equal(statuses.get("hydra"), "hydra:max·jippity");
    assert.equal(process.env.PI_HYDRA_SCOPE, "openai", "jippity publishes its scope for worker routing");
    const scopedModeEntry = [...entries].reverse().find((e: any) => e.customType === "behavior-mode");
    assert.equal(scopedModeEntry?.data.fusion.sidekick.provider, "openai", "jippity reconfigures an out-of-scope Fusion sidekick");
    const jippityOracle: any = { agent: "oracle", ctx };
    pi.events.emit("pi:hydra:subagent-route", jippityOracle);
    assert.ok(jippityOracle.models?.length && jippityOracle.models.every((key: string) => key.startsWith("openai/")), "jippity limits subagent routes to OpenAI");
    await commands.jippity("off", ctx);
    assert.equal(statuses.get("hydra"), "hydra:max");
    assert.equal(process.env.PI_HYDRA_SCOPE, undefined);

    // An empty OpenAI pool rejects activation instead of advertising a scope the lead cannot satisfy.
    const origGetAvailable = ctx.modelRegistry.getAvailable;
    ctx.modelRegistry.getAvailable = () => catalogModels.filter((m: any) => m.provider !== "openai");
    await commands.jippity("on", ctx);
    assert.match(notices.at(-1) ?? "", /Jippity unavailable/);
    assert.equal(statuses.get("hydra"), "hydra:max", "failed jippity activation does not advertise the scope");
    assert.equal(process.env.PI_HYDRA_SCOPE, undefined);
    ctx.modelRegistry.getAvailable = origGetAvailable;

    // A routing failure during activation (Fusion configure not acknowledged) rolls the
    // scope back too: status, env, and the serving lead must not claim OpenAI-only routing.
    await commands.mode("fusion-set lead model claude-bridge/claude-opus-5-5", ctx);
    allowFusionAck = false;
    await commands.jippity("on", ctx);
    allowFusionAck = true;
    assert.match(notices.at(-1) ?? "", /Jippity activation failed/);
    assert.notEqual(ctx.model.provider, "openai", "failed activation restores the pre-activation lead");
    assert.equal(statuses.get("hydra"), undefined, "failed activation does not advertise the scope");
    assert.equal(process.env.PI_HYDRA_SCOPE, undefined);
    await commands.mode("hydra max", ctx);
    const allOracle: any = { agent: "oracle", ctx };
    pi.events.emit("pi:hydra:subagent-route", allOracle);
    assert.ok(allOracle.models?.some((key: string) => !key.startsWith("openai/")), "jippity off restores all subscriptions");

    await commands.mode("hydra status", ctx);
    assert.match(notices.at(-1) ?? "", /Hydra: max/);

    catalogModels.push(...contributorModels);
    ctx.scopedModels = contributorModels.map(model => ({ model, thinkingLevel: "low" }));
    ctx.model = contributorModels[0];
    const musePayload: any = { reasoningDepth: 1.5, depthConfidence: 1, domain: "conversation", domainConfidence: 1, ctx };
    pi.events.emit("pi:jev:turn-signal", musePayload);
    await musePayload.promise;
    assert.equal(ctx.model.id, "muse-wonder-1.0-contributor", "live routing switches a warm Muse base to its contributor without a score bonus");
    ctx.scopedModels = [];

    assert.deepEqual(readUsageCounts(), {}, "routing and before_agent_start do not count hypothetical calls");
    const response = (provider: string, model: string, stopReason = "toolUse", totalTokens = 100) => ({
      message: { role: "assistant", provider, model, stopReason, usage: { totalTokens } },
    });
    for (const h of handlers.message_end ?? []) {
      await h(response("openai", "gpt-6.1-sol"), ctx);
      await h(response("openai", "gpt-6.1-sol"), ctx);
      await h(response("openai", "gpt-6-astra", "error", 0), ctx);
    }
    assert.deepEqual(readUsageCounts(), { openai: 2 }, "each completed call counts; zero-usage failures do not");
    const workerHandlers: Record<string, any> = {};
    process.env.PI_SUBAGENT = "1";
    registerModes({ on: (name: string, handler: any) => { workerHandlers[name] = handler; } } as any, "", "", "", "");
    delete process.env.PI_SUBAGENT;
    assert.deepEqual(Object.keys(workerHandlers), ["message_end"], "workers install accounting without lead routing");
    await workerHandlers.message_end(response("claude-bridge", "claude-opus-5-5"));
    assert.deepEqual(readUsageCounts(), { openai: 2, anthropic: 1 }, "worker fallback provider is counted from the actual response");
    const now = Date.now();
    writeFileSync(join(defaultUsagePath(), "another-process.json"), JSON.stringify({ schema: 1, events: [
      { t: now, family: "google", provider: "antigravity", model: "gemini-4-argon" },
      { t: now - USAGE_WINDOW_MS - 1, family: "meta", provider: "muse-code", model: "muse-wonder-1.0" },
    ] }));
    assert.deepEqual(readUsageCounts(), { openai: 2, anthropic: 1, google: 1 }, "combines independent ledgers and excludes expired calls");
    await commands.mode("hydra status", ctx);
    assert.match(notices.at(-1) ?? "", /24h calls:/);

    await commands.mode("apex", ctx);
    for (const h of handlers.message_end ?? []) await h(response("openai", "gpt-6-astra"), ctx);
    assert.deepEqual(readUsageCounts(), { openai: 2, anthropic: 1, google: 1 }, "manual-mode calls are excluded");
    assert.equal(process.env.PI_HYDRA_TIER, undefined, "switching to an explicit mode turns off Hydra");
    assert.equal(statuses.get("hydra"), undefined);
  } finally {
    for (const [key, value] of Object.entries({
      PI_CODING_AGENT_DIR: saved.dir,
      PI_SUBAGENT: saved.sub,
      PI_BEHAVIOR_MODE: saved.mode,
      PI_HYDRA_TIER: saved.hydra,
    })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

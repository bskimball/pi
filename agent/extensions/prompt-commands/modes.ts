import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { MODES, isMode, readPreferences, restoreMode, savePreferences, toolsForMode, type Mode, type ModelChoice, type ModeState, type FusionPair } from "./mode-state.ts";
import { pickFusionModel } from "./model-picker.ts";

// Resolve the installed builder rather than maintaining a divergent copy of Pi's prompt.
const builderUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "core/system-prompt.js")).href;
const labels: Record<Mode, string> = { pi: "Pi", apex: "Apex", "apex-orchestrate": "Apex Orchestrate", fusion: "Fusion" };

export function registerModes(pi: ExtensionAPI, regular: string, orchestrate: string, fusion: string): void {
  if (process.env.PI_SUBAGENT === "1") return;
  const preferencePath = join(getAgentDir(), "mode-settings.json");
  let preferences = readPreferences(preferencePath);
  let state: ModeState = structuredClone(preferences);
  let changing = false;
  const availableTools = () => pi.getAllTools().map(tool => tool.name);
  const applyModeTools = (mode: Mode) => pi.setActiveTools(toolsForMode(mode, availableTools()));
  let modelBlocked = false;
  const persist = (setDefault = false) => {
    pi.appendEntry("behavior-mode", structuredClone(state));
    const latest = readPreferences(preferencePath);
    latest.models[state.mode] = state.models[state.mode];
    if (state.mode === "fusion") latest.fusion = structuredClone(state.fusion);
    if (setDefault) latest.mode = state.mode;
    savePreferences(preferencePath, latest);
  };
  const announce = () => {
    process.env.PI_BEHAVIOR_MODE = state.mode;
    pi.events.emit("pi:modes:changed", { mode: state.mode, fusion: state.fusion });
  };
  const idle = (ctx: ExtensionContext) => {
    const query = { busy: !ctx.isIdle() || changing };
    pi.events.emit("pi:modes:query-busy", query);
    if (query.busy) ctx.ui.notify("Stop active agent work before switching modes or UI.", "warning");
    return !query.busy;
  };
  const current = (ctx: ExtensionContext): ModelChoice | undefined => ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id, thinking: pi.getThinkingLevel() } : undefined;
  async function chooseModel(ctx: ExtensionContext, role: string, previous?: ModelChoice): Promise<ModelChoice | undefined> {
    const model = await pickFusionModel(ctx, role, previous);
    if (!model) return undefined;
    const levels: string[] = [...getSupportedThinkingLevels(model)];
    if (previous && levels.includes(previous.thinking)) levels.sort((a, b) => Number(b === previous.thinking) - Number(a === previous.thinking));
    const thinking = await ctx.ui.select(`${role} thinking level`, levels);
    return thinking ? { provider: model.provider, modelId: model.id, thinking } : undefined;
  }
  async function configure(ctx: ExtensionContext): Promise<FusionPair | undefined> {
    const lead = await chooseModel(ctx, "Fusion lead", state.fusion?.lead ?? current(ctx));
    if (!lead) return undefined;
    const sidekick = await chooseModel(ctx, "Fusion sidekick", state.fusion?.sidekick);
    return sidekick ? { lead, sidekick } : undefined;
  }
  async function applyModel(ctx: ExtensionContext, choice?: ModelChoice): Promise<void> {
    if (!choice) return;
    const model = ctx.modelRegistry.find(choice.provider, choice.modelId);
    if (!model || !await pi.setModel(model)) throw new Error(`Model unavailable: ${choice.provider}/${choice.modelId}. Retry or choose a replacement.`);
    pi.setThinkingLevel(choice.thinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
    choice.thinking = pi.getThinkingLevel();
  }
  async function switchMode(mode: Mode, ctx: ExtensionContext, pair?: FusionPair): Promise<void> {
    if (!idle(ctx)) return;
    if (mode === "fusion" && !pair && !state.fusion) {
      pair = await configure(ctx);
      if (!pair) return;
    }
    if (!idle(ctx)) return;
    const previous = structuredClone(state);
    const previousModel = current(ctx);
    changing = true;
    try {
      if (previousModel) state.models[state.mode] = previousModel;
      if (!state.models[mode] && previousModel) state.models[mode] = previousModel;
      const fusion = pair ?? state.fusion;
      await applyModel(ctx, mode === "fusion" ? fusion?.lead : state.models[mode]);
      if (mode === "fusion" && fusion) {
        const request: { fusion: FusionPair; error?: string; promise?: Promise<void> } = { fusion };
        pi.events.emit("pi:fusion:configure", request);
        await request.promise;
        if (request.error) throw new Error(request.error);
      }
      state.mode = mode;
      state.fusion = fusion;
      applyModeTools(mode);
      announce();
      modelBlocked = false;
      persist(true);
      ctx.ui.setStatus("mode", labels[mode]);
      ctx.ui.notify(`Mode: ${labels[mode]}. Default for new sessions updated.`, "info");
    } catch (error) {
      state = previous;
      await applyModel(ctx, previousModel).catch(() => {});
      announce();
      ctx.ui.notify(String(error), "error");
    } finally { changing = false; }
  }
  pi.registerCommand("mode", {
    description: "Switch Pi, Apex, Apex Orchestrate, or Fusion; /mode configure edits the Fusion pair",
    handler: async (args, ctx) => {
      if (!idle(ctx)) return;
      let value = args.trim().toLowerCase();
      if (value === "configure") {
        const pair = await configure(ctx);
        if (pair) await switchMode("fusion", ctx, pair);
        return;
      }
      if (!value) {
        const selected = await ctx.ui.select("Behavior mode", MODES.map(mode => `${mode} — ${labels[mode]}`));
        if (!selected) return;
        value = selected.split(" — ")[0];
      }
      if (!isMode(value)) { ctx.ui.notify("Usage: /mode [pi|apex|apex-orchestrate|fusion|configure]", "warning"); return; }
      await switchMode(value, ctx);
    },
  });
  pi.registerCommand("orchestrate", {
    description: "Shortcut for Apex / Apex Orchestrate",
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      if (!["", "toggle", "on", "off"].includes(value)) { ctx.ui.notify("Usage: /orchestrate [on|off]", "warning"); return; }
      await switchMode(value === "on" || ((value === "" || value === "toggle") && state.mode !== "apex-orchestrate") ? "apex-orchestrate" : "apex", ctx);
    },
  });
  pi.registerCommand("ui", {
    description: "Switch Pi, Apex, or Claude presentation, independently of behavior",
    handler: async (args, ctx) => {
      if (!idle(ctx)) return;
      const value = args.trim().toLowerCase() || await ctx.ui.select("Presentation", ["pi", "apex", "claude"]);
      if (!value) return;
      if (value !== "pi" && value !== "apex" && value !== "claude") { ctx.ui.notify("Usage: /ui [pi|apex|claude]", "warning"); return; }
      const oldUi = preferences.ui;
      const oldTheme = ctx.ui.theme.name ?? preferences.themes[oldUi];
      preferences = readPreferences(preferencePath);
      preferences.themes[oldUi] = oldTheme;
      const result = ctx.ui.setTheme(preferences.themes[value]);
      if (!result.success) { ctx.ui.notify(result.error ?? "Theme unavailable", "error"); return; }
      preferences.ui = value;
      process.env.PI_APEX_UI = value === "pi" ? "0" : "1";
      process.env.PI_UI_SKIN = value === "claude" ? "claude" : "apex";
      pi.events.emit("pi:ui:changed", { ui: value, ctx });
      savePreferences(preferencePath, preferences);
      ctx.ui.notify(`UI: ${value === "apex" ? "Apex" : value === "claude" ? "Claude" : "Default Pi"}`, "info");
    },
  });
  pi.on("session_start", async (event, ctx) => {
    preferences = readPreferences(preferencePath);
    const entries = ctx.sessionManager.getBranch();
    const fresh = event.reason === "new" || (event.reason === "startup" && !entries.some(entry => entry.type === "message"));
    state = restoreMode(entries, preferences, fresh);
    changing = true;
    modelBlocked = state.mode === "fusion" && !state.fusion;
    try { await applyModel(ctx, state.mode === "fusion" ? state.fusion?.lead : state.models[state.mode]); }
    catch (error) { modelBlocked = true; ctx.ui.notify(String(error), "error"); }
    finally { changing = false; }
    applyModeTools(state.mode);
    announce();
    pi.appendEntry("behavior-mode", structuredClone(state));
    process.env.PI_APEX_UI = preferences.ui === "pi" ? "0" : "1";
    process.env.PI_UI_SKIN = preferences.ui === "claude" ? "claude" : "apex";
    if (ctx.hasUI) {
      ctx.ui.setTheme(preferences.themes[preferences.ui]);
      pi.events.emit("pi:ui:changed", { ui: preferences.ui, ctx });
      ctx.ui.setStatus("mode", labels[state.mode]);
    }
  });
  pi.on("model_select", (event) => {
    if (changing || event.source === "restore") return;
    modelBlocked = false;
    const choice = { provider: event.model.provider, modelId: event.model.id, thinking: pi.getThinkingLevel() };
    state.models[state.mode] = choice;
    if (state.mode === "fusion" && state.fusion) state.fusion.lead = choice;
    persist();
  });
  pi.on("thinking_level_select", event => {
    if (changing) return;
    const choice = state.mode === "fusion" ? state.fusion?.lead : state.models[state.mode];
    if (choice) { choice.thinking = event.level; persist(); }
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) {
      const latest = readPreferences(preferencePath);
      latest.themes[preferences.ui] = ctx.ui.theme.name ?? preferences.themes[preferences.ui];
      savePreferences(preferencePath, latest);
    }
  });
  pi.on("input", (_event, ctx) => {
    if (modelBlocked) {
      ctx.ui.notify("Selected model unavailable. Retry /mode or explicitly choose a replacement before continuing.", "error");
      return { action: "handled" as const };
    }
    return undefined;
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (state.mode === "apex") return { systemPrompt: event.systemPrompt + regular };
    if (state.mode === "apex-orchestrate") return { systemPrompt: event.systemPrompt + orchestrate };
    if (state.mode === "fusion") return { systemPrompt: event.systemPrompt + fusion };
    const { buildSystemPrompt } = await import(builderUrl) as { buildSystemPrompt: (options: BuildSystemPromptOptions) => string };
    const selectedTools = pi.getActiveTools();
    const options: BuildSystemPromptOptions = { ...event.systemPromptOptions, customPrompt: undefined, appendSystemPrompt: undefined, promptGuidelines: [], cwd: ctx.cwd, selectedTools };
    return { systemPrompt: buildSystemPrompt(options) };
  });
}

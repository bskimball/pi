import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { MODES, isMode, readPreferences, restoreMode, savePreferences, toolsForMode, type Mode, type ModelChoice, type ModeState, type FusionPair, type Preferences } from "./mode-state.ts";
import { pickFusionModel } from "./model-picker.ts";

// Resolve the installed builder rather than maintaining a divergent copy of Pi's prompt.
const builderUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "core/system-prompt.js")).href;
const labels: Record<Mode, string> = { pi: "Pi", apex: "Apex", "apex-orchestrate": "Apex Orchestrate", fusion: "Fusion", work: "Work" };
const uiLabels = { pi: "Default Pi", apex: "Apex", claude: "Claude", hal: "HAL" } as const;
const usesPersistentSidekick = (mode: Mode): mode is "fusion" | "work" => mode === "fusion" || mode === "work";

/**
 * Pi's builder appends project context and skills to a custom prompt, but its
 * stock tool-description/guideline section is only emitted for the stock
 * coding prompt. Preserve the active extension-provided tool guidance here
 * without bringing that coding-first base prompt into Work mode.
 */
function workToolGuidance(options: BuildSystemPromptOptions, selectedTools: readonly string[]): string | undefined {
  const snippets = selectedTools
    .map(name => options.toolSnippets?.[name] ? `- ${name}: ${options.toolSnippets[name]}` : undefined)
    .filter((line): line is string => line !== undefined);
  const guidelines = (options.promptGuidelines ?? []).map(line => line.trim()).filter(Boolean);
  if (snippets.length === 0 && guidelines.length === 0) return undefined;
  return [
    snippets.length ? `## Active tool guidance\n${snippets.join("\n")}` : undefined,
    guidelines.length ? `## Active tool rules\n${guidelines.map(line => `- ${line}`).join("\n")}` : undefined,
  ].filter(Boolean).join("\n\n");
}

function joinPromptAppends(...sections: Array<string | undefined>): string | undefined {
  const present = sections.filter((section): section is string => Boolean(section?.trim()));
  return present.length ? present.join("\n\n") : undefined;
}

export function registerModes(pi: ExtensionAPI, regular: string, orchestrate: string, fusion: string, work: string, fusionPreface = ""): void {
  if (process.env.PI_SUBAGENT === "1") return;
  const preferencePath = join(getAgentDir(), "mode-settings.json");
  let preferences = readPreferences(preferencePath);
  let state: ModeState = structuredClone(preferences);
  let changing = false;
  const availableTools = () => pi.getAllTools().map(tool => tool.name);
  const applyModeTools = (mode: Mode) => pi.setActiveTools(toolsForMode(mode, availableTools()));
  let modelBlocked = false;
  // Set when a mode switch fails and its compensation is incomplete: input
  // stays blocked until a later /mode succeeds. Deliberately separate from
  // modelBlocked so /model and thinking selection cannot clear it.
  let recoveryBlocked: string | false = false;
  const persist = (setDefault = false) => {
    pi.appendEntry("behavior-mode", structuredClone(state));
    const latest = readPreferences(preferencePath);
    latest.models[state.mode] = state.models[state.mode];
    if (usesPersistentSidekick(state.mode)) latest.fusion = structuredClone(state.fusion);
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
  async function configure(ctx: ExtensionContext, mode: "fusion" | "work"): Promise<FusionPair | undefined> {
    const label = mode === "work" ? "Work" : "Fusion";
    const lead = await chooseModel(ctx, `${label} lead`, state.fusion?.lead ?? current(ctx));
    if (!lead) return undefined;
    const sidekick = await chooseModel(ctx, `${label} sidekick`, state.fusion?.sidekick);
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
    if (usesPersistentSidekick(mode) && !pair && !state.fusion) {
      pair = await configure(ctx, mode);
      if (!pair) return;
    }
    if (!idle(ctx)) return;
    const nextFusion = pair ?? state.fusion;
    if (usesPersistentSidekick(mode) && !nextFusion) {
      ctx.ui.notify(`${labels[mode]} sidekick configuration is unavailable.`, "error");
      return;
    }
    // Stage the full next state and every handle needed to restore coherent
    // behavior. Nothing observable applies until the sequence below runs:
    // announce (tool advertisement, sidekick parking, env) stays last.
    const prevState = structuredClone(state);
    const prevModel = current(ctx);
    const prevActiveTools = [...pi.getActiveTools()];
    // The prefs file must be readable before mutation: recovery rewrites our
    // default from this snapshot, and an unreadable file aborts the switch.
    let prevPrefs: Preferences;
    try {
      prevPrefs = readPreferences(preferencePath);
    } catch (prefsError) {
      ctx.ui.notify(`Mode preferences unreadable (${prefsError instanceof Error ? prefsError.message : String(prefsError)}); switch aborted before any change.`, "error");
      return;
    }
    const nextState = structuredClone(state);
    if (prevModel && !recoveryBlocked) nextState.models[nextState.mode] = structuredClone(prevModel);
    if (!nextState.models[mode] && prevModel) nextState.models[mode] = structuredClone(prevModel);
    nextState.mode = mode;
    nextState.fusion = structuredClone(nextFusion);
    const targetModel = usesPersistentSidekick(mode) ? nextFusion?.lead : nextState.models[mode];
    let persisted = false;
    let rollback: (() => Promise<void>) | undefined;
    const prevBlocked = recoveryBlocked;
    changing = true;
    try {
      // Apply to a staged copy and record the actual (possibly clamped) Pi
      // thinking level, so persisted state agrees with reality.
      const stagedTarget = targetModel ? structuredClone(targetModel) : undefined;
      await applyModel(ctx, stagedTarget);
      if (stagedTarget) {
        if (usesPersistentSidekick(mode) && nextState.fusion) nextState.fusion.lead.thinking = stagedTarget.thinking;
        else if (nextState.models[mode]) nextState.models[mode]!.thinking = stagedTarget.thinking;
      }
      rollback = undefined;
      if (usesPersistentSidekick(mode) && nextFusion) {
        // Explicit handshake: the bus swallows listener exceptions, so a
        // missing synchronous acknowledgement is itself a failure.
        const request: { fusion: FusionPair; acknowledged?: boolean; error?: string; promise?: Promise<void>; rollback?: () => Promise<void> } = { fusion: structuredClone(nextState.fusion!) };
        pi.events.emit("pi:fusion:configure", request);
        if (!request.acknowledged) throw new Error(`${labels[mode]} runtime did not acknowledge sidekick configuration. Retry or choose a replacement.`);
        rollback = request.rollback;
        if (request.promise) await request.promise;
        if (request.error) throw new Error(request.error);
      }
      state = nextState;
      applyModeTools(mode);
      persist(true);
      persisted = true;
      announce();
      modelBlocked = false;
      recoveryBlocked = false;
      ctx.ui.setStatus("mode", labels[mode]);
      ctx.ui.notify(`Mode: ${labels[mode]}. Default for new sessions updated.`, "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Compensate in reverse order. Every step reports; none fail silently.
      const failures: string[] = [];
      try { await rollback?.(); }
      catch (rollbackError) { failures.push(`sidekick rollback: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); }
      // Repair from the persisted desired lead, not the possibly
      // half-applied actual model: current() may reflect a failed apply.
      const repairTarget = usesPersistentSidekick(prevState.mode) ? prevState.fusion?.lead : prevState.models[prevState.mode];
      try { await applyModel(ctx, repairTarget ? structuredClone(repairTarget) : (prevModel ? structuredClone(prevModel) : undefined)); }
      catch (modelError) { failures.push(`model restore: ${modelError instanceof Error ? modelError.message : String(modelError)}`); }
      try { pi.setActiveTools(prevActiveTools); }
      catch (toolsError) { failures.push(`tool restore: ${toolsError instanceof Error ? toolsError.message : String(toolsError)}`); }
      state = prevState;
      try { announce(); }
      catch (announceError) { failures.push(`announce: ${announceError instanceof Error ? announceError.message : String(announceError)}`); }
      // Compensation branch entry so the session reflects restored reality.
      // The prefs file saves atomically (tmp+rename), so it is either fully
      // updated or untouched: rewrite our default only when our save landed,
      // re-reading latest first to preserve unrelated concurrent changes.
      try { pi.appendEntry("behavior-mode", structuredClone(prevState)); }
      catch (entryError) { failures.push(`session entry: ${entryError instanceof Error ? entryError.message : String(entryError)}`); }
      if (persisted) {
        try {
          const latest = readPreferences(preferencePath);
          latest.mode = prevPrefs.mode;
          if (prevPrefs.models[mode] !== undefined) latest.models[mode] = structuredClone(prevPrefs.models[mode]) as ModelChoice;
          else delete latest.models[mode];
          if (usesPersistentSidekick(mode)) {
            if (prevPrefs.fusion !== undefined) latest.fusion = structuredClone(prevPrefs.fusion);
            else delete latest.fusion;
          }
          savePreferences(preferencePath, latest);
        } catch (prefsError) { failures.push(`preferences restore: ${prefsError instanceof Error ? prefsError.message : String(prefsError)}`); }
      }
      // A preexisting block survives until a SUCCESSFUL switch, not merely a
      // cleanly compensated failure.
      if (failures.length) {
        recoveryBlocked = `Mode switch to ${labels[mode]} failed (${message}) and recovery is incomplete: ${failures.join("; ")}. Retry /mode when ready.`;
      } else if (prevBlocked) {
        recoveryBlocked = prevBlocked;
      } else {
        recoveryBlocked = false;
      }
      try { ctx.ui.setStatus("mode", labels[prevState.mode]); } catch { /* cosmetic */ }
      let note = `Mode switch to ${labels[mode]} failed (${message}); restored ${labels[prevState.mode]}.`;
      if (typeof recoveryBlocked === "string") {
        note = failures.length ? recoveryBlocked : `${note} Prior recovery block still in effect: ${recoveryBlocked}`;
      }
      ctx.ui.notify(note, "error");
    } finally { changing = false; }
  }
  pi.registerCommand("mode", {
    description: "Switch Pi, Apex, Apex Orchestrate, Fusion, or Work; /mode configure edits the active collaboration pair",
    handler: async (args, ctx) => {
      if (!idle(ctx)) return;
      let value = args.trim().toLowerCase();
      if (value === "configure") {
        const configuredMode: "fusion" | "work" = state.mode === "work" ? "work" : "fusion";
        const pair = await configure(ctx, configuredMode);
        if (pair) await switchMode(configuredMode, ctx, pair);
        return;
      }
      if (!value) {
        const selected = await ctx.ui.select("Behavior mode", MODES.map(mode => `${mode} — ${labels[mode]}`));
        if (!selected) return;
        value = selected.split(" — ")[0];
      }
      if (!isMode(value)) { ctx.ui.notify("Usage: /mode [pi|apex|apex-orchestrate|fusion|work|configure]", "warning"); return; }
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
    description: "Switch Pi, Apex, Claude, or HAL presentation, independently of behavior",
    handler: async (args, ctx) => {
      if (!idle(ctx)) return;
      const value = args.trim().toLowerCase() || await ctx.ui.select("Presentation", ["pi", "apex", "claude", "hal"]);
      if (!value) return;
      if (value !== "pi" && value !== "apex" && value !== "claude" && value !== "hal") { ctx.ui.notify("Usage: /ui [pi|apex|claude|hal]", "warning"); return; }
      const oldUi = preferences.ui;
      const oldTheme = ctx.ui.theme.name ?? preferences.themes[oldUi];
      preferences = readPreferences(preferencePath);
      preferences.themes[oldUi] = oldTheme;
      const result = ctx.ui.setTheme(preferences.themes[value]);
      if (!result.success) { ctx.ui.notify(result.error ?? "Theme unavailable", "error"); return; }
      preferences.ui = value;
      process.env.PI_APEX_UI = value === "pi" ? "0" : "1";
      process.env.PI_UI_SKIN = value === "pi" ? "apex" : value;
      pi.events.emit("pi:ui:changed", { ui: value, ctx });
      savePreferences(preferencePath, preferences);
      ctx.ui.notify(`UI: ${uiLabels[value]}`, "info");
    },
  });
  pi.on("session_start", async (event, ctx) => {
    preferences = readPreferences(preferencePath);
    recoveryBlocked = false;
    const entries = ctx.sessionManager.getBranch();
    const fresh = event.reason === "new" || (event.reason === "startup" && !entries.some(entry => entry.type === "message"));
    state = restoreMode(entries, preferences, fresh);
    changing = true;
    modelBlocked = usesPersistentSidekick(state.mode) && !state.fusion;
    // Restore through a clone: applyModel records the actual (possibly
    // clamped) Pi level on its input, which must not overwrite the stored
    // desired choice that a later switch recovery repairs from.
    const restoreChoice = usesPersistentSidekick(state.mode) ? state.fusion?.lead : state.models[state.mode];
    try { await applyModel(ctx, restoreChoice ? structuredClone(restoreChoice) : undefined); }
    catch (error) { modelBlocked = true; ctx.ui.notify(String(error), "error"); }
    finally { changing = false; }
    applyModeTools(state.mode);
    announce();
    pi.appendEntry("behavior-mode", structuredClone(state));
    process.env.PI_APEX_UI = preferences.ui === "pi" ? "0" : "1";
    process.env.PI_UI_SKIN = preferences.ui === "pi" ? "apex" : preferences.ui;
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
    if (usesPersistentSidekick(state.mode) && state.fusion) state.fusion.lead = choice;
    persist();
  });
  pi.on("thinking_level_select", event => {
    if (changing) return;
    const choice = usesPersistentSidekick(state.mode) ? state.fusion?.lead : state.models[state.mode];
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
    if (recoveryBlocked) {
      ctx.ui.notify(recoveryBlocked, "error");
      return { action: "handled" as const };
    }
    if (modelBlocked) {
      ctx.ui.notify("Selected model unavailable. Retry /mode or explicitly choose a replacement before continuing.", "error");
      return { action: "handled" as const };
    }
    return undefined;
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (state.mode === "apex") return { systemPrompt: event.systemPrompt + regular };
    if (state.mode === "apex-orchestrate") return { systemPrompt: event.systemPrompt + orchestrate };
    if (state.mode === "fusion") return { systemPrompt: fusionPreface + event.systemPrompt + fusion };
    const { buildSystemPrompt } = await import(builderUrl) as { buildSystemPrompt: (options: BuildSystemPromptOptions) => string };
    const selectedTools = pi.getActiveTools();
    // Pi retains its stock builder behavior unchanged.
    if (state.mode !== "work") {
      return { systemPrompt: buildSystemPrompt({ ...event.systemPromptOptions, customPrompt: undefined, appendSystemPrompt: undefined, promptGuidelines: [], cwd: ctx.cwd, selectedTools }) };
    }
    // Runner handlers execute sequentially, so earlier extensions may have
    // appended dynamic context to the stock baseline. Preserve that suffix
    // when replacing only the baseline with Work's standalone prompt.
    const baseline = buildSystemPrompt(event.systemPromptOptions);
    const options: BuildSystemPromptOptions = {
      ...event.systemPromptOptions,
      cwd: ctx.cwd,
      selectedTools,
      customPrompt: work,
      appendSystemPrompt: joinPromptAppends(event.systemPromptOptions.appendSystemPrompt, workToolGuidance(event.systemPromptOptions, selectedTools)),
    };
    if (!event.systemPrompt.startsWith(baseline)) {
      ctx.ui.notify("Work prompt could not preserve an earlier extension's full prompt rewrite; only builder context is included.", "warning");
      return { systemPrompt: buildSystemPrompt(options) };
    }
    return { systemPrompt: buildSystemPrompt(options) + event.systemPrompt.slice(baseline.length) };
  });
}

import { join } from "node:path";
import { clampThinkingLevel, getCurrentSystemMessage, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { MODES, hasCliFlag, isMode, readPreferences, restoreMode, savePreferences, synchronizeFusionModel, toolsForMode, type Mode, type ModelChoice, type ModeState, type FusionPair, type Preferences } from "./mode-state.ts";
import { pickFusionModel } from "./model-picker.ts";
import { registerPresentationSwitch } from "./presentation-switch.ts";
import { AA_STALE_MS, readAaCatalog, syncAaCatalog } from "./hydra/aa-sync.ts";
import { QUOTA_STALE_MS, readOpenCircuits, readQuotaSnapshot, syncQuotaSnapshot } from "./hydra/quota-sync.ts";
import { HYDRA_SCOPE_PROVIDERS, HYDRA_TIERS, isHydraTier, rankModelsForHydra, selectThinkingForModel, subagentHydraProfile, type ActiveHydraTier, type HydraScope, type HydraTier, type HydraTurnSignalInput } from "./hydra/scorer.ts";
import { readUsageCounts, recordHydraUsage } from "./hydra/usage.ts";

const labels: Record<Mode, string> = { pi: "Pi", apex: "Apex", "apex-orchestrate": "Apex Orchestrate", fusion: "Fusion", work: "Work" };
const usesPersistentSidekick = (mode: Mode): mode is "fusion" => mode === "fusion";
const CACHE_TTL_MS = 30 * 60_000;

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

function joinPromptAppends(...sections: Array<string | undefined>): string {
  return sections.filter((section): section is string => Boolean(section?.trim())).join("\n\n");
}

export function registerModes(pi: ExtensionAPI, regular: string, orchestrate: string, fusion: string, work: string, fusionPreface = "", piBlock = ""): void {
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
  const fusionPairLabel = (pair: FusionPair) =>
    `Lead ${pair.lead.provider}/${pair.lead.modelId} (${pair.lead.thinking}); sidekick ${pair.sidekick.provider}/${pair.sidekick.modelId} (${pair.sidekick.thinking}).`;
  const persist = (setDefault = false) => {
    synchronizeFusionModel(state);
    pi.appendEntry("behavior-mode", structuredClone(state));
    const latest = readPreferences(preferencePath);
    latest.models[state.mode] = state.models[state.mode];
    if (usesPersistentSidekick(state.mode)) latest.fusion = structuredClone(state.fusion);
    if (state.hydra && state.hydra !== "off") latest.hydra = state.hydra;
    else delete latest.hydra;
    if (latest.hydra && state.hydraScope) latest.hydraScope = state.hydraScope;
    else delete latest.hydraScope;
    synchronizeFusionModel(latest);
    if (setDefault && state.mode !== "apex-orchestrate") latest.mode = state.mode;
    savePreferences(preferencePath, latest);
  };
  let lastTurnAt = 0;
  const activeHydra = (): ActiveHydraTier | undefined =>
    state.hydra && state.hydra !== "off" ? state.hydra : undefined;
  // Structured pair for non-TUI hosts (desktop over RPC). TUI is skipped so
  // raw JSON never reaches the terminal footer; cleared outside Fusion.
  const publishPair = (ctx: ExtensionContext) => {
    const tier = activeHydra();
    if (ctx.hasUI) {
      const scope = tier && state.hydraScope === "openai" ? "\u00b7jippity" : "";
      ctx.ui.setStatus("hydra", tier ? `hydra:${tier}${scope}` : undefined);
    }
    if (ctx.mode === "tui") return;
    ctx.ui.setStatus("fusion-pair", usesPersistentSidekick(state.mode) && state.fusion ? JSON.stringify(state.fusion) : undefined);
  };
  const announce = () => {
    process.env.PI_BEHAVIOR_MODE = state.mode;
    const tier = activeHydra();
    if (tier) process.env.PI_HYDRA_TIER = tier;
    else delete process.env.PI_HYDRA_TIER;
    if (tier && state.hydraScope) process.env.PI_HYDRA_SCOPE = state.hydraScope;
    else delete process.env.PI_HYDRA_SCOPE;
    pi.events.emit("pi:modes:changed", { mode: state.mode, fusion: state.fusion, hydra: state.hydra, hydraScope: state.hydraScope });
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
    const thinking = await ctx.ui.select(`${role} thinking level${role.toLowerCase().includes("lead") ? " (high recommended)" : role.toLowerCase().includes("sidekick") ? " (medium/low usually enough)" : ""}`, levels);
    return thinking ? { provider: model.provider, modelId: model.id, thinking } : undefined;
  }
  async function configureFusion(ctx: ExtensionContext): Promise<FusionPair | undefined> {
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
  function parseEntryTimestampMs(entry: any): number {
    const candidates = [entry?.timestamp, entry?.message?.timestamp];
    for (const raw of candidates) {
      if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
      if (typeof raw === "string" && raw.trim()) {
        const parsed = Date.parse(raw);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
      }
    }
    return 0;
  }
  function isSessionCacheWarm(ctx: ExtensionContext): boolean {
    const entries = ctx.sessionManager?.getBranch?.() ?? [];
    let latestMessageTs = 0;
    let hasMessages = false;
    for (const entry of entries) {
      if (entry?.type === "message") {
        hasMessages = true;
        const ts = parseEntryTimestampMs(entry);
        if (ts > latestMessageTs) latestMessageTs = ts;
      }
    }
    if (!hasMessages) return false;
    const anchorTs = Math.max(lastTurnAt, latestMessageTs);
    if (anchorTs <= 0) return false;
    if (Date.now() - anchorTs > CACHE_TTL_MS) return false;
    return true;
  }
  function rankForCurrentScope(
    ctx: ExtensionContext,
    tier: ActiveHydraTier,
    signal?: HydraTurnSignalInput,
    cacheWarm = false,
  ) {
    const scopeProviders = state.hydraScope ? HYDRA_SCOPE_PROVIDERS[state.hydraScope] : undefined;
    const available = ctx.modelRegistry?.getAvailable?.() ?? [];
    const models = scopeProviders ? available.filter((m) => scopeProviders.has(m.provider)) : available;
    const scopedKeys = new Set(
      (ctx.scopedModels ?? []).map(({ model }: any) => `${model.provider}/${model.id}`),
    );
    const catalog = readAaCatalog().models;
    const quota = readQuotaSnapshot();
    const openCircuits = readOpenCircuits();
    const currentKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    return rankModelsForHydra({
      models,
      scopedKeys,
      catalog,
      quota,
      openCircuits,
      tier,
      signal,
      currentModelKey: currentKey,
      cacheWarm,
      usage: readUsageCounts(),
    });
  }
  let hydraRouteChain: Promise<void> = Promise.resolve();
  let lastJevTurnSignal: HydraTurnSignalInput | undefined;
  let jevRoutedThisTurn = false;
  interface HydraRouteResult {
    summary: string;
    model: string;
    thinking: string;
    score?: number;
    switchedModel: boolean;
  }
  async function routeWithHydra(
    ctx: ExtensionContext,
    tier: ActiveHydraTier,
    signal?: HydraTurnSignalInput,
    forceModelPick = false,
  ): Promise<HydraRouteResult | undefined> {
    let outcome: HydraRouteResult | undefined;
    const run = async () => {
      if (signal) lastJevTurnSignal = signal;
      const cacheWarm = !forceModelPick && isSessionCacheWarm(ctx);
      const ranked = rankForCurrentScope(ctx, tier, signal, cacheWarm);
      const winner = ranked[0];
      if (!winner) return;

      const currentKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const currentRanked = currentKey ? ranked.find((c) => c.key === currentKey ||
        (ctx.model?.id.startsWith("muse-") && c.key === `${currentKey}-contributor`)) : undefined;
      const scoreMargin = winner.finalScore - (currentRanked?.finalScore ?? 0);
      const shouldSwitchModel =
        forceModelPick ||
        !cacheWarm ||
        !currentKey ||
        (ctx.model?.id.startsWith("muse-") && winner.key === `${currentKey}-contributor`) ||
        (winner.key !== currentKey &&
          signal !== undefined &&
          scoreMargin >= 0.02);

      const prevState = structuredClone(state);
      const prevModel = current(ctx);
      let rollback: (() => Promise<void>) | undefined;
      changing = true;
      try {
        if (shouldSwitchModel && winner.key !== currentKey) {
          const choice: ModelChoice = {
            provider: winner.model.provider,
            modelId: winner.model.id,
            thinking: winner.recommendedThinking,
          };
          const stagedChoice = structuredClone(choice);
          await applyModel(ctx, stagedChoice);
          choice.thinking = stagedChoice.thinking;

          if (usesPersistentSidekick(state.mode)) {
            const sidekickRanked = rankForCurrentScope(
              ctx,
              "standard",
              { reasoningDepth: 2, depthConfidence: 1, domain: "coding", domainConfidence: 1 },
              false,
            );
            const sidekickWinner = sidekickRanked[0] ?? winner;
            const existingSidekick = state.fusion?.sidekick;
            const scopeProviders = state.hydraScope ? HYDRA_SCOPE_PROVIDERS[state.hydraScope] : undefined;
            const nextPair: FusionPair = {
              lead: choice,
              // Keep an existing sidekick only while it satisfies the active Hydra scope.
              sidekick: existingSidekick && (!scopeProviders || scopeProviders.has(existingSidekick.provider))
                ? existingSidekick
                : {
                  provider: sidekickWinner.model.provider,
                  modelId: sidekickWinner.model.id,
                  thinking: sidekickWinner.recommendedThinking,
                },
            };
            const request: {
              fusion: FusionPair;
              acknowledged?: boolean;
              error?: string;
              promise?: Promise<void>;
              rollback?: () => Promise<void>;
            } = {
              fusion: structuredClone(nextPair),
            };
            pi.events.emit("pi:fusion:configure", request);
            if (!request.acknowledged) {
              throw new Error(`${labels[state.mode]} runtime did not acknowledge sidekick configuration.`);
            }
            rollback = request.rollback;
            if (request.promise) await request.promise;
            if (request.error) throw new Error(request.error);
            state.fusion = nextPair;
          }

          state.models[state.mode] = choice;
          persist();
          publishPair(ctx);
          outcome = {
            summary: `${winner.key} (${choice.thinking}, score ${winner.finalScore.toFixed(2)})`,
            model: winner.key,
            thinking: choice.thinking,
            score: winner.finalScore,
            switchedModel: true,
          };
          return;
        }

        // Keep current lead model and dynamically adjust thinking effort.
        const activeModel = ctx.model ?? winner.model;
        const activeKey = `${activeModel.provider}/${activeModel.id}`;
        const activeScore = (ranked.find((c) => c.key === activeKey ||
          (activeModel.id.startsWith("muse-") && c.key === `${activeKey}-contributor`)) ?? winner).finalScore;
        const nextThinking = selectThinkingForModel(activeModel, tier, signal);
        if (nextThinking !== pi.getThinkingLevel()) {
          pi.setThinkingLevel(nextThinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
          const actualThinking = pi.getThinkingLevel();
          const activeChoice = usesPersistentSidekick(state.mode) ? state.fusion?.lead : state.models[state.mode];
          if (activeChoice) {
            activeChoice.thinking = actualThinking;
            persist();
          }
        }
        // The lead held, but an active Hydra scope may still invalidate the Fusion sidekick.
        if (usesPersistentSidekick(state.mode) && state.fusion) {
          const scopeProviders = state.hydraScope ? HYDRA_SCOPE_PROVIDERS[state.hydraScope] : undefined;
          if (scopeProviders && !scopeProviders.has(state.fusion.sidekick.provider)) {
            const sidekickRanked = rankForCurrentScope(
              ctx,
              "standard",
              { reasoningDepth: 2, depthConfidence: 1, domain: "coding", domainConfidence: 1 },
              false,
            );
            const sidekickWinner = sidekickRanked[0] ?? winner;
            const nextPair: FusionPair = {
              lead: { provider: activeModel.provider, modelId: activeModel.id, thinking: pi.getThinkingLevel() },
              sidekick: {
                provider: sidekickWinner.model.provider,
                modelId: sidekickWinner.model.id,
                thinking: sidekickWinner.recommendedThinking,
              },
            };
            const request: {
              fusion: FusionPair;
              acknowledged?: boolean;
              error?: string;
              promise?: Promise<void>;
              rollback?: () => Promise<void>;
            } = { fusion: structuredClone(nextPair) };
            pi.events.emit("pi:fusion:configure", request);
            if (!request.acknowledged) {
              throw new Error(`${labels[state.mode]} runtime did not acknowledge sidekick configuration.`);
            }
            rollback = request.rollback;
            if (request.promise) await request.promise;
            if (request.error) throw new Error(request.error);
            state.fusion = nextPair;
            persist();
          }
        }
        publishPair(ctx);
        const actualThinking = pi.getThinkingLevel();
        outcome = {
          summary: `${activeKey} (${actualThinking}, score ${activeScore.toFixed(2)})`,
          model: activeKey,
          thinking: actualThinking,
          score: activeScore,
          switchedModel: false,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failures: string[] = [];
        try { await rollback?.(); }
        catch (rollbackError) { failures.push(`sidekick rollback: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); }
        const repairTarget = usesPersistentSidekick(prevState.mode) ? prevState.fusion?.lead : prevState.models[prevState.mode];
        try {
          await applyModel(ctx, repairTarget ? structuredClone(repairTarget) : (prevModel ? structuredClone(prevModel) : undefined));
        } catch (modelError) {
          failures.push(`model restore: ${modelError instanceof Error ? modelError.message : String(modelError)}`);
        }
        state = prevState;
        try { pi.appendEntry("behavior-mode", structuredClone(prevState)); }
        catch (entryError) { failures.push(`session entry: ${entryError instanceof Error ? entryError.message : String(entryError)}`); }
        try { publishPair(ctx); } catch { /* cosmetic */ }
        if (failures.length) {
          recoveryBlocked = `Hydra routing in ${labels[prevState.mode]} failed (${message}) and recovery is incomplete: ${failures.join("; ")}. Retry /mode when ready.`;
          ctx.ui.notify(recoveryBlocked, "error");
        } else {
          ctx.ui.notify(`Hydra routing failed (${message}); restored ${labels[prevState.mode]} model.`, "error");
        }
        outcome = undefined;
      } finally {
        changing = false;
      }
    };
    const next = hydraRouteChain.then(run, run);
    hydraRouteChain = next.then(() => undefined, () => undefined);
    await next;
    return outcome;
  }
  async function switchMode(mode: Mode, ctx: ExtensionContext, pair?: FusionPair): Promise<void> {
    if (!idle(ctx)) return;
    if (usesPersistentSidekick(mode) && !pair && !state.fusion) {
      pair = await configureFusion(ctx);
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
    delete nextState.hydra;
    delete nextState.hydraScope;
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
      publishPair(ctx);
      const identity = usesPersistentSidekick(mode) && state.fusion
        ? ` ${fusionPairLabel(state.fusion)}`
        : "";
      ctx.ui.notify(`Mode: ${labels[mode]}. ${mode === "apex-orchestrate" ? "Current session only." : "Default for new sessions updated."}${identity}`, "info");
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
          if (prevPrefs.hydra && prevPrefs.hydra !== "off") latest.hydra = prevPrefs.hydra;
          else delete latest.hydra;
          if (latest.hydra && prevPrefs.hydraScope) latest.hydraScope = prevPrefs.hydraScope;
          else delete latest.hydraScope;
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
      try { ctx.ui.setStatus("mode", labels[prevState.mode]); publishPair(ctx); } catch { /* cosmetic */ }
      let note = `Mode switch to ${labels[mode]} failed (${message}); restored ${labels[prevState.mode]}.`;
      if (typeof recoveryBlocked === "string") {
        note = failures.length ? recoveryBlocked : `${note} Prior recovery block still in effect: ${recoveryBlocked}`;
      }
      ctx.ui.notify(note, "error");
    } finally { changing = false; }
  }
  async function handleHydraCommand(subArgs: string[], ctx: ExtensionContext): Promise<void> {
    let sub = subArgs[0]?.toLowerCase() ?? "";
    if (!sub) {
      const currentTier = state.hydra ?? "off";
      const options = [
        ...HYDRA_TIERS.map(t => `${t} — ${t === "off" ? "Disable automatic stats routing" : `Hydra ${t} effort routing`}${t === currentTier ? " (active)" : ""}`),
        "status — Show ranked AA models, quota health, and current selection",
        "sync — Refresh Artificial Analysis metrics and 8317 quota snapshot",
      ];
      const picked = await ctx.ui.select("Hydra model router", options);
      if (!picked) return;
      sub = picked.split(" — ")[0]!;
    }
    if (sub === "sync") {
      try {
        const aa = await syncAaCatalog();
        const q = await syncQuotaSnapshot();
        ctx.ui.notify(`Hydra synced: ${aa.models.length} AA models (${aa.source}); ${q.note}.`, "info");
      } catch (err) {
        ctx.ui.notify(`Hydra sync failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
      return;
    }
    if (sub === "status") {
      const tier: ActiveHydraTier = activeHydra() ?? "high";
      const aaSnap = readAaCatalog();
      const quotaSnap = readQuotaSnapshot();
      const openCircuits = readOpenCircuits();
      const ranked = rankForCurrentScope(ctx, tier, undefined, isSessionCacheWarm(ctx));
      const top = ranked.slice(0, 4).map((r, idx) =>
        `${idx + 1}. ${r.key} (${r.recommendedThinking}) score=${r.finalScore.toFixed(2)} [code=${r.aa.codingScore.toFixed(0)} intel=${(r.aa.intelligenceIndex ?? 0).toFixed(0)} tps=${(r.aa.outputSpeedTps ?? 0).toFixed(0)} $${(r.aa.blendedPricePer1m ?? 0).toFixed(2)}${r.quotaReason ? ` ${r.quotaReason}` : ""}]`
      );
      const header = `Hydra: ${state.hydra ?? "off"}${state.hydraScope ? ` [${state.hydraScope} only]` : ""} (previewing tier=${tier}, AA=${aaSnap.source} ${aaSnap.models.length} models, quota=${quotaSnap.source}, openCircuits=${openCircuits.size})`;
      const usage = Object.entries(readUsageCounts()).sort((a, b) => b[1] - a[1]);
      const usageLine = `24h turns: ${usage.length ? usage.map(([family, n]) => `${family} ${n}`).join(", ") : "none"}`;
      ctx.ui.notify([header, usageLine, ...(top.length ? top : ["No matching AA models in current provider scope."])].join("\n"), "info");
      return;
    }
    if (sub === "on" || sub === "toggle") {
      sub = activeHydra() ? "off" : "high";
    }
    if (!isHydraTier(sub)) {
      ctx.ui.notify("Usage: /mode hydra [off|standard|high|max|status|sync]", "warning");
      return;
    }
    try {
      readPreferences(preferencePath);
    } catch (prefsError) {
      ctx.ui.notify(`Mode preferences unreadable (${prefsError instanceof Error ? prefsError.message : String(prefsError)}); switch aborted before any change.`, "error");
      return;
    }
    const nextTier: HydraTier = sub;
    state.hydra = nextTier === "off" ? undefined : nextTier;
    if (nextTier === "off") delete state.hydraScope;
    persist();
    announce();
    publishPair(ctx);
    if (nextTier === "off") {
      ctx.ui.notify("Hydra model router: off (using pinned mode model).", "info");
      return;
    }
    const pickedResult = await routeWithHydra(ctx, nextTier, undefined, true);
    ctx.ui.notify(
      `Hydra model router: ${nextTier}.${pickedResult ? ` Selected ${pickedResult.summary}.` : " No matching AA model available in current scope; keeping active model."}`,
      "info",
    );
  }
  pi.registerCommand("mode", {
    description: "Switch Pi, Apex, Apex Orchestrate, Fusion, Work, or Hydra (/mode hydra [off|standard|high|max|status|sync]); /mode configure edits the pair",
    handler: async (args, ctx) => {
      if (!idle(ctx)) return;
      let value = args.trim().toLowerCase();
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts[0]?.toLowerCase() === "hydra") {
        await handleHydraCommand(parts.slice(1), ctx);
        return;
      }
      if (value.split(/\s+/)[0] === "fusion-set") {
        const parts = args.trim().split(/\s+/);
        const [, role, field, selection] = parts;
        if (parts.length !== 4 || (role !== "lead" && role !== "sidekick") || (field !== "model" && field !== "thinking")) {
          ctx.ui.notify("Usage: /mode fusion-set <lead|sidekick> model <provider>/<modelId> or /mode fusion-set <lead|sidekick> thinking <level>", "warning");
          return;
        }
        if (state.mode !== "fusion" || !state.fusion) {
          ctx.ui.notify("Fusion pair changes require an active, configured Fusion mode.", "warning");
          return;
        }
        const pair = structuredClone(state.fusion);
        const choice = pair[role];
        const slash = selection.indexOf("/");
        const provider = field === "model" ? selection.slice(0, slash) : choice.provider;
        const modelId = field === "model" ? selection.slice(slash + 1) : choice.modelId;
        const model = ctx.modelRegistry.getAvailable().find(model => model.provider === provider && model.id === modelId);
        if ((field === "model" && slash <= 0) || !model) {
          ctx.ui.notify(`Model unavailable: ${field === "model" ? selection : `${provider}/${modelId}`}. Choose an available configured model.`, "error");
          return;
        }
        if (field === "thinking") {
          const levels: string[] = getSupportedThinkingLevels(model);
          if (!levels.includes(selection)) {
            ctx.ui.notify(`Unsupported thinking level: ${selection}. Supported: ${levels.join(", ")}.`, "error");
            return;
          }
          choice.thinking = selection;
        } else {
          choice.provider = model.provider;
          choice.modelId = model.id;
          choice.thinking = clampThinkingLevel(model, choice.thinking as Parameters<typeof clampThinkingLevel>[1]);
        }
        await switchMode("fusion", ctx, pair);
        return;
      }
      if (value === "configure") {
        if (state.mode === "work") {
          ctx.ui.notify("Work mode has no lead/sidekick pair to configure \u2014 it dispatches strategist, researcher, author, and clerk. Switch to Fusion to configure a pair.", "info");
          return;
        }
        const pair = await configureFusion(ctx);
        if (pair) await switchMode("fusion", ctx, pair);
        return;
      }
      if (!value) {
        const hydraSuffix = activeHydra() ? ` (active: ${activeHydra()})` : "";
        const selected = await ctx.ui.select("Behavior mode", [
          ...MODES.map(mode => `${mode} — ${labels[mode]}`),
          `hydra — Hydra stats router${hydraSuffix}`,
        ]);
        if (!selected) return;
        value = selected.split(" — ")[0];
        if (value === "hydra") {
          await handleHydraCommand([], ctx);
          return;
        }
      }
      if (!isMode(value)) { ctx.ui.notify("Usage: /mode [pi|apex|apex-orchestrate|fusion|work|hydra|configure]", "warning"); return; }
      await switchMode(value, ctx);
    },
  });
  pi.registerCommand("jippity", {
    description: "Hydra routing restricted to OpenAI (ChatGPT) models: /jippity [on|off]",
    handler: async (args, ctx) => {
      if (!idle(ctx)) return;
      const value = args.trim().toLowerCase();
      if (!["", "toggle", "on", "off"].includes(value)) { ctx.ui.notify("Usage: /jippity [on|off]", "warning"); return; }
      const enable = value === "on" || ((value === "" || value === "toggle") && state.hydraScope !== "openai");
      try {
        readPreferences(preferencePath);
      } catch (prefsError) {
        ctx.ui.notify(`Mode preferences unreadable (${prefsError instanceof Error ? prefsError.message : String(prefsError)}); switch aborted before any change.`, "error");
        return;
      }
      let activationPrev: { hydra: HydraTier | undefined; hydraScope: HydraScope | undefined } | undefined;
      if (enable) {
        const tier = activeHydra() ?? "high";
        // Reject activation when the OpenAI pool is empty: enabling first and
        // keeping the current model would silently run out of scope.
        const prevHydra = state.hydra;
        const prevScope = state.hydraScope;
        activationPrev = { hydra: prevHydra, hydraScope: prevScope };
        state.hydra = tier;
        state.hydraScope = "openai";
        const ranked = rankForCurrentScope(ctx, tier, undefined, false);
        if (ranked.length === 0) {
          state.hydra = prevHydra;
          if (prevScope) state.hydraScope = prevScope;
          else delete state.hydraScope;
          ctx.ui.notify("Jippity unavailable: no OpenAI model is available to Hydra (check ChatGPT sign-in, quota, or open circuits). Scope not enabled; current routing unchanged.", "error");
          return;
        }
      } else {
        delete state.hydraScope;
      }
      persist();
      announce();
      publishPair(ctx);
      const tier = activeHydra();
      const picked = tier ? await routeWithHydra(ctx, tier, undefined, true) : undefined;
      if (enable && !picked && activationPrev) {
        // Routing failed and rolled the model/pair back: undo the scope
        // activation too, so status, env, and preferences never advertise
        // OpenAI-only routing while an out-of-scope model serves.
        state.hydra = activationPrev.hydra;
        if (activationPrev.hydraScope) state.hydraScope = activationPrev.hydraScope;
        else delete state.hydraScope;
        persist();
        announce();
        publishPair(ctx);
        ctx.ui.notify("Jippity activation failed; scope not enabled and previous routing restored. See the Hydra routing error above.", "error");
        return;
      }
      const label = enable ? `Jippity: Hydra ${tier} on OpenAI models only.` : `Jippity off: Hydra ${tier ?? "off"} across all subscriptions.`;
      ctx.ui.notify(`${label}${picked ? ` Selected ${picked.summary}.` : tier ? " No matching OpenAI model available; keeping active model." : ""}`, "info");
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
  pi.on("session_start", async (event, ctx) => {
    preferences = readPreferences(preferencePath);
    recoveryBlocked = false;
    lastTurnAt = 0;
    lastJevTurnSignal = undefined;
    jevRoutedThisTurn = false;
    const entries = ctx.sessionManager.getBranch();
    const fresh = event.reason === "new" || (event.reason === "startup" && !entries.some(entry => entry.type === "message"));
    state = synchronizeFusionModel(restoreMode(entries, preferences, fresh));
    const cliModelOverride = event.reason === "startup" && !usesPersistentSidekick(state.mode) && hasCliFlag(process.argv, "--model") && Boolean(ctx.model);
    const cliThinkingOverride = event.reason === "startup" && !usesPersistentSidekick(state.mode) && hasCliFlag(process.argv, "--thinking");
    if (cliModelOverride && ctx.model) {
      const thinking = cliThinkingOverride ? pi.getThinkingLevel() : (state.models[state.mode]?.thinking ?? pi.getThinkingLevel());
      state.models[state.mode] = { provider: ctx.model.provider, modelId: ctx.model.id, thinking };
    } else if (cliThinkingOverride && state.models[state.mode]) {
      state.models[state.mode]!.thinking = pi.getThinkingLevel();
    }
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
    if (cliModelOverride || cliThinkingOverride) persist();
    else pi.appendEntry("behavior-mode", structuredClone(state));
    if (ctx.hasUI) ctx.ui.setStatus("mode", labels[state.mode]);
    publishPair(ctx);
    const startupHydra = activeHydra();
    if (startupHydra && !cliModelOverride) {
      // Refresh stale AA or quota snapshots opportunistically in the background without blocking startup.
      const aaSnap = readAaCatalog();
      if (Date.now() - aaSnap.updatedAt > AA_STALE_MS) {
        syncAaCatalog().catch(() => undefined);
      }
      const qSnap = readQuotaSnapshot();
      if (Date.now() - qSnap.updatedAt > QUOTA_STALE_MS) {
        syncQuotaSnapshot().catch(() => undefined);
      }
      if (fresh || !isSessionCacheWarm(ctx)) {
        await routeWithHydra(ctx, startupHydra, undefined, true);
      }
    }
  });
  pi.events.on?.("pi:jev:turn-signal", (payload: unknown) => {
    const tier = activeHydra();
    if (!tier || !payload || typeof payload !== "object") return;
    const rec = payload as HydraTurnSignalInput & {
      ctx?: ExtensionContext;
      promise?: Promise<void>;
      selectedModel?: string;
      selectedThinking?: string;
      score?: number;
      switchedModel?: boolean;
      summary?: string;
    };
    if (!rec.ctx) return;
    rec.promise = routeWithHydra(rec.ctx, tier, {
      reasoningDepth: rec.reasoningDepth,
      depthConfidence: rec.depthConfidence,
      domain: rec.domain,
      domainConfidence: rec.domainConfidence,
    }, false).then((res) => {
      lastTurnAt = Date.now();
      if (res) {
        jevRoutedThisTurn = true;
        rec.selectedModel = res.model;
        rec.selectedThinking = res.thinking;
        rec.score = res.score;
        rec.switchedModel = res.switchedModel;
        rec.summary = res.summary;
        try {
          rec.ctx?.ui?.notify?.(
            `Jev Hydra (${tier}): ${res.model} (${res.thinking}) · depth ${rec.reasoningDepth.toFixed(1)} ${rec.domain}${typeof res.score === "number" ? ` (score ${res.score.toFixed(2)})` : ""}`,
            "info",
          );
        } catch {
          // Cosmetic notification must never interrupt turn routing.
        }
      }
    });
  });
  pi.events.on?.("pi:hydra:subagent-route", (payload: unknown) => {
    const tier = activeHydra();
    if (!tier || !payload || typeof payload !== "object") return;
    const req = payload as {
      agent?: string;
      ctx?: ExtensionContext;
      signal?: HydraTurnSignalInput;
      models?: string[];
      thinking?: string;
      scope?: string;
      scopeExhausted?: boolean;
    };
    if (!req.agent || !req.ctx) return;
    req.scope = state.hydraScope;
    const profile = subagentHydraProfile(req.agent, tier);
    const effectiveSignal: HydraTurnSignalInput = req.signal ?? (
      (req.agent === "machinist" || req.agent === "artisan") && lastJevTurnSignal
        ? lastJevTurnSignal
        : profile.signal
    );
    const ranked = rankForCurrentScope(req.ctx, profile.tier, effectiveSignal, false);
    if (ranked.length === 0) {
      // Signal exhaustion explicitly so workers fail closed under a scope
      // instead of falling back to out-of-scope static models.
      req.models = [];
      req.scopeExhausted = true;
      return;
    }
    req.models = ranked.map((r) => r.key);
    req.thinking = ranked[0]!.recommendedThinking;
    recordHydraUsage(ranked[0]!.model.provider, ranked[0]!.model.id);
  });
  pi.on("model_select", (event, ctx) => {
    if (changing || event.source === "restore") return;
    modelBlocked = false;
    const choice = { provider: event.model.provider, modelId: event.model.id, thinking: pi.getThinkingLevel() };
    state.models[state.mode] = choice;
    if (usesPersistentSidekick(state.mode) && state.fusion) state.fusion.lead = choice;
    persist();
    publishPair(ctx);
  });
  pi.on("thinking_level_select", (event, ctx) => {
    if (changing) return;
    const choice = usesPersistentSidekick(state.mode) ? state.fusion?.lead : state.models[state.mode];
    if (choice) { choice.thinking = event.level; persist(); publishPair(ctx); }
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
    await hydraRouteChain;
    const tier = activeHydra();
    if (tier && ctx && !jevRoutedThisTurn && !isSessionCacheWarm(ctx)) {
      await routeWithHydra(ctx, tier, undefined, false);
    }
    if (tier && ctx?.model) recordHydraUsage(ctx.model.provider, ctx.model.id);
    jevRoutedThisTurn = false;
    lastTurnAt = Date.now();
    const options = event.systemPromptOptions;
    if (state.mode === "apex") options.appendSystemPrompt = joinPromptAppends(options.appendSystemPrompt, regular);
    else if (state.mode === "apex-orchestrate") options.appendSystemPrompt = joinPromptAppends(options.appendSystemPrompt, orchestrate);
    else if (state.mode === "fusion") {
      if (options.customPrompt) options.customPrompt = fusionPreface + options.customPrompt;
      options.appendSystemPrompt = joinPromptAppends(options.appendSystemPrompt, options.customPrompt ? fusion : fusionPreface + fusion);
    } else if (state.mode === "work") {
      options.customPrompt = work;
      options.appendSystemPrompt = joinPromptAppends(options.appendSystemPrompt, workToolGuidance(options, pi.getActiveTools()));
    } else {
      options.customPrompt = undefined;
      options.appendSystemPrompt = joinPromptAppends(options.appendSystemPrompt, piBlock);
    }
  });
  const warned = new Set<string>();
  pi.on("context_with_system", (event, ctx) => {
    const system = getCurrentSystemMessage(event.messages);
    if (!system) return;
    const marker = ({ apex: regular, "apex-orchestrate": orchestrate, fusion, pi: piBlock, work })[state.mode].trim().split("\n")[0];
    const problem = marker && !Object.values(system.sections ?? {}).join("\n").includes(marker)
      ? `missing ${labels[state.mode]} mode block` : undefined;
    if (problem && !warned.has(problem)) {
      warned.add(problem);
      ctx.ui.notify(`Prompt delivery: ${problem}; check option-projecting providers such as claude-bridge.`, "warning");
    }
  });
  registerPresentationSwitch(pi);
}

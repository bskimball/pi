/** Task adapter over the kit Agent Catalog. Spawn policy stays in this extension. */
import { modelAttempts as catalogModelAttempts, resolveAgentThinking as catalogResolveAgentThinking, type AgentDef } from "@pi/ui-kit";

/** Opt-in single-model execution; ordinary spawns retain declared fallbacks. */
export function modelAttempts(
  def: AgentDef,
  override?: string,
  allowFallback = true,
): Array<string | undefined> {
  return catalogModelAttempts(
    allowFallback ? def : { ...def, fallbackModels: [] },
    override,
  );
}

export interface HydraSubagentResolution {
  attempts: Array<string | undefined>;
  thinking: string | undefined;
  /** Set when an active Hydra scope leaves no in-scope model; callers must fail rather than spawn. */
  error?: string;
}

/** Hydra provider scopes, duplicated per extension owner (mirrors prompt-commands' scorer). */
const HYDRA_SCOPE_PROVIDERS: Readonly<Record<string, ReadonlySet<string>>> = {
  openai: new Set(["openai", "openai-codex"]),
};

export function hydraScopeProviders(scope?: string | null): ReadonlySet<string> | undefined {
  return scope ? HYDRA_SCOPE_PROVIDERS[scope] : undefined;
}

/**
 * Scope-filter a rebind's reconstructed fallback chain (rebinds bypass the
 * Hydra resolver). No active scope returns the chain unchanged.
 */
export function scopeAttemptChain(
  attempts: Array<string | undefined>,
  agentName: string,
  scope?: string | null,
): { attempts: Array<string | undefined>; error?: string } {
  const effectiveScope = scope ?? process.env.PI_HYDRA_SCOPE;
  if (!hydraScopeProviders(effectiveScope)) return { attempts };
  const filtered = attempts.filter((m) => modelInHydraScope(m, effectiveScope));
  if (filtered.length === 0) {
    return {
      attempts: [],
      error: `Hydra scope "${effectiveScope}" has no in-scope model in the rebind chain for ${agentName}; refusing out-of-scope rebind. Run /jippity off or restore OpenAI availability.`,
    };
  }
  return { attempts: filtered };
}

/** Backwards-compatible name: rebind chains are one scope-filtered chain. */
export const scopeRebindAttempts = scopeAttemptChain;

export function modelInHydraScope(model: string | undefined, scope?: string | null): boolean {
  const allowed = hydraScopeProviders(scope ?? process.env.PI_HYDRA_SCOPE);
  if (!allowed) return true;
  if (!model) return false;
  const slash = model.indexOf("/");
  return slash > 0 && allowed.has(model.slice(0, slash));
}

/**
 * Resolve subagent model attempts and thinking level, consulting Hydra via
 * `pi:hydra:subagent-route` when Hydra is active and no explicit model override
 * was requested.
 */
export function resolveSubagentModelsAndThinking(options: {
  def: AgentDef;
  parentThinking?: string;
  modelOverride?: string;
  allowFallback?: boolean;
  ctx?: unknown;
  emitEvent?: (event: string, payload: unknown) => void;
}): HydraSubagentResolution {
  const { def, parentThinking, modelOverride, allowFallback = true, ctx, emitEvent } = options;
  const fallbackThinking = catalogResolveAgentThinking(def, parentThinking);
  const hydraTier = process.env.PI_HYDRA_TIER;
  const hydraActive = hydraTier === "standard" || hydraTier === "high" || hydraTier === "max";

  if (!modelOverride && hydraActive && emitEvent && ctx) {
    const req: {
      agent: string;
      ctx: unknown;
      models?: string[];
      fallbackModels: string[];
      thinking?: string;
      scope?: string;
      scopeExhausted?: boolean;
    } = {
      agent: def.name, ctx,
      fallbackModels: modelAttempts(def, undefined, allowFallback).filter(
        (m): m is string => typeof m === "string" && m.length > 0,
      ),
    };
    try {
      emitEvent("pi:hydra:subagent-route", req);
    } catch {
      // Fall back to static frontmatter if event listener throws.
    }
    const scope = req.scope ?? process.env.PI_HYDRA_SCOPE;
    const allowed = hydraScopeProviders(scope);
    if (allowed) {
      // Scope is exclusive: Hydra's ranked models and the agent's static
      // fallbacks are both filtered, and an empty remainder fails closed
      // instead of spawning an out-of-scope (or default) model.
      const inScope = (m: string) => modelInHydraScope(m, scope);
      const hydraModels = Array.isArray(req.models) ? req.models.filter(inScope) : [];
      const staticAttempts = req.fallbackModels.filter(inScope);
      const merged = allowFallback
        ? [...new Set([...hydraModels.slice(0, 3), ...staticAttempts])]
        : hydraModels.length > 0
          ? [hydraModels[0]!]
          : staticAttempts.slice(0, 1);
      if (merged.length === 0) {
        return {
          attempts: [],
          thinking: fallbackThinking,
          error: `Hydra scope "${scope}" has no available model for ${def.name}; refusing out-of-scope fallback. Run /jippity off or restore OpenAI availability.`,
        };
      }
      return {
        attempts: merged,
        thinking: hydraModels.length > 0 ? req.thinking ?? fallbackThinking : fallbackThinking,
      };
    }
    if (Array.isArray(req.models)) {
      const merged = allowFallback
        ? [...new Set([...req.models.slice(0, 3), ...req.fallbackModels])]
        : (req.models.length > 0 ? req.models : req.fallbackModels).slice(0, 1);
      return {
        attempts: merged,
        thinking: req.thinking ?? fallbackThinking,
        ...(merged.length === 0 ? { error: `Hydra has no healthy model for ${def.name}; restore quota or availability before retrying.` } : {}),
      };
    }
  }

  return {
    attempts: modelAttempts(def, modelOverride, allowFallback),
    thinking: fallbackThinking,
  };
}

export {
  WORK_CREW_AGENTS,
  agentParamDescription,
  apexAgentList,
  composeSpecialistSharedPrompts,
  discoverAgents,
  isApexRosterAgent,
  isFusionOnlyAgent,
  isProjectAgentFile,
  isWorkCrewAgent,
  orchestrateAgentList,
  orchestrateAgentParamDescription,
  parseAgentFile,
  piAgentParamDescription,
  readSharedFile,
  resolveAgentThinking,
  routingHint,
  stderrDiagnostic,
  stripRegularModeCarveout,
  workCrewList,
  type AgentDef,
  type SpecialistWorkerMode,
  type WorkCrewAgent,
} from "@pi/ui-kit";

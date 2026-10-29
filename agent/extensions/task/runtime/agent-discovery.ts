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
      thinking?: string;
    } = { agent: def.name, ctx };
    try {
      emitEvent("pi:hydra:subagent-route", req);
    } catch {
      // Fall back to static frontmatter if event listener throws.
    }
    if (Array.isArray(req.models) && req.models.length > 0) {
      const staticAttempts = modelAttempts(def, undefined, allowFallback).filter(
        (m): m is string => typeof m === "string" && m.length > 0,
      );
      const merged = allowFallback
        ? [...new Set([...req.models.slice(0, 3), ...staticAttempts])]
        : [req.models[0]!];
      return {
        attempts: merged.length > 0 ? merged : [undefined],
        thinking: req.thinking ?? fallbackThinking,
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

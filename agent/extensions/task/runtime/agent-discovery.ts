/** Task adapter over the kit Agent Catalog. Spawn policy stays in this extension. */
import { modelAttempts as catalogModelAttempts, type AgentDef } from "@pi/ui-kit";

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

export {
  SKIN_ENV_VAR,
  activeSkinName,
  composerPromptGlyph,
  skinGlyphs,
  type SkinGlyphs,
  type SkinName,
} from "./internal/presentation/skin.ts";
export {
  WidthText,
  stripAnsi,
  TREE,
  cleanInline,
  type ToolRenderContext,
} from "./internal/presentation/ui-common.ts";
export {
  fallbackTruncateToWidth,
  fallbackVisibleWidth,
  padStartToWidth,
  safeTruncateToWidth,
  safeVisibleWidth,
} from "./internal/presentation/safe-text-layout.ts";
export { reportRenderFailure } from "./internal/presentation/tool-receipt.ts";
export {
  UI_CHROME_ENV_VAR,
  UI_CHROME_LEGACY_ENV_VAR,
  apexPresentationEnabled,
  uiChromeEnabled,
  withApexPresentation,
} from "./internal/presentation/presentation.ts";
export { installSharedPresentation, installSharedTools, resetUiKitInstallForTests } from "./install.ts";
export {
  OBSERVATORY_MAX_LINES,
  buildObservatory,
  expandFeatured,
  inventoryAt,
  inventorySelectorOptions,
  inventorySelectorTitle,
  isConversationBlank,
  listInventory,
  renderObservatory,
  resolveSelectorChoice,
  selectorOptions,
  selectorTitle,
  specialistLaunchDraft,
  type FeaturedEntry,
  type Observatory,
} from "./observatory/observatory.ts";
export { createObservatoryOrb, type ObservatoryOrbResult } from "./observatory/observatory-orb.ts";
export {
  registerObservatoryLanding,
  type ObservatoryLanding,
  type LandingBlock,
} from "./observatory/landing.ts";
export {
  classicObservatoryLanding,
  registerClassicObservatoryLanding,
} from "./observatory/classic-landing.ts";
export { starFieldRow } from "./observatory/star-field.ts";
export { TRUECOLOR, pixelRows } from "./observatory/pixel-art.ts";
export { runFeaturedExtensionCommand } from "./internal/runtime/featured-commands.ts";
export { installBuiltinReceipts } from "./internal/presentation/builtin-receipts.ts";
export { intercomMessageLines, parseIntercomMessage } from "./internal/presentation/intercom-receipt.ts";
export { noticeLines, type NoticeRow } from "./internal/presentation/notice-view.ts";
export { buildTodoList, renderTodoList } from "./internal/todo/todo-view.ts";
export { installUiHost, type UiHostOptions } from "./host.ts";
export {
  WORK_CREW_AGENTS,
  agentParamDescription,
  apexAgentList,
  composeSpecialistSharedPrompts,
  discoverAgents,
  isProjectAgentFile,
  isWorkCrewAgent,
  modelAttempts,
  parseAgentFile,
  piAgentParamDescription,
  readSharedFile,
  resolveAgentThinking,
  routingHint,
  stderrDiagnostic,
  workCrewList,
  type AgentDef,
  type SpecialistWorkerMode,
  type WorkCrewAgent,
} from "./internal/runtime/agent-discovery.ts";

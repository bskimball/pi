import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installUiHost } from "@pi/ui-kit";
import { registerClaudeLanding } from "./landing.ts";
import { buildWorkingIndicator } from "./working.ts";

export {
  CLAUDE_INDICATOR_FRAME_COUNT,
  CLAUDE_WORKING_INTERVAL_MS,
  CLAUDE_WORKING_MESSAGES,
  CLAUDE_WORKING_MOTIFS,
  CLAUDE_WORKING_WEIGHTS,
  buildWorkingIndicator,
  claudeWorkingTonesFor,
} from "./working.ts";

export default function (pi: ExtensionAPI) {
  registerClaudeLanding();
  installUiHost(pi, {
    skin: "claude",
    thinkingLabel: "\u00b7 thinking",
    buildWorkingIndicator,
  });
}

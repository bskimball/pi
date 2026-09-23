import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installUiHost } from "@pi/ui-kit";
import { registerApexLanding } from "./landing.ts";
import { buildFooter } from "./footer.ts";
import { buildWorkingIndicator } from "./working.ts";

export {
  RANDOM_INDICATOR_FRAME_COUNT,
  RANDOM_INDICATOR_INTERVAL_MS,
  WORKING_MESSAGES,
  buildWorkingIndicator,
  resolveWorkingLeadTone,
} from "./working.ts";

export default function (pi: ExtensionAPI) {
  registerApexLanding();
  installUiHost(pi, {
    skin: "apex",
    thinkingLabel: "\u00b7 thinking",
    buildWorkingIndicator,
    buildFooter,
  });
}

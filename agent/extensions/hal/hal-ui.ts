import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installUiHost } from "@pi/ui-kit";
import { registerHalLanding } from "./landing.ts";
import { buildWorkingIndicator } from "./working.ts";

export {
  HAL_DEFAULT_CANDIDATE,
  HAL_INDICATOR_CANDIDATES,
  HAL_WORKING_MESSAGES,
  buildWorkingIndicator,
} from "./working.ts";

export default function (pi: ExtensionAPI) {
  registerHalLanding();
  installUiHost(pi, {
    skin: "hal",
    thinkingLabel: "\u00b7 thinking",
    buildWorkingIndicator,
  });
}

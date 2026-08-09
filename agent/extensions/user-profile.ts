// Inject optional private user context from the global Pi agent directory.
// The profile file is intentionally local-only and ignored by the shared config.

import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { loadUserProfile } from "./lib/user-profile.ts";

export default function (pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event) => {
    const profile = loadUserProfile(getAgentDir());
    if (!profile) return undefined;

    return {
      systemPrompt: `${event.systemPrompt}\n\n# Private user context\n\n${profile}`,
    };
  });
}

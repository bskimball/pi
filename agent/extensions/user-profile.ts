// Inject optional private user context from the global Pi agent directory.
// The profile file is intentionally local-only and ignored by the shared config.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

export const USER_PROFILE_FILE = "USER_PROFILE.local.md";
export const MAX_USER_PROFILE_CHARS = 8_000;

export function loadUserProfile(agentDir: string): string | undefined {
  try {
    const profile = readFileSync(join(agentDir, USER_PROFILE_FILE), "utf8").trim();
    return profile ? profile.slice(0, MAX_USER_PROFILE_CHARS) : undefined;
  } catch {
    return undefined;
  }
}

export default function (pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event) => {
    const profile = loadUserProfile(getAgentDir());
    if (!profile) return undefined;

    return {
      systemPrompt: `${event.systemPrompt}\n\n# Private user context\n\n${profile}`,
    };
  });
}

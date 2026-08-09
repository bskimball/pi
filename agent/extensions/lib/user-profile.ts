import { readFileSync } from "node:fs";
import { join } from "node:path";

export const USER_PROFILE_FILE = "USER_PROFILE.local.md";
export const MAX_USER_PROFILE_CHARS = 8_000;

export function loadUserProfile(agentDir: string): string | undefined {
  try {
    const profile = readFileSync(join(agentDir, USER_PROFILE_FILE), "utf8").trim();
    if (!profile) return undefined;
    return profile.slice(0, MAX_USER_PROFILE_CHARS);
  } catch {
    return undefined;
  }
}

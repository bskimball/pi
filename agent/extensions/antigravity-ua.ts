// antigravity-ua: pin the Antigravity client fingerprint for npm:pi-antigravity.
//
// pi-antigravity 0.10.0 sends `antigravity/cli/1.2.4` by default, and
// Cloud Code Assist hides newer models (gemini-4-argon-*) from clients that
// old. A single refresh with the stale header persists an Argon-less catalog
// to models-store.json, so the override must hold for every Pi launch path
// (desktop launchers, GooeyPi, task children), not only interactive bash.
// The provider reads ANTIGRAVITY_USER_AGENT per request, so setting it while
// extensions load covers the first catalog refresh.
//
// Bump this when `agy --version` moves; drop it once the package default is
// current. An explicit ANTIGRAVITY_USER_AGENT in the environment still wins.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ANTIGRAVITY_CLI_USER_AGENT =
  "antigravity/cli/1.4.0 (aidev_client; os_type=linux; arch=amd64; cl=1000494485; auth_method=consumer)";

export default function (_pi: ExtensionAPI): void {
  process.env.ANTIGRAVITY_USER_AGENT ||= ANTIGRAVITY_CLI_USER_AGENT;
}

// antigravity-ua: pin the Antigravity client fingerprint for npm:pi-antigravity.
//
// pi-antigravity 0.12.0 still sends `antigravity/cli/1.4.0`. Cloud Code Assist
// hides newer models from clients older than the CLI that advertises them
// (`agy` 1.5.4 lists gemini-4-carbon-*). A refresh with a stale header persists
// that gap to models-store.json, so the override must hold for every Pi launch
// path (desktop launchers, GooeyPi, task children), not only interactive bash.
// The provider reads ANTIGRAVITY_USER_AGENT per request, so setting it while
// extensions load covers the first catalog refresh.
//
// Bump the version when `agy --version` moves; drop this once the package
// default is current. An explicit ANTIGRAVITY_USER_AGENT in the environment
// still wins. The cl= value is the last fingerprint the catalog endpoint accepts.
//
// fetchAvailableModels is merged across daily, sandbox, and production. Production
// does not list gemini-4-carbon yet, and pi-antigravity 0.12.0 keeps only the last
// endpoint's recommended ids, so the merge drops Carbon. Global extensions load
// before npm packages, so rewriting that assignment here is in effect before the
// provider module evaluates. Drop the rewrite once the package unions those ids.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ANTIGRAVITY_CLI_USER_AGENT =
  "antigravity/cli/1.5.4 (aidev_client; os_type=linux; arch=amd64; cl=1000494485; auth_method=consumer)";

const LAST_WINS_SORTS =
  'agentModelSorts = data.agentModelSorts as AvailableModelsRaw["agentModelSorts"];';
const UNION_SORTS =
  'agentModelSorts = agentModelSorts ? [...agentModelSorts, ...(data.agentModelSorts as AvailableModelsRaw["agentModelSorts"])] : data.agentModelSorts as AvailableModelsRaw["agentModelSorts"];';

function unionCatalogSortsBeforeProviderLoad(): void {
  const clientPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../npm/node_modules/pi-antigravity/src/client/client.ts",
  );
  try {
    const source = readFileSync(clientPath, "utf8");
    if (!source.includes(LAST_WINS_SORTS)) return;
    writeFileSync(clientPath, source.replaceAll(LAST_WINS_SORTS, UNION_SORTS));
  } catch {
    // Installed package missing or unreadable. Catalog discovery still uses whatever is installed.
  }
}

unionCatalogSortsBeforeProviderLoad();

export default function (_pi: ExtensionAPI): void {
  process.env.ANTIGRAVITY_USER_AGENT ||= ANTIGRAVITY_CLI_USER_AGENT;
}

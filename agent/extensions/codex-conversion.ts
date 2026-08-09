// Local Codex conversion entry: install Apex Codex presentation on this
// extension's ExtensionAPI, then boot @howaboua/pi-codex-conversion on the
// same instance so registerTool wraps its structured tools with stable Apex
// renderers.
//
// Pi gives each extension its own ExtensionAPI/tool map, so the presentation
// patch and the package factory must share this file's `pi` (same pattern as
// agent/extensions/mcp-adapter.ts). Loading the package here — instead of via
// settings.json `packages` — is what makes the shared instance possible, so
// the `packages` entry stays removed to prevent double registration.
//
// The package is pinned in agent/npm/package.json and installed under
// agent/npm/node_modules, which is not on Node's walk-up path from this file;
// import the pinned dist entry by relative path (the same file Pi's package
// loader imports for the `packages` entry). A bare specifier fails to resolve
// under Pi's jiti loader from agent/extensions.
//
// Presentation is imported from apex/lib (not apex-ui.ts) so this entry does
// not load apex-ui's default-export side-effect graph.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import codexConversion from "../npm/node_modules/@howaboua/pi-codex-conversion/dist/index.js";
import { installCodexPresentation } from "./apex/lib/codex-presentation.ts";

export default async function codexConversionExtension(
  pi: ExtensionAPI,
): Promise<void> {
  installCodexPresentation(pi);
  await codexConversion(pi);
}

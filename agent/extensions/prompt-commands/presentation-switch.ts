import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readPreferences, savePreferences, type UiPresentation } from "./mode-state.ts";

const UI_CHROME_ENV_VAR = "PI_UI_CHROME";
const UI_CHROME_LEGACY_ENV_VAR = "PI_APEX_UI";
const SKIN_ENV_VAR = "PI_UI_SKIN";

export const uiLabels = { pi: "Default Pi", apex: "Apex", claude: "Claude", hal: "HAL" } as const;
export type UiName = keyof typeof uiLabels;

const UI_EXTENSION_DIR: Record<Exclude<UiName, "pi">, string> = {
  apex: "apex",
  claude: "claude",
  hal: "hal",
};

export function uiExtensionInstalled(ui: Exclude<UiName, "pi">): boolean {
  return fs.existsSync(join(dirname(fileURLToPath(import.meta.url)), "..", UI_EXTENSION_DIR[ui]));
}

export function availableUis(): UiName[] {
  const names: UiName[] = ["pi"];
  for (const name of ["apex", "claude", "hal"] as const) {
    if (uiExtensionInstalled(name)) names.push(name);
  }
  return names;
}

export function applyUiEnv(ui: UiName): void {
  const on = ui === "pi" ? "0" : "1";
  process.env[UI_CHROME_ENV_VAR] = on;
  process.env[UI_CHROME_LEGACY_ENV_VAR] = on;
  process.env[SKIN_ENV_VAR] = ui === "pi" ? "apex" : ui;
}

export function resolveInstalledUi(saved: UiPresentation): UiName {
  return saved !== "pi" && !uiExtensionInstalled(saved) ? "pi" : saved;
}

function idle(pi: ExtensionAPI, ctx: ExtensionContext): boolean {
  const query = { busy: !ctx.isIdle() };
  pi.events.emit("pi:modes:query-busy", query);
  if (query.busy) ctx.ui.notify("Stop active agent work before switching modes or UI.", "warning");
  return !query.busy;
}

/** Owns /ui, chrome env, and theme restore. Behavior-mode handshake stays in modes.ts. */
export function registerPresentationSwitch(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT === "1") return;
  const preferencePath = join(getAgentDir(), "mode-settings.json");

  pi.registerCommand("ui", {
    description: "Switch Pi, Apex, Claude, or HAL presentation, independently of behavior",
    handler: async (args, ctx) => {
      if (!idle(pi, ctx)) return;
      const installed = availableUis();
      const value = args.trim().toLowerCase() || await ctx.ui.select("Presentation", installed);
      if (!value) return;
      if (value !== "pi" && value !== "apex" && value !== "claude" && value !== "hal") {
        ctx.ui.notify(`Usage: /ui [${installed.join("|")}]`, "warning");
        return;
      }
      if (value !== "pi" && !uiExtensionInstalled(value)) {
        ctx.ui.notify(`${uiLabels[value]} UI is not installed.`, "error");
        return;
      }
      const preferences = readPreferences(preferencePath);
      const oldUi = preferences.ui;
      const oldTheme = ctx.ui.theme.name ?? preferences.themes[oldUi];
      preferences.themes[oldUi] = oldTheme;
      const result = ctx.ui.setTheme(preferences.themes[value]);
      if (!result.success) {
        ctx.ui.notify(result.error ?? "Theme unavailable", "error");
        return;
      }
      preferences.ui = value;
      applyUiEnv(value);
      pi.events.emit("pi:ui:changed", { ui: value, ctx });
      savePreferences(preferencePath, preferences);
      ctx.ui.notify(`UI: ${uiLabels[value]}`, "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const preferences = readPreferences(preferencePath);
    const activeUi = resolveInstalledUi(preferences.ui);
    applyUiEnv(activeUi);
    if (!ctx.hasUI) return;
    ctx.ui.setTheme(preferences.themes[activeUi]);
    pi.events.emit("pi:ui:changed", { ui: activeUi, ctx });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (!ctx.hasUI) return;
    const latest = readPreferences(preferencePath);
    latest.themes[latest.ui] = ctx.ui.theme.name ?? latest.themes[latest.ui];
    savePreferences(preferencePath, latest);
  });
}

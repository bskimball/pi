import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readPreferences, savePreferences, type UiPresentation } from "./mode-state.ts";
import { createTransitionController } from "./transition-controller.ts";

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

const CANONICAL_CUSTOM_THEMES: Record<Exclude<UiName, "pi">, string> = {
  apex: "apex-dark",
  claude: "claude-dark",
  hal: "hal-dark",
};

function themeForUi(preferences: ReturnType<typeof readPreferences>, ui: UiName): string {
  return ui === "pi" ? preferences.themes.pi : CANONICAL_CUSTOM_THEMES[ui];
}

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
  const lifecycle = createTransitionController();
  pi.events.on?.("pi:modes:query-busy", (payload: unknown) => {
    if (payload && typeof payload === "object" && "busy" in payload && lifecycle.busy) payload.busy = true;
  });
  applyUiEnv(resolveInstalledUi(readPreferences(preferencePath).ui));

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
      if (!idle(pi, ctx)) return;
      const token = lifecycle.begin("presentation");
      if (token === undefined) return;
      const oldTheme = ctx.ui.theme.name;
      const oldEnv = [UI_CHROME_ENV_VAR, UI_CHROME_LEGACY_ENV_VAR, SKIN_ENV_VAR].map(key => [key, process.env[key]] as const);
      let previous: ReturnType<typeof readPreferences> | undefined;
      let persisted = false;
      let applied = false;
      try {
        const preferences = readPreferences(preferencePath);
        previous = structuredClone(preferences);
        const oldUi = preferences.ui;
        preferences.themes[oldUi] = oldUi === "pi"
          ? ctx.ui.theme.name ?? preferences.themes.pi
          : CANONICAL_CUSTOM_THEMES[oldUi];
        const targetTheme = themeForUi(preferences, value);
        applied = true;
        const result = ctx.ui.setTheme(targetTheme);
        if (!result.success) {
          ctx.ui.notify(result.error ?? "Theme unavailable", "error");
          return;
        }
        preferences.themes[value] = targetTheme;
        preferences.ui = value;
        savePreferences(preferencePath, preferences);
        persisted = true;
        applyUiEnv(value);
        pi.events.emit("pi:ui:changed", { ui: value, ctx });
        lifecycle.recoveryBlocked = false;
        ctx.ui.notify(`UI: ${uiLabels[value]}`, "info");
      } catch (error) {
        const failures: string[] = [];
        if (applied && oldTheme) {
          try {
            const restored = ctx.ui.setTheme(oldTheme);
            if (!restored.success) throw new Error(restored.error ?? "Theme unavailable");
          } catch (restoreError) { failures.push(`theme restore: ${String(restoreError)}`); }
        }
        for (const [key, value] of oldEnv) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        if (persisted && previous) {
          try {
            const latest = readPreferences(preferencePath);
            latest.ui = previous.ui;
            latest.themes = previous.themes;
            savePreferences(preferencePath, latest);
          } catch (restoreError) { failures.push(`preferences restore: ${String(restoreError)}`); }
        }
        if (applied && previous) {
          try { pi.events.emit("pi:ui:changed", { ui: resolveInstalledUi(previous.ui), ctx }); }
          catch (restoreError) { failures.push(`presentation restore: ${String(restoreError)}`); }
        }
        if (failures.length) lifecycle.recoveryBlocked = failures.join("; ");
        ctx.ui.notify(`UI switch failed (${String(error)}).${failures.length ? ` Recovery incomplete: ${failures.join("; ")}. Retry /ui.` : " Previous presentation restored."}`, "error");
      } finally { lifecycle.end(token); }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const token = await lifecycle.acquire("restoring");
    try {
      const preferences = readPreferences(preferencePath);
      const activeUi = resolveInstalledUi(preferences.ui);
      const activeTheme = themeForUi(preferences, activeUi);
      if (preferences.themes[activeUi] !== activeTheme) {
        preferences.themes[activeUi] = activeTheme;
        savePreferences(preferencePath, preferences);
      }
      if (ctx.hasUI) {
        const result = ctx.ui.setTheme(activeTheme);
        if (!result.success) throw new Error(result.error ?? "Theme unavailable");
      }
      applyUiEnv(activeUi);
      if (!ctx.hasUI) return;
      pi.events.emit("pi:ui:changed", { ui: activeUi, ctx });
      lifecycle.recoveryBlocked = false;
    } catch (error) {
      lifecycle.recoveryBlocked = `UI restore failed (${String(error)}). Retry /ui.`;
      ctx.ui.notify(lifecycle.recoveryBlocked, "error");
    } finally { lifecycle.end(token); }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (!ctx.hasUI) return;
    const latest = readPreferences(preferencePath);
    latest.themes[latest.ui] = latest.ui === "pi"
      ? ctx.ui.theme.name ?? latest.themes.pi
      : CANONICAL_CUSTOM_THEMES[latest.ui];
    savePreferences(preferencePath, latest);
  });
}

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export const MODES = ["pi", "apex", "apex-orchestrate", "fusion"] as const;
export type Mode = typeof MODES[number];
export type ModelChoice = { provider: string; modelId: string; thinking: string };
export type FusionPair = { lead: ModelChoice; sidekick: ModelChoice };
export type ModeState = { mode: Mode; models: Partial<Record<Mode, ModelChoice>>; fusion?: FusionPair };
export type Preferences = ModeState & { ui: "pi" | "apex"; themes: { pi: string; apex: string } };
export const isMode = (value: unknown): value is Mode => MODES.includes(value as Mode);
export function initialPreferences(): Preferences {
  return { mode: "apex", models: {}, ui: "apex", themes: { pi: "dark", apex: "apex-dark" } };
}
export function readPreferences(path: string): Preferences {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (!isMode(data.mode) || !data.models || !["pi", "apex"].includes(data.ui)) throw new Error("Invalid mode preferences");
    return { ...initialPreferences(), ...data, themes: { ...initialPreferences().themes, ...data.themes } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return initialPreferences();
    throw error;
  }
}
export function savePreferences(path: string, prefs: Preferences): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(prefs, null, 2) + "\n");
  renameSync(temp, path);
}
export function restoreMode(entries: readonly any[], defaults: Preferences, fresh: boolean): ModeState {
  let saved: ModeState | undefined;
  let legacy = false;
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType === "orchestrate-mode") legacy = entry.data?.enabled === true;
    if (entry.customType === "behavior-mode" && isMode(entry.data?.mode)) saved = entry.data;
  }
  return structuredClone(saved ?? { mode: fresh ? defaults.mode : legacy ? "apex-orchestrate" : "apex", models: defaults.models, fusion: defaults.fusion });
}
export function toolsForMode(mode: Mode, names: string[]): string[] {
  if (mode === "pi") return names.filter(name => ["read", "bash", "edit", "write"].includes(name));
  if (mode === "fusion") return names.filter(name => !["task", "task_chain", "task_rebind", "intercom"].includes(name));
  return names;
}

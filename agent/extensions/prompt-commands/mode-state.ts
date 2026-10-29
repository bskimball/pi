import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { isHydraTier, type HydraTier } from "./hydra/scorer.ts";

export const MODES = ["pi", "apex", "apex-orchestrate", "fusion", "work"] as const;
export type Mode = typeof MODES[number];
export type ModelChoice = { provider: string; modelId: string; thinking: string };
export type FusionPair = { lead: ModelChoice; sidekick: ModelChoice };
export type ModeState = { mode: Mode; models: Partial<Record<Mode, ModelChoice>>; fusion?: FusionPair; hydra?: HydraTier };
export type UiPresentation = "pi" | "apex" | "claude" | "hal";
export type Preferences = ModeState & { ui: UiPresentation; themes: { pi: string; apex: string; claude: string; hal: string } };
export const isMode = (value: unknown): value is Mode => MODES.includes(value as Mode);
export function initialPreferences(): Preferences {
  return { mode: "apex", models: {}, ui: "apex", themes: { pi: "dark", apex: "apex-dark", claude: "claude-dark", hal: "hal-dark" } };
}
export function readPreferences(path: string): Preferences {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (!isMode(data.mode) || !data.models || !["pi", "apex", "claude", "hal"].includes(data.ui)) throw new Error("Invalid mode preferences");
    const hydra = isHydraTier(data.hydra) ? data.hydra : undefined;
    return { ...initialPreferences(), ...data, ...(hydra ? { hydra } : {}), mode: data.mode === "apex-orchestrate" ? "apex" : data.mode, themes: { ...initialPreferences().themes, ...data.themes } };
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
export function synchronizeFusionModel<T extends ModeState>(state: T): T {
  if (state.fusion) state.models.fusion = structuredClone(state.fusion.lead);
  return state;
}

export function hasCliFlag(argv: readonly string[], flag: string): boolean {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") return false;
    if (arg === flag && i + 1 < argv.length) return true;
  }
  return false;
}

export function restoreMode(entries: readonly any[], defaults: Preferences, fresh: boolean): ModeState {
  let saved: ModeState | undefined;
  let legacy = false;
  let trailingModel: { provider: string; modelId: string } | undefined;
  let trailingThinking: string | undefined;
  for (const entry of entries) {
    if (entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string") {
      trailingModel = { provider: entry.provider, modelId: entry.modelId };
      continue;
    }
    if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
      trailingThinking = entry.thinkingLevel;
      continue;
    }
    if (entry.type !== "custom") continue;
    if (entry.customType === "orchestrate-mode") legacy = entry.data?.enabled === true;
    if (entry.customType === "behavior-mode" && isMode(entry.data?.mode)) {
      saved = entry.data;
      trailingModel = undefined;
      trailingThinking = undefined;
    }
  }
  const restored = structuredClone(saved ?? { mode: fresh ? defaults.mode : legacy ? "apex-orchestrate" : "apex", models: defaults.models, fusion: defaults.fusion, ...(defaults.hydra ? { hydra: defaults.hydra } : {}) });
  if (!fresh && (trailingModel || trailingThinking)) {
    const current = restored.mode === "fusion" ? restored.fusion?.lead : restored.models[restored.mode];
    const provider = trailingModel?.provider ?? current?.provider;
    const modelId = trailingModel?.modelId ?? current?.modelId;
    const thinking = trailingThinking ?? current?.thinking ?? "medium";
    if (provider && modelId) {
      const choice: ModelChoice = { provider, modelId, thinking };
      restored.models[restored.mode] = choice;
      if (restored.mode === "fusion" && restored.fusion) restored.fusion.lead = structuredClone(choice);
    }
  }
  return restored;
}
/** Fusion-owned: persistent-sidekick modes do not expose chain/rebind. */
export function toolsForFusion(names: string[]): string[] {
  return names.filter(name => name !== "task_chain" && name !== "task_rebind");
}

/** Work-owned: no persistent sidekick, so chain/rebind stay off. Same availability as Fusion today. */
export function toolsForWork(names: string[]): string[] {
  return names.filter(name => name !== "task_chain" && name !== "task_rebind");
}

export function toolsForMode(mode: Mode, names: string[]): string[] {
  if (mode === "fusion") return toolsForFusion(names);
  if (mode === "work") return toolsForWork(names);
  return names;
}

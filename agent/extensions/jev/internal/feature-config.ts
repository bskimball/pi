// Fail-closed opt-in settings for Jev advisory features.
//
// The file is read on every call so edits take effect without module state. Missing,
// unreadable, or malformed configuration enables nothing; valid fields are retained
// independently when neighboring fields are invalid.

import { readFileSync } from "node:fs";
import { getJevConfigPath } from "./client.ts";

export interface FeatureSettings {
  enabled: boolean;
  threshold: number;
  deadlineMs: number;
}

export interface CodeJudgeSettings extends FeatureSettings {
  maxChars: number;
  evidenceBar: number;
  goodTraitBar: number;
}

export interface SkillRouterSettings extends FeatureSettings {
  minMargin: number;
  minConfidence: number;
  breadthThreshold: number;
}

export interface JevFeatureConfig {
  skillRouter: SkillRouterSettings;
  codeJudge: CodeJudgeSettings;
  routingAdvisory: FeatureSettings;
  todoEvidence: FeatureSettings;
  memoryTriage: FeatureSettings;
  oracleTrigger: FeatureSettings;
}

export const FEATURE_DEFAULTS: JevFeatureConfig = {
  skillRouter: { enabled: false, threshold: 0.55, deadlineMs: 2500, minMargin: 0.15, minConfidence: 0.6, breadthThreshold: 0.6 },
  codeJudge: { enabled: false, threshold: 0.8, deadlineMs: 2500, maxChars: 16000, evidenceBar: 0.5, goodTraitBar: 0.10 },
  routingAdvisory: { enabled: false, threshold: 0.8, deadlineMs: 2500 },
  todoEvidence: { enabled: false, threshold: 0.8, deadlineMs: 2500 },
  memoryTriage: { enabled: false, threshold: 0.8, deadlineMs: 2500 },
  oracleTrigger: { enabled: false, threshold: 0.8, deadlineMs: 2500 },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function featureSettings(value: unknown, defaults: FeatureSettings): FeatureSettings {
  const block = isRecord(value) ? value : Object.create(null) as Record<string, unknown>;
  return {
    enabled: typeof block.enabled === "boolean" ? block.enabled : defaults.enabled,
    threshold: boundedNumber(block.threshold, defaults.threshold, 0.5, 1),
    deadlineMs: boundedInteger(block.deadlineMs, defaults.deadlineMs, 250, 10_000),
  };
}

function skillRouterSettings(value: unknown, defaults: SkillRouterSettings): SkillRouterSettings {
  const block = isRecord(value) ? value : Object.create(null) as Record<string, unknown>;
  const base = featureSettings(value, defaults);
  return {
    ...base,
    minMargin: boundedNumber(block.minMargin, defaults.minMargin, 0, 1),
    minConfidence: boundedNumber(block.minConfidence, defaults.minConfidence, 0, 1),
    breadthThreshold: boundedNumber(block.breadthThreshold, defaults.breadthThreshold, 0, 1),
  };
}

function defaults(): JevFeatureConfig {
  return {
    skillRouter: { ...FEATURE_DEFAULTS.skillRouter },
    codeJudge: { ...FEATURE_DEFAULTS.codeJudge },
    routingAdvisory: { ...FEATURE_DEFAULTS.routingAdvisory },
    todoEvidence: { ...FEATURE_DEFAULTS.todoEvidence },
    memoryTriage: { ...FEATURE_DEFAULTS.memoryTriage },
    oracleTrigger: { ...FEATURE_DEFAULTS.oracleTrigger },
  };
}

export function loadFeatureConfig(): JevFeatureConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getJevConfigPath(), "utf8"));
    if (!isRecord(parsed)) return defaults();
    const codeJudge = featureSettings(parsed.codeJudge, FEATURE_DEFAULTS.codeJudge);
    const codeJudgeBlock = isRecord(parsed.codeJudge) ? parsed.codeJudge : Object.create(null) as Record<string, unknown>;
    return {
      skillRouter: skillRouterSettings(parsed.skillRouter, FEATURE_DEFAULTS.skillRouter),
      codeJudge: {
        ...codeJudge,
        maxChars: boundedInteger(codeJudgeBlock.maxChars, FEATURE_DEFAULTS.codeJudge.maxChars, 1000, 60_000),
        evidenceBar: boundedNumber(codeJudgeBlock.evidenceBar, FEATURE_DEFAULTS.codeJudge.evidenceBar, 0, 1),
        goodTraitBar: boundedNumber(codeJudgeBlock.goodTraitBar, FEATURE_DEFAULTS.codeJudge.goodTraitBar, 0, 1),
      },
      routingAdvisory: featureSettings(parsed.routingAdvisory, FEATURE_DEFAULTS.routingAdvisory),
      todoEvidence: featureSettings(parsed.todoEvidence, FEATURE_DEFAULTS.todoEvidence),
      memoryTriage: featureSettings(parsed.memoryTriage, FEATURE_DEFAULTS.memoryTriage),
      oracleTrigger: featureSettings(parsed.oracleTrigger, FEATURE_DEFAULTS.oracleTrigger),
    };
  } catch {
    return defaults();
  }
}

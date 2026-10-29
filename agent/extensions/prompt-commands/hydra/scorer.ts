// Pure stats-driven model and thinking scorer for Hydra.
//
// Combines Artificial Analysis metrics (Coding Score, Intelligence Index,
// Output Speed tok/s, Blended Price), 8317 quota / circuit-breaker health,
// Jev's per-turn task signal, and prompt-cache stickiness.

import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { matchAaMetrics, type AaModelMetrics } from "./aa-sync.ts";
import { quotaMultiplierForModel, type QuotaSnapshot } from "./quota-sync.ts";

export const HYDRA_TIERS = ["off", "standard", "high", "max"] as const;
export type HydraTier = (typeof HYDRA_TIERS)[number];
export type ActiveHydraTier = Exclude<HydraTier, "off">;

export function isHydraTier(value: unknown): value is HydraTier {
  return HYDRA_TIERS.includes(value as HydraTier);
}

export interface HydraTurnSignalInput {
  reasoningDepth: number; // 1..4
  depthConfidence: number;
  domain: "coding" | "reasoning" | "fast_edit" | "research";
  domainConfidence: number;
}

export type SubagentHydraRole = {
  tier?: ActiveHydraTier;
  signal: HydraTurnSignalInput;
};

/**
 * Default Hydra task signal and tier profile for a specialist subagent role.
 */
export function subagentHydraProfile(
  agentName: string,
  parentTier: ActiveHydraTier,
): { tier: ActiveHydraTier; signal: HydraTurnSignalInput } {
  const name = agentName.toLowerCase();
  if (name === "oracle" || name === "advisor" || name === "strategist") {
    return {
      tier: parentTier === "max" ? "max" : "high",
      signal: { reasoningDepth: 3.8, depthConfidence: 1, domain: "reasoning", domainConfidence: 1 },
    };
  }
  if (name === "artisan" || name === "machinist") {
    return {
      tier: parentTier,
      signal: {
        reasoningDepth: name === "artisan" ? 3.2 : 2.6,
        depthConfidence: 1,
        domain: "coding",
        domainConfidence: 1,
      },
    };
  }
  if (name === "librarian" || name === "researcher") {
    return {
      tier: parentTier === "max" ? "high" : "standard",
      signal: { reasoningDepth: 2.6, depthConfidence: 1, domain: "research", domainConfidence: 1 },
    };
  }
  if (name === "scribe" || name === "author") {
    return {
      tier: parentTier === "max" ? "high" : "standard",
      signal: { reasoningDepth: 2.3, depthConfidence: 1, domain: "coding", domainConfidence: 1 },
    };
  }
  // inspector, scout, stevedore, clerk, picasso, etc.: fast execution/verification
  return {
    tier: "standard",
    signal: { reasoningDepth: 1.5, depthConfidence: 1, domain: "fast_edit", domainConfidence: 1 },
  };
}


export interface RankedModelCandidate {
  model: Model<Api>;
  key: string;
  aa: AaModelMetrics;
  rawUtility: number;
  quotaMultiplier: number;
  quotaReason?: string;
  cacheBonus: number;
  finalScore: number;
  recommendedThinking: string;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export const EXCLUDED_HYDRA_PROVIDERS = new Set([
  "anthropic",
  "google",
  "google-gemini-cli",
  "github-copilot",
  "opencode",
]);

/**
 * Provider preference tie-breaker when identical underlying models are exposed
 * by multiple providers (e.g. direct/bridge vs local-proxy fallback).
 */
function providerQualityBonus(provider: string): number {
  const p = provider.toLowerCase();
  if (p === "claude-bridge" || p === "openai" || p === "antigravity" || p === "xai" || p === "meta") {
    return 0.015;
  }
  if (p === "local-proxy") return 0.01;
  return 0;
}

/**
 * Map Hydra tier + Jev reasoning depth (1..4) to a desired Pi thinking level,
 * then clamp to what the chosen model actually supports.
 */
export function selectThinkingForModel(
  model: Model<Api>,
  tier: ActiveHydraTier,
  signal?: HydraTurnSignalInput,
): string {
  const depth = signal?.reasoningDepth ?? (tier === "standard" ? 2 : tier === "high" ? 3 : 4);
  let desired: string;
  if (tier === "standard") {
    if (depth < 1.75) desired = "low";
    else if (depth < 2.85) desired = "medium";
    else desired = "high";
  } else if (tier === "high") {
    if (depth < 1.6) desired = "low";
    else if (depth < 2.5) desired = "medium";
    else if (depth < 3.4) desired = "high";
    else desired = "xhigh";
  } else {
    // max tier
    if (depth < 2.2) desired = "high";
    else if (depth < 3.4) desired = "xhigh";
    else desired = "max";
  }

  const supported = getSupportedThinkingLevels(model);
  if (supported.includes(desired as Parameters<typeof clampThinkingLevel>[1])) {
    return desired;
  }
  return clampThinkingLevel(model, desired as Parameters<typeof clampThinkingLevel>[1]);
}

/**
 * Compute normalized [0..1] AA utility for a model given the active Hydra tier
 * and optional Jev turn signal.
 */
export function computeAaUtility(
  aa: AaModelMetrics,
  tier: ActiveHydraTier,
  signal?: HydraTurnSignalInput,
): number {
  const intelNorm = clamp01(((aa.intelligenceIndex ?? 30) - 15) / 45); // 15..60 -> 0..1
  const codingNorm = clamp01(((aa.codingScore ?? 30) - 20) / 45);      // 20..65 -> 0..1
  const speedNorm = clamp01(Math.min(aa.outputSpeedTps ?? 80, 260) / 260);
  const price = aa.blendedPricePer1m ?? 2.5;
  const costEfficiency = clamp01(1 - Math.min(price, 10) / 10);

  const domain = signal?.domain ?? "coding";
  const depth = signal?.reasoningDepth ?? (tier === "standard" ? 2 : tier === "high" ? 3 : 4);

  // When Jev provides a concrete turn signal, weight speed & cost-efficiency
  // higher on routine/fast turns so Hydra selects nimble workhorse models
  // (e.g. Sonnet 5.5, GPT-6.1 Sol/Terra, Haiku 5.5) instead of locking onto
  // heavy frontier models for every turn.
  if (signal) {
    if (domain === "fast_edit" || depth < 1.8) {
      return tier === "max"
        ? 0.35 * codingNorm + 0.25 * intelNorm + 0.30 * speedNorm + 0.10 * costEfficiency
        : 0.25 * codingNorm + 0.45 * speedNorm + 0.30 * costEfficiency;
    }
    if (depth < 2.75 && domain !== "reasoning") {
      return tier === "max"
        ? 0.45 * codingNorm + 0.30 * intelNorm + 0.18 * speedNorm + 0.07 * costEfficiency
        : 0.40 * codingNorm + 0.15 * intelNorm + 0.28 * speedNorm + 0.17 * costEfficiency;
    }
  }

  if (tier === "standard") {
    if (domain === "fast_edit" || depth < 1.7) {
      return 0.35 * codingNorm + 0.40 * speedNorm + 0.25 * costEfficiency;
    }
    return 0.45 * codingNorm + 0.20 * intelNorm + 0.20 * speedNorm + 0.15 * costEfficiency;
  }

  if (tier === "high") {
    if (domain === "reasoning" || depth >= 3.3) {
      return 0.45 * codingNorm + 0.40 * intelNorm + 0.10 * speedNorm + 0.05 * costEfficiency;
    }
    return 0.55 * codingNorm + 0.25 * intelNorm + 0.12 * speedNorm + 0.08 * costEfficiency;
  }

  // max tier: frontier intelligence & coding dominate
  if (domain === "reasoning") {
    return 0.60 * intelNorm + 0.35 * codingNorm + 0.05 * speedNorm;
  }
  return 0.45 * intelNorm + 0.50 * codingNorm + 0.05 * speedNorm;
}

export interface RankModelsOptions {
  models: readonly Model<Api>[];
  scopedKeys?: ReadonlySet<string>;
  catalog: readonly AaModelMetrics[];
  quota: QuotaSnapshot;
  openCircuits: ReadonlySet<string>;
  tier: ActiveHydraTier;
  signal?: HydraTurnSignalInput;
  currentModelKey?: string;
  cacheWarm?: boolean;
}

/**
 * Rank available Pi models by AA stats, quota health, and cache stickiness.
 */
export function rankModelsForHydra(options: RankModelsOptions): RankedModelCandidate[] {
  const {
    models,
    scopedKeys,
    catalog,
    quota,
    openCircuits,
    tier,
    signal,
    currentModelKey,
    cacheWarm = false,
  } = options;

  // Filter out API-priced/excluded providers first, then prefer user's scoped models when non-empty.
  const allowedModels = models.filter((m) => !EXCLUDED_HYDRA_PROVIDERS.has(m.provider.toLowerCase()));
  const pool =
    scopedKeys && scopedKeys.size > 0
      ? allowedModels.filter((m) => scopedKeys.has(`${m.provider}/${m.id}`))
      : allowedModels;
  const effectivePool = pool.length > 0 ? pool : allowedModels;

  const candidates: RankedModelCandidate[] = [];
  for (const model of effectivePool) {
    const key = `${model.provider}/${model.id}`;
    const aa = matchAaMetrics(model.id, catalog);
    if (!aa) continue;

    const { multiplier: quotaMultiplier, reason: quotaReason } = quotaMultiplierForModel(
      model.provider,
      model.id,
      tier,
      openCircuits,
      quota,
    );
    if (quotaMultiplier <= 0) continue;

    const rawUtility = computeAaUtility(aa, tier, signal) + providerQualityBonus(model.provider);
    // Cache stickiness bonus: when the session transcript already has warm tokens on
    // `currentModelKey`, add a stickiness margin when no explicit Jev signal is present
    // (or a lighter tie-breaker when Jev classified the turn) so Hydra switches models
    // when Jev detects a meaningful shift in task depth/domain while avoiding churn on ties.
    const isCurrent = currentModelKey !== undefined && key === currentModelKey;
    const cacheBonus = isCurrent && cacheWarm ? (signal ? 0.025 : 0.14) : 0;
    const finalScore = Number((rawUtility * quotaMultiplier + cacheBonus).toFixed(4));

    candidates.push({
      model,
      key,
      aa,
      rawUtility: Number(rawUtility.toFixed(4)),
      quotaMultiplier,
      quotaReason,
      cacheBonus,
      finalScore,
      recommendedThinking: selectThinkingForModel(model, tier, signal),
    });
  }

  candidates.sort((a, b) => b.finalScore - a.finalScore || a.key.localeCompare(b.key));
  return candidates;
}

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

function effectiveSignalDepth(
  tier: ActiveHydraTier,
  signal?: HydraTurnSignalInput,
): number {
  if (!signal) {
    return tier === "standard" ? 2.2 : tier === "high" ? 3.1 : 3.8;
  }
  const raw = signal.reasoningDepth;
  if (signal.domain === "coding") {
    return Math.max(signal.depthConfidence < 0.65 ? 2.2 : 2.0, raw);
  }
  if (signal.domain === "reasoning") {
    return Math.max(2.8, raw);
  }
  return raw;
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
  const depth = effectiveSignalDepth(tier, signal);
  const domain = signal?.domain ?? "coding";
  let desired: string;
  if (tier === "standard") {
    if (domain === "fast_edit" && depth < 1.8) desired = "low";
    else if (depth < 2.85) desired = "medium";
    else desired = "high";
  } else if (tier === "high") {
    if (domain === "fast_edit" && depth < 1.8) desired = "low";
    else if (depth < 2.65) desired = "medium";
    else if (depth < 3.45) desired = "high";
    else desired = "xhigh";
  } else {
    // max tier
    if (domain === "fast_edit" && depth < 1.8) desired = "medium";
    else if (depth < 2.5) desired = "high";
    else if (depth < 3.45) desired = "xhigh";
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
  const costEfficiency = clamp01(1 - Math.min(price, 3.0) / 3.0);

  const domain = signal?.domain ?? "coding";
  const depth = effectiveSignalDepth(tier, signal);

  let utility: number;
  if (domain === "fast_edit" && depth < 1.8) {
    // Trivial mechanical edits / quick commands: favor high-throughput, low-cost models (Haiku 5.5, Flash, Terra).
    utility = tier === "max"
      ? 0.35 * codingNorm + 0.25 * intelNorm + 0.30 * speedNorm + 0.10 * costEfficiency
      : 0.25 * codingNorm + 0.45 * speedNorm + 0.30 * costEfficiency;
  } else if (depth < 2.85 && domain !== "reasoning" && tier !== "max") {
    // Mid-difficulty coding / research (Level 2): favor strong mid-tier coding + fast throughput (Sonnet 5.5, GPT-6.1 Sol/Terra).
    utility = 0.42 * codingNorm + 0.13 * intelNorm + 0.20 * speedNorm + 0.25 * costEfficiency;
  } else if (tier !== "max" && (domain === "reasoning" || depth >= 2.85)) {
    // Complex multi-file coding or reasoning (Level 3+): frontier intelligence & coding dominate (Opus 5.5, Carbon, Astra).
    utility = 0.50 * codingNorm + 0.40 * intelNorm + 0.06 * speedNorm + 0.04 * costEfficiency;
  } else if (tier === "max") {
    utility = domain === "reasoning"
      ? 0.60 * intelNorm + 0.35 * codingNorm + 0.05 * speedNorm
      : 0.45 * intelNorm + 0.50 * codingNorm + 0.05 * speedNorm;
  } else {
    utility = 0.55 * codingNorm + 0.25 * intelNorm + 0.12 * speedNorm + 0.08 * costEfficiency;
  }

  // Capability floor: lightweight models (codingScore < 48, e.g. Haiku, Flash, Luna) must not
  // outrank mid/frontier coding models on coding or reasoning tasks solely due to speed/price.
  if ((domain === "coding" || domain === "reasoning") && (aa.codingScore ?? 0) < 48) {
    utility *= 0.55;
  }

  return utility;
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

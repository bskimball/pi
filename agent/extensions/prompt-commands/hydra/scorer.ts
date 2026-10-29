// Pure stats-driven model and thinking scorer for Hydra.
//
// Combines Artificial Analysis metrics (Coding Score, Intelligence Index,
// Output Speed tok/s), subscription capacity and recent usage balance,
// 8317 quota / circuit-breaker health, Jev's per-turn task signal, and
// prompt-cache stickiness. API list price is ignored: routed providers are
// flat-rate subscriptions, so capacity, not per-token cost, is the constraint.

import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { matchAaMetrics, type AaModelMetrics } from "./aa-sync.ts";
import { inferModelFamily, quotaMultiplierForModel, quotaRemainingForModel, type QuotaSnapshot } from "./quota-sync.ts";

export const HYDRA_TIERS = ["off", "standard", "high", "max"] as const;
export type HydraTier = (typeof HYDRA_TIERS)[number];
export type ActiveHydraTier = Exclude<HydraTier, "off">;

export function isHydraTier(value: unknown): value is HydraTier {
  return HYDRA_TIERS.includes(value as HydraTier);
}

/** Optional Hydra pool restriction to one subscription's providers (`/jippity` = OpenAI only). */
export const HYDRA_SCOPE_PROVIDERS = {
  openai: new Set(["openai", "openai-codex"]),
} as const satisfies Record<string, ReadonlySet<string>>;
export type HydraScope = keyof typeof HYDRA_SCOPE_PROVIDERS;

export function isHydraScope(value: unknown): value is HydraScope {
  return typeof value === "string" && Object.hasOwn(HYDRA_SCOPE_PROVIDERS, value);
}

export interface HydraTurnSignalInput {
  reasoningDepth: number; // 1..4
  depthConfidence: number;
  domain: HydraDomain;
  domainConfidence: number;
}

export type HydraDomain = "coding" | "reasoning" | "fast_edit" | "research" | "writing" | "conversation";

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
      signal: { reasoningDepth: 2.3, depthConfidence: 1, domain: "writing", domainConfidence: 1 },
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

/**
 * Relative subscription capacity per model family (1 = largest plan).
 * Unlisted families are pay-per-use or minor plans.
 */
export const SUBSCRIPTION_CAPACITY: Readonly<Record<string, number>> = {
  google: 1,
  openai: 1,
  meta: 1,
  anthropic: 0.5,
  xai: 0.5,
};
const DEFAULT_SUBSCRIPTION_CAPACITY = 0.25;
const CAPACITY_BONUS = 0.04;
/** Under-used families are only promoted when within this fraction of the task's best score. */
const BALANCE_QUALITY_GATE = 0.85;
/** General tiebreak tilt toward the fastest, cheapest, most-quota model — applied only inside the quality band. */
const QUOTA_HEADROOM_WEIGHT = 0.08;
const SPEED_TILT_WEIGHT = 0.04;
const COST_TILT_WEIGHT = 0.03;
/** Relaxed gate for a family starved below a quarter of its capacity share, so every healthy subscription gets some suitable work. */
const STARVED_QUALITY_GATE = 0.6;
const STARVED_SHARE_FRACTION = 0.25;

/**
 * Hands-on preferences that AA benchmarks do not capture, added to task utility
 * per domain and model family (e.g. Gemini for creative work, Muse Wonder's
 * conversational feel).
 */
export const DOMAIN_AFFINITY: Partial<Record<HydraDomain, Readonly<Record<string, number>>>> = {
  writing: { google: 0.18 },
  conversation: { meta: 0.05 },
};

/** Routed turns required in the usage window before balancing applies. */
export const MIN_USAGE_SAMPLE = 20;
const BALANCE_EXPONENT = 0.5;
const MIN_BALANCE = 0.6;
const MAX_BALANCE = 1.5;

export function subscriptionCapacity(family: string): number {
  return SUBSCRIPTION_CAPACITY[family] ?? DEFAULT_SUBSCRIPTION_CAPACITY;
}

/**
 * Proportional multiplier on [0.6..1.5]: (target share / actual share)^0.5.
 * A family used below its capacity share keeps gaining priority until it
 * catches up, so large subscriptions are not starved by small quality gaps.
 */
export function usageBalanceMultiplier(
  family: string,
  usage: Readonly<Record<string, number>> | undefined,
  poolFamilies: ReadonlySet<string>,
): number {
  if (!usage) return 1;
  const total = Object.values(usage).reduce((sum, n) => sum + n, 0);
  if (total < MIN_USAGE_SAMPLE) return 1;
  let capacitySum = 0;
  for (const f of poolFamilies) capacitySum += subscriptionCapacity(f);
  if (capacitySum <= 0) return 1;
  const target = subscriptionCapacity(family) / capacitySum;
  const share = (usage[family] ?? 0) / total;
  if (share <= 0) return MAX_BALANCE;
  return Math.max(MIN_BALANCE, Math.min(MAX_BALANCE, (target / share) ** BALANCE_EXPONENT));
}

function isStarved(
  family: string,
  usage: Readonly<Record<string, number>> | undefined,
  poolFamilies: ReadonlySet<string>,
): boolean {
  if (!usage) return false;
  const total = Object.values(usage).reduce((sum, n) => sum + n, 0);
  if (total < MIN_USAGE_SAMPLE) return false;
  let capacitySum = 0;
  for (const f of poolFamilies) capacitySum += subscriptionCapacity(f);
  const target = subscriptionCapacity(family) / capacitySum;
  return (usage[family] ?? 0) / total < target * STARVED_SHARE_FRACTION;
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
    return Math.max(2.85, raw);
  }
  if (signal.domain === "research" && signal.domainConfidence < 0.55) {
    return Math.max(2.2, raw);
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
  const isFastLookup = isShallowTurn(signal?.domain ?? "coding", depth);
  let desired: string;
  if (tier === "standard") {
    if (isFastLookup) desired = "low";
    else if (depth < 2.85) desired = "medium";
    else desired = "high";
  } else if (tier === "high") {
    if (isFastLookup) desired = "low";
    else if (depth < 2.65) desired = "medium";
    else if (depth < 3.45) desired = "high";
    else desired = "xhigh";
  } else {
    // max tier
    if (isFastLookup) desired = "medium";
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

function isShallowTurn(domain: HydraDomain, depth: number): boolean {
  return (domain === "fast_edit" || domain === "research" || domain === "conversation") && depth < 1.75;
}

/** Normalized [0..1] AA measurements a domain profile can weight. */
type Metric =
  | "code"
  | "intel"
  | "speed"
  | "factual"
  | "work"
  | "presentation"
  | "creativeBuild"
  | "expressiveness"
  | "organization"
  | "informativeness"
  | "transparency"
  | "warmth"
  | "imagination"
  | "lowSlop";
type Weights = Partial<Record<Metric, number>>;

/**
 * Per-domain AA profiles. `workhorse` applies at Level 2 depth and blends into
 * `frontier` by Level 3, so deeper turns lean on raw capability.
 */
const DOMAIN_PROFILES: Record<Exclude<HydraDomain, "fast_edit">, { workhorse: Weights; frontier: Weights }> = {
  coding: {
    workhorse: { code: 0.45, intel: 0.15, speed: 0.25, factual: 0.10, transparency: 0.05 },
    frontier: { code: 0.55, intel: 0.33, factual: 0.07, speed: 0.05 },
  },
  reasoning: {
    workhorse: { intel: 0.40, code: 0.20, factual: 0.25, transparency: 0.15 },
    frontier: { intel: 0.45, code: 0.20, factual: 0.25, transparency: 0.10 },
  },
  research: {
    workhorse: { factual: 0.30, intel: 0.20, informativeness: 0.15, work: 0.15, speed: 0.20 },
    frontier: { factual: 0.30, intel: 0.35, work: 0.20, informativeness: 0.15 },
  },
  writing: {
    workhorse: { imagination: 0.20, expressiveness: 0.20, creativeBuild: 0.15, presentation: 0.15, lowSlop: 0.10, intel: 0.20 },
    frontier: { imagination: 0.20, expressiveness: 0.15, creativeBuild: 0.15, presentation: 0.15, lowSlop: 0.05, intel: 0.30 },
  },
  conversation: {
    workhorse: { warmth: 0.20, organization: 0.15, informativeness: 0.15, transparency: 0.15, lowSlop: 0.10, intel: 0.15, speed: 0.10 },
    frontier: { warmth: 0.15, organization: 0.15, informativeness: 0.15, transparency: 0.15, lowSlop: 0.05, intel: 0.35 },
  },
};
const FAST_PROFILE: Weights = { speed: 0.60, code: 0.25, intel: 0.15 };
const FAST_PROFILE_MAX: Weights = { speed: 0.35, code: 0.35, intel: 0.30 };
/** Score assumed for a measurement AA has not published for a model: slightly below neutral. */
const UNMEASURED = 0.45;

/** Catalog-wide min/max for AA Elo-style measurements that have no fixed scale. */
export type AaMetricRanges = Partial<Record<"work" | "presentation" | "creativeBuild", { min: number; max: number }>>;

function creativeBuildElo(aa: AaModelMetrics): number | null {
  const values = [aa.aa3dElo, aa.code2videoElo].filter((v): v is number => typeof v === "number");
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
}

function rawRangeValue(aa: AaModelMetrics, key: keyof AaMetricRanges): number | null {
  if (key === "work") return aa.gdpvalElo ?? null;
  if (key === "presentation") return aa.presentationElo ?? null;
  return creativeBuildElo(aa);
}

export function computeMetricRanges(catalog: readonly AaModelMetrics[]): AaMetricRanges {
  const ranges: AaMetricRanges = {};
  for (const key of ["work", "presentation", "creativeBuild"] as const) {
    const values = catalog.map((m) => rawRangeValue(m, key)).filter((v): v is number => v !== null);
    if (values.length >= 2) ranges[key] = { min: Math.min(...values), max: Math.max(...values) };
  }
  return ranges;
}

function metricValue(aa: AaModelMetrics, metric: Metric, ranges: AaMetricRanges): number | undefined {
  const pct = (value: number | undefined) => (typeof value === "number" ? clamp01(value / 100) : undefined);
  switch (metric) {
    case "code":
      return clamp01(((aa.codingScore ?? 30) - 20) / 45); // 20..65 -> 0..1
    case "intel":
      return clamp01(((aa.intelligenceIndex ?? 30) - 15) / 45); // 15..60 -> 0..1
    case "speed":
      return clamp01(Math.min(aa.outputSpeedTps ?? 80, 260) / 260);
    case "factual":
      return typeof aa.hallucinationRate === "number" ? clamp01(1 - aa.hallucinationRate) : undefined;
    case "work":
    case "presentation":
    case "creativeBuild": {
      const raw = rawRangeValue(aa, metric);
      const range = ranges[metric];
      if (raw === null || !range || range.max <= range.min) return undefined;
      return clamp01((raw - range.min) / (range.max - range.min));
    }
    case "lowSlop": {
      const slop = pct(aa.personality?.slop);
      return slop === undefined ? undefined : 1 - slop;
    }
    default:
      return pct(aa.personality?.[metric]);
  }
}

function scoreProfile(aa: AaModelMetrics, weights: Weights, ranges: AaMetricRanges): number {
  let total = 0;
  for (const [metric, weight] of Object.entries(weights) as Array<[Metric, number]>) {
    total += weight * (metricValue(aa, metric, ranges) ?? UNMEASURED);
  }
  return total;
}

/**
 * Compute normalized [0..1] AA utility for a model given the active Hydra tier
 * and optional Jev turn signal, weighting every AA measurement relevant to the
 * turn's domain (coding, reasoning, research, writing, conversation, quick edits).
 */
export function computeAaUtility(
  aa: AaModelMetrics,
  tier: ActiveHydraTier,
  signal?: HydraTurnSignalInput,
  ranges: AaMetricRanges = {},
): number {
  const domain = signal?.domain ?? "coding";
  const depth = effectiveSignalDepth(tier, signal);
  const shallow = isShallowTurn(domain, depth);

  if (shallow || domain === "fast_edit") {
    return scoreProfile(aa, tier === "max" ? FAST_PROFILE_MAX : FAST_PROFILE, ranges);
  }

  const profile = DOMAIN_PROFILES[domain];
  const t = tier === "max" ? 1 : clamp01((depth - MID_DEPTH) / (FRONTIER_DEPTH - MID_DEPTH));
  const workhorse = scoreProfile(aa, profile.workhorse, ranges);
  let utility = workhorse + (scoreProfile(aa, profile.frontier, ranges) - workhorse) * t;

  // Capability floor: lightweight models (codingScore < 40, e.g. Haiku, Flash, Luna) must not
  // outrank capable models on coding, reasoning, or non-trivial research. Writing and
  // conversation lean on personality and creative measurements instead.
  if ((domain === "coding" || domain === "reasoning" || domain === "research") && (aa.codingScore ?? 0) < 40) {
    utility *= 0.55;
  }
  return utility;
}

/** Depth where the workhorse profile starts blending toward frontier weights. */
export const MID_DEPTH = 1.8;
/** Depth (and above) scored entirely on frontier weights. */
export const FRONTIER_DEPTH = 2.6;

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
  /** Routed-turn counts per model family over the recent usage window. */
  usage?: Readonly<Record<string, number>>;
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
    usage,
  } = options;

  // Filter out API-priced/excluded providers first, then prefer user's scoped models when non-empty.
  const allowedModels = models.filter((m) => !EXCLUDED_HYDRA_PROVIDERS.has(m.provider.toLowerCase()));
  const pool =
    scopedKeys && scopedKeys.size > 0
      ? allowedModels.filter((m) => scopedKeys.has(`${m.provider}/${m.id}`))
      : allowedModels;
  const effectivePool = pool.length > 0 ? pool : allowedModels;
  const poolFamilies = new Set(effectivePool.map((m) => inferModelFamily(m.provider, m.id)));
  const ranges = computeMetricRanges(catalog);

  const domain = signal?.domain ?? "coding";
  const scored = effectivePool.flatMap((model) => {
    const aa = matchAaMetrics(model.id, catalog);
    if (!aa) return [];
    const quotaHealth = quotaMultiplierForModel(model.provider, model.id, tier, openCircuits, quota);
    if (quotaHealth.multiplier <= 0) return [];
    const family = inferModelFamily(model.provider, model.id);
    const taskUtility = computeAaUtility(aa, tier, signal, ranges) + (DOMAIN_AFFINITY[domain]?.[family] ?? 0);
    return [{ model, aa, family, quotaHealth, taskUtility }];
  });
  const bestTaskUtility = Math.max(0, ...scored.map((s) => s.taskUtility));

  const candidates: RankedModelCandidate[] = [];
  for (const { model, aa, family, quotaHealth, taskUtility } of scored) {
    const key = `${model.provider}/${model.id}`;
    const { multiplier: quotaMultiplier, reason: quotaReason } = quotaHealth;
    let balance = usageBalanceMultiplier(family, usage, poolFamilies);
    // Under-use may only promote models that are good enough for this task.
    const gate = isStarved(family, usage, poolFamilies) ? STARVED_QUALITY_GATE : BALANCE_QUALITY_GATE;
    if (balance > 1 && taskUtility < gate * bestTaskUtility) balance = 1;
    // Fastest + most quota (and cheapest, as a quota-burn proxy) wins among
    // models that are good enough for the task; outside the quality band the
    // tilt is withheld so it can never trade correctness for speed or quota.
    let tilt = 0;
    if (taskUtility >= BALANCE_QUALITY_GATE * bestTaskUtility) {
      const remaining = quotaRemainingForModel(model.provider, model.id, quota);
      const headroom = remaining !== null ? remaining / 100 : 0.5;
      const speedNorm = clamp01(Math.min(aa.outputSpeedTps ?? 80, 260) / 260);
      const costEfficiency = clamp01(1 - Math.min(aa.blendedPricePer1m ?? 2.5, 3.0) / 3.0);
      tilt = QUOTA_HEADROOM_WEIGHT * headroom + SPEED_TILT_WEIGHT * speedNorm + COST_TILT_WEIGHT * costEfficiency;
    }
    const rawUtility =
      taskUtility * balance +
      CAPACITY_BONUS * subscriptionCapacity(family) +
      providerQualityBonus(model.provider) +
      tilt;
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

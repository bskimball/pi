// Artificial Analysis (https://artificialanalysis.ai/models) scraper, parser,
// and cached catalog store for Hydra model routing.
//
// Extracts the structured `initialModels` array from the Next.js RSC stream on
// artificialanalysis.ai/models and falls back to a built-in baseline snapshot
// when offline or before the first sync.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const AA_MODELS_URL = "https://artificialanalysis.ai/models";
export const AA_STALE_MS = 24 * 60 * 60_000; // 24 hours

export interface AaModelMetrics {
  slug: string;
  name: string;
  releaseSlug?: string;
  creatorSlug?: string;
  intelligenceIndex: number | null;
  engineeringIndex: number | null;
  frontierCode20: number | null;
  terminalBench40: number | null;
  /** Combined coding score on [0..100], derived from engineering, frontierCode20, and terminalBench40. */
  codingScore: number;
  /** Median output speed in tokens/sec. */
  outputSpeedTps: number | null;
  /** Median time to first chunk/token in seconds. */
  ttftSeconds: number | null;
  /** Blended price (USD per 1M tokens, 7:2:1 or 3:1). */
  blendedPricePer1m: number | null;
  inputPricePer1m: number | null;
  outputPricePer1m: number | null;
  cacheHitPricePer1m: number | null;
  contextWindowTokens: number | null;
  isReasoning: boolean;
}

export interface AaCatalogSnapshot {
  schema: 1;
  updatedAt: number;
  source: "live" | "seed";
  models: AaModelMetrics[];
}

/**
 * Seed baseline captured from artificialanalysis.ai/models so Hydra works
 * out-of-the-box offline or before the first `/mode hydra sync` completes.
 */
export const SEED_AA_MODELS: AaModelMetrics[] = [
  {
    slug: "gemini-4-carbon",
    name: "Gemini 4 Carbon (High)",
    creatorSlug: "google",
    intelligenceIndex: 59.4,
    engineeringIndex: 64.7,
    frontierCode20: 0.41,
    terminalBench40: 0.65,
    codingScore: 60.2,
    outputSpeedTps: 99.8,
    ttftSeconds: 97.5,
    blendedPricePer1m: 2.94,
    inputPricePer1m: 2.0,
    outputPricePer1m: 12.0,
    cacheHitPricePer1m: 0.2,
    contextWindowTokens: 1_000_000,
    isReasoning: true,
  },
  {
    slug: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    creatorSlug: "anthropic",
    intelligenceIndex: 58.4,
    engineeringIndex: 64.6,
    frontierCode20: 0.464,
    terminalBench40: 0.596,
    codingScore: 60.5,
    outputSpeedTps: 98.3,
    ttftSeconds: 688.0,
    blendedPricePer1m: 2.94,
    inputPricePer1m: 4.0,
    outputPricePer1m: 20.0,
    cacheHitPricePer1m: 0.2,
    contextWindowTokens: 1_000_000,
    isReasoning: true,
  },
  {
    slug: "gpt-6-astra",
    name: "GPT-6 Astra",
    creatorSlug: "openai",
    intelligenceIndex: 56.9,
    engineeringIndex: 61.8,
    frontierCode20: 0.42,
    terminalBench40: 0.59,
    codingScore: 58.0,
    outputSpeedTps: 73.1,
    ttftSeconds: 262.9,
    blendedPricePer1m: 7.7,
    inputPricePer1m: 5.0,
    outputPricePer1m: 25.0,
    cacheHitPricePer1m: 0.5,
    contextWindowTokens: 400_000,
    isReasoning: true,
  },
  {
    slug: "gpt-6-1-sol",
    name: "GPT-6.1 Sol",
    creatorSlug: "openai",
    intelligenceIndex: 54.5,
    engineeringIndex: 59.3,
    frontierCode20: 0.41,
    terminalBench40: 0.56,
    codingScore: 55.6,
    outputSpeedTps: 79.3,
    ttftSeconds: 251.4,
    blendedPricePer1m: 1.47,
    inputPricePer1m: 1.5,
    outputPricePer1m: 6.0,
    cacheHitPricePer1m: 0.15,
    contextWindowTokens: 1_000_000,
    isReasoning: true,
  },
  {
    slug: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    creatorSlug: "anthropic",
    intelligenceIndex: 54.2,
    engineeringIndex: 58.2,
    frontierCode20: 0.42,
    terminalBench40: 0.64,
    codingScore: 57.5,
    outputSpeedTps: 136.9,
    ttftSeconds: 463.2,
    blendedPricePer1m: 1.47,
    inputPricePer1m: 2.0,
    outputPricePer1m: 10.0,
    cacheHitPricePer1m: 0.1,
    contextWindowTokens: 1_000_000,
    isReasoning: true,
  },
  {
    slug: "gpt-6-1-terra",
    name: "GPT-6.1 Terra",
    creatorSlug: "openai",
    intelligenceIndex: 51.0,
    engineeringIndex: 54.4,
    frontierCode20: 0.42,
    terminalBench40: 0.56,
    codingScore: 53.2,
    outputSpeedTps: 90.9,
    ttftSeconds: 144.2,
    blendedPricePer1m: 0.735,
    inputPricePer1m: 0.75,
    outputPricePer1m: 3.0,
    cacheHitPricePer1m: 0.075,
    contextWindowTokens: 400_000,
    isReasoning: true,
  },
  {
    slug: "muse-wonder-full",
    name: "Muse Wonder Full",
    creatorSlug: "meta",
    intelligenceIndex: 49.7,
    engineeringIndex: 54.9,
    frontierCode20: 0.38,
    terminalBench40: 0.57,
    codingScore: 52.4,
    outputSpeedTps: 150.0,
    ttftSeconds: 30.0,
    blendedPricePer1m: 2.94,
    inputPricePer1m: null,
    outputPricePer1m: null,
    cacheHitPricePer1m: null,
    contextWindowTokens: 1_000_000,
    isReasoning: true,
  },
  {
    slug: "claude-fable-5-1",
    name: "Claude Fable 5.1",
    creatorSlug: "anthropic",
    intelligenceIndex: 49.0,
    engineeringIndex: 56.6,
    frontierCode20: 0.32,
    terminalBench40: 0.52,
    codingScore: 50.3,
    outputSpeedTps: 64.3,
    ttftSeconds: 133.8,
    blendedPricePer1m: 7.175,
    inputPricePer1m: null,
    outputPricePer1m: null,
    cacheHitPricePer1m: null,
    contextWindowTokens: 220_000,
    isReasoning: true,
  },
  {
    slug: "kimi-k3-1-pro",
    name: "Kimi K3.1 Pro",
    creatorSlug: "kimi",
    intelligenceIndex: 46.0,
    engineeringIndex: 50.4,
    frontierCode20: 0.25,
    terminalBench40: 0.67,
    codingScore: 49.5,
    outputSpeedTps: 35.7,
    ttftSeconds: 3.0,
    blendedPricePer1m: 1.54,
    inputPricePer1m: null,
    outputPricePer1m: null,
    cacheHitPricePer1m: null,
    contextWindowTokens: 220_000,
    isReasoning: true,
  },
  {
    slug: "muse-wonder",
    name: "Muse Wonder",
    creatorSlug: "meta",
    intelligenceIndex: 43.3,
    engineeringIndex: 49.3,
    frontierCode20: 0.28,
    terminalBench40: 0.52,
    codingScore: 45.7,
    outputSpeedTps: 197.4,
    ttftSeconds: 23.6,
    blendedPricePer1m: 2.94,
    inputPricePer1m: null,
    outputPricePer1m: null,
    cacheHitPricePer1m: null,
    contextWindowTokens: 1_000_000,
    isReasoning: true,
  },
  {
    slug: "claude-haiku-5-5",
    name: "Claude Haiku 5.5",
    creatorSlug: "anthropic",
    intelligenceIndex: 36.2,
    engineeringIndex: 42.3,
    frontierCode20: 0.35,
    terminalBench40: 0.33,
    codingScore: 39.2,
    outputSpeedTps: 240.0,
    ttftSeconds: 340.7,
    blendedPricePer1m: 0.077,
    inputPricePer1m: null,
    outputPricePer1m: null,
    cacheHitPricePer1m: null,
    contextWindowTokens: 200_000,
    isReasoning: true,
  },
  {
    slug: "grok-4-7",
    name: "Grok 4.7",
    creatorSlug: "xai",
    intelligenceIndex: 34.3,
    engineeringIndex: 41.0,
    frontierCode20: 0.29,
    terminalBench40: 0.26,
    codingScore: 36.0,
    outputSpeedTps: 104.1,
    ttftSeconds: 30.6,
    blendedPricePer1m: 1.35,
    inputPricePer1m: 2.0,
    outputPricePer1m: 6.0,
    cacheHitPricePer1m: 0.5,
    contextWindowTokens: 500_000,
    isReasoning: true,
  },
  {
    slug: "deepseek-v4-1-flash-1017",
    name: "DeepSeek V4.1 Flash",
    creatorSlug: "deepseek",
    intelligenceIndex: 32.5,
    engineeringIndex: 37.5,
    frontierCode20: 0.28,
    terminalBench40: 0.34,
    codingScore: 35.2,
    outputSpeedTps: 178.3,
    ttftSeconds: 1.2,
    blendedPricePer1m: 0.184,
    inputPricePer1m: null,
    outputPricePer1m: null,
    cacheHitPricePer1m: null,
    contextWindowTokens: 131_072,
    isReasoning: true,
  },
  {
    slug: "glm-5-3",
    name: "GLM-5.3",
    creatorSlug: "zai",
    intelligenceIndex: 31.7,
    engineeringIndex: 37.6,
    frontierCode20: 0.22,
    terminalBench40: 0.42,
    codingScore: 35.8,
    outputSpeedTps: 74.2,
    ttftSeconds: 2.2,
    blendedPricePer1m: 0.902,
    inputPricePer1m: null,
    outputPricePer1m: null,
    cacheHitPricePer1m: null,
    contextWindowTokens: 220_000,
    isReasoning: true,
  },
  {
    slug: "gemini-3-8-flash",
    name: "Gemini 3.8 Flash",
    creatorSlug: "google",
    intelligenceIndex: 30.5,
    engineeringIndex: 38.5,
    frontierCode20: 0.19,
    terminalBench40: 0.20,
    codingScore: 31.0,
    outputSpeedTps: 140.4,
    ttftSeconds: 25.6,
    blendedPricePer1m: 0.578,
    inputPricePer1m: null,
    outputPricePer1m: null,
    cacheHitPricePer1m: null,
    contextWindowTokens: 220_000,
    isReasoning: true,
  },
  {
    slug: "gpt-6-luna",
    name: "GPT-6 Luna",
    creatorSlug: "openai",
    intelligenceIndex: 27.8,
    engineeringIndex: 33.2,
    frontierCode20: 0.25,
    terminalBench40: 0.13,
    codingScore: 28.0,
    outputSpeedTps: 120.6,
    ttftSeconds: 73.5,
    blendedPricePer1m: 0.077,
    inputPricePer1m: null,
    outputPricePer1m: null,
    cacheHitPricePer1m: null,
    contextWindowTokens: 220_000,
    isReasoning: true,
  },
  {
    slug: "muse-spark-open",
    name: "Muse Spark",
    creatorSlug: "meta",
    intelligenceIndex: 24.7,
    engineeringIndex: 34.9,
    frontierCode20: 0.08,
    terminalBench40: 0.08,
    codingScore: 23.4,
    outputSpeedTps: 140.9,
    ttftSeconds: 0.7,
    blendedPricePer1m: 0.78,
    inputPricePer1m: null,
    outputPricePer1m: null,
    cacheHitPricePer1m: null,
    contextWindowTokens: 1_000_000,
    isReasoning: true,
  },
];

export function defaultAaCatalogPath(): string {
  const configuredAgentDir = process.env.PI_CODING_AGENT_DIR?.trim();
  const agentDir = configuredAgentDir || join(homedir(), ".pi", "agent");
  return join(agentDir, "harness", "aa-models.json");
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function computeCodingScore(input: {
  intelligenceIndex: number | null;
  engineeringIndex: number | null;
  frontierCode20: number | null;
  terminalBench40: number | null;
}): number {
  const parts: Array<{ value: number; weight: number }> = [];
  if (input.engineeringIndex !== null) parts.push({ value: input.engineeringIndex, weight: 0.45 });
  if (input.frontierCode20 !== null) parts.push({ value: input.frontierCode20 * 100, weight: 0.30 });
  if (input.terminalBench40 !== null) parts.push({ value: input.terminalBench40 * 100, weight: 0.25 });
  if (parts.length === 0) {
    return input.intelligenceIndex ?? 0;
  }
  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  return Number((parts.reduce((sum, p) => sum + p.value * p.weight, 0) / totalWeight).toFixed(2));
}

/**
 * Parse the `initialModels` array from Artificial Analysis's `/models` HTML.
 */
export function parseAaModelsHtml(html: string): AaModelMetrics[] {
  const parts = html.split('self.__next_f.push([1,"');
  let full = "";
  for (let i = 1; i < parts.length; i++) {
    const end = parts[i]!.indexOf('"])</script>');
    if (end !== -1) {
      try {
        full += JSON.parse(`"${parts[i]!.slice(0, end)}"`);
      } catch {
        // Skip malformed chunk.
      }
    }
  }
  const payload = full || html;
  const marker = '"initialModels":[';
  const pos = payload.indexOf(marker);
  if (pos === -1) return [];

  const arrStart = pos + marker.length - 1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = arrStart;
  for (; end < payload.length; end++) {
    const ch = payload[end];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (!inStr) {
      if (ch === "[") depth++;
      else if (ch === "]") {
        depth--;
        if (depth === 0) {
          end++;
          break;
        }
      }
    }
  }

  let rawList: unknown;
  try {
    rawList = JSON.parse(payload.slice(arrStart, end));
  } catch {
    return [];
  }
  if (!Array.isArray(rawList)) return [];

  const models: AaModelMetrics[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const slug = typeof rec.slug === "string" ? rec.slug.trim() : "";
    if (!slug) continue;
    const name = typeof rec.name === "string" ? rec.name.trim() : slug;
    const release = rec.release && typeof rec.release === "object" ? (rec.release as Record<string, unknown>) : undefined;
    const creator = rec.creator && typeof rec.creator === "object" ? (rec.creator as Record<string, unknown>) : undefined;
    const capabilities = rec.capabilities && typeof rec.capabilities === "object" ? (rec.capabilities as Record<string, unknown>) : undefined;
    const timescale = rec.timescaleData && typeof rec.timescaleData === "object" ? (rec.timescaleData as Record<string, unknown>) : undefined;

    const intelligenceIndex = finiteOrNull(rec.intelligenceIndex);
    const engineeringIndex = finiteOrNull(capabilities?.engineering);
    const frontierCode20 = finiteOrNull(rec.frontierCode20 ?? rec.frontierCode);
    const terminalBench40 = finiteOrNull(rec.terminalBench40 ?? rec.terminalBench21);
    const codingScore = computeCodingScore({
      intelligenceIndex,
      engineeringIndex,
      frontierCode20,
      terminalBench40,
    });

    models.push({
      slug,
      name,
      releaseSlug: typeof release?.slug === "string" ? release.slug : undefined,
      creatorSlug: typeof creator?.slug === "string" ? creator.slug : undefined,
      intelligenceIndex,
      engineeringIndex,
      frontierCode20,
      terminalBench40,
      codingScore,
      outputSpeedTps: finiteOrNull(timescale?.medianOutputSpeed),
      ttftSeconds: finiteOrNull(timescale?.medianTimeToFirstChunk),
      blendedPricePer1m: finiteOrNull(rec.price1mBlended7To2To1 ?? rec.price1mBlended0To3To1),
      inputPricePer1m: finiteOrNull(rec.price1mInputTokens),
      outputPricePer1m: finiteOrNull(rec.price1mOutputTokens),
      cacheHitPricePer1m: finiteOrNull(rec.cacheHitPrice),
      contextWindowTokens: finiteOrNull(rec.contextWindowTokens),
      isReasoning: rec.isReasoning !== false,
    });
  }
  return models;
}

export function readAaCatalog(path = defaultAaCatalogPath()): AaCatalogSnapshot {
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      if (raw && typeof raw === "object" && Array.isArray(raw.models) && raw.models.length > 0) {
        return {
          schema: 1,
          updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
          source: raw.source === "live" ? "live" : "seed",
          models: raw.models as AaModelMetrics[],
        };
      }
    }
  } catch {
    // Fall back to seed snapshot.
  }
  return {
    schema: 1,
    updatedAt: 0,
    source: "seed",
    models: SEED_AA_MODELS,
  };
}

export function saveAaCatalog(snapshot: AaCatalogSnapshot, path = defaultAaCatalogPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export async function syncAaCatalog(options?: {
  path?: string;
  url?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<AaCatalogSnapshot> {
  const path = options?.path ?? defaultAaCatalogPath();
  const url = options?.url ?? AA_MODELS_URL;
  const timeoutMs = options?.timeoutMs ?? 8_000;
  const fetchFn = options?.fetchImpl ?? globalThis.fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      signal: controller.signal,
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const parsed = parseAaModelsHtml(html);
    if (parsed.length === 0) throw new Error("No AA model entries found in response");

    // Merge with seed entries so models not in the top 28 default chart still retain baseline scores.
    const bySlug = new Map<string, AaModelMetrics>();
    for (const seed of SEED_AA_MODELS) bySlug.set(seed.slug, seed);
    for (const live of parsed) bySlug.set(live.slug, live);

    const snapshot: AaCatalogSnapshot = {
      schema: 1,
      updatedAt: Date.now(),
      source: "live",
      models: [...bySlug.values()],
    };
    saveAaCatalog(snapshot, path);
    return snapshot;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/^@cf\/[^/]+\//, "")
    .replace(/-(?:thinking|preview|contributor|non-reasoning|reasoning|default-fallback)$/g, "")
    .replace(/-(?:20\d{6}|\d{4})$/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Exact same-model slug normalization only (never aliases an older model
 * generation onto a newer generation's benchmark scores).
 */
const EXPLICIT_ALIASES: Record<string, string> = {
  "claude-opus-5-5": "claude-opus-5-5",
  "claude-fable-5-1": "claude-fable-5-1",
  "claude-sonnet-5-5": "claude-sonnet-5-5",
  "claude-haiku-5-5": "claude-haiku-5-5",
  "gpt-6-astra": "gpt-6-astra",
  "gpt-6-1-sol": "gpt-6-1-sol",
  "gpt-6-1-terra": "gpt-6-1-terra",
  "gpt-6-luna": "gpt-6-luna",
  "grok-4-7": "grok-4-7",
  "gemini-4-carbon": "gemini-4-carbon",
  "gemini-3-8-flash-high": "gemini-3-8-flash",
  "gemini-3-8-flash": "gemini-3-8-flash",
  "muse-wonder-1-0": "muse-wonder",
  "muse-wonder": "muse-wonder",
  "muse-spark-open": "muse-spark-open",
  "glm-5-3": "glm-5-3",
  "deepseek-v4-1-flash-1017": "deepseek-v4-1-flash-1017",
  "deepseek-v4-1-flash": "deepseek-v4-1-flash-1017",
  "kimi-k3-1-pro": "kimi-k3-1-pro",
  "qwen3-8-27b": "qwen3-8-27b",
};

/**
 * Match a Pi model ID (e.g. `claude-opus-5-5`, `openai/gpt-6.1-sol`,
 * `@cf/zai-org/glm-5.3`) to its Artificial Analysis metrics entry.
 */
export function matchAaMetrics(
  modelId: string,
  catalog: readonly AaModelMetrics[],
): AaModelMetrics | undefined {
  const rawId = modelId.includes("/") && !modelId.startsWith("@cf/")
    ? modelId.slice(modelId.indexOf("/") + 1)
    : modelId;
  const norm = normalizeToken(rawId);
  const bySlug = new Map<string, AaModelMetrics>();
  for (const entry of catalog) {
    bySlug.set(normalizeToken(entry.slug), entry);
    if (entry.releaseSlug) bySlug.set(normalizeToken(entry.releaseSlug), entry);
  }

  if (bySlug.has(norm)) return bySlug.get(norm);
  const aliased = EXPLICIT_ALIASES[norm];
  if (aliased && bySlug.has(normalizeToken(aliased))) {
    return bySlug.get(normalizeToken(aliased));
  }
  return undefined;
}

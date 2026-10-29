// Quota and circuit-breaker health reader for Hydra model routing.
//
// Reads:
// 1. Persisted model circuit breakers (`agent/harness/model-circuits.json`)
// 2. Cached or live CLIProxyAPI `/v8/management/credentials` status & quota
//    snapshot (`agent/harness/quota-snapshot.json`) when a management key is
//    available via `CPA_MANAGEMENT_KEY` or `agent/harness/hydra.json`.
// Never exposes secrets or blocks turns when the management API is unconfigured.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_CPA_BASE_URL = "http://127.0.0.1:8317";
export const QUOTA_STALE_MS = 10 * 60_000; // 10 minutes

export interface ProviderQuotaEntry {
  provider: string;
  /** Remaining quota percentage on [0..100], or null when only health/cooldown is known. */
  remainingPercent: number | null;
  inCooldown: boolean;
  disabled: boolean;
  successCount: number;
  failureCount: number;
}

export interface QuotaSnapshot {
  schema: 1;
  updatedAt: number;
  source: "live" | "none";
  providers: Record<string, ProviderQuotaEntry>;
}

export function defaultHarnessDir(): string {
  const configuredAgentDir = process.env.PI_CODING_AGENT_DIR?.trim();
  const agentDir = configuredAgentDir || join(homedir(), ".pi", "agent");
  return join(agentDir, "harness");
}

export function defaultQuotaSnapshotPath(): string {
  return join(defaultHarnessDir(), "quota-snapshot.json");
}

export function defaultCircuitStorePath(): string {
  return join(defaultHarnessDir(), "model-circuits.json");
}

export function defaultHydraConfigPath(): string {
  return join(defaultHarnessDir(), "hydra.json");
}

/**
 * Read the set of currently open circuit-breaker keys (`provider/modelId`)
 * from `agent/harness/model-circuits.json`.
 */
export function readOpenCircuits(path = defaultCircuitStorePath(), now = Date.now()): Set<string> {
  const open = new Set<string>();
  try {
    if (!existsSync(path)) return open;
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.entries)) return open;
    for (const entry of raw.entries) {
      if (!entry || typeof entry !== "object") continue;
      const key = typeof entry.key === "string" ? entry.key : "";
      const openUntil = typeof entry.openUntil === "number" ? entry.openUntil : 0;
      if (key && openUntil > now) open.add(key);
    }
  } catch {
    // Ignore unreadable circuit file.
  }
  return open;
}

function resolveManagementKey(configPath = defaultHydraConfigPath()): { baseUrl: string; key?: string } {
  let baseUrl = process.env.CPA_BASE_URL?.trim() || DEFAULT_CPA_BASE_URL;
  let key = process.env.CPA_MANAGEMENT_KEY?.trim() || undefined;
  try {
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, "utf8"));
      if (raw && typeof raw === "object") {
        if (typeof raw.cpaBaseUrl === "string" && raw.cpaBaseUrl.trim()) {
          baseUrl = raw.cpaBaseUrl.trim();
        }
        if (!key && typeof raw.cpaManagementKey === "string" && raw.cpaManagementKey.trim()) {
          key = raw.cpaManagementKey.trim();
        }
      }
    }
  } catch {
    // Ignore malformed config.
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), key };
}

export function readQuotaSnapshot(path = defaultQuotaSnapshotPath()): QuotaSnapshot {
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      if (raw && typeof raw === "object" && raw.providers && typeof raw.providers === "object") {
        return {
          schema: 1,
          updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
          source: raw.source === "live" ? "live" : "none",
          providers: raw.providers as Record<string, ProviderQuotaEntry>,
        };
      }
    }
  } catch {
    // Fall through.
  }
  return { schema: 1, updatedAt: 0, source: "none", providers: {} };
}

export function saveQuotaSnapshot(snapshot: QuotaSnapshot, path = defaultQuotaSnapshotPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function normalizeProviderFamily(raw: string): string {
  const lower = raw.trim().toLowerCase();
  if (lower.includes("claude") || lower.includes("anthropic")) return "anthropic";
  if (lower.includes("codex") || lower.includes("openai")) return "openai";
  if (lower.includes("antigravity") || lower.includes("gemini") || lower.includes("google")) return "google";
  if (lower.includes("xai") || lower.includes("grok")) return "xai";
  if (lower.includes("meta") || lower.includes("muse")) return "meta";
  if (lower.includes("kimi") || lower.includes("moonshot")) return "kimi";
  if (lower.includes("zai") || lower.includes("glm")) return "zai";
  if (lower.includes("deepseek")) return "deepseek";
  return lower;
}

export function parseCredentialsResponse(payload: unknown): Record<string, ProviderQuotaEntry> {
  const out: Record<string, ProviderQuotaEntry> = Object.create(null);
  if (!payload || typeof payload !== "object") return out;
  const files = Array.isArray((payload as { files?: unknown }).files)
    ? ((payload as { files: unknown[] }).files)
    : [];

  for (const item of files) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const providerRaw = String(rec.quota_provider ?? rec.quotaProvider ?? rec.provider ?? rec.type ?? "").trim();
    if (!providerRaw) continue;
    const family = normalizeProviderFamily(providerRaw);
    const disabled = rec.disabled === true;
    const cooldowns = Array.isArray(rec.cooldowns) ? rec.cooldowns : [];
    const inCooldown = cooldowns.length > 0 || rec.unavailable === true;
    const usable = !disabled && !inCooldown;
    const successCount = typeof rec.success === "number" && Number.isFinite(rec.success) ? rec.success : 0;
    const failureCount = typeof rec.failed === "number" && Number.isFinite(rec.failed) ? rec.failed : 0;
    const remainingRaw = rec.remaining_percent ?? rec.remainingPercent;
    let remainingPercent =
      usable && typeof remainingRaw === "number" && Number.isFinite(remainingRaw)
        ? Math.max(0, Math.min(100, remainingRaw))
        : null;
    // CPA builds without a top-level percent report per-credential quota signals
    // (quota.signals.<name>.*remaining*percent*); the most binding signal wins.
    if (remainingPercent === null && usable) {
      const quota = rec.quota && typeof rec.quota === "object" ? (rec.quota as Record<string, unknown>) : undefined;
      const signals = quota?.signals && typeof quota.signals === "object" ? Object.values(quota.signals as Record<string, unknown>) : [];
      for (const signal of signals) {
        if (!signal || typeof signal !== "object") continue;
        for (const [key, value] of Object.entries(signal as Record<string, unknown>)) {
          if (!/remaining/i.test(key) || !/percent|pct/i.test(key)) continue;
          if (typeof value !== "number" || !Number.isFinite(value)) continue;
          // The field name declares the unit: percent on [0..100], at every magnitude.
          const pct = Math.max(0, Math.min(100, value));
          remainingPercent = remainingPercent === null ? pct : Math.min(remainingPercent, pct);
        }
      }
    }

    const prev = out[family];
    if (!prev) {
      out[family] = {
        provider: family,
        remainingPercent,
        inCooldown: !usable && inCooldown,
        disabled: !usable && disabled,
        successCount,
        failureCount,
      };
    } else {
      const prevUsable = !prev.disabled && !prev.inCooldown;
      const anyUsable = prevUsable || usable;
      prev.disabled = !anyUsable && prev.disabled && disabled;
      prev.inCooldown = !anyUsable && (prev.inCooldown || inCooldown);
      prev.successCount += successCount;
      prev.failureCount += failureCount;
      if (remainingPercent !== null) {
        prev.remainingPercent = prev.remainingPercent === null
          ? remainingPercent
          : Math.max(prev.remainingPercent, remainingPercent);
      }
    }
  }
  return out;
}

export async function syncQuotaSnapshot(options?: {
  path?: string;
  configPath?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<{ snapshot: QuotaSnapshot; note: string }> {
  const path = options?.path ?? defaultQuotaSnapshotPath();
  const { baseUrl, key } = resolveManagementKey(options?.configPath);
  if (!key) {
    const existing = readQuotaSnapshot(path);
    return {
      snapshot: existing,
      note: "CPA_MANAGEMENT_KEY not set (using model-circuits.json health only; set CPA_MANAGEMENT_KEY or cpaManagementKey in agent/harness/hydra.json for 8317 quota polling)",
    };
  }

  const fetchFn = options?.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 4_000);
  try {
    const res = await fetchFn(`${baseUrl}/v8/management/credentials`, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const body = await res.json();
    const providers = parseCredentialsResponse(body);
    const snapshot: QuotaSnapshot = {
      schema: 1,
      updatedAt: Date.now(),
      source: "live",
      providers,
    };
    saveQuotaSnapshot(snapshot, path);
    return {
      snapshot,
      note: `synced ${Object.keys(providers).length} provider family quota state(s) from ${baseUrl}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function inferModelFamily(provider: string, modelId: string): string {
  const combined = `${provider}/${modelId}`.toLowerCase();
  if (combined.includes("claude") || combined.includes("anthropic")) return "anthropic";
  if (combined.includes("gpt") || combined.includes("codex") || combined.includes("openai")) return "openai";
  if (combined.includes("gemini") || combined.includes("antigravity") || combined.includes("google")) return "google";
  if (combined.includes("grok") || combined.includes("xai")) return "xai";
  if (combined.includes("muse") || combined.includes("meta")) return "meta";
  if (combined.includes("kimi") || combined.includes("moonshot")) return "kimi";
  if (combined.includes("glm") || combined.includes("zai")) return "zai";
  if (combined.includes("deepseek")) return "deepseek";
  return provider.toLowerCase();
}

/** Remaining quota percent for a model's family, or null when CPA has not reported it. */
export function quotaRemainingForModel(
  provider: string,
  modelId: string,
  quota: QuotaSnapshot,
): number | null {
  return quota.providers[inferModelFamily(provider, modelId)]?.remainingPercent ?? null;
}

/**
 * Compute a quota multiplier on [0..1] for a candidate model:
 * - 0 when the model's circuit is open, credential is disabled/in cooldown, or remaining < 5%
 * - 1.0 when remaining >= 40% (or unknown and healthy)
 * - Linearly scaled [0.35..1.0] when remaining is between 5% and 40% in standard/high tiers.
 */
export function quotaMultiplierForModel(
  provider: string,
  modelId: string,
  tier: "standard" | "high" | "max",
  openCircuits: ReadonlySet<string>,
  quota: QuotaSnapshot,
): { multiplier: number; reason?: string } {
  const key = `${provider}/${modelId}`;
  if (openCircuits.has(key)) {
    return { multiplier: 0, reason: "circuit-open" };
  }
  const family = inferModelFamily(provider, modelId);
  const entry = quota.providers[family];
  if (!entry) return { multiplier: 1 };
  if (entry.disabled) return { multiplier: 0, reason: "credential-disabled" };
  if (entry.inCooldown) return { multiplier: 0, reason: "quota-cooldown" };
  if (entry.remainingPercent !== null) {
    if (entry.remainingPercent < 5) {
      return { multiplier: 0, reason: `quota-exhausted (${entry.remainingPercent.toFixed(0)}%)` };
    }
    if (entry.remainingPercent < 40 && tier !== "max") {
      const scaled = 0.35 + ((entry.remainingPercent - 5) / 35) * 0.65;
      return {
        multiplier: Number(scaled.toFixed(3)),
        reason: `quota-conserve (${entry.remainingPercent.toFixed(0)}%)`,
      };
    }
  }
  return { multiplier: 1 };
}

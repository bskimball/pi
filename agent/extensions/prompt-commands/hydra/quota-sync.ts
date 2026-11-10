// Native subscription quota observations and persisted worker circuit health.
// Failed probes retain their original observation age; unknown quota is not exhaustion.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const QUOTA_STALE_MS = 10 * 60_000;
export interface ProviderQuotaEntry {
  provider: string;
  remainingPercent: number | null;
  remainingObservedAt?: number;
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
  models?: Record<string, ProviderQuotaEntry>;
}
export function defaultHarnessDir(): string {
  return join(process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent"), "harness");
}
export const defaultQuotaSnapshotPath = () => join(defaultHarnessDir(), "quota-snapshot.json");
export const defaultCircuitStorePath = () => join(defaultHarnessDir(), "model-circuits.json");

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}
export function readOpenCircuits(path = defaultCircuitStorePath(), now = Date.now()): Set<string> {
  const entries = readJson(path)?.entries;
  return new Set(Array.isArray(entries) ? entries.filter(e => typeof e?.key === "string" && e.openUntil > now).map(e => e.key) : []);
}
export function readQuotaSnapshot(path = defaultQuotaSnapshotPath()): QuotaSnapshot {
  const raw = readJson(path);
  if (!raw?.providers || typeof raw.providers !== "object") return { schema: 1, updatedAt: 0, source: "none", providers: {} };
  const updatedAt = raw.updatedAt ?? 0;
  // Freeze legacy observation ages before any caller advances the snapshot clock.
  for (const entry of [...Object.values(raw.providers), ...Object.values(raw.models ?? {})] as ProviderQuotaEntry[]) {
    entry.remainingObservedAt ??= updatedAt;
  }
  return { schema: 1, updatedAt, source: raw.source === "live" ? "live" : "none", providers: raw.providers, models: raw.models };
}
export function saveQuotaSnapshot(snapshot: QuotaSnapshot, path = defaultQuotaSnapshotPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}
function observation(provider: string, remainingPercent: number, at = Date.now()): ProviderQuotaEntry {
  return { provider, remainingPercent: Math.max(0, Math.min(100, remainingPercent)), remainingObservedAt: at, inCooldown: false, disabled: false, successCount: 0, failureCount: 0 };
}
function remainingFromUsed(values: unknown[]): number {
  const used = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0);
  if (!used.length) throw new Error("No usage windows");
  return Math.max(0, 100 - Math.max(...used));
}

async function museUsage(timeout: number): Promise<unknown> {
  let binary = process.env.PI_MUSE_BINARY?.trim() || "muse";
  if (!process.env.PI_MUSE_BINARY && process.platform === "win32") {
    const dir = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Programs", "muse");
    const version = readFileSync(join(dir, ".muse-version"), "utf8").trim();
    if (!/^[0-9]+\.[0-9]+\.[0-9]+-R[0-9]+(?:\.[0-9]+)?$/.test(version)) throw new Error("Invalid Muse version");
    binary = join(dir, `muse-bin-${version}.exe`);
  }
  const { stdout } = await promisify(execFile)(binary, ["usage", "--json"], { timeout, maxBuffer: 64 * 1024, windowsHide: true });
  return JSON.parse(stdout);
}

export async function syncQuotaSnapshot(options: {
  path?: string;
  home?: string;
  agentDir?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  museUsage?: (timeout: number) => Promise<unknown>;
} = {}): Promise<{ snapshot: QuotaSnapshot; note: string }> {
  const path = options.path ?? defaultQuotaSnapshotPath();
  const home = options.home ?? homedir();
  const agentDir = options.agentDir ?? dirname(defaultHarnessDir());
  const auth = readJson(join(agentDir, "auth.json")) ?? {};
  const timeout = options.timeoutMs ?? 4_000;
  const fetchFn = options.fetchImpl ?? fetch;
  const providers: Record<string, ProviderQuotaEntry> = {};
  const models: Record<string, ProviderQuotaEntry> = {};
  const unavailable: string[] = [];
  async function json(url: string, token: string | undefined, body?: unknown, headers?: Record<string, string>) {
    if (!token) throw new Error("No credential");
    const res = await fetchFn(url, {
      signal: AbortSignal.timeout(timeout), method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  await Promise.all([
    (async () => {
      try {
        const cc = readJson(join(home, ".claude", ".credentials.json"))?.claudeAiOauth;
        const token = cc?.expiresAt > Date.now() ? cc.accessToken : auth.anthropic?.access;
        const usage = await json("https://api.anthropic.com/api/oauth/usage", token, undefined, { "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0" });
        providers.anthropic = observation("anthropic", remainingFromUsed([usage.five_hour?.utilization, usage.seven_day?.utilization]));
      } catch { unavailable.push("anthropic"); }
    })(),
    (async () => {
      try {
        const codex = readJson(join(home, ".codex", "auth.json"))?.tokens;
        const usage = await json("https://chatgpt.com/backend-api/wham/usage", codex?.access_token, undefined,
          codex?.account_id ? { "chatgpt-account-id": codex.account_id } : undefined);
        providers.openai = observation("openai", usage.rate_limit?.limit_reached === true ? 0 : remainingFromUsed([
          usage.rate_limit?.primary_window?.used_percent, usage.rate_limit?.secondary_window?.used_percent,
        ]));
        for (const [id, value] of Object.entries(usage.model_usage ?? {}) as Array<[string, any]>) {
          if (value.available === false) models[`openai/${id}`] = observation("openai", 0);
        }
      } catch { unavailable.push("openai"); }
    })(),
    (async () => {
      try {
        const data = await json("https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels", auth.antigravity?.access,
          { project: auth.antigravity?.projectId }, { "User-Agent": "antigravity/cli/1.5.4 (aidev_client; os_type=linux; arch=amd64; cl=1000494485; auth_method=consumer)" });
        let found = false;
        for (const [id, value] of Object.entries(data.models ?? {}) as Array<[string, any]>) {
          const fraction = value.quotaInfo?.remainingFraction;
          if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
          models[`antigravity/${id.replace(/-(low|medium|high)$/, "")}`] = observation("google", fraction * 100);
          found = true;
        }
        if (!found) throw new Error("No model quotas");
      } catch { unavailable.push("google"); }
    })(),
    (async () => {
      try {
        const usage: any = await (options.museUsage ?? museUsage)(timeout);
        const allowance = usage.allowance;
        const at = allowance?.asOfMs;
        if (typeof at !== "number" || !Number.isFinite(at) || at <= 0 || at > Date.now()) throw new Error("No observation time");
        providers.meta = observation("meta", remainingFromUsed([allowance.window?.usedPercent, allowance.weekly?.usedPercent]), at);
      } catch { unavailable.push("meta"); }
    })(),
  ]);
  // Re-read after probes so a passive response arriving during polling is not overwritten.
  const previous = readQuotaSnapshot(path);
  const merge = (old: Record<string, ProviderQuotaEntry>, fresh: Record<string, ProviderQuotaEntry>) => {
    const result = { ...old };
    for (const [key, entry] of Object.entries(fresh)) {
      if (old[key] && (old[key].remainingObservedAt ?? previous.updatedAt) > entry.remainingObservedAt!) continue;
      result[key] = entry;
    }
    return result;
  };
  // Clear successful OpenAI model gates when the provider no longer reports them.
  const previousModels = { ...previous.models };
  if (providers.openai) for (const key of Object.keys(previousModels)) if (key.startsWith("openai/")) delete previousModels[key];
  const snapshot: QuotaSnapshot = {
    schema: 1, updatedAt: Date.now(), source: "live",
    providers: merge(previous.providers, providers), models: merge(previousModels, models),
  };
  // Legacy observations keep their original age even as the snapshot itself advances.
  for (const entry of [...Object.values(snapshot.providers), ...Object.values(snapshot.models ?? {})]) entry.remainingObservedAt ??= previous.updatedAt;
  saveQuotaSnapshot(snapshot, path);
  return { snapshot, note: `native quota sync${unavailable.length ? `; unavailable: ${unavailable.sort().join(", ")} (last-known observations retained)` : ""}; xai uses response health (remaining quota unknown)` };
}

/** Capture only recognized subscription-window headers, not generic request-rate limits. */
export function recordQuotaHeaders(headers: Record<string, string>, provider: string, modelId: string, path = defaultQuotaSnapshotPath()): void {
  const family = inferModelFamily(provider, modelId);
  const normalized = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const values = family === "anthropic"
    ? ["5h", "7d"].map(window => normalized[`anthropic-ratelimit-unified-${window}-utilization`]).filter(v => v !== undefined).map(v => Number(v) * 100)
    : family === "openai"
      ? ["primary", "secondary"].map(window => normalized[`x-codex-${window}-used-percent`]).filter(v => v !== undefined).map(Number)
      : [];
  if (!values.length) return;
  try {
    const snapshot = readQuotaSnapshot(path);
    snapshot.providers[family] = observation(family, remainingFromUsed(values));
    snapshot.updatedAt = Date.now();
    snapshot.source = "live";
    saveQuotaSnapshot(snapshot, path);
  } catch { /* Passive telemetry must not interrupt a model response. */ }
}

export function inferModelFamily(provider: string, modelId: string): string {
  const combined = `${provider}/${modelId}`.toLowerCase();
  if (/claude|anthropic/.test(combined)) return "anthropic";
  if (/gpt|codex|openai/.test(combined)) return "openai";
  if (/gemini|antigravity|google/.test(combined)) return "google";
  if (/grok|xai/.test(combined)) return "xai";
  if (/muse|meta/.test(combined)) return "meta";
  if (/kimi|moonshot/.test(combined)) return "kimi";
  if (/glm|zai/.test(combined)) return "zai";
  if (combined.includes("deepseek")) return "deepseek";
  return provider.toLowerCase();
}
function quotaEntries(provider: string, modelId: string, quota: QuotaSnapshot): ProviderQuotaEntry[] {
  const modelProvider = provider === "openai-codex" ? "openai" : provider;
  return [quota.models?.[`${modelProvider}/${modelId}`], quota.providers[inferModelFamily(provider, modelId)]]
    .filter((entry): entry is ProviderQuotaEntry => entry !== undefined);
}
export function quotaRemainingForModel(provider: string, modelId: string, quota: QuotaSnapshot): number | null {
  const now = Date.now();
  const remaining = quotaEntries(provider, modelId, quota).flatMap(entry => {
    const observedAt = entry.remainingObservedAt ?? quota.updatedAt;
    if (!Number.isFinite(observedAt) || observedAt <= 0 || observedAt > now || now - observedAt > QUOTA_STALE_MS) return [];
    const value = entry.remainingPercent;
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? [value] : [];
  });
  return remaining.length ? Math.min(...remaining) : null;
}
export function quotaMultiplierForModel(provider: string, modelId: string, tier: "standard" | "high" | "max", openCircuits: ReadonlySet<string>, quota: QuotaSnapshot): { multiplier: number; reason?: string } {
  if (openCircuits.has(`${provider}/${modelId}`)) return { multiplier: 0, reason: "circuit-open" };
  const entries = quotaEntries(provider, modelId, quota);
  if (entries.some(entry => entry.disabled)) return { multiplier: 0, reason: "credential-disabled" };
  if (entries.some(entry => entry.inCooldown)) return { multiplier: 0, reason: "quota-cooldown" };
  const remaining = quotaRemainingForModel(provider, modelId, quota);
  if (remaining !== null) {
    if (remaining < 5) return { multiplier: 0, reason: `quota-exhausted (${remaining.toFixed(0)}%)` };
    if (remaining < 40 && tier !== "max") return { multiplier: Number((0.35 + ((remaining - 5) / 35) * 0.65).toFixed(3)), reason: `quota-conserve (${remaining.toFixed(0)}%)` };
  }
  return { multiplier: 1 };
}

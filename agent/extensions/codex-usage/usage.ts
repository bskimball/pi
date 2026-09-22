import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const BASE_URL = "https://chatgpt.com/backend-api";
const AUTH_CLAIM = "https://api.openai.com/auth";
const CACHE_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;

export interface UsageStatus {
  fiveHourRemaining?: number;
  weeklyRemaining?: number;
}

interface CacheEntry {
  value?: UsageStatus;
  expiresAt: number;
  pending?: Promise<UsageStatus | undefined>;
}

const cache = new Map<string, CacheEntry>();

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function canonicalBaseUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, "");
    return url.protocol === "https:" && url.hostname === "chatgpt.com"
      && !url.port && !url.username && !url.password && !url.search && !url.hash
      && (path === "/backend-api" || path === "/backend-api/codex");
  } catch {
    return false;
  }
}

export function isSupportedModel(model: ExtensionContext["model"]): boolean {
  return model?.api === "openai-codex-responses"
    && canonicalBaseUrl(model.baseUrl);
}

function windowMinutes(value: Record<string, unknown>): number | undefined {
  if (typeof value.window_minutes === "number" && Number.isFinite(value.window_minutes)) {
    return value.window_minutes;
  }
  return typeof value.limit_window_seconds === "number" && Number.isFinite(value.limit_window_seconds)
    ? Math.ceil(value.limit_window_seconds / 60)
    : undefined;
}

export function parseUsage(payload: unknown): UsageStatus | undefined {
  const rateLimit = record(record(payload)?.rate_limit);
  if (!rateLimit) return undefined;
  const windows = [
    record(rateLimit.primary_window) ?? record(rateLimit.primary),
    record(rateLimit.secondary_window) ?? record(rateLimit.secondary),
  ].filter((value): value is Record<string, unknown> => Boolean(value));
  const remaining = (minutes: number): number | undefined => {
    const window = windows.find((value) => windowMinutes(value) === minutes);
    const used = window?.used_percent;
    return typeof used === "number" && Number.isFinite(used)
      ? 100 - Math.max(0, Math.min(100, used))
      : undefined;
  };
  const status = { fiveHourRemaining: remaining(300), weeklyRemaining: remaining(10_080) };
  return status.fiveHourRemaining === undefined && status.weeklyRemaining === undefined ? undefined : status;
}

function accountIdFromToken(token: string): string | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const claims = record(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")));
    const auth = record(claims?.[AUTH_CLAIM]);
    const accountId = auth?.chatgpt_account_id;
    return typeof accountId === "string" && accountId.trim() ? accountId : undefined;
  } catch {
    return undefined;
  }
}

export async function getUsage(ctx: ExtensionContext): Promise<UsageStatus | undefined> {
  const model = ctx.model;
  if (!model || !isSupportedModel(model)) return undefined;
  try {
    const resolved = await ctx.modelRegistry.getProviderAuth(model.provider);
    const token = resolved?.auth.apiKey;
    if (!token || !canonicalBaseUrl(resolved?.auth.baseUrl ?? model.baseUrl)) return undefined;
    const accountId = accountIdFromToken(token);
    if (!accountId) return undefined;

    const existing = cache.get(accountId);
    if (existing && existing.expiresAt > Date.now()) return existing.value;
    if (existing?.pending) return existing.pending;

    const entry = existing ?? { expiresAt: 0 };
    const previous = entry.value;
    entry.pending = (async () => {
      try {
        const response = await fetch(`${BASE_URL}/wham/usage`, {
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            "chatgpt-account-id": accountId,
            "OAI-Language": "en",
            originator: "pi",
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) return previous;
        entry.value = parseUsage(await response.json()) ?? previous;
        entry.expiresAt = Date.now() + CACHE_MS;
        return entry.value;
      } catch {
        return previous;
      } finally {
        entry.pending = undefined;
      }
    })();
    cache.set(accountId, entry);
    return entry.pending;
  } catch {
    return undefined;
  }
}

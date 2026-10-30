// Per-process completed-call ledgers. Readers combine the last 24 hours;
// independent writers never overwrite another session's usage.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultHarnessDir, inferModelFamily } from "./quota-sync.ts";

export const USAGE_WINDOW_MS = 24 * 60 * 60_000;
const MAX_EVENTS = 20_000;
const ledgerName = `${process.pid}-${randomUUID()}.json`;

interface UsageEvent {
  t: number;
  family: string;
  provider: string;
  model: string;
}

export function defaultUsagePath(): string {
  // Separate from the old routed-turn ledger: those entries are not calls.
  return join(defaultHarnessDir(), "hydra-calls");
}

function readEvents(path: string, now: number): UsageEvent[] {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (raw?.schema !== 1 || !Array.isArray(raw.events)) return [];
    return raw.events.filter(
      (e: unknown): e is UsageEvent =>
        !!e &&
        typeof (e as UsageEvent).t === "number" &&
        typeof (e as UsageEvent).family === "string" &&
        (e as UsageEvent).t <= now &&
        now - (e as UsageEvent).t < USAGE_WINDOW_MS,
    );
  } catch {
    return [];
  }
}

/** Actual completed-call counts, not planned routes or user turns. */
export function readUsageCounts(path = defaultUsagePath(), now = Date.now()): Record<string, number> {
  const counts: Record<string, number> = {};
  try {
    if (!existsSync(path)) return counts;
    for (const file of readdirSync(path)) {
      if (!file.endsWith(".json")) continue;
      const fullPath = join(path, file);
      if (now - statSync(fullPath).mtimeMs >= USAGE_WINDOW_MS) continue;
      for (const e of readEvents(fullPath, now)) counts[e.family] = (counts[e.family] ?? 0) + 1;
    }
  } catch {
    // Telemetry must not block routing.
  }
  return counts;
}

export function recordHydraUsage(
  provider: string,
  modelId: string,
  path = defaultUsagePath(),
  now = Date.now(),
): void {
  try {
    const ledger = join(path, ledgerName);
    const events = readEvents(ledger, now);
    events.push({ t: now, family: inferModelFamily(provider, modelId), provider, model: modelId });
    mkdirSync(path, { recursive: true });
    const tmp = `${ledger}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ schema: 1, events: events.slice(-MAX_EVENTS) })}\n`, "utf8");
    renameSync(tmp, ledger);
  } catch {
    // Usage tracking must never block a call.
  }
}

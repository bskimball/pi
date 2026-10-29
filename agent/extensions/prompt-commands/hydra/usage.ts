// Rolling per-subscription usage ledger for Hydra load balancing.
//
// Records which model family served each routed turn over the last 24 hours so
// the scorer can steer work toward under-used subscriptions. Concurrent
// sessions may occasionally drop an event on a write race; the balance signal
// is approximate by design.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultHarnessDir, inferModelFamily } from "./quota-sync.ts";

export const USAGE_WINDOW_MS = 24 * 60 * 60_000;
const MAX_EVENTS = 2_000;

interface UsageEvent {
  t: number;
  family: string;
}

export function defaultUsagePath(): string {
  return join(defaultHarnessDir(), "hydra-usage.json");
}

function readEvents(path: string, now: number): UsageEvent[] {
  try {
    if (!existsSync(path)) return [];
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || !Array.isArray(raw.events)) return [];
    return raw.events.filter(
      (e: unknown): e is UsageEvent =>
        !!e &&
        typeof (e as UsageEvent).t === "number" &&
        typeof (e as UsageEvent).family === "string" &&
        now - (e as UsageEvent).t < USAGE_WINDOW_MS,
    );
  } catch {
    return [];
  }
}

/** Routed-turn counts per model family within the rolling window. */
export function readUsageCounts(path = defaultUsagePath(), now = Date.now()): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of readEvents(path, now)) counts[e.family] = (counts[e.family] ?? 0) + 1;
  return counts;
}

export function recordHydraUsage(
  provider: string,
  modelId: string,
  path = defaultUsagePath(),
  now = Date.now(),
): void {
  try {
    const events = readEvents(path, now);
    events.push({ t: now, family: inferModelFamily(provider, modelId) });
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${now}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ schema: 1, events: events.slice(-MAX_EVENTS) })}\n`, "utf8");
    renameSync(tmp, path);
  } catch {
    // Usage tracking must never block a turn.
  }
}

// Pure concurrency bound. No Pi imports.

// Full Pi subprocesses are expensive on Windows. The shared bounded setting
// defaults to five; larger fan-outs queue rather than oversubscribing.
const DEFAULT_MAX_CONCURRENT = 5;
const MAX_CONFIGURED_CONCURRENT = 8;
export function configuredSyncTaskLimit(
  raw = process.env.PI_TASK_MAX_WORKERS,
): number {
  if (!raw?.trim()) return DEFAULT_MAX_CONCURRENT;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= MAX_CONFIGURED_CONCURRENT
    ? value
    : DEFAULT_MAX_CONCURRENT;
}

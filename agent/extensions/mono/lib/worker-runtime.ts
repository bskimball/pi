// worker-runtime: policy and state predicates for async RPC workers.
// Process/RPC lifecycle and task tools remain in async-task.ts.

export const MAX_LIVE_WORKERS = 3;
export const MAX_SETTLED_META = 24;
export const MODEL_IDLE_MS = 300_000;
export const TOOL_IDLE_MS = 900_000;
export const RETRY_COMPACT_BUDGET_MS = 600_000;

export type WorkerLifecycle =
  | "starting"
  | "running"
  | "retrying"
  | "compacting"
  | "settled"
  | "aborting"
  | "failed"
  | "closed";

export type WorkerPhase = "model" | "tool" | "retry" | "compacting" | "none";

export interface WorkerActivityState {
  runningById: ReadonlyMap<string, unknown>;
  runningAnonymous: readonly unknown[];
}

export interface WorkerStateView {
  lifecycle: WorkerLifecycle;
  phase: WorkerPhase;
  waitingUi: readonly unknown[];
}

export interface CapWorker {
  countsTowardCap: boolean;
  closed: boolean;
}

export function isLiveLifecycle(lifecycle: WorkerLifecycle): boolean {
  return (
    lifecycle === "starting" ||
    lifecycle === "running" ||
    lifecycle === "retrying" ||
    lifecycle === "compacting" ||
    lifecycle === "aborting"
  );
}

export function hasActiveTools(worker: WorkerActivityState): boolean {
  return worker.runningById.size > 0 || worker.runningAnonymous.length > 0;
}

export function workerStateLabel(view: WorkerStateView): string {
  if (view.waitingUi.length) return "waiting for reply";
  if (view.lifecycle === "running") {
    if (view.phase === "tool") return "tool";
    if (view.phase === "model") return "thinking";
  }
  return view.lifecycle;
}

export function countLiveWorkers(workers: Iterable<CapWorker>): number {
  let count = 0;
  for (const worker of workers) {
    if (worker.countsTowardCap && !worker.closed) count++;
  }
  return count;
}

export function canStartWorker(workers: Iterable<CapWorker>): boolean {
  return countLiveWorkers(workers) < MAX_LIVE_WORKERS;
}

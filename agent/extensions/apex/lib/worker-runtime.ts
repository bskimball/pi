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

export interface ModelFallbackState {
  hasNextAttempt: boolean;
  fallbackInProgress: boolean;
  killReason?: string;
  resultText?: string;
  modelError?: string;
  activitiesStarted: number;
}

const MODEL_FALLBACK_ERROR_PATTERN =
  /\b(?:auth[_ -]?unavailable|no auth available|no api key(?: found)?|unauthori[sz]ed|forbidden|authentication(?: failed| unavailable)?|invalid api key|model (?:not found|unavailable)|provider (?:unavailable|returned (?:an )?error)|overloaded|rate.?limit(?:ed)?|too many requests|service.?unavailable|server.?error|internal.?error|(?:http\s*)?(?:429|500|502|503|504|524))\b/i;

/** True only for terminal provider/model failures where another configured
 * model can reasonably succeed. Tool, implementation, context, and control
 * failures must remain attached to the attempted model and never be replayed.
 */
export function isModelFallbackError(message: string | undefined): boolean {
  return !!message?.trim() && MODEL_FALLBACK_ERROR_PATTERN.test(message);
}

/**
 * Retry only clean model/provider failures. Once a worker has produced visible
 * output or started a tool, replaying its prompt could duplicate real work.
 */
export function shouldRetryModelFallback(state: ModelFallbackState): boolean {
  return (
    state.hasNextAttempt &&
    !state.fallbackInProgress &&
    !state.killReason &&
    !state.resultText?.trim() &&
    isModelFallbackError(state.modelError) &&
    state.activitiesStarted === 0
  );
}

export function splitQualifiedModel(
  model: string | undefined,
): { provider: string; modelId: string } | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
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

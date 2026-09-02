// worker-runtime: async RPC worker control plane.
//
// Owns registry/capacity, bounded errors, activity closure, subscriber
// invalidation, timers, idle phase policy, generation settlement, RPC event
// transitions, cooperative abort, escalation, and process-tree force kill.
// async-task.ts supplies model/circuit and Pi-notification policy through hooks
// and owns the task_* tool adapters.

import { ActivityLedger, type ActivityStatus } from "./activity-ledger.ts";
import { JobRegistry } from "./job-registry.ts";
import { killProcessTree } from "./process-tree-kill.ts";

export const DEFAULT_MAX_LIVE_WORKERS = 5;
export const TASK_CONCURRENCY_ENV = "PI_TASK_MAX_WORKERS";
export const MAX_CONFIGURED_WORKERS = 8;

export function configuredWorkerLimit(
  raw = process.env[TASK_CONCURRENCY_ENV],
): number {
  if (!raw?.trim()) return DEFAULT_MAX_LIVE_WORKERS;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= MAX_CONFIGURED_WORKERS
    ? value
    : DEFAULT_MAX_LIVE_WORKERS;
}

export const MAX_LIVE_WORKERS = configuredWorkerLimit();
export const MAX_SETTLED_META = 24;
export const MODEL_IDLE_MS = 300_000;
export const TOOL_IDLE_MS = 900_000;
export const RETRY_COMPACT_BUDGET_MS = 600_000;
/** Stored assistant/result preview. Full child output lives in the worker session file. */
export const LATEST_RESULT_CHARS = 12_000;

function storeLatestText(text: string): string {
  if (text.length <= LATEST_RESULT_CHARS) return text;
  return text.slice(text.length - LATEST_RESULT_CHARS);
}

function appendLatestText(current: string, next: string): string {
  if (!next) return current;
  if (next.length >= LATEST_RESULT_CHARS) {
    return next.slice(next.length - LATEST_RESULT_CHARS);
  }
  if (current.length + next.length <= LATEST_RESULT_CHARS) return current + next;
  return current.slice(current.length - (LATEST_RESULT_CHARS - next.length)) + next;
}

function extractTextDelta(event: Record<string, unknown>): string {
  const update = event.assistantMessageEvent;
  if (!update || typeof update !== "object") return "";
  const delta = (update as { type?: string; delta?: unknown }).delta;
  if ((update as { type?: string }).type !== "text_delta" || typeof delta !== "string") {
    return "";
  }
  return delta.length > LATEST_RESULT_CHARS
    ? delta.slice(delta.length - LATEST_RESULT_CHARS)
    : delta;
}

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

export interface RuntimeClient {
  pid?: number;
  isClosed: boolean;
  request(
    command: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{ success: boolean }>;
  closeStdin(): void;
}

export interface RuntimeWorker extends CapWorker {
  lifecycle: WorkerLifecycle;
  phase: WorkerPhase;
  updatedAt: number;
  /** Monotonic renderer invalidation token; advances with each published state. */
  renderVersion: number;
  lastEventAt?: number;
  idleTimer?: NodeJS.Timeout;
  hardTimer?: NodeJS.Timeout;
  abortTimer?: NodeJS.Timeout;
  fallbackEpoch: number;
  fallbackInProgress: boolean;
  fallbackAwaitingAgentStart: boolean;
  killReason?: string;
  pid?: number;
  client?: RuntimeClient;
  ledger: ActivityLedger;
  errors: string[];
  subscribers?: Set<() => void>;
  pinnedInvalidate?: () => void;
}

export interface RuntimePendingUiRequest {
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  receivedAt: number;
  expectsReply: boolean;
}

export interface RuntimeEventWorker extends RuntimeWorker {
  generation: number;
  generationStartedAt: number;
  generationSettledAt?: number;
  turns: number;
  maxTurns: number;
  pendingSteer: number;
  pendingFollowUp: number;
  pendingUi: Map<string, RuntimePendingUiRequest>;
  latestAssistantText: string;
  latestResult: string;
  modelError?: string;
  modelAttemptUsedTools: boolean;
  circuitFailureAttempt?: number;
  exitCode: number | null;
}

export type RuntimeFallbackResult = "retried" | "exhausted" | "cancelled";

export interface WorkerRuntimeEventHooks<TWorker extends RuntimeEventWorker> {
  normalizeToolName(name: unknown): string;
  summarizeToolArgs(args: unknown): string;
  extractAssistantText(message: object): string;
  shouldRetryFallback(worker: TWorker): boolean;
  retryFallback(worker: TWorker): Promise<RuntimeFallbackResult>;
  onSuccessfulSettlement?(worker: TWorker): void;
  onFailedSettlement?(worker: TWorker): void;
  beforeSettlementNotify?(worker: TWorker): void;
  afterSettlementNotify?(worker: TWorker): void;
}

export interface SettleGenerationOptions {
  error?: string;
  killReason?: string;
}

export interface WorkerRuntimeOptions {
  maxErrors?: number;
  maxSettled?: number;
  normalizeError?: (message: string) => string;
  abortGraceMs?: number;
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

function isTerminalLifecycle(lifecycle: WorkerLifecycle): boolean {
  return lifecycle === "settled" || lifecycle === "failed" || lifecycle === "closed";
}

export class WorkerRuntime<TWorker extends RuntimeWorker> {
  readonly workers = new JobRegistry<TWorker>();
  private readonly maxErrors: number;
  private readonly maxSettled: number;
  private readonly normalizeError: (message: string) => string;
  private readonly abortGraceMs: number;

  constructor(options: WorkerRuntimeOptions = {}) {
    this.maxErrors = Math.max(1, options.maxErrors ?? 12);
    this.maxSettled = Math.max(0, options.maxSettled ?? MAX_SETTLED_META);
    this.normalizeError = options.normalizeError ?? ((message) => message);
    this.abortGraceMs = Math.max(1, options.abortGraceMs ?? 5_000);
  }

  liveCount(): number {
    return countLiveWorkers(this.workers.values());
  }

  canStart(): boolean {
    return canStartWorker(this.workers.values());
  }

  pruneSettled(): void {
    this.workers.pruneSettled(
      (worker) => isTerminalLifecycle(worker.lifecycle) && !worker.countsTowardCap,
      this.maxSettled,
    );
  }

  notify(worker: TWorker): void {
    worker.renderVersion += 1;
    try {
      worker.pinnedInvalidate?.();
    } catch {
      // Presentation invalidation must never break worker control.
    }
    for (const subscriber of worker.subscribers ?? []) {
      try {
        subscriber();
      } catch {
        // Subscriber errors are isolated from lifecycle state.
      }
    }
  }

  touch(worker: TWorker): void {
    worker.updatedAt = Date.now();
    worker.lastEventAt = worker.updatedAt;
  }

  pushError(worker: TWorker, message: string): void {
    worker.errors.push(this.normalizeError(message));
    if (worker.errors.length > this.maxErrors) {
      worker.errors.splice(0, worker.errors.length - this.maxErrors);
    }
  }

  closeActivities(
    worker: TWorker,
    status: ActivityStatus = "completed",
  ): void {
    worker.ledger.closeAll(status);
  }

  clearIdle(worker: TWorker): void {
    if (!worker.idleTimer) return;
    clearTimeout(worker.idleTimer);
    worker.idleTimer = undefined;
  }

  clearHard(worker: TWorker): void {
    if (!worker.hardTimer) return;
    clearTimeout(worker.hardTimer);
    worker.hardTimer = undefined;
  }

  clearAbort(worker: TWorker): void {
    if (!worker.abortTimer) return;
    clearTimeout(worker.abortTimer);
    worker.abortTimer = undefined;
  }

  clearTimers(worker: TWorker): void {
    this.clearIdle(worker);
    this.clearHard(worker);
    this.clearAbort(worker);
  }

  armHard(worker: TWorker, timeoutMs: number): void {
    this.clearHard(worker);
    worker.hardTimer = setTimeout(() => {
      this.forceKill(worker, `exceeded ${timeoutMs / 1000}s time limit`);
    }, timeoutMs);
    worker.hardTimer.unref?.();
  }

  forceKill(worker: TWorker, reason: string): void {
    if (worker.closed) return;
    worker.fallbackEpoch += 1;
    worker.fallbackInProgress = false;
    worker.fallbackAwaitingAgentStart = false;
    worker.killReason = worker.killReason ?? reason;
    const pid = worker.pid ?? worker.client?.pid;
    if (pid != null) killProcessTree(pid);
    try {
      worker.client?.closeStdin();
    } catch {
      // Ignore close races after process termination.
    }
    this.notify(worker);
  }

  armIdle(worker: TWorker): void {
    this.clearIdle(worker);
    if (
      worker.closed ||
      isTerminalLifecycle(worker.lifecycle) ||
      worker.lifecycle === "starting"
    ) {
      worker.phase = "none";
      return;
    }
    if (worker.lifecycle === "retrying" || worker.lifecycle === "compacting") {
      worker.phase = worker.lifecycle === "retrying" ? "retry" : "compacting";
      worker.idleTimer = setTimeout(() => {
        this.forceKill(
          worker,
          `retry/compacting budget exceeded (${RETRY_COMPACT_BUDGET_MS / 1000}s)`,
        );
      }, RETRY_COMPACT_BUDGET_MS);
      worker.idleTimer.unref?.();
      return;
    }
    if (worker.lifecycle === "aborting") {
      worker.phase = "none";
      return;
    }
    const toolPhase = worker.ledger.hasActiveTools();
    worker.phase = toolPhase ? "tool" : "model";
    const budgetMs = toolPhase ? TOOL_IDLE_MS : MODEL_IDLE_MS;
    worker.idleTimer = setTimeout(() => {
      this.forceKill(
        worker,
        `idle for ${budgetMs / 1000}s${toolPhase ? " during tool execution" : ""}`,
      );
    }, budgetMs);
    worker.idleTimer.unref?.();
  }

  settleGeneration<TEventWorker extends TWorker & RuntimeEventWorker>(
    worker: TEventWorker,
    lifecycle: "settled" | "failed",
    options: SettleGenerationOptions = {},
    hooks?: WorkerRuntimeEventHooks<TEventWorker>,
  ): boolean {
    if (worker.closed || isTerminalLifecycle(worker.lifecycle)) return false;
    worker.fallbackEpoch += 1;
    worker.fallbackInProgress = false;
    worker.fallbackAwaitingAgentStart = false;
    this.clearIdle(worker);
    this.clearAbort(worker);
    this.closeActivities(
      worker,
      lifecycle === "failed" || options.killReason ? "error" : "completed",
    );
    worker.lifecycle = lifecycle;
    worker.generationSettledAt = Date.now();
    worker.phase = "none";
    worker.pendingSteer = 0;
    worker.pendingFollowUp = 0;
    if (options.error) this.pushError(worker, options.error);
    if (options.killReason) worker.killReason = options.killReason;
    if (!worker.latestResult && worker.latestAssistantText) {
      worker.latestResult = worker.latestAssistantText;
    }
    if (lifecycle === "settled" && !worker.killReason) {
      hooks?.onSuccessfulSettlement?.(worker);
    } else if (lifecycle === "failed") {
      hooks?.onFailedSettlement?.(worker);
    }
    worker.updatedAt = Date.now();
    hooks?.beforeSettlementNotify?.(worker);
    this.notify(worker);
    hooks?.afterSettlementNotify?.(worker);
    return true;
  }

  handleExit<TEventWorker extends TWorker & RuntimeEventWorker>(
    worker: TEventWorker,
    exitCode: number | null,
    error: string,
    hooks?: WorkerRuntimeEventHooks<TEventWorker>,
  ): void {
    worker.exitCode = exitCode;
    worker.pid = undefined;
    this.clearTimers(worker);
    worker.fallbackEpoch += 1;
    worker.fallbackInProgress = false;
    worker.fallbackAwaitingAgentStart = false;
    // Publish process ownership atomically with settlement. Subscribers must
    // never observe a failed worker that still appears to hold capacity or a
    // live client after the process has already exited.
    worker.countsTowardCap = false;
    worker.client = undefined;
    if (worker.closed) {
      this.pruneSettled();
      return;
    }
    if (!isTerminalLifecycle(worker.lifecycle)) {
      this.settleGeneration(
        worker,
        "failed",
        { error: worker.killReason ?? error, killReason: worker.killReason },
        hooks,
      );
    } else {
      this.notify(worker);
    }
    this.pruneSettled();
  }

  startGeneration<TEventWorker extends TWorker & RuntimeEventWorker>(
    worker: TEventWorker,
  ): void {
    worker.generation += 1;
    worker.generationStartedAt = Date.now();
    worker.generationSettledAt = undefined;
    worker.turns = 0;
    worker.pendingSteer = 0;
    worker.pendingFollowUp = 0;
    worker.pendingUi.clear();
    worker.latestAssistantText = "";
    worker.latestResult = "";
    worker.modelError = undefined;
    worker.circuitFailureAttempt = undefined;
    worker.modelAttemptUsedTools = false;
    worker.fallbackInProgress = false;
    worker.fallbackAwaitingAgentStart = false;
    worker.fallbackEpoch += 1;
    worker.killReason = undefined;
    worker.exitCode = null;
    worker.lifecycle = "running";
    this.touch(worker);
    this.armIdle(worker);
  }

  handleEvent<TEventWorker extends TWorker & RuntimeEventWorker>(
    worker: TEventWorker,
    event: Record<string, unknown>,
    hooks: WorkerRuntimeEventHooks<TEventWorker>,
  ): void {
    if (worker.closed) return;
    const type = String(event.type ?? "");
    this.touch(worker);

    switch (type) {
      case "agent_start": {
        if (worker.fallbackAwaitingAgentStart) {
          worker.fallbackAwaitingAgentStart = false;
        }
        if (worker.lifecycle === "settled" || worker.lifecycle === "failed") {
          // A queued follow-up from either terminal state starts a full new
          // generation just like an explicit prompt. Do not leak prior
          // result/error/tool/UI state across it.
          this.startGeneration(worker);
        } else {
          if (worker.lifecycle !== "aborting") worker.lifecycle = "running";
          this.armIdle(worker);
        }
        break;
      }
      case "agent_end": {
        this.armIdle(worker);
        break;
      }
      case "agent_settled": {
        if (worker.lifecycle === "aborting") {
          this.settleGeneration(
            worker,
            "settled",
            { killReason: worker.killReason ?? "aborted" },
            hooks,
          );
          return;
        } else if (
          worker.fallbackInProgress ||
          worker.fallbackAwaitingAgentStart
        ) {
          break;
        } else if (worker.lifecycle !== "failed") {
          if (hooks.shouldRetryFallback(worker)) {
            const generation = worker.generation;
            void hooks.retryFallback(worker).then((result) => {
              if (
                result === "exhausted" &&
                worker.generation === generation &&
                !isTerminalLifecycle(worker.lifecycle)
              ) {
                this.settleGeneration(
                  worker,
                  "failed",
                  {
                    error:
                      worker.modelError ?? "configured model fallbacks exhausted",
                  },
                  hooks,
                );
              }
            });
            return;
          } else if (
            worker.modelError &&
            !worker.killReason &&
            !worker.latestResult &&
            !worker.latestAssistantText &&
            !worker.modelAttemptUsedTools
          ) {
            this.settleGeneration(
              worker,
              "failed",
              { error: worker.modelError },
              hooks,
            );
            return;
          } else {
            this.settleGeneration(worker, "settled", {}, hooks);
            return;
          }
        }
        break;
      }
      case "turn_start": {
        worker.turns += 1;
        if (worker.turns > worker.maxTurns) {
          this.clearIdle(worker);
          this.forceKill(worker, `exceeded ${worker.maxTurns} turns`);
          return;
        }
        this.armIdle(worker);
        break;
      }
      case "tool_execution_start": {
        worker.modelAttemptUsedTools = true;
        const callId =
          event.toolCallId == null ? undefined : String(event.toolCallId);
        worker.ledger.start(
          hooks.normalizeToolName(event.toolName),
          hooks.summarizeToolArgs(event.args),
          callId,
        );
        if (worker.lifecycle === "running") this.armIdle(worker);
        break;
      }
      case "tool_execution_end": {
        const callId =
          event.toolCallId == null ? undefined : String(event.toolCallId);
        worker.ledger.end(callId, Boolean(event.isError));
        if (worker.lifecycle === "running") this.armIdle(worker);
        break;
      }
      case "message_update": {
        const delta = extractTextDelta(event);
        if (delta) {
          worker.latestAssistantText = appendLatestText(
            worker.latestAssistantText,
            delta,
          );
          worker.latestResult = worker.latestAssistantText;
        }
        break;
      }
      case "message_end": {
        const message = event.message;
        if (message && typeof message === "object") {
          const assistant = message as {
            role?: string;
            stopReason?: string;
            errorMessage?: string;
          };
          if (assistant.role === "assistant") {
            const text = hooks.extractAssistantText(message);
            if (text) {
              worker.latestAssistantText = storeLatestText(text);
              worker.latestResult = worker.latestAssistantText;
            }
            if (assistant.stopReason === "error" || assistant.errorMessage) {
              const error = String(
                assistant.errorMessage ?? "provider/model error",
              );
              worker.modelError = error;
              this.pushError(worker, error);
            }
          }
        }
        if (isLiveLifecycle(worker.lifecycle)) this.armIdle(worker);
        break;
      }
      case "auto_retry_start": {
        worker.lifecycle = "retrying";
        this.armIdle(worker);
        break;
      }
      case "auto_retry_end": {
        if (event.success === false) {
          this.pushError(worker, String(event.finalError ?? "auto-retry failed"));
        }
        if (worker.lifecycle === "retrying") worker.lifecycle = "running";
        this.armIdle(worker);
        break;
      }
      case "compaction_start": {
        worker.lifecycle = "compacting";
        this.armIdle(worker);
        break;
      }
      case "compaction_end": {
        if (event.aborted) {
          this.pushError(worker, "compaction aborted");
        } else if (event.errorMessage) {
          this.pushError(worker, String(event.errorMessage));
        }
        if (worker.lifecycle === "compacting") worker.lifecycle = "running";
        this.armIdle(worker);
        break;
      }
      case "queue_update": {
        worker.pendingSteer = Array.isArray(event.steering)
          ? event.steering.length
          : 0;
        worker.pendingFollowUp = Array.isArray(event.followUp)
          ? event.followUp.length
          : 0;
        break;
      }
      case "extension_error": {
        this.pushError(worker, `extension_error: ${String(event.error ?? "")}`);
        break;
      }
      case "extension_ui_request": {
        const id = typeof event.id === "string" ? event.id : undefined;
        const method = String(event.method ?? "");
        if (!id || !method) break;
        const expectsReply = new Set(["select", "confirm", "input", "editor"]).has(
          method,
        );
        if (expectsReply) {
          worker.pendingUi.set(id, {
            id,
            method,
            title: typeof event.title === "string" ? event.title : undefined,
            message:
              typeof event.message === "string" ? event.message : undefined,
            options: Array.isArray(event.options)
              ? event.options.map(String)
              : undefined,
            receivedAt: Date.now(),
            expectsReply,
          });
        }
        break;
      }
      default: {
        if (
          isLiveLifecycle(worker.lifecycle) &&
          worker.lifecycle === "running" &&
          type !== "message_update" &&
          type !== "tool_execution_update" &&
          type !== "bash_execution_update"
        ) {
          this.armIdle(worker);
        }
        break;
      }
    }
    // Streaming deltas do not change pinned-card or task_wait status text.
    // Pushing every token/output chunk through onUpdate rebuilds the parent
    // tool-result surface and can native-abort Windows ConPTY / V8.
    const isStreamingDelta =
      type === "message_update" ||
      type === "tool_execution_update" ||
      type === "bash_execution_update";
    if (!isStreamingDelta) {
      this.notify(worker);
    }
  }

  async abort(worker: TWorker): Promise<{ cooperative: boolean; settled: boolean }> {
    worker.fallbackEpoch += 1;
    worker.fallbackInProgress = false;
    worker.fallbackAwaitingAgentStart = false;
    worker.lifecycle = "aborting";
    worker.killReason = worker.killReason ?? "abort requested";
    this.clearIdle(worker);
    this.notify(worker);

    let cooperative = false;
    if (worker.client && !worker.client.isClosed) {
      try {
        cooperative = (await worker.client.request({ type: "abort" }, 5_000)).success;
      } catch {
        cooperative = false;
      }
    }
    const limit = Date.now() + this.abortGraceMs;
    while (Date.now() < limit && !isTerminalLifecycle(worker.lifecycle)) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const settled = isTerminalLifecycle(worker.lifecycle);
    this.notify(worker);
    return { cooperative, settled };
  }

  async abortAndEscalate(worker: TWorker): Promise<{
    cooperative: boolean;
    settled: boolean;
    escalated: boolean;
    exited: boolean;
  }> {
    const cooperativeResult = await this.abort(worker);
    if (cooperativeResult.settled) {
      return {
        ...cooperativeResult,
        escalated: false,
        exited: worker.client?.isClosed ?? false,
      };
    }
    this.forceKill(worker, "abort force-kill after grace period");
    const deadline = Date.now() + this.abortGraceMs;
    while (
      Date.now() < deadline &&
      worker.countsTowardCap &&
      !worker.client?.isClosed
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const exited = !worker.countsTowardCap || worker.client?.isClosed === true;
    this.notify(worker);
    return {
      cooperative: cooperativeResult.cooperative,
      settled: isTerminalLifecycle(worker.lifecycle),
      escalated: true,
      exited,
    };
  }
}

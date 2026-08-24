// async-task: session-backed bidirectional RPC sub-agents.
//
// Tools: task_start, task_rebind, task_status, task_list, task_send, task_wait,
//        task_abort, task_close, task_reply, task_chain.
// Additive to the existing synchronous `task` tool in amp-task.ts.
// Plain bounded tool results only — no custom TUI renderers or render timers.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import {
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  agentParamDescription,
  composeSpecialistSharedPrompts,
  discoverAgents,
  modelAttempts,
  stderrDiagnostic,
  type AgentDef,
} from "./runtime/agent-discovery.ts";
import {
  argsSummary,
  missionFromPrompt,
} from "./presentation/task-view.ts";
import {
  installTaskRenderSafety,
  paintTaskPinnedSurface,
} from "./presentation/render-safety.ts";
import { writeLastPhase } from "./runtime/last-phase.ts";
import { RpcClient } from "./runtime/rpc-client.ts";
import {
  createWorkerIdentity,
  findWorkerByHandle,
  findWorkerByInstance,
} from "./runtime/worker-identity.ts";
import {
  classifyWorkerSidecar,
  deleteWorkerSidecar,
  isPidAlive,
  listWorkerSidecars,
  writeWorkerSidecar,
  type WorkerSidecar,
} from "./runtime/worker-sidecar.ts";
import {
  killProcessTree,
  killProcessTreeSync,
} from "./runtime/process-tree-kill.ts";
import {
  ActivityLedger,
  type Activity,
} from "./runtime/activity-ledger.ts";
import {
  taskPresentationEnabled,
  withTaskPresentation,
} from "./presentation/presentation.ts";
import {
  textResult,
  resolveCwd,
  validateCwd,
} from "./runtime/tool-result.ts";
import {
  boundExpandedCardText,
  boundText,
  capRenderedCardLines,
  cleanOneLine,
  extractAssistantText,
  formatAge,
  renderedCardCharCount,
} from "./runtime/text-bounds.ts";
import {
  fleetSnapshotKey,
  publishFleetSnapshot,
  type FleetSnapshotItem,
} from "./runtime/fleet-bus.ts";
import { safeTruncateToWidth } from "./presentation/safe-text-layout.ts";
import {
  TREE,
  WidthText,
  fitLine,
  formatDuration,
  textContent,
  type ToolRenderContext,
} from "./presentation/ui-common.ts";
import {
  MAX_LIVE_WORKERS,
  MAX_SETTLED_META,
  isLiveLifecycle,
  shouldRetryModelFallback,
  splitQualifiedModel,
  workerStateLabel,
  WorkerRuntime,
  type RuntimeEventWorker,
  type RuntimeFallbackResult,
  type RuntimePendingUiRequest,
  type WorkerLifecycle,
  type WorkerPhase,
  type WorkerRuntimeEventHooks,
} from "./runtime/worker-runtime.ts";
import {
  getSharedModelCircuitBreaker,
  isQualifyingCircuitFailure,
} from "./runtime/model-circuit-breaker.ts";
import {
  contextCheckpointNote,
  shouldCheckpointTimedOutWait,
} from "./runtime/task-compaction-policy.ts";
import {
  activityRows,
  boundedRailTextLines,
  buildTreeLines,
  type TreeRow,
} from "./presentation/tree-view.ts";
import {
  detailRow,
  emptyStateLines,
  finiteNumber,
  lifecycleKind,
  metaText,
  noteRow,
  previewLines,
  receiptHeader,
  safeLine,
  spanText,
  statusLabel,
  tailLines,
  type StatusKind,
} from "./presentation/status-view.ts";
import { noticeComponent, type NoticeRow } from "./presentation/notice-view.ts";
import { waitForSnapshot } from "./runtime/wait-policy.ts";
import {
  WAIT_DEFAULT_TIMEOUT_SEC,
  SETTLED_RESULT_CHARS,
  formatCompactWorkerStatus,
  formatSettledResult,
  formatWaitHeartbeat,
  type WorkerStatusSnapshot,
} from "./runtime/worker-status.ts";
import {
  evaluateSettledReport,
  parseReportSchema,
  reportInstruction,
  reportStatusLine,
  type ReportStatus,
} from "./runtime/report-schema.ts";
import { assembleChainDigest, substitutePrev } from "./runtime/chain-prev.ts";

// ---------------------------------------------------------------- constants


const MAX_ACTIVITIES = 40;
const MAX_ERRORS = 12;
const STATUS_TEXT_CAP = 4_000;
const STATUS_LINE_CAP = 40;
const DEFAULT_TIMEOUT_SEC = 1800;
const DEFAULT_MAX_TURNS = 30;

const ABORT_GRACE_MS = 5_000;
const PROMPT_ACCEPT_TIMEOUT_MS = 60_000;

/** Follow-up commands carried by every settlement notice, model-side and UI. */
const SETTLED_HINT =
  "Use task_wait for the full bounded report; task_send for follow-up; task_close to reap.";
/** Result preview budget in the settlement notice payload. */
const NOTICE_RESULT_CAP = 400;

/** Tools that must never be available inside a child worker. */
const EXCLUDED_CHILD_TOOLS = [
  "task",
  "task_start",
  "task_rebind",
  "task_status",
  "task_list",
  "task_send",
  "task_wait",
  "task_abort",
  "task_close",
  "task_reply",
  "task_chain",
  "subagent",
  "wait_for_subagents",
  "wait",
].join(",");

export type { WorkerLifecycle } from "./runtime/worker-runtime.ts";
type IdlePhase = WorkerPhase;

interface PendingUiRequest extends RuntimePendingUiRequest {
  /** Fire-and-forget methods never expect a reply. */
  expectsReply: boolean;
}

interface GenerationSnapshot {
  generation: number;
  startedAt: number;
  settledAt?: number;
  turns: number;
  resultText: string;
  errorText?: string;
  exitCode: number | null;
  killReason?: string;
}

interface WorkerView {
  /** Absent only on historical receipts written before durable identities. */
  instanceId?: string;
  id: string;
  agent: string;
  mission: string;
  model?: string;
  thinking?: string;
  lifecycle: WorkerLifecycle;
  phase: IdlePhase;
  generation: number;
  turns: number;
  maxTurns: number;
  createdAt: number;
  lastEventAt?: number;
  pendingSteer: number;
  pendingFollowUp: number;
  activities: Activity[];
  waitingUi: PendingUiRequest[];
  latestText: string;
  killReason?: string;
  countsTowardCap: boolean;
  reportStatus?: ReportStatus;
  cleanupComplete?: boolean;
  cleanupWorkers?: number;
  cleanupMaxWorkers?: number;
}

interface AsyncRenderState {
  hasResult?: boolean;
  startedAt?: number;
}

interface Worker extends RuntimeEventWorker {
  instanceId: string;
  id: string;
  agent: string;
  mission: string;
  cwd: string;
  model?: string;
  thinking?: string;
  initialPrompt: string;
  modelAttempts: Array<string | undefined>;
  modelAttemptIndex: number;
  /** Attempt index whose qualifying failure was already persisted. */
  circuitFailureAttempt?: number;
  fallbackReplaySafe: boolean;
  createdAt: number;
  timeoutMs: number;
  client?: RpcClient;
  sessionDir: string;
  sessionId?: string;
  sessionFile?: string;
  notifiedGeneration: number;
  waiters: Array<{
    generation: number;
    resolve: (snapshot: GenerationSnapshot) => void;
    timer?: NodeJS.Timeout;
  }>;
  /** True once a task_start result surface became this worker's canonical card. */
  hasPinnedSurface?: boolean;
  /** Lifecycle frozen for the canonical work card while process cleanup runs. */
  pinnedLifecycle?: WorkerLifecycle;
  cleanupComplete?: boolean;
  cleanupWorkers?: number;
  cleanupMaxWorkers?: number;
  pendingUi: Map<string, PendingUiRequest>;
  lastPersistedSidecar?: { lifecycle: WorkerLifecycle; generation: number; pid?: number };
  reportSchema?: string;
  parsedReport: Record<string, unknown> | null;
  reportStatus: ReportStatus;
  reportError?: string;
}

// ---------------------------------------------------------------- helpers

function rpcSessionRoot(): string {
  // Isolated under the gitignored Pi runtime sessions tree.
  return path.join(os.homedir(), ".pi", "agent", "sessions", "rpc-workers");
}

function ensureSessionDir(instanceId: string): string {
  const dir = path.join(rpcSessionRoot(), instanceId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}


function renderWorkerCard(
  view: WorkerView,
  theme: any,
  expanded: boolean,
  waiting = false,
): Component {
  return new WidthText((width) => {
    const now = Date.now();
    const state = workerStateLabel(view);
    const stateColor =
      view.lifecycle === "failed" || view.lifecycle === "closed"
        ? "error"
        : view.lifecycle === "settled"
          ? "success"
          : view.waitingUi.length || view.lifecycle === "retrying"
            ? "warning"
            : "accent";
    const meta = [
      view.model,
      view.thinking && `think:${view.thinking}`,
      `gen:${view.generation}`,
      `${view.turns}/${view.maxTurns} turns`,
    ]
      .filter(Boolean)
      .join(" · ");
    const left = `${theme.fg("dim", TREE.header)} ${theme.fg("dim", view.id)} ${theme.fg("accent", view.agent)}${meta ? ` ${theme.fg("dim", `(${meta})`)}` : ""}  ${theme.fg("text", view.mission)}`;
    const elapsed = formatDuration(now - view.createdAt);
    const lines = [
      fitLine(
        left,
        `${theme.fg(stateColor, state)} ${theme.fg("dim", elapsed)}`,
        width,
      ),
    ];

    // Children are accumulated first so exactly one actual final child can own
    // TREE.last; every earlier child keeps TREE.branch.
    const rows: TreeRow[] = [];

    rows.push(
      ...activityRows(theme, width, view.activities, {
        expanded,
        collapsedLimit: 4,
        expandedLimit: 16,
        now,
      }),
    );

    if (view.waitingUi.length) {
      const request = view.waitingUi[0];
      rows.push({
        line: (rail) =>
          safeTruncateToWidth(
            `${theme.fg("dim", rail)} ${theme.fg("warning", "?")} ${theme.fg("text", cleanOneLine(request.title || request.message || request.method, 160))} ${theme.fg("dim", `[${request.id}]`)}`,
            width,
          ),
      });
    }
    if (view.pendingSteer || view.pendingFollowUp) {
      rows.push({
        line: (rail) =>
          safeTruncateToWidth(
            `${theme.fg("dim", rail)}${TREE.hang}${theme.fg("muted", `queued: ${view.pendingSteer} steer · ${view.pendingFollowUp} follow-up`)}`,
            width,
          ),
      });
    }

    // The latest-text preview hangs off the child above it rather than
    // becoming its own branch, so it can never own the terminal edge.
    let headerPreview: string[] | undefined;
    if (expanded && view.latestText) {
      const preview = boundExpandedCardText(view.latestText, {
        maxChars: 2_400,
        maxLines: 8,
        keep: "tail",
      }).text.split(/\r?\n/);
      if (rows.length) rows[rows.length - 1].continuation = preview;
      else headerPreview = preview;
    }

    if (view.killReason) {
      rows.push({
        line: (rail) =>
          safeTruncateToWidth(
            `${theme.fg("dim", rail)} ${theme.fg("error", "×")} ${theme.fg("error", cleanOneLine(view.killReason, 180))}`,
            width,
          ),
      });
    } else if (waiting && !["settled", "failed", "closed"].includes(view.lifecycle)) {
      rows.push({
        line: (rail) =>
          safeTruncateToWidth(
            `${theme.fg("dim", rail)}${TREE.hang}${theme.fg("muted", "Esc stops waiting; worker continues · task_abort stops it")}`,
            width,
          ),
      });
    } else if (view.cleanupComplete) {
      rows.push({
        line: (rail) =>
          fitLine(
            `${theme.fg("dim", rail)} ${theme.fg("success", "✓")} ${theme.fg("success", "task complete")}`,
            theme.fg(
              "dim",
              `slot released · ${view.cleanupWorkers ?? 0}/${view.cleanupMaxWorkers ?? MAX_LIVE_WORKERS} workers`,
            ),
            width,
          ),
      });
    }
    if (view.reportStatus && view.reportStatus !== "none-requested") {
      rows.push({
        line: (rail) =>
          safeTruncateToWidth(
            `${theme.fg("dim", rail)}${TREE.hang}${theme.fg("muted", reportStatusLine(view.reportStatus!, null))}`,
            width,
          ),
      });
    }

    const assembled = buildTreeLines(
      theme,
      width,
      lines[0],
      rows,
      boundedRailTextLines(theme, width, headerPreview ?? []),
    );
    return expanded ? capRenderedCardLines(assembled) : assembled;
  }, "[async worker display unavailable]");
}

function noteExpandedCardRender(kind: string, lines: readonly string[]): void {
  writeLastPhase(
    `task-card:expand kind=${kind} chars=${renderedCardCharCount(lines)}`,
  );
}

function viewFromDetails(details: unknown): WorkerView | undefined {
  if (!details || typeof details !== "object") return undefined;
  const candidate = (details as { worker?: unknown }).worker ?? details;
  if (!candidate || typeof candidate !== "object") return undefined;
  const view = candidate as WorkerView;
  return typeof view.id === "string" && typeof view.agent === "string"
    ? view
    : undefined;
}

/* ----------------------------------------------------------------
 * Control receipts (task_status / task_list / task_send / task_abort /
 * task_reply). These are deliberately compact: the worker's own story is told
 * by the pinned task_start card, so a control call only reports what it did.
 * Everything is built from structured `details`, never from the human text.
 * ---------------------------------------------------------------- */

function detailRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

interface ControlReceipt {
  id?: string;
  /** Operation/mode being performed: `steer`, `confirm`, `3 live`… */
  operation?: string;
  meta?: string;
  kind: StatusKind;
  /** Outcome word for the right rail (defaults to the kind's label). */
  label?: string;
  /** One short bounded message. */
  message?: string;
  /** Extra dim rows; bounded and only widened when expanded. */
  notes?: readonly string[];
  duration?: string;
}

function controlLines(
  theme: any,
  width: number,
  tool: string,
  receipt: ControlReceipt,
  expanded: boolean,
): string[] {
  const header = receiptHeader(theme, width, {
    tool,
    id: receipt.id,
    subject: receipt.operation,
    meta: receipt.meta,
    kind: receipt.kind,
    label: receipt.label,
    duration: receipt.duration,
    rootGlyph: TREE.receipt,
  });
  const rows: TreeRow[] = [];
  if (receipt.message) {
    rows.push(
      noteRow(
        theme,
        width,
        receipt.message,
        receipt.kind === "failed" ? "error" : "muted",
      ),
    );
  }
  for (const note of (receipt.notes ?? []).slice(0, expanded ? 6 : 2)) {
    rows.push(noteRow(theme, width, note));
  }
  return rows.length ? buildTreeLines(theme, width, header, rows) : [header];
}

/** Compact receipt for a result that carries no usable structured details. */
function controlFallbackLines(
  theme: any,
  width: number,
  tool: string,
  text: unknown,
  isError: boolean,
): string[] {
  const header = receiptHeader(theme, width, {
    tool,
    kind: isError ? "failed" : "unknown",
    rootGlyph: TREE.receipt,
  });
  const lines = tailLines(text, 3, 300);
  if (!lines.length) return [header];
  return [
    header,
    ...previewLines(theme, width, lines, isError ? "error" : "toolOutput"),
  ];
}

/** One-line call row shown while a control tool is in flight. */
function controlCallLine(
  theme: any,
  width: number,
  tool: string,
  args: unknown,
  started: boolean,
): string {
  const raw = detailRecord(args);
  const id = safeLine(raw?.id, 40);
  const operation = safeLine(raw?.mode ?? raw?.request_id, 60);
  return receiptHeader(theme, width, {
    tool,
    id: id || undefined,
    subject: operation || undefined,
    kind: started ? "running" : "queued",
    label: started ? "working" : "queued",
    rootGlyph: TREE.receipt,
  });
}

/**
 * Shared call/result wiring for the control tools: the call row is blanked as
 * soon as a result exists, and every builder runs inside WidthText so a throw
 * degrades to one bounded fallback line.
 */
function controlRenderers(
  tool: string,
  build: (
    result: any,
    theme: any,
    width: number,
    expanded: boolean,
  ) => string[],
) {
  return withTaskPresentation({
    renderShell: "self" as const,
    renderCall(
      args: any,
      theme: any,
      context: ToolRenderContext<AsyncRenderState, any>,
    ): Component {
      if (context.expanded) {
        noteExpandedCardRender(`${tool}-call`, []);
      }
      return new WidthText(
        (width) =>
          context.state.hasResult
            ? []
            : [controlCallLine(theme, width, tool, args, context.executionStarted)],
        `[${tool} call unavailable]`,
      );
    },
    renderResult(
      result: any,
      options: { expanded: boolean; isPartial: boolean },
      theme: any,
      context: ToolRenderContext<AsyncRenderState, any>,
    ): Component {
      context.state.hasResult = true;
      return new WidthText((width) => {
        const expandedNow = context.expanded || options.expanded;
        const lines = build(result, theme, width, expandedNow);
        const out = expandedNow ? capRenderedCardLines(lines) : lines;
        if (expandedNow) noteExpandedCardRender(tool, out);
        return out;
      }, `[${tool} result unavailable]`);
    },
  });
}

/** Map a control outcome word onto the shared status vocabulary. */
function outcomeKind(outcome: string): StatusKind {
  switch (outcome) {
    case "accepted":
    case "delivered":
    case "cancelled":
    case "settled":
      return "succeeded";
    case "queued":
      return "waiting";
    case "rejected":
    case "failed":
    case "escalated":
    case "unconfirmed":
      return "failed";
    case "noop":
      return "unknown";
    default:
      return "unknown";
  }
}

function renderLaunchReceipt(view: WorkerView, theme: any): Component {
  return new WidthText((width) => {
    const state =
      view.lifecycle === "failed" || view.lifecycle === "closed"
        ? theme.fg("error", view.lifecycle)
        : theme.fg("success", view.id === "starting" ? "starting" : "started");
    const left = `${theme.fg("dim", TREE.header)} ${theme.fg("dim", "async")} ${theme.fg("accent", view.agent)} ${theme.fg("text", view.id)}  ${theme.fg("text", view.mission)}`;
    const hint =
      view.id === "starting"
        ? state
        : `${state} ${theme.fg("dim", `· task_wait ${view.id} for live progress`)}`;
    return [fitLine(left, hint, width)];
  }, "[async worker launch unavailable]");
}

// ---------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
  if (taskPresentationEnabled()) installTaskRenderSafety();
  const agents = discoverAgents();
  const agentList = [...agents.values()]
    .map((agent) => `- ${agent.name}: ${agent.description}`)
    .join("\n");

  const runtime = new WorkerRuntime<Worker>({
    maxErrors: MAX_ERRORS,
    maxSettled: MAX_SETTLED_META,
    normalizeError: (message) => cleanOneLine(message, 300),
    abortGraceMs: ABORT_GRACE_MS,
  });
  const workers = runtime.workers;
  const workerByHandle = (id: string): Worker | undefined =>
    findWorkerByHandle(workers.values(), id);
  const workerByInstance = (instanceId: string | undefined): Worker | undefined =>
    findWorkerByInstance(workers, instanceId);
  const compactionReserveTokensByCwd = new Map<string, number>();
  const compactionReserveTokens = (cwd: string): number => {
    const cached = compactionReserveTokensByCwd.get(cwd);
    if (cached !== undefined) return cached;
    const reserveTokens = SettingsManager.create(cwd).getCompactionSettings().reserveTokens;
    compactionReserveTokensByCwd.set(cwd, reserveTokens);
    return reserveTokens;
  };
  let nextId = 1;
  let agentBusy = false;
  let shuttingDown = false;
  let lastFleetKey = "";

  const snapshotFleetItems = (): FleetSnapshotItem[] => {
    const items: FleetSnapshotItem[] = [];
    for (const worker of workers.values()) {
      if (!isLiveLifecycle(worker.lifecycle) || worker.closed) continue;
      items.push({
        id: worker.id,
        agent: worker.agent,
        lifecycle: worker.lifecycle,
        createdAt: worker.createdAt,
        lastEventAt: worker.lastEventAt,
      });
    }
    return items;
  };

  const syncFleetWidget = (_ctx?: ExtensionContext) => {
    const items: FleetSnapshotItem[] = snapshotFleetItems();
    // Fleet consumers remount an Apex widget when a snapshot changes. Keep the
    // key structural: lastEventAt advances for every RPC delta, including the
    // streaming updates deliberately excluded from pinned-card repaint below.
    // Publishing those heartbeats would restore a second full-render path.
    const key = fleetSnapshotKey(items);
    if (key === lastFleetKey) return;
    lastFleetKey = key;
    publishFleetSnapshot(items);
  };

  const liveCount = () => runtime.liveCount();
  const pruneSettled = () => runtime.pruneSettled();
  const persistWorker = (worker: Worker) => {
    if (worker.closed) return;
    const snapshot = {
      lifecycle: worker.lifecycle,
      generation: worker.generation,
      pid: worker.pid,
    };
    if (
      worker.lastPersistedSidecar?.lifecycle === snapshot.lifecycle &&
      worker.lastPersistedSidecar.generation === snapshot.generation &&
      worker.lastPersistedSidecar.pid === snapshot.pid
    ) return;
    try {
      writeWorkerSidecar({
        version: 1,
        instanceId: worker.instanceId,
        id: worker.id,
        agent: worker.agent,
        mission: worker.mission,
        cwd: worker.cwd,
        model: worker.model,
        thinking: worker.thinking,
        sessionDir: worker.sessionDir,
        pid: worker.pid,
        parentPid: process.pid,
        createdAt: worker.createdAt,
        updatedAt: worker.updatedAt,
        lifecycle: worker.lifecycle,
        generation: worker.generation,
        closed: false,
      });
      worker.lastPersistedSidecar = snapshot;
    } catch {
      // Sidecars are durability metadata; a live worker remains usable.
    }
  };
  const notifySubscribers = (worker: Worker) => {
    persistWorker(worker);
    runtime.notify(worker);
  };
  const touch = (worker: Worker) => runtime.touch(worker);
  const pushError = (worker: Worker, message: string) =>
    runtime.pushError(worker, message);
  const closeAllRunning = (
    worker: Worker,
    status: Activity["status"] = "completed",
  ) => runtime.closeActivities(worker, status);
  const clearIdle = (worker: Worker) => runtime.clearIdle(worker);
  const clearHard = (worker: Worker) => runtime.clearHard(worker);
  const clearAbortTimer = (worker: Worker) => runtime.clearAbort(worker);
  const forceKillWorker = (worker: Worker, reason: string) =>
    runtime.forceKill(worker, reason);
  const abortWorkerAndEscalate = (worker: Worker) =>
    runtime.abortAndEscalate(worker);
  const armIdle = (worker: Worker) => runtime.armIdle(worker);

  const resolveWaiters = (worker: Worker, snapshot: GenerationSnapshot) => {
    const matched: Worker["waiters"] = [];
    const remaining: Worker["waiters"] = [];
    for (const waiter of worker.waiters) {
      (waiter.generation === snapshot.generation ? matched : remaining).push(waiter);
    }
    // Detach before invoking callbacks: each waiter cleanup may inspect or
    // mutate worker.waiters, and concurrent waits must never skip one another.
    worker.waiters = remaining;
    for (const waiter of matched) {
      if (waiter.timer) clearTimeout(waiter.timer);
      try {
        waiter.resolve(snapshot);
      } catch {
        // ignore
      }
    }
  };

  const generationSnapshot = (worker: Worker): GenerationSnapshot => ({
    generation: worker.generation,
    startedAt: worker.generationStartedAt,
    settledAt: worker.generationSettledAt,
    turns: worker.turns,
    resultText: worker.latestResult || worker.latestAssistantText,
    errorText: worker.errors[worker.errors.length - 1],
    exitCode: worker.exitCode,
    killReason: worker.killReason,
  });

  const workerStatusSnapshot = (worker: Worker): WorkerStatusSnapshot => ({
    id: worker.id,
    lifecycle: worker.lifecycle,
    agent: worker.agent,
    model: worker.model,
    generation: worker.generation,
    turns: worker.turns,
    maxTurns: worker.maxTurns,
    phase: worker.phase,
    createdAt: worker.createdAt,
    lastEventAt: worker.lastEventAt,
    mission: worker.mission,
    pendingSteer: worker.pendingSteer,
    pendingFollowUp: worker.pendingFollowUp,
    killReason: worker.killReason,
    exitCode: worker.exitCode,
    latestResult: worker.latestResult,
    latestAssistantText: worker.latestAssistantText,
    running: worker.ledger.running(),
    recent: worker.ledger.snapshot(),
    errors: worker.errors,
    waitingUi: [...worker.pendingUi.values()]
      .filter((request) => request.expectsReply)
      .map((request) => ({
        id: request.id,
        method: request.method,
        title: request.title,
      })),
  });

  const workerView = (worker: Worker): WorkerView => ({
    instanceId: worker.instanceId,
    id: worker.id,
    agent: worker.agent,
    mission: worker.mission,
    model: worker.model,
    thinking: worker.thinking,
    lifecycle: worker.lifecycle,
    phase: worker.phase,
    generation: worker.generation,
    turns: worker.turns,
    maxTurns: worker.maxTurns,
    createdAt: worker.createdAt,
    lastEventAt: worker.lastEventAt,
    pendingSteer: worker.pendingSteer,
    pendingFollowUp: worker.pendingFollowUp,
    activities: worker.ledger.snapshot().slice(-16),
    waitingUi: [...worker.pendingUi.values()]
      .filter((request) => request.expectsReply)
      .slice(0, 4)
      .map((request) => ({ ...request, options: request.options?.slice(0, 8) })),
    latestText: boundText(
      worker.latestResult || worker.latestAssistantText,
      STATUS_TEXT_CAP,
      STATUS_LINE_CAP,
    ).text,
    killReason: worker.killReason,
    countsTowardCap: worker.countsTowardCap,
    reportStatus: worker.reportStatus,
    cleanupComplete: worker.cleanupComplete,
    cleanupWorkers: worker.cleanupWorkers,
    cleanupMaxWorkers: worker.cleanupMaxWorkers,
  });

  type ModelFallbackResult = RuntimeFallbackResult;

  /** Persist a clean provider/model availability failure for circuit breaking. */
  const noteCircuitFailure = (worker: Worker) => {
    if (
      worker.killReason ||
      worker.circuitFailureAttempt === worker.modelAttemptIndex ||
      worker.modelAttemptUsedTools ||
      !worker.fallbackReplaySafe ||
      !!(worker.latestResult || worker.latestAssistantText)?.trim()
    ) {
      return;
    }
    const message = worker.modelError;
    if (!isQualifyingCircuitFailure(message)) return;
    try {
      getSharedModelCircuitBreaker().recordFailure(worker.model, message);
      worker.circuitFailureAttempt = worker.modelAttemptIndex;
    } catch {
      // Circuit state is advisory only.
    }
  };

  /** Close the circuit after a successful settled generation. */
  const noteCircuitSuccess = (worker: Worker) => {
    if (worker.killReason || worker.modelError) return;
    try {
      getSharedModelCircuitBreaker().recordSuccess(worker.model);
    } catch {
      // Circuit state is advisory only.
    }
  };

  const retryModelFallback = async (
    worker: Worker,
  ): Promise<ModelFallbackResult> => {
    if (
      !shouldRetryModelFallback({
        hasNextAttempt:
          worker.fallbackReplaySafe &&
          worker.modelAttemptIndex + 1 < worker.modelAttempts.length,
        fallbackInProgress: worker.fallbackInProgress,
        killReason: worker.killReason,
        resultText: worker.latestResult || worker.latestAssistantText,
        modelError: worker.modelError,
        activitiesStarted: worker.modelAttemptUsedTools ? 1 : 0,
      }) ||
      !worker.client ||
      worker.client.isClosed
    ) {
      return "exhausted";
    }

    // Count the clean failure against the model we are leaving, then consult
    // persisted circuits so later tasks skip known-unhealthy candidates.
    noteCircuitFailure(worker);

    const decision = getSharedModelCircuitBreaker().selectAttempt(
      worker.modelAttempts,
      worker.modelAttemptIndex + 1,
    );
    if (decision.index >= worker.modelAttempts.length) {
      return "exhausted";
    }
    const nextIndex = decision.index;
    const nextModel = decision.model;
    if (decision.skipped.length) {
      pushError(
        worker,
        `circuit open; skipped ${decision.skipped.join(", ")}${decision.failSafe ? " (fail-safe retry)" : ""}`,
      );
    }
    const qualified = splitQualifiedModel(nextModel);
    if (!qualified) {
      const label = nextModel ?? "default model";
      worker.modelAttemptIndex = nextIndex;
      worker.model = label;
      worker.modelError = `fallback model must be provider-qualified: ${label}`;
      pushError(worker, worker.modelError);
      notifySubscribers(worker);
      if (nextIndex + 1 >= worker.modelAttempts.length) return "exhausted";
      worker.modelError = "model unavailable";
      return retryModelFallback(worker);
    }

    const client = worker.client;
    const generation = worker.generation;
    const fallbackEpoch = ++worker.fallbackEpoch;
    const ownsFallback = () =>
      !worker.closed &&
      worker.client === client &&
      !client.isClosed &&
      worker.generation === generation &&
      worker.fallbackEpoch === fallbackEpoch &&
      worker.fallbackReplaySafe &&
      !worker.killReason &&
      worker.lifecycle !== "aborting" &&
      worker.lifecycle !== "settled" &&
      worker.lifecycle !== "failed" &&
      worker.lifecycle !== "closed";
    const cancelIfOwned = () => {
      if (worker.fallbackEpoch !== fallbackEpoch) return;
      worker.fallbackInProgress = false;
      worker.fallbackAwaitingAgentStart = false;
      notifySubscribers(worker);
    };

    worker.fallbackInProgress = true;
    worker.fallbackAwaitingAgentStart = true;
    worker.lifecycle = "retrying";
    clearIdle(worker);
    closeAllRunning(worker, "error");
    const previousModel = worker.model ?? "default model";
    const previousError = worker.modelError ?? "provider/model error";
    pushError(
      worker,
      `${previousModel}: ${previousError}; trying fallback ${nextModel}`,
    );
    notifySubscribers(worker);

    try {
      const fresh = await client.request({ type: "new_session" }, 30_000);
      if (!ownsFallback()) {
        cancelIfOwned();
        return "cancelled";
      }
      if (!fresh.success) {
        throw new Error(fresh.error ?? "new session rejected");
      }
      const selected = await client.request(
        {
          type: "set_model",
          provider: qualified.provider,
          modelId: qualified.modelId,
        },
        30_000,
      );
      if (!ownsFallback()) {
        cancelIfOwned();
        return "cancelled";
      }
      if (!selected.success) {
        throw new Error(selected.error ?? `model unavailable: ${nextModel}`);
      }

      worker.modelAttemptIndex = nextIndex;
      worker.model = nextModel;
      worker.modelError = undefined;
      worker.modelAttemptUsedTools = false;
      worker.latestAssistantText = "";
      worker.latestResult = "";
      worker.pendingUi.clear();
      worker.pendingSteer = 0;
      worker.pendingFollowUp = 0;
      worker.lifecycle = "running";
      touch(worker);

      const response = await client.request(
        { type: "prompt", message: worker.initialPrompt },
        PROMPT_ACCEPT_TIMEOUT_MS,
      );
      if (!ownsFallback()) {
        cancelIfOwned();
        return "cancelled";
      }
      if (!response.success) {
        throw new Error(response.error ?? "fallback prompt rejected");
      }
      worker.fallbackInProgress = false;
      armIdle(worker);
      notifySubscribers(worker);
      return "retried";
    } catch (error) {
      if (!ownsFallback()) {
        cancelIfOwned();
        return "cancelled";
      }
      const message = error instanceof Error ? error.message : String(error);
      worker.modelAttemptIndex = nextIndex;
      worker.model = nextModel;
      worker.modelError = message;
      worker.fallbackInProgress = false;
      worker.lifecycle = "running";
      pushError(worker, `${nextModel}: fallback setup failed: ${message}`);
      armIdle(worker);
      notifySubscribers(worker);
      return retryModelFallback(worker);
    }
  };

  const formatWorkerStatus = (worker: Worker): string =>
    formatCompactWorkerStatus(workerStatusSnapshot(worker));

  const formatWorkerWaitStatus = (worker: Worker): string =>
    formatWaitHeartbeat(workerStatusSnapshot(worker));

  const workerNotifyLine = (worker: Worker): string => {
    const result = cleanOneLine(
      worker.latestResult || worker.latestAssistantText || "(no output)",
      200,
    );
    return [
      `${worker.id}: ${worker.lifecycle}`,
      `agent=${worker.agent}`,
      `gen=${worker.generation}`,
      `turns=${worker.turns}`,
      worker.killReason ? `reason=${worker.killReason}` : undefined,
      `result=${result}`,
    ]
      .filter(Boolean)
      .join("  ");
  };

  const drainSettledNotifications = () => {
    if (shuttingDown || agentBusy) return;
    const pending = workers
      .entries()
      .map(({ item: w }) => w)
      .filter(
        (w) =>
          !w.closed &&
          (w.lifecycle === "settled" || w.lifecycle === "failed") &&
          w.notifiedGeneration < w.generation,
      );
    if (!pending.length) return;

    for (const w of pending) w.notifiedGeneration = w.generation;

    const lines = [
      pending.length === 1
        ? "Async RPC worker settled:"
        : `${pending.length} async RPC workers settled:`,
      ...pending.map(workerNotifyLine),
      SETTLED_HINT,
    ];
    try {
      pi.sendMessage(
        {
          customType: "async-task-settled",
          content: lines.join("\n"),
          display: true,
          details: {
            workers: pending.map((w) => ({
              id: w.id,
              lifecycle: w.lifecycle,
              agent: w.agent,
              generation: w.generation,
              turns: w.turns,
              killReason: w.killReason,
              // Bounded preview so the transcript notice can show what the
              // worker concluded without re-parsing the prose body.
              result: cleanOneLine(
                w.latestResult || w.latestAssistantText || "",
                NOTICE_RESULT_CAP,
              ),
            })),
          },
        },
        { triggerTurn: true },
      );
    } catch {
      for (const w of pending) w.notifiedGeneration = w.generation - 1;
    }
  };

  const maybeNotifySettled = (worker: Worker) => {
    if (shuttingDown || worker.closed) return;
    if (worker.lifecycle !== "settled" && worker.lifecycle !== "failed") return;
    if (worker.notifiedGeneration >= worker.generation) return;
    if (agentBusy) return;
    drainSettledNotifications();
  };

  const shouldRetryWorkerFallback = (worker: Worker) =>
    shouldRetryModelFallback({
      hasNextAttempt:
        worker.fallbackReplaySafe &&
        worker.modelAttemptIndex + 1 < worker.modelAttempts.length,
      fallbackInProgress: worker.fallbackInProgress,
      killReason: worker.killReason,
      resultText: worker.latestResult || worker.latestAssistantText,
      modelError: worker.modelError,
      activitiesStarted: worker.modelAttemptUsedTools ? 1 : 0,
    });

  const eventHooks: WorkerRuntimeEventHooks<Worker> = {
    normalizeToolName: (name) => cleanOneLine(name, 40),
    summarizeToolArgs: argsSummary,
    extractAssistantText,
    shouldRetryFallback: shouldRetryWorkerFallback,
    retryFallback: retryModelFallback,
    onSuccessfulSettlement: noteCircuitSuccess,
    onFailedSettlement: noteCircuitFailure,
    beforeSettlementNotify: (worker) => {
      applySettledReport(worker);
      resolveWaiters(worker, generationSnapshot(worker));
    },
    afterSettlementNotify: maybeNotifySettled,
  };

  const applySettledReport = (worker: Worker) => {
    const evaluation = evaluateSettledReport(
      worker.latestResult || worker.latestAssistantText || "",
      worker.reportSchema,
    );
    worker.reportStatus = evaluation.status;
    worker.parsedReport = evaluation.parsed;
    worker.reportError = evaluation.error;
  };

  const settleGeneration = (
    worker: Worker,
    lifecycle: "settled" | "failed",
    options?: { error?: string; killReason?: string },
  ) => {
    const result = runtime.settleGeneration(worker, lifecycle, options, eventHooks);
    syncFleetWidget();
    return result;
  };

  const handleRpcEvent = (worker: Worker, event: Record<string, unknown>) => {
    runtime.handleEvent(worker, event, eventHooks);
    persistWorker(worker);
    syncFleetWidget();
  };

  const handleUiRequest = (
    worker: Worker,
    request: Record<string, unknown>,
  ) => {
    // extension_ui_request is handled by the normal RPC event stream. This
    // dedicated callback remains reserved for future generic auto-answers.
    void worker;
    void request;
  };

  const startGeneration = (worker: Worker) => runtime.startGeneration(worker);

  const spawnWorker = async (
    def: AgentDef,
    params: {
      prompt: string;
      cwd: string;
      model?: string;
      rebind?: WorkerSidecar;
      reportSchema?: string;
      forkSessionFile?: string;
      lastPhaseTag?: string;
    },
  ): Promise<{ worker?: Worker; error?: string }> => {
    const identity = params.rebind
      ? { id: createWorkerIdentity(nextId++).id, instanceId: params.rebind.instanceId }
      : createWorkerIdentity(nextId++);
    const { id, instanceId } = identity;
    writeLastPhase(
      `${params.lastPhaseTag ?? "task_start:pre-spawn"} agent=${def.name} id=${id}`,
    );
    const sessionDir = params.rebind?.sessionDir ?? ensureSessionDir(instanceId);
    const timeoutMs = (def.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
    const maxTurns = def.maxTurns ?? DEFAULT_MAX_TURNS;
    const attempts = modelAttempts(def, params.model ?? params.rebind?.model);
    // Skip known-unhealthy provider/model circuits before spawn. When every
    // candidate is open, selectAttempt still returns a deterministic fail-safe
    // without erasing circuit state.
    const initial = getSharedModelCircuitBreaker().selectAttempt(attempts, 0);
    const model = initial.model;
    const modelLabel = model ?? "default model";

    const worker: Worker = {
      instanceId,
      id,
      agent: def.name,
      mission: params.rebind?.mission ?? missionFromPrompt(params.prompt),
      cwd: params.cwd,
      model: modelLabel,
      thinking: def.thinking,
      initialPrompt: params.rebind ? "" : params.prompt,
      modelAttempts: attempts,
      modelAttemptIndex: initial.index,
      circuitFailureAttempt: undefined,
      modelAttemptUsedTools: false,
      fallbackReplaySafe: true,
      fallbackInProgress: false,
      fallbackAwaitingAgentStart: false,
      fallbackEpoch: 0,
      lifecycle: params.rebind ? "settled" : "starting",
      generation: params.rebind?.generation ?? 1,
      createdAt: params.rebind?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      renderVersion: 0,
      phase: "none",
      turns: 0,
      maxTurns,
      timeoutMs,
      sessionDir,
      pendingSteer: 0,
      pendingFollowUp: 0,
      ledger: new ActivityLedger({ maxActivities: MAX_ACTIVITIES }),
      errors: [],
      latestAssistantText: "",
      latestResult: "",
      exitCode: null,
      notifiedGeneration: 0,
      countsTowardCap: true,
      closed: false,
      waiters: [],
      pendingUi: new Map(),
      generationStartedAt: params.rebind?.updatedAt ?? Date.now(),
      reportSchema: params.rebind ? undefined : params.reportSchema,
      parsedReport: null,
      reportStatus: params.rebind
        ? "none-requested"
        : params.reportSchema?.trim()
          ? "missing"
          : "none-requested",
    };

    workers.set(instanceId, worker);
    if (initial.skipped.length) {
      pushError(
        worker,
        `circuit open; skipped ${initial.skipped.join(", ")}${initial.failSafe ? " (fail-safe primary)" : ""}`,
      );
    }

    const cliJs = process.argv[1];
    const args = [
      cliJs,
      "--mode",
      "rpc",
      "--session-dir",
      sessionDir,
      "--exclude-tools",
      EXCLUDED_CHILD_TOOLS,
      "--name",
      `async-${def.name}-${id}`,
    ];
    // Pi CLI: --fork coexists with --session-dir (conflicts only with
    // --session/--continue/--resume/--no-session). New transcript is written
    // under sessionDir; source file is the parent session.
    if (!params.rebind && params.forkSessionFile) {
      args.push("--fork", params.forkSessionFile);
    }
    if (model) {
      const slash = model.indexOf("/");
      if (slash > 0) {
        args.push(
          "--provider",
          model.slice(0, slash),
          "--model",
          model.slice(slash + 1),
        );
      } else {
        args.push("--model", model);
      }
    }
    if (def.thinking) args.push("--thinking", def.thinking);
    if (!def.inheritSkills) args.push("--no-skills");
    if (def.tools) {
      const tools = def.tools
        .split(",")
        .map((tool) => tool.trim())
        .filter(Boolean);
      if (tools.length) args.push("--tools", tools.join(","));
    }
    // Async workers support steering/follow-ups and UI requests; load mode-
    // correct shared norms rather than the fire-and-forget sync preamble.
    const shared = composeSpecialistSharedPrompts("async");
    const systemPrompt = [shared.systemPreamble, def.body]
      .filter(Boolean)
      .join("\n\n");
    if (systemPrompt) args.push("--system-prompt", systemPrompt);
    const appendParts = [
      shared.appendSystemPrompt,
      !params.rebind && params.reportSchema?.trim()
        ? reportInstruction(params.reportSchema)
        : undefined,
    ].filter(Boolean);
    if (appendParts.length) {
      args.push("--append-system-prompt", appendParts.join("\n\n"));
    }

    let client: RpcClient;
    try {
      writeLastPhase(`task_start:rpc-client id=${id}`);
      client = new RpcClient({
        args,
        cwd: params.cwd,
        env: {
          ...process.env,
          PI_SUBAGENT: "1",
          PI_ASYNC_RPC: "1",
          PI_SUBAGENT_AGENT: def.name,
          PI_SUBAGENT_MODEL: modelLabel,
        },
        onEvent: (event) => handleRpcEvent(worker, event),
        onUiRequest: (req) => handleUiRequest(worker, req),
        onExit: (code, _signal) => {
          const diagnostic =
            stderrDiagnostic(client.stderr.text) ??
            `process exited (code=${code ?? "null"})`;
          runtime.handleExit(worker, code, diagnostic, eventHooks);
          syncFleetWidget();
        },
        onError: (error) => {
          pushError(worker, `spawn error: ${error.message}`);
        },
      });
    } catch (error) {
      workers.delete(instanceId);
      const message = error instanceof Error ? error.message : String(error);
      return { error: `Failed to spawn ${id}: ${message}` };
    }

    worker.client = client;
    worker.pid = client.pid;
    persistWorker(worker);
    writeLastPhase(
      `task_start:spawned id=${id} pid=${String(client.pid ?? "none")}`,
    );

    if (params.rebind) {
      worker.killReason = "rebound after parent exit; use task_send mode=prompt to continue";
      notifySubscribers(worker);
      return { worker };
    }

    runtime.armHard(worker, timeoutMs);

    // Accept the initial prompt before returning the handle. Model/provider
    // preflight failures are eligible for the same configured fallback chain
    // as failures emitted after agent_start.
    try {
      const response = await client.request(
        { type: "prompt", message: params.prompt },
        PROMPT_ACCEPT_TIMEOUT_MS,
      );
      if (!response.success) {
        const message = response.error ?? "prompt rejected";
        worker.modelError = message;
        pushError(worker, message);
        const fallbackResult = await retryModelFallback(worker);
        if (fallbackResult !== "retried") {
          const finalError = worker.modelError ?? message;
          forceKillWorker(worker, `prompt rejected: ${finalError}`);
          worker.countsTowardCap = false;
          worker.lifecycle = "failed";
          worker.closed = true;
          try {
            deleteWorkerSidecar(worker.sessionDir);
          } catch {
            // Sidecar deletion is best effort after a rejected prompt.
          }
          clearHard(worker);
          clearIdle(worker);
          try {
            client.closeStdin();
          } catch {
            // ignore
          }
          return { error: `${id} prompt rejected: ${finalError}` };
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      worker.modelError = message;
      pushError(worker, message);
      const fallbackResult = await retryModelFallback(worker);
      if (fallbackResult !== "retried") {
        const finalError = worker.modelError ?? message;
        forceKillWorker(worker, `prompt accept failed: ${finalError}`);
        worker.countsTowardCap = false;
        worker.lifecycle = "failed";
        worker.closed = true;
        try {
          deleteWorkerSidecar(worker.sessionDir);
        } catch {
          // Sidecar deletion is best effort after a failed prompt acceptance.
        }
        return { error: `${id} failed to accept prompt: ${finalError}` };
      }
    }

    // Best-effort state fetch for session id (non-blocking for the caller —
    // we already accepted the prompt).
    void client
      .request({ type: "get_state" }, 10_000)
      .then((res) => {
        if (!res.success || !res.data || typeof res.data !== "object") return;
        const data = res.data as {
          sessionId?: string;
          sessionFile?: string;
          model?: { id?: string; provider?: string };
        };
        if (data.sessionId) worker.sessionId = String(data.sessionId);
        if (data.sessionFile) worker.sessionFile = String(data.sessionFile);
        if (data.model?.id) {
          const model = data.model.provider
            ? `${data.model.provider}/${data.model.id}`
            : data.model.id;
          if (worker.model !== model) {
            worker.model = model;
            notifySubscribers(worker);
          }
        }
      })
      .catch(() => {});

    if (worker.lifecycle === "starting") {
      worker.lifecycle = "running";
    }
    armIdle(worker);
    syncFleetWidget();
    return { worker };
  };

  const waitWorkerGeneration = (
    worker: Worker,
    targetGen: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ) =>
    waitForSnapshot<GenerationSnapshot>({
      signal,
      timeoutMs,
      register(resolve) {
        const waiter: Worker["waiters"][number] = {
          generation: targetGen,
          resolve,
          timer: undefined,
        };
        worker.waiters.push(waiter);
        notifySubscribers(worker);
        if (
          (worker.lifecycle === "settled" ||
            worker.lifecycle === "failed" ||
            worker.lifecycle === "closed") &&
          worker.generation >= targetGen
        ) {
          resolve(generationSnapshot(worker));
        }
        return () => {
          const index = worker.waiters.indexOf(waiter);
          if (index >= 0) worker.waiters.splice(index, 1);
          notifySubscribers(worker);
        };
      },
    });

  const closeWorker = (
    worker: Worker,
    reason: string,
    mode: "async" | "sync" = "async",
  ): string => {
    if (worker.closed) {
      return `${worker.id} is already closed.`;
    }
    // Preserve the work lifecycle while cleanup updates the canonical card's
    // final child row in place. Normal close is a successful completion, not a
    // failure or a separate detached receipt.
    if (worker.hasPinnedSurface) worker.pinnedLifecycle = worker.lifecycle;
    worker.fallbackEpoch += 1;
    worker.fallbackInProgress = false;
    worker.fallbackAwaitingAgentStart = false;
    worker.closed = true;
    worker.lifecycle = "closed";
    worker.countsTowardCap = false;
    // Normal cleanup is not a failure and must not become a red `× task_close`
    // reason on the pinned work card. Preserve only real stop/kill reasons.
    if (reason !== "task_close") worker.killReason = worker.killReason ?? reason;
    clearHard(worker);
    clearIdle(worker);
    clearAbortTimer(worker);
    closeAllRunning(worker, "error");

    // Resolve detached waiters so callback cleanup cannot mutate the array
    // being iterated and orphan another concurrent wait.
    const waiters = worker.waiters;
    worker.waiters = [];
    for (const waiter of waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      try {
        waiter.resolve(generationSnapshot(worker));
      } catch {
        // ignore
      }
    }

    try {
      worker.client?.closeStdin();
    } catch {
      // ignore
    }
    worker.client?.dispose();

    const pid = worker.pid ?? worker.client?.pid;
    if (pid != null) {
      try {
        if (mode === "sync") killProcessTreeSync(pid);
        else killProcessTree(pid);
      } catch {
        // ignore
      }
    }
    worker.client = undefined;
    worker.pid = undefined;
    worker.updatedAt = Date.now();
    try {
      deleteWorkerSidecar(worker.sessionDir);
    } catch {
      // Clean shutdown must not revive this worker; deletion is best effort.
    }
    if (worker.hasPinnedSurface && reason === "task_close") {
      worker.cleanupComplete = true;
      worker.cleanupWorkers = liveCount();
      worker.cleanupMaxWorkers = MAX_LIVE_WORKERS;
    }
    notifySubscribers(worker);
    worker.pinnedInvalidate = undefined;
    pruneSettled();
    syncFleetWidget();
    return `${worker.id} closed (${reason}).`;
  };

  // ------------------------------------------------------------ tools

  pi.registerTool({
    name: "task_start",
    label: "Task Start",
    description: `Start an asynchronous specialist sub-agent in an isolated session. Use it when work benefits from separate specialist context, such as broad investigation, an independent separable implementation slice, or fresh-eyes review. Multi-file, long-running, or frontend work may remain inline in regular mode. Returns a worker id (task_N) immediately, so use it when you want to keep working, steer the specialist later, or collect results with task_wait. Prefer the synchronous \`task\` tool for a single bounded result in-line.

Available agents:
${agentList}

At most ${MAX_LIVE_WORKERS} live workers; each holds a slot until task_close.`,
    promptSnippet:
      "Start an async RPC specialist (returns handle immediately; use task_wait/task_send/task_close).",
    promptGuidelines: [
      "After deciding to delegate, use task_start when the specialist engagement is multi-turn or may need steering.",
      "Use the synchronous task tool when you need one final report before continuing.",
      "After task_start, do useful independent work, then one task_wait (default 600s). Do not call task_status immediately after start or a wait timeout.",
      "Always task_close workers when finished; they hold a concurrency slot until closed.",
      "Do not nest task/task_* tools inside workers (they are excluded).",
    ],
    parameters: Type.Object({
      agent: Type.String({
        description: agentParamDescription(agents),
      }),
      prompt: Type.String({
        description:
          "Complete self-contained work order: goal, scope, context, evidence, validation, and expected return format.",
      }),
      cwd: Type.Optional(
        Type.String({
          description: "Working directory for the agent (defaults to current)",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Omit this. Every agent has a configured default model and fallback chain; do not override it. The only sanctioned override is upgrading oracle so its review capability is at least the orchestrator's. Format when sanctioned: provider/id, or a bare id to inherit the agent's provider.",
        }),
      ),
      reportSchema: Type.Optional(
        Type.String({
          description:
            "JSON Schema subset (object; properties string|number|boolean; required[]; optional enum). Child final message must include a ```report``` JSON fence matching it.",
        }),
      ),
      context: Type.Optional(
        Type.Union([Type.Literal("fresh"), Type.Literal("fork")], {
          description:
            "fresh (default) starts empty. fork copies this parent session unfiltered, including prior task_* calls. Falls back to fresh if the parent session is not yet persisted.",
        }),
      ),
    }),
    executionMode: "parallel",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      syncFleetWidget(ctx);
      const def = agents.get(params.agent);
      if (!def) {
        return textResult(
          `Unknown agent "${params.agent}". Available: ${[...agents.keys()].join(", ")}`,
          true,
        );
      }
      if (!params.prompt?.trim()) {
        return textResult("prompt is required.", true);
      }
      if (!runtime.canStart()) {
        return textResult(
          `Async RPC capacity full (max ${MAX_LIVE_WORKERS} live workers). Close a worker with task_close first. Persistent workers count against the cap until closed.`,
          true,
        );
      }
      const cwd = resolveCwd(params.cwd, ctx.cwd);
      const cwdError = validateCwd(cwd);
      if (cwdError) return textResult(cwdError, true);

      let reportSchema = params.reportSchema?.trim() || undefined;
      if (reportSchema) {
        const parsed = parseReportSchema(reportSchema);
        if (parsed.error) {
          return textResult(`Invalid reportSchema: ${parsed.error}`, true);
        }
      }

      let forkSessionFile: string | undefined;
      let contextNote = "context: fresh";
      if (params.context === "fork") {
        let parentFile: string | undefined;
        try {
          parentFile = ctx.sessionManager?.getSessionFile?.();
        } catch {
          parentFile = undefined;
        }
        if (parentFile && fs.existsSync(parentFile)) {
          forkSessionFile = parentFile;
          contextNote = "context: fork";
        } else {
          contextNote = "context: fresh (parent session not yet persisted)";
        }
      }

      const { worker, error } = await spawnWorker(def, {
        prompt: params.prompt,
        cwd,
        model: params.model,
        reportSchema,
        forkSessionFile,
      });
      if (error || !worker) {
        return textResult(error ?? "Failed to start worker.", true);
      }

      const text = [
        `started ${worker.id}`,
        `agent: ${worker.agent}`,
        `model: ${worker.model ?? "default"}`,
        `generation: ${worker.generation}`,
        contextNote,
        reportSchema ? "reportSchema: requested" : undefined,
        `mission: ${cleanOneLine(worker.mission, 140)}`,
        `live_workers: ${liveCount()}/${MAX_LIVE_WORKERS}`,
        `After useful independent work, one task_wait (default ${WAIT_DEFAULT_TIMEOUT_SEC}s). task_status is for blockers, not polling.`,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
      return textResult(text, false, { worker: workerView(worker) });
    },
    ...withTaskPresentation({
      renderShell: "self" as const,
      renderCall(
        args: any,
        theme: any,
        context: ToolRenderContext<AsyncRenderState, any>,
      ) {
        context.state.startedAt ??= Date.now();
        const def = args.agent ? agents.get(args.agent) : undefined;
        const view: WorkerView = {
          id: "starting",
          agent: args.agent ?? "agent",
          mission: missionFromPrompt(args.prompt ?? "Mission"),
          model: args.model ?? def?.model,
          thinking: def?.thinking,
          lifecycle: "starting",
          phase: "none",
          generation: 1,
          turns: 0,
          maxTurns: def?.maxTurns ?? DEFAULT_MAX_TURNS,
          createdAt: context.state.startedAt,
          pendingSteer: 0,
          pendingFollowUp: 0,
          activities: [],
          waitingUi: [],
          latestText: "",
          countsTowardCap: true,
        };
        const call = renderLaunchReceipt(view, theme);
        if (context.expanded) {
          noteExpandedCardRender("worker-call", call.render(80));
        }
        return new WidthText((width) =>
          context.state.hasResult ? [] : call.render(width),
        );
      },
      renderResult(
        result: any,
        options: { expanded: boolean; isPartial: boolean },
        theme: any,
        context: ToolRenderContext<AsyncRenderState, any>,
      ) {
        // The launch receipt morphs in place into the canonical live worker card:
        // same transcript item, no disappear/reappear. renderCall stops drawing
        // once hasResult is set, so exactly one surface is visible at a time.
        context.state.hasResult = true;
        const initial = viewFromDetails(result.details);
        if (!initial) {
          return new WidthText(() => [textContent(result) || "(no output)"]);
        }
        const workerInstanceId = initial.instanceId;
        const pinned = workerByInstance(workerInstanceId);
        if (pinned) {
          pinned.hasPinnedSurface = true;
          pinned.pinnedInvalidate = () => {
            paintTaskPinnedSurface(() => context.invalidate());
          };
        }
        // Last observed live state, so the card keeps its final appearance if the
        // worker is later reaped out of the registry by pruneSettled.
        let lastView: WorkerView = initial;
        let cached:
          | {
              width: number;
              expanded: boolean;
              waiting: boolean;
              renderVersion: number;
              timeBucket: number;
              lines: string[];
            }
          | undefined;
        return new WidthText((width) => {
          // Read the registry on every render so the card never shows a stale
          // snapshot captured at result time.
          const live = workerByInstance(workerInstanceId);
          if (live) {
            lastView = workerView(live);
            if (live.closed && live.pinnedLifecycle) {
              lastView.lifecycle = live.pinnedLifecycle;
            }
          }
          const expanded = context.expanded || options.expanded;
          const waiting = !!live?.waiters.length;
          const renderVersion = live?.renderVersion ?? -1;
          const timeBucket = Math.floor(Date.now() / 1000);
          if (
            cached?.width === width &&
            cached.expanded === expanded &&
            cached.waiting === waiting &&
            cached.renderVersion === renderVersion &&
            cached.timeBucket === timeBucket
          ) {
            return cached.lines;
          }
          const lines = renderWorkerCard(
            lastView,
            theme,
            expanded,
            waiting,
          ).render(width);
          const capped = expanded ? capRenderedCardLines(lines) : lines;
          if (expanded && cached?.expanded !== true) {
            noteExpandedCardRender("worker", capped);
          }
          cached = {
            width,
            expanded,
            waiting,
            renderVersion,
            timeBucket,
            lines: capped,
          };
          return capped;
        }, "[async worker display unavailable]");
      },
    }),
  });

  pi.registerTool({
    name: "task_chain",
    label: "Task Chain",
    description:
      "Run 1-6 specialists sequentially in one live-worker slot. Each step's bounded report replaces every {{prev}} in the next prompt. For mechanical pipelines only; no mid-chain steering. Not rebindable. First failed/killed step stops the chain.",
    promptSnippet:
      "Sequential 1-6 specialist pipeline; {{prev}} substitution; one slot; not rebindable.",
    parameters: Type.Object({
      steps: Type.Array(
        Type.Object({
          agent: Type.String({ description: agentParamDescription(agents) }),
          prompt: Type.String({
            description:
              "Work order for this step. Use {{prev}} to insert the previous step's bounded report.",
          }),
        }),
        {
          minItems: 1,
          maxItems: 6,
          description: "1-6 sequential steps; max 6.",
        },
      ),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      syncFleetWidget(ctx);
      const steps = params.steps ?? [];
      if (!Array.isArray(steps) || steps.length < 1) {
        return textResult("steps must contain at least one {agent, prompt}.", true);
      }
      if (steps.length > 6) {
        return textResult("task_chain supports at most 6 steps.", true);
      }
      for (const [i, step] of steps.entries()) {
        if (!agents.get(step.agent)) {
          return textResult(
            `Unknown agent "${step.agent}" at step ${i + 1}. Available: ${[...agents.keys()].join(", ")}`,
            true,
          );
        }
        if (!step.prompt?.trim()) {
          return textResult(`prompt is required at step ${i + 1}.`, true);
        }
      }
      if (!runtime.canStart()) {
        return textResult(
          `Async RPC capacity full (max ${MAX_LIVE_WORKERS} live workers). Close a worker with task_close first.`,
          true,
        );
      }
      const cwd = resolveCwd(undefined, ctx.cwd);
      const cwdError = validateCwd(cwd);
      if (cwdError) return textResult(cwdError, true);

      const digest: string[] = [];
      let prevText = "";
      let lastReport = "";
      let failed = false;

      for (let i = 0; i < steps.length; i++) {
        if (signal?.aborted) {
          digest.push(`stopped: aborted before step ${i + 1}`);
          failed = true;
          break;
        }
        const step = steps[i];
        const def = agents.get(step.agent)!;
        const prompt = substitutePrev(step.prompt, prevText);
        writeLastPhase(`task_chain:spawn step=${i + 1}/${steps.length}`);
        const { worker, error } = await spawnWorker(def, {
          prompt,
          cwd,
          lastPhaseTag: `task_chain:spawn step=${i + 1}/${steps.length}`,
        });
        if (error || !worker) {
          digest.push(`step ${i + 1} failed ${step.agent} · ${error ?? "spawn failed"}`);
          failed = true;
          break;
        }

        const startedAt = Date.now();
        const snapshot = await waitWorkerGeneration(
          worker,
          worker.generation,
          worker.timeoutMs,
          signal,
        );
        const elapsed = formatDuration(Date.now() - startedAt);

        if (snapshot === "interrupted") {
          closeWorker(worker, "task_chain abort", "sync");
          digest.push(`step ${i + 1} aborted ${step.agent} · ${elapsed}`);
          digest.push(`stopped: abort signal killed step ${i + 1}`);
          failed = true;
          break;
        }
        if (snapshot === "timeout") {
          closeWorker(worker, "task_chain timeout", "sync");
          digest.push(`step ${i + 1} timeout ${step.agent} · ${elapsed}`);
          digest.push(`stopped: step ${i + 1} wait timed out`);
          failed = true;
          break;
        }

        const reportLine = reportStatusLine(worker.reportStatus, worker.parsedReport);
        const ok = worker.lifecycle === "settled" && !worker.killReason;
        const errorLine = snapshot.killReason || snapshot.errorText;
        digest.push(
          `step ${i + 1} ${ok ? "ok" : "failed"} ${step.agent} · ${elapsed} · ${reportLine}`,
        );
        const bound = formatSettledResult(snapshot.resultText);
        lastReport = bound.text;
        prevText = boundText(bound.text, SETTLED_RESULT_CHARS, Number.POSITIVE_INFINITY).text;
        closeWorker(worker, "task_chain step complete", "sync");
        if (!ok) {
          if (errorLine) digest.push(`stopped: step ${i + 1} ${errorLine}`);
          else digest.push(`stopped: step ${i + 1} lifecycle=${worker.lifecycle}`);
          failed = true;
          break;
        }
      }

      const assembled = assembleChainDigest(digest, lastReport || "(empty)");
      return textResult(assembled.text, failed);
    },
  });

  pi.registerTool({
    name: "task_rebind",
    label: "Task Rebind",
    description:
      "Recover dead async RPC workers after a parent crash. Live orphan processes are reported but never attached to or killed because their stdio pipes are not stolen.",
    promptSnippet:
      "After a parent crash or resume, call task_rebind; historical handles are not valid until task_status confirms a rebound worker.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Optional prior task handle or durable instance id." })),
    }),
    executionMode: "parallel",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      syncFleetWidget(ctx);
      const requested = params.id?.trim();
      const lines: string[] = [];
      let stoppedForCap = false;
      for (const sidecar of listWorkerSidecars(rpcSessionRoot())) {
        if (requested && sidecar.id !== requested && sidecar.instanceId !== requested) continue;
        const classification = classifyWorkerSidecar(sidecar, {
          registered: !!workerByInstance(sidecar.instanceId),
          pidAlive: isPidAlive,
        });
        if (classification === "skip") continue;
        if (classification === "orphan") {
          lines.push(`orphan pid=${sidecar.pid ?? "missing"} session_dir=${sidecar.sessionDir} (not rebound; pipes are not stolen)`);
          continue;
        }
        if (stoppedForCap || liveCount() >= MAX_LIVE_WORKERS) {
          stoppedForCap = true;
          lines.push(`skipped-for-cap instance=${sidecar.instanceId}`);
          continue;
        }
        const def = discoverAgents().get(sidecar.agent);
        if (!def) {
          lines.push(`error instance=${sidecar.instanceId}: agent "${sidecar.agent}" is unavailable`);
          continue;
        }
        const { worker, error } = await spawnWorker(def, {
          prompt: "",
          cwd: sidecar.cwd,
          model: sidecar.model,
          rebind: sidecar,
        });
        lines.push(error
          ? `error instance=${sidecar.instanceId}: ${error}`
          : `rebound ${worker!.id} instance=${sidecar.instanceId} session_dir=${sidecar.sessionDir}`);
      }
      return textResult(lines.length ? lines.slice(0, 32).join("\n") : "No eligible worker sidecars found.", false);
    },
    ...controlRenderers("task_rebind", (result, theme, width, expanded) =>
      controlLines(theme, width, "task_rebind", {
        operation: "recover",
        kind: result?.isError ? "failed" : "succeeded",
        message: cleanOneLine(textContent(result), 240),
      }, expanded)),
  });

  pi.registerTool({
    name: "task_status",
    label: "Task Status",
    description:
      "Compact lifecycle snapshot for one async RPC worker (id, agent, turns, running tool, last-event age, waiting UI). Live status omits the result body. Use for blockers (waiting UI, stall, kill reason), not polling.",
    promptSnippet: "Inspect one worker's compact lifecycle when blocked; do not poll with this.",
    parameters: Type.Object({
      id: Type.String({ description: "Worker id from task_start (e.g. task_1)." }),
    }),
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const id = params.id?.trim();
      if (!id) return textResult("id is required.", true);
      const worker = workerByHandle(id);
      if (!worker) {
        return textResult(
          `Unknown worker "${id}". Use task_list to see workers.`,
          true,
        );
      }
      return textResult(formatWorkerStatus(worker), false, {
        id: worker.id,
        lifecycle: worker.lifecycle,
        generation: worker.generation,
        turns: worker.turns,
        worker: workerView(worker),
      });
    },
    ...controlRenderers("task_status", (result, theme, width, expanded) => {
      const view = viewFromDetails(result?.details);
      if (!view) {
        return controlFallbackLines(
          theme,
          width,
          "task_status",
          textContent(result),
          Boolean(result?.isError),
        );
      }
      // An observed worker that already owns a pinned task_start card must not
      // get a second full card here; report the observation compactly instead.
      if (workerByInstance(view.instanceId)?.hasPinnedSurface) {
        const running = view.activities.filter(
          (activity) => activity.status === "running",
        ).length;
        return controlLines(
          theme,
          width,
          "task_status",
          {
            id: view.id,
            operation: "observe",
            meta: metaText([
              view.agent,
              `gen ${view.generation}`,
              `${view.turns}/${view.maxTurns} turns`,
              running ? `${running} running` : undefined,
              view.waitingUi.length
                ? `${view.waitingUi.length} awaiting reply`
                : undefined,
            ]),
            kind: lifecycleKind(view.lifecycle),
            label: workerStateLabel(view),
            message: view.killReason
              ? cleanOneLine(view.killReason, 200)
              : undefined,
            notes: tailLines(view.latestText, expanded ? 4 : 1, 200),
            duration: spanText(view.createdAt, undefined, Date.now()),
          },
          expanded,
        );
      }
      return renderWorkerCard(view, theme, expanded).render(width);
    }),
  });

  pi.registerTool({
    name: "task_list",
    label: "Task List",
    description:
      "Compact roster of async RPC workers (id, lifecycle, agent, turns, last-event age, mission). Persistent live workers count against the concurrency cap until task_close. Prefer this over repeated task_status when checking several workers.",
    promptSnippet: "List async RPC workers without dumping result bodies.",
    parameters: Type.Object({
      include_settled: Type.Optional(
        Type.Boolean({
          description:
            "Include settled/failed/closed workers (default true). Set false for cap-holding live workers only.",
        }),
      ),
    }),
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const includeSettled = params.include_settled !== false;
      const now = Date.now();
      const rows = workers
        .entries()
        .map(({ item: w }) => w)
        .filter((w) => {
          if (includeSettled) return true;
          return w.countsTowardCap && !w.closed;
        });

      const live = rows.filter((w) => w.countsTowardCap && !w.closed).length;
      // The renderer reads this structured list; it never parses the text body.
      const listDetails = {
        list: {
          includeSettled,
          live,
          total: rows.length,
          maxWorkers: MAX_LIVE_WORKERS,
          workers: rows.map((w) => workerView(w)),
        },
      };

      if (!rows.length) {
        return textResult(
          includeSettled
            ? "No async RPC workers."
            : "No live async RPC workers.",
          false,
          listDetails,
        );
      }

      const lines = [
        `async RPC workers (${live} live / ${rows.length} shown; cap ${MAX_LIVE_WORKERS}):`,
        ...rows.map((w) => {
          const age = formatAge(now - w.createdAt);
          const last =
            w.lastEventAt != null
              ? formatAge(now - w.lastEventAt)
              : "n/a";
          return `${w.id}  ${w.lifecycle.padEnd(10)} agent=${w.agent} model=${w.model ?? "default"} gen=${w.generation} turns=${w.turns} cap=${w.countsTowardCap} age=${age} last=${last}  ${w.mission}`;
        }),
      ];
      return textResult(lines.join("\n"), false, listDetails);
    },
    ...controlRenderers("task_list", (result, theme, width, expanded) => {
      const list = detailRecord(detailRecord(result?.details)?.list);
      const views = Array.isArray(list?.workers)
        ? (list.workers as unknown[])
            .map(viewFromDetails)
            .filter((view): view is WorkerView => !!view)
        : undefined;
      if (!views) {
        return controlFallbackLines(
          theme,
          width,
          "task_list",
          textContent(result),
          Boolean(result?.isError),
        );
      }
      const includeSettled = list?.includeSettled !== false;
      if (!views.length) {
        return emptyStateLines(
          theme,
          width,
          "task_list",
          includeSettled ? "no async workers" : "nothing live",
          "task_start launches a specialist worker and returns a task_N handle.",
        );
      }

      const now = Date.now();
      const live =
        finiteNumber(list?.live) ??
        views.filter((view) => view.countsTowardCap).length;
      const max = finiteNumber(list?.maxWorkers) ?? MAX_LIVE_WORKERS;
      const header = receiptHeader(theme, width, {
        tool: "task_list",
        subject: `${live}/${max} live`,
        meta: metaText([
          views.length !== live ? `${views.length} shown` : undefined,
          includeSettled ? undefined : "live only",
        ]),
      });

      const limit = expanded ? 24 : 8;
      const shown = views.slice(-limit);
      const hidden = views.length - shown.length;
      const rows: TreeRow[] = [];
      if (hidden > 0) {
        rows.push(noteRow(theme, width, `${hidden} older workers hidden`, "muted"));
      }
      for (const view of shown) {
        const kind = lifecycleKind(view.lifecycle);
        rows.push(
          detailRow(theme, width, {
            kind,
            id: view.id,
            // Missions are capped hard here so the state metadata to the right
            // survives at normal terminal widths.
            text: cleanOneLine(view.mission || view.agent, expanded ? 90 : 48),
            detail: metaText([
              view.agent,
              workerStateLabel(view),
              `gen ${view.generation}`,
              `${view.turns}/${view.maxTurns} turns`,
              view.countsTowardCap ? "holds slot" : undefined,
              expanded ? view.model : undefined,
            ]),
            duration: spanText(view.createdAt, undefined, now),
          }),
        );
      }
      return buildTreeLines(theme, width, header, rows);
    }),
  });

  pi.registerTool({
    name: "task_send",
    label: "Task Send",
    description: `Send a message to an existing async RPC worker.

Modes:
- steer: Queued until the next model-call boundary. Cannot interrupt current inference or in-flight tools; delivered after the current assistant turn finishes its tool calls, before the next LLM call.
- follow_up: Delivered only after the agent fully settles (no more tool calls or steering).
- prompt: Only allowed when the worker is settled; starts a new generation.

Truthfully reports queueing semantics. Steer is never mid-inference interrupt.`,
    promptSnippet:
      "Send steer/follow_up (or settled prompt) to an async RPC worker.",
    parameters: Type.Object({
      id: Type.String({ description: "Worker id from task_start." }),
      message: Type.String({ description: "Message to send to the worker." }),
      mode: Type.Union(
        [
          Type.Literal("steer"),
          Type.Literal("follow_up"),
          Type.Literal("prompt"),
        ],
        {
          description:
            "steer = queue until next model-call boundary; follow_up = after settle; prompt = new generation only when settled.",
        },
      ),
    }),
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const id = params.id?.trim();
      const message = params.message?.trim();
      const mode = params.mode;
      // Structured send receipt: the renderer reads this instead of the prose.
      const sendDetails = (outcome: string, note?: string) => ({
        send: {
          id: id ?? "",
          mode: mode ?? "",
          outcome,
          note,
          message,
          lifecycle: workerByHandle(id ?? "")?.lifecycle,
          pendingSteer: workerByHandle(id ?? "")?.pendingSteer,
          pendingFollowUp: workerByHandle(id ?? "")?.pendingFollowUp,
        },
      });
      if (!id) return textResult("id is required.", true, sendDetails("rejected", "id is required"));
      if (!message)
        return textResult("message is required.", true, sendDetails("rejected", "message is required"));
      if (!mode)
        return textResult("mode is required.", true, sendDetails("rejected", "mode is required"));
      const worker = workerByHandle(id);
      if (!worker) {
        return textResult(`Unknown worker "${id}".`, true, sendDetails("rejected", "unknown worker"));
      }
      if (worker.closed || worker.lifecycle === "closed") {
        return textResult(`${id} is closed.`, true, sendDetails("rejected", "worker closed"));
      }
      if (!worker.client || worker.client.isClosed) {
        return textResult(
          `${id} has no live RPC connection.`,
          true,
          sendDetails("rejected", "no live RPC connection"),
        );
      }

      if (mode === "prompt") {
        if (worker.lifecycle !== "settled" && worker.lifecycle !== "failed") {
          return textResult(
            `${id} is ${worker.lifecycle}; prompt mode is only allowed when settled/failed. Use steer or follow_up while running, or wait first.`,
            true,
            sendDetails("rejected", `worker is ${worker.lifecycle}; prompt needs settled`),
          );
        }
        try {
          worker.initialPrompt = message;
          worker.fallbackReplaySafe = true;
          startGeneration(worker);
          const response = await worker.client.request(
            { type: "prompt", message },
            PROMPT_ACCEPT_TIMEOUT_MS,
          );
          if (!response.success) {
            settleGeneration(worker, "failed", {
              error: response.error ?? "prompt rejected",
            });
            return textResult(
              `${id} prompt rejected: ${response.error ?? "unknown"}`,
              true,
              sendDetails("rejected", response.error ?? "unknown"),
            );
          }
          return textResult(
            [
              `${id} accepted new prompt (generation ${worker.generation}).`,
              `lifecycle: ${worker.lifecycle}`,
              "A new generation is running.",
            ].join("\n"),
            false,
            sendDetails("accepted", `generation ${worker.generation} running`),
          );
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return textResult(`${id} prompt failed: ${msg}`, true, sendDetails("failed", msg));
        }
      }

      if (mode === "steer") {
        // Prefer dedicated steer command; if agent is not streaming this still queues/accepts.
        try {
          const response = await worker.client.request(
            { type: "steer", message },
            30_000,
          );
          if (!response.success) {
            // Fallback: prompt with streamingBehavior steer when required.
            const fallback = await worker.client.request(
              {
                type: "prompt",
                message,
                streamingBehavior: "steer",
              },
              30_000,
            );
            if (!fallback.success) {
              return textResult(
                `${id} steer rejected: ${fallback.error ?? response.error ?? "unknown"}`,
                true,
                sendDetails("rejected", fallback.error ?? response.error ?? "unknown"),
              );
            }
          }
          worker.pendingSteer += 1;
          worker.fallbackReplaySafe = false;
          worker.modelError = undefined;
          worker.fallbackEpoch += 1;
          worker.fallbackInProgress = false;
          worker.fallbackAwaitingAgentStart = false;
          if (worker.lifecycle === "retrying") worker.lifecycle = "running";
          armIdle(worker);
          notifySubscribers(worker);
          return textResult(
            [
              `${id} steer queued.`,
              "Semantics: steer is delivered after the current assistant turn finishes its tool calls, before the next LLM call.",
              "It cannot interrupt current inference or in-flight tools.",
              `lifecycle: ${worker.lifecycle}`,
              `pending_steer (local estimate): ${worker.pendingSteer}`,
            ].join("\n"),
            false,
            sendDetails("queued", "delivered at the next model-call boundary"),
          );
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return textResult(`${id} steer failed: ${msg}`, true, sendDetails("failed", msg));
        }
      }

      // follow_up
      try {
        const response = await worker.client.request(
          { type: "follow_up", message },
          30_000,
        );
        if (!response.success) {
          const fallback = await worker.client.request(
            {
              type: "prompt",
              message,
              streamingBehavior: "followUp",
            },
            30_000,
          );
          if (!fallback.success) {
            return textResult(
              `${id} follow_up rejected: ${fallback.error ?? response.error ?? "unknown"}`,
              true,
              sendDetails("rejected", fallback.error ?? response.error ?? "unknown"),
            );
          }
        }
        worker.pendingFollowUp += 1;
        worker.fallbackReplaySafe = false;
        worker.modelError = undefined;
        worker.fallbackEpoch += 1;
        worker.fallbackInProgress = false;
        worker.fallbackAwaitingAgentStart = false;
        if (worker.lifecycle === "retrying") worker.lifecycle = "running";
        armIdle(worker);
        notifySubscribers(worker);
        return textResult(
          [
            `${id} follow_up queued.`,
            "Semantics: follow_up is delivered only when the agent has fully settled (no more tool calls or steering).",
            `lifecycle: ${worker.lifecycle}`,
            `pending_follow_up (local estimate): ${worker.pendingFollowUp}`,
          ].join("\n"),
          false,
          sendDetails("queued", "delivered after the worker settles"),
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(`${id} follow_up failed: ${msg}`, true, sendDetails("failed", msg));
      }
    },
    ...controlRenderers("task_send", (result, theme, width, expanded) => {
      const send = detailRecord(detailRecord(result?.details)?.send);
      if (!send) {
        return controlFallbackLines(
          theme,
          width,
          "task_send",
          textContent(result),
          Boolean(result?.isError),
        );
      }
      const outcome = safeLine(send.outcome, 20) || "unknown";
      const pending = finiteNumber(
        send.mode === "follow_up" ? send.pendingFollowUp : send.pendingSteer,
      );
      const sentMessage = safeLine(send.message, 400);
      const outcomeNote = safeLine(send.note, 200);
      const showSentMessage = ["accepted", "delivered", "queued"].includes(outcome);
      return controlLines(
        theme,
        width,
        "task_send",
        {
          id: safeLine(send.id, 40) || undefined,
          operation: safeLine(send.mode, 20) || undefined,
          meta: metaText([
            safeLine(send.lifecycle, 20) || undefined,
            outcome === "queued" && pending !== undefined
              ? `${pending} pending`
              : undefined,
          ]),
          kind: outcomeKind(outcome),
          label: outcome,
          message:
            showSentMessage && sentMessage
              ? `sent: ${sentMessage}`
              : outcomeNote || undefined,
          notes: showSentMessage
            ? outcomeNote
              ? [outcomeNote]
              : []
            : expanded
              ? tailLines(send.message, 3, 200)
              : [],
        },
        expanded,
      );
    }),
  });

  pi.registerTool({
    name: "task_wait",
    label: "Task Wait",
    description:
      `Wait until the worker's current generation settles (agent_settled). Default timeout ${WAIT_DEFAULT_TIMEOUT_SEC}s. On timeout, returns a compact heartbeat without killing the worker; the full bounded report is returned only on settlement. Cancelling this tool call only stops waiting. When a wait times out at Pi's configured compaction reserve boundary, task_wait requests that the current tool-only turn end so Pi can auto-compact. Use task_abort to stop the worker explicitly.`,
    promptSnippet:
      "Wait for an async RPC worker generation to settle; default 600s; timeout returns a compact heartbeat, not a poll cue.",
    parameters: Type.Object({
      id: Type.String({ description: "Worker id from task_start." }),
      timeoutSec: Type.Optional(
        Type.Number({
          description:
            `Max seconds to wait (default ${WAIT_DEFAULT_TIMEOUT_SEC}). On timeout, returns a compact heartbeat without killing.`,
        }),
      ),
      generation: Type.Optional(
        Type.Number({
          description:
            "Specific generation to wait for (default: current generation at call time).",
        }),
      ),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      syncFleetWidget(ctx);
      const id = params.id?.trim();
      if (!id) return textResult("id is required.", true);
      const worker = workerByHandle(id);
      if (!worker) {
        return textResult(`Unknown worker "${id}".`, true);
      }
      if (worker.closed || worker.lifecycle === "closed") {
        return textResult(
          `${id} is closed.\n\n${formatWorkerStatus(worker)}`,
          true,
        );
      }

      const targetGen = params.generation ?? worker.generation;
      if (targetGen !== worker.generation) {
        return textResult(
          `${id} is currently generation ${worker.generation}; generation ${targetGen} is not retained. Wait on the current generation or omit generation.`,
          true,
          { worker: workerView(worker), waiting: false },
        );
      }
      const timeoutSec = params.timeoutSec ?? WAIT_DEFAULT_TIMEOUT_SEC;
      const timeoutMs = Math.max(0, timeoutSec) * 1000;

      const notifyLive = () => {
        if (worker.hasPinnedSurface) return;
        const text = formatWorkerWaitStatus(worker);
        onUpdate?.({
          content: [{ type: "text", text }],
          details: { worker: workerView(worker), waiting: true },
        });
      };
      if (!worker.hasPinnedSurface) {
        worker.subscribers = worker.subscribers || new Set();
        worker.subscribers.add(notifyLive);
        notifyLive();
      }

      const alreadySettled =
        (worker.lifecycle === "settled" || worker.lifecycle === "failed") &&
        worker.generation === targetGen;
      if (alreadySettled) {
        worker.subscribers?.delete(notifyLive);
        const bound = formatSettledResult(
          worker.latestResult || worker.latestAssistantText,
        );
        return textResult(
          [
            `${id} already settled (generation ${targetGen}, lifecycle=${worker.lifecycle}).`,
            `turns: ${worker.turns}`,
            reportStatusLine(worker.reportStatus, worker.parsedReport),
            worker.killReason ? `kill_reason: ${worker.killReason}` : undefined,
            "",
            `--- result ---`,
            bound.text || "(empty)",
          ]
            .filter(Boolean)
            .join("\n"),
          worker.lifecycle === "failed",
          {
            worker: workerView(worker),
            waiting: false,
            parsedReport: worker.parsedReport,
            reportStatus: worker.reportStatus,
          },
        );
      }

      const snapshot = await waitWorkerGeneration(
        worker,
        targetGen,
        timeoutMs,
        signal,
      );

      worker.subscribers?.delete(notifyLive);

      if (snapshot === "interrupted") {
        // A cancelled parent turn must not become an implicit task_abort. The
        // worker is independent and may still be doing useful work; callers
        // that intend to stop it have the explicit task_abort control.
        return textResult(
          [
            `${id} wait interrupted; worker was NOT aborted.`,
            "The worker continues in the background; use task_wait to reconnect, or task_abort to stop it explicitly.",
            "",
            formatWorkerWaitStatus(worker),
          ].join("\n"),
          false,
          { worker: workerView(worker), waiting: false },
        );
      }

      if (snapshot === "timeout") {
        let contextUsage: ReturnType<ExtensionContext["getContextUsage"]>;
        try {
          contextUsage = ctx.getContextUsage();
        } catch {
          contextUsage = undefined;
        }
        const reserveTokens = compactionReserveTokens(ctx.cwd);
        const checkpoint = shouldCheckpointTimedOutWait(
          contextUsage,
          reserveTokens,
        );
        return {
          ...textResult(
            [
              `${id} wait timed out after ${timeoutSec}s (generation ${targetGen} still ${worker.lifecycle}).`,
              "Worker was NOT killed.",
              contextCheckpointNote(contextUsage, reserveTokens),
              "",
              formatWorkerWaitStatus(worker),
            ]
              .filter(Boolean)
              .join("\n"),
            false,
            {
              worker: workerView(worker),
              waiting: false,
              contextCheckpoint: checkpoint,
            },
          ),
          ...(checkpoint ? { terminate: true } : {}),
        };
      }

      const bound = formatSettledResult(snapshot.resultText);
      return textResult(
        [
          `${id} settled (generation ${snapshot.generation}).`,
          `lifecycle: ${worker.lifecycle}`,
          `turns: ${snapshot.turns}`,
          reportStatusLine(worker.reportStatus, worker.parsedReport),
          snapshot.killReason
            ? `kill_reason: ${snapshot.killReason}`
            : undefined,
          snapshot.errorText ? `error: ${snapshot.errorText}` : undefined,
          worker.reportError ? `report_error: ${worker.reportError}` : undefined,
          "",
          `--- result ---`,
          bound.text || "(empty)",
        ]
          .filter(Boolean)
          .join("\n"),
        worker.lifecycle === "failed",
        {
          worker: workerView(worker),
          waiting: false,
          parsedReport: worker.parsedReport,
          reportStatus: worker.reportStatus,
        },
      );
    },
    ...withTaskPresentation({
      renderShell: "self" as const,
      renderCall(
        args: any,
        theme: any,
        context: ToolRenderContext<AsyncRenderState, any>,
      ) {
        context.state.startedAt ??= Date.now();
        const worker = args.id ? workerByHandle(String(args.id)) : undefined;
        // The worker already owns a canonical pinned card from task_start; a
        // second card here would duplicate title/activity, so stay silent.
        if (worker?.hasPinnedSurface) return new WidthText(() => []);
        const view = worker
          ? workerView(worker)
          : {
              id: String(args.id ?? "worker"),
              agent: "agent",
              mission: "Waiting for async worker",
              lifecycle: "starting" as const,
              phase: "none" as const,
              generation: Number(args.generation ?? 1),
              turns: 0,
              maxTurns: DEFAULT_MAX_TURNS,
              createdAt: context.state.startedAt,
              pendingSteer: 0,
              pendingFollowUp: 0,
              activities: [],
              waitingUi: [],
              latestText: "",
              countsTowardCap: true,
            };
        const call = renderWorkerCard(view, theme, context.expanded, true);
        return new WidthText((width) =>
          context.state.hasResult ? [] : call.render(width),
        );
      },
      renderResult(
        result: any,
        options: { expanded: boolean; isPartial: boolean },
        theme: any,
        context: ToolRenderContext<AsyncRenderState, any>,
      ) {
        context.state.hasResult = true;
        const view = viewFromDetails(result.details);
        const waitId =
          view?.id ??
          (context.args?.id != null ? String(context.args.id) : undefined);
        const pinned = view
          ? workerByInstance(view.instanceId)
          : waitId
            ? workerByHandle(waitId)
            : undefined;
        const resultText = textContent(result);
        const isError = Boolean((result as { isError?: boolean }).isError);
        const isTimeout = /wait timed out/i.test(resultText);
        if (pinned?.hasPinnedSurface && !isError && !isTimeout) {
          // Normal progress and settlement live on the canonical pinned card.
          return new WidthText(() => []);
        }
        if (pinned?.hasPinnedSurface) {
          // Timeout/validation failures are control outcomes the worker card
          // cannot express. Render them as receipts rather than detached alert
          // text so a routine wait timeout does not look like a warning.
          if (isTimeout && !isError) {
            const timeout = finiteNumber(context.args?.timeoutSec) ?? WAIT_DEFAULT_TIMEOUT_SEC;
            return new WidthText((width) => [
              receiptHeader(theme, width, {
                tool: "task_wait",
                id: waitId,
                subject: `wait ended after ${timeout}s`,
                meta: metaText([
                  safeLine(view?.lifecycle, 20) || undefined,
                  view ? `gen ${view.generation}` : undefined,
                  "worker continues",
                ]),
                kind: "waiting",
                label: (result.details as { contextCheckpoint?: boolean })
                  ?.contextCheckpoint
                  ? "context checkpoint"
                  : "still running",
                rootGlyph: TREE.receipt,
              }),
            ]);
          }
          return new WidthText((width) =>
            controlLines(
              theme,
              width,
              "task_wait",
              {
                id: waitId,
                operation: "failed",
                kind: "failed",
                message: cleanOneLine(resultText, 240),
              },
              options.expanded,
            ),
          );
        }
        if (!view) return new WidthText(() => [resultText || "(no output)"]);
        const waiting = Boolean((result.details as { waiting?: boolean })?.waiting);
        return renderWorkerCard(view, theme, options.expanded, waiting);
      },
      }),
  });

  pi.registerTool({
    name: "task_abort",
    label: "Task Abort",
    description:
      "Cooperatively abort the worker's current inference/tool run via RPC abort. Waits a short grace period (~5s) for agent_settled; if unresponsive, escalates to Windows taskkill /F /T (or POSIX kill). Preserves the worker/session when cooperative abort succeeds so you can send a new prompt later.",
    promptSnippet:
      "Cooperatively abort current async worker run; force-kill only if unresponsive.",
    parameters: Type.Object({
      id: Type.String({ description: "Worker id from task_start." }),
    }),
    executionMode: "parallel",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      syncFleetWidget(ctx);
      const id = params.id?.trim();
      const abortDetails = (
        outcome: string,
        note: string,
        extra?: Record<string, unknown>,
      ) => ({
        abort: { id: id ?? "", outcome, note, ...extra },
      });
      if (!id)
        return textResult("id is required.", true, abortDetails("rejected", "id is required"));
      const worker = workerByHandle(id);
      if (!worker) {
        return textResult(
          `Unknown worker "${id}".`,
          true,
          abortDetails("rejected", "unknown worker"),
        );
      }
      if (worker.closed || worker.lifecycle === "closed") {
        return textResult(
          `${id} is already closed.`,
          true,
          abortDetails("rejected", "worker already closed"),
        );
      }
      if (
        worker.lifecycle === "settled" ||
        worker.lifecycle === "failed"
      ) {
        return textResult(
          `${id} is already ${worker.lifecycle}; nothing to abort.\n\n${formatWorkerStatus(worker)}`,
          false,
          {
            worker: workerView(worker),
            waiting: false,
            ...abortDetails("noop", `already ${worker.lifecycle}; nothing to abort`),
          },
        );
      }

      const outcome = await abortWorkerAndEscalate(worker);

      if (outcome.escalated) {
        return textResult(
          [
            outcome.exited
              ? `${id} abort escalated to process-tree kill; exit confirmed.`
              : `${id} abort escalated to process-tree kill; exit is not yet confirmed and capacity remains reserved.`,
            `cooperative=${outcome.cooperative} settled=${outcome.settled}`,
            "Worker metadata is retained; use task_status to inspect and task_close to reap.",
            "",
            formatWorkerStatus(worker),
          ].join("\n"),
          !outcome.exited,
          {
            worker: workerView(worker),
            waiting: false,
            ...abortDetails(
              outcome.exited ? "escalated" : "unconfirmed",
              outcome.exited
                ? "process tree killed; exit confirmed"
                : "process tree kill requested; exit not confirmed, slot still held",
              { cooperative: outcome.cooperative, escalated: true, exited: outcome.exited },
            ),
          },
        );
      }

      return textResult(
        [
          `${id} abort completed cooperatively (or settled during grace).`,
          `lifecycle: ${worker.lifecycle}`,
          "Worker/session preserved. You may task_send mode=prompt for a new generation, or task_close to reap.",
          "",
          formatWorkerStatus(worker),
        ].join("\n"),
        false,
        {
          worker: workerView(worker),
          waiting: false,
          ...abortDetails(
            "settled",
            "stopped cooperatively; worker/session preserved for task_send or task_close",
            { cooperative: outcome.cooperative, escalated: false, exited: outcome.exited },
          ),
        },
      );
    },
    ...controlRenderers("task_abort", (result, theme, width, expanded) => {
      const abort = detailRecord(detailRecord(result?.details)?.abort);
      if (!abort) {
        return controlFallbackLines(
          theme,
          width,
          "task_abort",
          textContent(result),
          Boolean(result?.isError),
        );
      }
      const view = viewFromDetails(result?.details);
      const outcome = safeLine(abort.outcome, 20) || "unknown";
      return controlLines(
        theme,
        width,
        "task_abort",
        {
          id: safeLine(abort.id, 40) || undefined,
          operation: abort.escalated === true ? "force kill" : "cooperative abort",
          meta: metaText([
            view ? `${view.agent}` : undefined,
            view ? statusLabel(lifecycleKind(view.lifecycle)) : undefined,
            view && !view.countsTowardCap ? "slot released" : undefined,
          ]),
          kind: outcomeKind(outcome),
          label: outcome,
          message: safeLine(abort.note, 200) || undefined,
          notes:
            expanded && view?.killReason
              ? [cleanOneLine(view.killReason, 200)]
              : [],
        },
        expanded,
      );
    }),
  });

  pi.registerTool({
    name: "task_close",
    label: "Task Close",
    description:
      "Close and reap a persistent async RPC worker and its process tree. Frees the concurrency slot. Bounded settled metadata may be retained briefly for status.",
    promptSnippet: "Close/reap an async RPC worker and free its capacity slot.",
    parameters: Type.Object({
      id: Type.String({ description: "Worker id from task_start." }),
    }),
    executionMode: "parallel",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      syncFleetWidget(ctx);
      const id = params.id?.trim();
      if (!id) return textResult("id is required.", true);
      const worker = workerByHandle(id);
      if (!worker) {
        return textResult(`Unknown worker "${id}".`, true);
      }
      const message = closeWorker(worker, "task_close", "async");
      await new Promise((r) => setTimeout(r, 100));
      return textResult(
        [
          message,
          `live_workers: ${liveCount()}/${MAX_LIVE_WORKERS}`,
          "",
          formatWorkerStatus(worker),
        ].join("\n"),
        false,
        {
          worker: workerView(worker),
          close: {
            message,
            liveWorkers: liveCount(),
            maxWorkers: MAX_LIVE_WORKERS,
            exitCode: worker.exitCode,
            sessionId: worker.sessionId,
            sessionFile: worker.sessionFile,
            errors: worker.errors.slice(-5),
          },
        },
      );
    },
    ...withTaskPresentation({
      renderShell: "self" as const,
      renderCall(
        args: any,
        theme: any,
        context: ToolRenderContext<AsyncRenderState, any>,
      ) {
        const id = cleanOneLine(args.id ?? "worker", 40);
        const worker = args.id ? workerByHandle(String(args.id)) : undefined;
        if (worker?.hasPinnedSurface) return new WidthText(() => []);
        return new WidthText((width) =>
          context.state.hasResult
            ? []
            : [
                fitLine(
                  `${theme.fg("dim", TREE.receipt)} ${theme.fg("text", id)}`,
                  theme.fg("warning", "closing"),
                  width,
                ),
              ],
        );
      },
      renderResult(
        result: any,
        options: { expanded: boolean; isPartial: boolean },
        theme: any,
        context: ToolRenderContext<AsyncRenderState, any>,
      ) {
        // Replace the transient "closing" call row in the same tool surface;
        // do not leave it above the final compact close receipt.
        context.state.hasResult = true;
        const details = result.details as
          | {
              worker?: WorkerView;
              close?: {
                message?: string;
                liveWorkers?: number;
                maxWorkers?: number;
                exitCode?: number | null;
                sessionId?: string;
                sessionFile?: string;
                errors?: string[];
              };
            }
          | undefined;
        const view = details?.worker;
        const close = details?.close;
        if (!view || !close) {
          let entered = false;
          let exited = false;
          return new WidthText((width) => {
            if (!entered) {
              entered = true;
              writeLastPhase("task_close:receipt-render:enter fallback");
            }
            const lines = controlFallbackLines(
              theme,
              width,
              "task_close",
              textContent(result),
              Boolean((result as { isError?: boolean }).isError),
            );
            if (!exited) {
              exited = true;
              writeLastPhase("task_close:receipt-render:exit fallback");
            }
            return lines;
          }, "[task_close result unavailable]");
        }
        // A pinned worker reports completion inside its canonical card. Keep the
        // task_close tool surface silent; legacy/unpinned workers retain this
        // standalone receipt as a fallback.
        const live = workerByInstance(view.instanceId);
        if (live?.hasPinnedSurface) return new WidthText(() => []);
        let entered = false;
        let exited = false;
        return new WidthText((width) => {
          if (!entered) {
            entered = true;
            writeLastPhase(`task_close:receipt-render:enter id=${view.id} standalone`);
          }
          const released = !view.countsTowardCap;
          const left = released
            ? `${theme.fg("success", "✓")} ${theme.fg("muted", view.id)} ${theme.fg("muted", view.agent)}`
            : `${theme.fg("dim", TREE.receipt)} ${theme.fg("muted", view.id)} ${theme.fg("muted", view.agent)}`;
          const right = released
            ? `${theme.fg("success", "task complete")} ${theme.fg("dim", `· slot released · ${close.liveWorkers}/${close.maxWorkers} workers`)}`
            : theme.fg("warning", "closing · slot retained");
          const lines = [fitLine(left, right, width)];
          if (!options.expanded) {
            if (!exited) {
              exited = true;
              writeLastPhase(`task_close:receipt-render:exit id=${view.id} standalone`);
            }
            return lines;
          }

          const diagnostics = [
            `lifecycle: ${view.lifecycle}`,
            `exit_code: ${close.exitCode ?? "pending"}`,
            view.killReason ? `reason: ${view.killReason}` : undefined,
            close.sessionId ? `session_id: ${close.sessionId}` : undefined,
            close.sessionFile
              ? `session_file: ${cleanOneLine(close.sessionFile, 240)}`
              : undefined,
            ...(close.errors ?? []).map((error) => `error: ${error}`),
          ].filter((line): line is string => !!line);
          for (let index = 0; index < diagnostics.length; index++) {
            const rail = index === diagnostics.length - 1 ? TREE.last : TREE.branch;
            lines.push(
              safeTruncateToWidth(
                `${theme.fg("dim", rail)} ${theme.fg("dim", diagnostics[index])}`,
                width,
              ),
            );
          }
          const capped = options.expanded ? capRenderedCardLines(lines) : lines;
          if (options.expanded) noteExpandedCardRender("task_close", capped);
          if (!exited) {
            exited = true;
            writeLastPhase(`task_close:receipt-render:exit id=${view.id} standalone`);
          }
          return capped;
        });
      },
      }),
  });

  pi.registerTool({
    name: "task_reply",
    label: "Task Reply",
    description: `Answer a child worker's extension_ui_request dialog (select/confirm/input/editor) by request id. Use task_status to see waiting_ui_requests. Fire-and-forget UI methods (notify/setStatus/...) do not need a reply.

This is the supported checkpoint/interaction seam: Pi RPC exposes extension_ui_request events that block the child until extension_ui_response is sent.`,
    promptSnippet:
      "Reply to a waiting extension_ui_request on an async RPC worker.",
    parameters: Type.Object({
      id: Type.String({ description: "Worker id from task_start." }),
      request_id: Type.String({
        description: "extension_ui_request id from task_status.",
      }),
      value: Type.Optional(
        Type.String({
          description: "Value for select/input/editor responses.",
        }),
      ),
      confirmed: Type.Optional(
        Type.Boolean({ description: "Value for confirm responses." }),
      ),
      cancelled: Type.Optional(
        Type.Boolean({
          description: "If true, cancel the dialog (child receives undefined/false).",
        }),
      ),
    }),
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const id = params.id?.trim();
      const requestId = params.request_id?.trim();
      const replyDetails = (
        outcome: string,
        note: string,
        method?: string,
      ) => ({
        reply: {
          id: id ?? "",
          requestId: requestId ?? "",
          method,
          outcome,
          note,
        },
      });
      if (!id)
        return textResult("id is required.", true, replyDetails("rejected", "id is required"));
      if (!requestId)
        return textResult(
          "request_id is required.",
          true,
          replyDetails("rejected", "request_id is required"),
        );
      const worker = workerByHandle(id);
      if (!worker) {
        return textResult(
          `Unknown worker "${id}".`,
          true,
          replyDetails("rejected", "unknown worker"),
        );
      }
      if (worker.closed || !worker.client || worker.client.isClosed) {
        return textResult(
          `${id} has no live RPC connection.`,
          true,
          replyDetails("rejected", "no live RPC connection"),
        );
      }
      const pending = worker.pendingUi.get(requestId);
      if (!pending) {
        return textResult(
          `No waiting UI request "${requestId}" on ${id}. Use task_status to list waiting_ui_requests.`,
          true,
          replyDetails("rejected", "no such waiting UI request"),
        );
      }

      const response: Record<string, unknown> = {
        type: "extension_ui_response",
        id: requestId,
      };
      if (params.cancelled) {
        response.cancelled = true;
      } else if (pending.method === "confirm") {
        response.confirmed = params.confirmed === true;
      } else {
        if (params.value == null) {
          return textResult(
            `value is required for method ${pending.method} (or set cancelled=true).`,
            true,
            replyDetails(
              "rejected",
              `value is required for ${pending.method}`,
              pending.method,
            ),
          );
        }
        response.value = params.value;
      }

      const ok = worker.client.write(response);
      if (!ok) {
        return textResult(
          `${id} failed to write extension_ui_response.`,
          true,
          replyDetails("failed", "could not write the response", pending.method),
        );
      }
      worker.pendingUi.delete(requestId);
      // The fin holds station while a worker waits on a reply; releasing it
      // here means it resumes immediately rather than at the next RPC event.
      notifySubscribers(worker);
      const answer = params.cancelled
        ? "cancelled"
        : pending.method === "confirm"
          ? `confirmed=${params.confirmed === true}`
          : cleanOneLine(params.value, 120);
      return textResult(
        `${id} replied to UI request ${requestId} (method=${pending.method}).`,
        false,
        replyDetails(
          params.cancelled ? "cancelled" : "delivered",
          answer,
          pending.method,
        ),
      );
    },
    ...controlRenderers("task_reply", (result, theme, width, expanded) => {
      const reply = detailRecord(detailRecord(result?.details)?.reply);
      if (!reply) {
        return controlFallbackLines(
          theme,
          width,
          "task_reply",
          textContent(result),
          Boolean(result?.isError),
        );
      }
      const outcome = safeLine(reply.outcome, 20) || "unknown";
      return controlLines(
        theme,
        width,
        "task_reply",
        {
          id: safeLine(reply.id, 40) || undefined,
          operation: safeLine(reply.method, 20) || "reply",
          meta: metaText([safeLine(reply.requestId, 40) || undefined]),
          kind: outcomeKind(outcome),
          label: outcome,
          message: safeLine(reply.note, 200) || undefined,
        },
        expanded,
      );
    }),
  });

  // ---------------------------------------------------- settlement notice

  // Without this the settlement message renders as a raw `[async-task-settled]`
  // prose block that reads like a user turn. The renderer keeps worker id,
  // status, agent, generation/turns and the follow-up commands, but presents
  // them as a bounded background receipt.
  pi.registerMessageRenderer<{ workers?: unknown }>(
    "async-task-settled",
    (message, options, theme) => {
      if (!taskPresentationEnabled()) return undefined;
      const raw = Array.isArray(message.details?.workers)
        ? message.details.workers
        : [];
      const rows: NoticeRow[] = [];
      for (const entry of raw.slice(0, 24)) {
        const record = detailRecord(entry);
        if (!record) continue;
        const id = safeLine(record.id, 40);
        if (!id) continue;
        const generation = finiteNumber(record.generation);
        const turns = finiteNumber(record.turns);
        rows.push({
          kind: lifecycleKind(record.lifecycle),
          id,
          subject: safeLine(record.agent, 40) || undefined,
          detail: metaText([
            generation !== undefined ? `gen ${generation}` : undefined,
            turns !== undefined ? `${turns} turns` : undefined,
            safeLine(record.killReason, 80) || undefined,
          ]),
          preview: safeLine(record.result, NOTICE_RESULT_CAP) || undefined,
        });
      }
      // No structured workers means a malformed payload; fall through to Pi's
      // default rendering rather than showing an empty receipt.
      if (!rows.length) return undefined;
      return noticeComponent(theme, {
        channel: "async task",
        rows,
        hint: SETTLED_HINT,
        expanded: options.expanded,
        pad: options.outputPad,
      });
    },
  );

  // ------------------------------------------------------------ lifecycle

  // Busy gate is start → settled only (same pattern as bg-process).
  pi.on("agent_start", () => {
    agentBusy = true;
  });
  pi.on("agent_settled", () => {
    agentBusy = false;
    drainSettledNotifications();
    syncFleetWidget();
  });

  pi.on("session_start", () => {
    syncFleetWidget();
  });

  pi.on("session_shutdown", (_event, _ctx: ExtensionContext) => {
    shuttingDown = true;
    try {
      for (const { item: worker } of workers.entries()) {
        if (worker.closed) continue;
        try {
          closeWorker(worker, "session_shutdown", "sync");
        } catch {
          // best effort
        }
      }
    } finally {
      for (const worker of workers.values()) {
        worker.pinnedInvalidate = undefined;
      }
      workers.clear();
      lastFleetKey = "";
      publishFleetSnapshot([]);
    }
  });
}

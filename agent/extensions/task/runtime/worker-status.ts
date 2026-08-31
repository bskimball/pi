// Compact model-facing worker status. UI cards keep their own richer
// WorkerView; these strings are what re-enter the lead context.

import {
  boundText,
  cleanOneLine,
  formatAge,
} from "./text-bounds.ts";
import { isLiveLifecycle, type WorkerLifecycle } from "./worker-runtime.ts";
import { WAIT_DEFAULT_TIMEOUT_SEC } from "./wait-policy.ts";

export { WAIT_DEFAULT_TIMEOUT_SEC };
export const SETTLED_RESULT_CHARS = 12_000;
export const SETTLED_RESULT_LINES = 120;

const MISSION_CAP = 140;
const ACTIVITY_CAP = 120;
const RESULT_PREVIEW_CHARS = 1_200;
const RESULT_PREVIEW_LINES = 16;

export interface WorkerStatusActivity {
  tool: string;
  summary: string;
  status?: string;
  duration?: number;
}

export interface WorkerStatusUiRequest {
  id: string;
  method: string;
  title?: string;
}

export interface WorkerStatusSnapshot {
  id: string;
  lifecycle: string;
  agent: string;
  model?: string;
  generation: number;
  turns: number;
  maxTurns: number;
  phase?: string;
  createdAt: number;
  lastEventAt?: number;
  mission: string;
  pendingSteer: number;
  pendingFollowUp: number;
  killReason?: string;
  exitCode?: number | null;
  latestResult?: string;
  latestAssistantText?: string;
  running: WorkerStatusActivity[];
  recent: WorkerStatusActivity[];
  errors: string[];
  waitingUi: WorkerStatusUiRequest[];
}

function lastEventAge(snapshot: WorkerStatusSnapshot, now: number): string {
  return snapshot.lastEventAt != null
    ? formatAge(now - snapshot.lastEventAt)
    : "n/a";
}

function activityLine(activity: WorkerStatusActivity): string {
  const duration =
    activity.duration != null ? ` (${formatAge(activity.duration)})` : "";
  const status = activity.status ? `${activity.status} ` : "";
  return `${status}${activity.tool}: ${cleanOneLine(activity.summary, ACTIVITY_CAP)}${duration}`;
}

function headerLines(snapshot: WorkerStatusSnapshot, now: number): string[] {
  const pending =
    snapshot.pendingSteer > 0 || snapshot.pendingFollowUp > 0
      ? `pending_messages: steer=${snapshot.pendingSteer} follow_up=${snapshot.pendingFollowUp}`
      : undefined;
  return [
    `${snapshot.id}  lifecycle=${snapshot.lifecycle}  agent=${snapshot.agent}  model=${snapshot.model ?? "default"}`,
    `generation=${snapshot.generation}  turns=${snapshot.turns}/${snapshot.maxTurns}${snapshot.phase ? `  phase=${snapshot.phase}` : ""}  last_event_age=${lastEventAge(snapshot, now)}`,
    `mission: ${cleanOneLine(snapshot.mission, MISSION_CAP)}`,
    pending,
    snapshot.killReason ? `kill_reason: ${snapshot.killReason}` : undefined,
    snapshot.exitCode != null ? `exit_code: ${snapshot.exitCode}` : undefined,
  ].filter((line): line is string => line !== undefined);
}

function waitingUiLines(snapshot: WorkerStatusSnapshot): string[] {
  if (snapshot.waitingUi.length === 0) return [];
  return [
    `waiting_ui (${snapshot.waitingUi.length}); reply via task_reply:`,
    ...snapshot.waitingUi.slice(0, 2).map(
      (request) =>
        `  - ${request.id} method=${request.method}${request.title ? ` title=${cleanOneLine(request.title, 60)}` : ""}`,
    ),
  ];
}

function liveBody(snapshot: WorkerStatusSnapshot): string[] {
  const running = snapshot.running[0];
  const recent = snapshot.recent.slice(-2);
  const errors = snapshot.errors.slice(-2);
  return [
    running ? `running: ${activityLine(running)}` : "running: (none)",
    recent.length
      ? `recent: ${recent.map((activity) => activityLine(activity)).join(" | ")}`
      : undefined,
    errors.length ? `errors: ${errors.map((error) => cleanOneLine(error, 160)).join(" | ")}` : undefined,
    ...waitingUiLines(snapshot),
  ].filter((line): line is string => line !== undefined);
}

function settledBody(snapshot: WorkerStatusSnapshot): string[] {
  const bound = boundText(
    snapshot.latestResult || snapshot.latestAssistantText,
    RESULT_PREVIEW_CHARS,
    RESULT_PREVIEW_LINES,
  );
  return [
    ...waitingUiLines(snapshot),
    `--- result (${bound.truncated ? "truncated tail; task_wait returns the full bounded report" : "full"}) ---`,
    bound.text || "(empty)",
  ];
}

/** Compact lifecycle snapshot for task_status / abort / close / wait failures. */
export function formatCompactWorkerStatus(
  snapshot: WorkerStatusSnapshot,
  now = Date.now(),
): string {
  const live = isLiveLifecycle(snapshot.lifecycle as WorkerLifecycle);
  return [
    ...headerLines(snapshot, now),
    ...(live ? liveBody(snapshot) : settledBody(snapshot)),
  ].join("\n");
}

/** Heartbeat for a wait timeout or interrupt — no result body. */
export function formatWaitHeartbeat(
  snapshot: WorkerStatusSnapshot,
  now = Date.now(),
): string {
  const running = snapshot.running.at(-1);
  return [
    `${snapshot.id} lifecycle=${snapshot.lifecycle} agent=${snapshot.agent} generation=${snapshot.generation} turns=${snapshot.turns}/${snapshot.maxTurns} last_event_age=${lastEventAge(snapshot, now)}`,
    running ? `activity: ${activityLine(running)}` : undefined,
    ...waitingUiLines(snapshot),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Bounded specialist report attached once, when a generation settles. */
export function formatSettledResult(value: unknown): {
  text: string;
  truncated: boolean;
} {
  return boundText(value, SETTLED_RESULT_CHARS, SETTLED_RESULT_LINES);
}

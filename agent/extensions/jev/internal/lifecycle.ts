// Pure task_wait audit helpers. No Pi imports, I/O, or network.

export interface WaitObservation {
  workerId: string;
  generation: number | undefined;
  /** True when a "--- result ---" body was present (settled), not a heartbeat. */
  settled: boolean;
}

export interface WaitAudit {
  workerId: string;
  generation: number | undefined;
  reportStatus: string | undefined;
  mission: string;
  reportBody: string;
}

const ADVISORY_MAX = 400;
const RESULT_MARKER = "--- result ---";
const POLL_THRESHOLD = 3;

let lastWaitKey: string | undefined;
let lastWaitCount = 0;

function bound(text: string, max = ADVISORY_MAX): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function textFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
    parts.push(block.text);
  }
  if (parts.length === 0) return undefined;
  return parts.join("\n");
}

function extractReportBody(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trim() === RESULT_MARKER);
  if (index < 0) return undefined;
  return lines.slice(index + 1).join("\n");
}

function workerIdentity(details: unknown): {
  workerId: string;
  generation: number | undefined;
  worker: Record<string, unknown>;
} | null {
  if (!isRecord(details)) return null;
  const worker = isRecord(details.worker) ? details.worker : undefined;
  if (!worker) return null;
  const workerId = typeof worker.id === "string" ? worker.id.trim() : "";
  if (!workerId) return null;
  const generation = typeof worker.generation === "number" && Number.isFinite(worker.generation)
    ? worker.generation
    : undefined;
  return { workerId, generation, worker };
}

/** Identity for any task_wait result (settled or heartbeat). Null when the
 *  tool is not task_wait or details do not carry a usable worker id. */
export function readWaitObservation(
  toolName: string,
  content: unknown,
  details: unknown,
): WaitObservation | null {
  if (toolName !== "task_wait") return null;
  const identity = workerIdentity(details);
  if (!identity) return null;
  const text = textFromContent(content);
  const settled = text !== undefined && extractReportBody(text) !== undefined;
  return { workerId: identity.workerId, generation: identity.generation, settled };
}

/** Returns null when this is not an auditable settled task_wait result
 *  (wrong tool, heartbeat/timeout, or no "--- result ---" marker). */
export function readWaitResult(
  toolName: string,
  content: unknown,
  details: unknown,
): WaitAudit | null {
  const observation = readWaitObservation(toolName, content, details);
  if (!observation?.settled) return null;
  const text = textFromContent(content);
  if (text === undefined) return null;
  const reportBody = extractReportBody(text);
  if (reportBody === undefined) return null;
  const identity = workerIdentity(details);
  if (!identity) return null;
  const mission = typeof identity.worker.mission === "string" ? identity.worker.mission : "";
  const reportStatus = isRecord(details) && typeof details.reportStatus === "string"
    ? details.reportStatus
    : undefined;
  return {
    workerId: observation.workerId,
    generation: observation.generation,
    reportStatus,
    mission,
    reportBody,
  };
}

/** Deterministic advisory for a broken report contract. Null when fine. */
export function reportStatusAdvisory(audit: WaitAudit): string | null {
  if (audit.reportStatus !== "missing" && audit.reportStatus !== "invalid") return null;
  return bound(
    `A report schema was requested, but the worker reply is ${audit.reportStatus}; the result below may not be machine-checkable.`,
  );
}

/** Records a wait. Heartbeats on the same (workerId, generation) increment;
 *  a settled result on that key resets to 0. Returns the current consecutive
 *  heartbeat count (0 after a settle). */
export function noteWait(
  workerId: string,
  generation: number | undefined,
  settled = false,
): number {
  const key = `${workerId}\0${generation ?? ""}`;
  if (settled) {
    lastWaitKey = key;
    lastWaitCount = 0;
    return 0;
  }
  if (lastWaitKey === key) {
    lastWaitCount += 1;
  } else {
    lastWaitKey = key;
    lastWaitCount = 1;
  }
  return lastWaitCount;
}

/** Advisory when the same worker+generation has been waited on repeatedly. Null when fine. */
export function pollAdvisory(consecutiveCount: number, workerId: string): string | null {
  if (consecutiveCount < POLL_THRESHOLD) return null;
  const id = workerId.trim() || "worker";
  return bound(
    `task_wait on ${id} has returned ${consecutiveCount} consecutive timeout heartbeats for the same generation; do independent work instead of polling.`,
  );
}

/** Resets module state. */
export function resetLifecycleState(): void {
  lastWaitKey = undefined;
  lastWaitCount = 0;
}

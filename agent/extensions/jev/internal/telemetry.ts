import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";

const MAX_LOG_BYTES = 1_000_000;
const LOG_FILE_NAME = "pi-jev.jsonl";
export type EvaluationStatus = "success" | "no-match" | "timeout" | "error" | "cancelled" | "skipped";

export interface TelemetryEvent {
  event: "evaluation" | "suggestion" | "read-after-suggestion" | "edit-after-finding";
  sessionId: string;
  workspaceId: string;
  evaluationId?: string;
  suggestionId?: string;
  source?: string;
  sources?: string[];
  status?: EvaluationStatus;
  elapsedMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  skill?: string;
  findings?: Array<{ id: string; probability: number }>;
  probability?: number;
  skillDecision?: {
    reason: "selected" | "none_needed" | "below_threshold" | "unusable";
    winner: string;
    probability: number;
    threshold: number;
    candidateCount: number;
  };
  thresholds?: { skill?: number; risk?: number; code?: number };
  skipReason?: "short-prompt" | "no-questions";
  toolCallId?: string;
  originatingToolCallId?: string;
  proxy?: "read-after-suggestion" | "edit-after-finding";
}

function logPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return join(agentDir, "logs", LOG_FILE_NAME);
}

function rotateIfNeeded(path: string): void {
  try {
    if (statSync(path).size < MAX_LOG_BYTES) return;
    const archive = `${path}.1`;
    rmSync(archive, { force: true });
    renameSync(path, archive);
  } catch {
    // Missing and unrotatable logs both fail soft.
  }
}

/** Append one bounded metadata-only event. Callers must never pass prompts, source, patches, errors, or paths. */
export function logTelemetry(event: TelemetryEvent): void {
  try {
    const path = logPath();
    mkdirSync(dirname(path), { recursive: true });
    rotateIfNeeded(path);
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8");
  } catch {
    // Measurement must never affect agent work.
  }
}

export function nextEphemeralId(prefix: "session" | "eval" | "suggestion"): string {
  return `${prefix}-${randomUUID()}`;
}

/** Stable, payload-free workspace correlation. The normalized path itself is never logged. */
export function workspaceIdForCwd(cwd: string): string {
  const normalized = normalize(resolve(cwd)).replace(/\\/g, "/");
  const canonical = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 24);
}

/** Match Pi's normal relative/absolute/~ path behavior closely enough for in-memory correlation. */
export function normalizeToolPath(rawPath: string, cwd: string): string {
  let value = rawPath.trim();
  if (value.startsWith("@")) value = value.slice(1);
  if (value === "~") value = homedir();
  else if (value.startsWith("~/") || value.startsWith("~\\")) value = join(homedir(), value.slice(2));
  const absolute = resolve(cwd, value);
  const normalized = normalize(absolute).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

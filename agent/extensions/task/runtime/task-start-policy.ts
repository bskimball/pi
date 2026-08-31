import * as path from "node:path";
import type { WorkerLifecycle } from "./worker-runtime.ts";

export interface DuplicateTaskCandidate {
  id: string;
  agent: string;
  cwd: string;
  initialPrompt: string;
  lifecycle: WorkerLifecycle;
  closed: boolean;
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function normalizeTaskWorkOrder(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isActive(lifecycle: WorkerLifecycle): boolean {
  return (
    lifecycle === "starting" ||
    lifecycle === "running" ||
    lifecycle === "retrying" ||
    lifecycle === "compacting" ||
    lifecycle === "aborting"
  );
}

export function findDuplicateTask(
  workers: Iterable<DuplicateTaskCandidate>,
  agent: string,
  cwd: string,
  prompt: string,
): DuplicateTaskCandidate | undefined {
  const targetCwd = canonicalPath(cwd);
  const targetPrompt = normalizeTaskWorkOrder(prompt);
  if (!targetPrompt) return undefined;
  for (const worker of workers) {
    if (worker.closed || !isActive(worker.lifecycle)) continue;
    if (worker.agent !== agent) continue;
    if (canonicalPath(worker.cwd) !== targetCwd) continue;
    if (normalizeTaskWorkOrder(worker.initialPrompt) !== targetPrompt) continue;
    return worker;
  }
  return undefined;
}

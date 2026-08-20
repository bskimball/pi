// Durable, bounded metadata for async RPC workers. This never owns child pipes.

import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkerLifecycle } from "./worker-runtime.ts";

export const WORKER_SIDECAR_VERSION = 1;
export const WORKER_SIDECAR_FILE = "worker.json";
export const MAX_WORKER_SIDECARS = 32;
const MAX_WORKER_SIDECAR_SCAN_DIRS = 4096;

export interface WorkerSidecar {
  version: 1;
  instanceId: string;
  id: string;
  agent: string;
  mission: string;
  cwd: string;
  model?: string;
  thinking?: string;
  sessionDir: string;
  pid?: number;
  parentPid: number;
  createdAt: number;
  updatedAt: number;
  lifecycle: WorkerLifecycle;
  generation: number;
  closed: boolean;
}

export function sidecarPath(sessionDir: string): string {
  return path.join(sessionDir, WORKER_SIDECAR_FILE);
}

function validSidecar(value: unknown): value is WorkerSidecar {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<WorkerSidecar>;
  return item.version === WORKER_SIDECAR_VERSION &&
    typeof item.instanceId === "string" &&
    typeof item.id === "string" &&
    typeof item.agent === "string" &&
    typeof item.mission === "string" &&
    typeof item.cwd === "string" &&
    typeof item.sessionDir === "string" &&
    typeof item.parentPid === "number" &&
    typeof item.createdAt === "number" &&
    typeof item.updatedAt === "number" &&
    typeof item.lifecycle === "string" &&
    typeof item.generation === "number" &&
    typeof item.closed === "boolean";
}

export function writeWorkerSidecar(sidecar: WorkerSidecar): void {
  fs.mkdirSync(sidecar.sessionDir, { recursive: true });
  const target = sidecarPath(sidecar.sessionDir);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(sidecar)}\n`, "utf8");
  try {
    fs.renameSync(temp, target);
  } catch (error) {
    // Windows cannot rename over an existing file.
    if ((error as NodeJS.ErrnoException).code === "EEXIST" || process.platform === "win32") {
      try {
        fs.unlinkSync(target);
      } catch {
        // ignore
      }
      fs.renameSync(temp, target);
      return;
    }
    try {
      fs.unlinkSync(temp);
    } catch {
      // ignore
    }
    throw error;
  }
}

export function readWorkerSidecar(sessionDir: string): WorkerSidecar | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(sidecarPath(sessionDir), "utf8"));
    return validSidecar(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function listWorkerSidecars(root: string, max = MAX_WORKER_SIDECARS): WorkerSidecar[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: WorkerSidecar[] = [];
  let scanned = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || scanned++ >= MAX_WORKER_SIDECAR_SCAN_DIRS) continue;
    const sidecar = readWorkerSidecar(path.join(root, entry.name));
    if (sidecar) result.push(sidecar);
  }
  return result
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, Math.max(0, max));
}

export function deleteWorkerSidecar(sessionDir: string): void {
  try {
    fs.unlinkSync(sidecarPath(sessionDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export type RebindClassification = "skip" | "orphan" | "rebind";

export function classifyWorkerSidecar(
  sidecar: WorkerSidecar,
  options: { registered: boolean; pidAlive: (pid: number) => boolean },
): RebindClassification {
  if (sidecar.closed || options.registered) return "skip";
  return sidecar.pid && options.pidAlive(sidecar.pid) ? "orphan" : "rebind";
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

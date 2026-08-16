// Crash-surviving last-phase breadcrumb. Per-pid files only so children
// cannot clobber the parent. Never throws.

import * as fs from "node:fs";
import * as path from "node:path";
import { watchdogStateDirectory } from "./terminal-restore.ts";

const PHASE_CAP = 240;

export function lastPhasePath(pid = process.pid): string {
  return path.join(watchdogStateDirectory(), `last-phase-${pid}`);
}

function sanitizePhase(phase: string): string {
  return String(phase).replace(/[\r\n]+/g, " ").slice(0, PHASE_CAP);
}

export function writeLastPhase(phase: string): void {
  try {
    const filePath = lastPhasePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const line = `${new Date().toISOString()} pid=${process.pid} ${sanitizePhase(phase)}`;
    fs.writeFileSync(filePath, line, "utf8");
  } catch {
    // ignore
  }
}

export function readLastPhase(pid: number): string | undefined {
  try {
    const value = fs.readFileSync(lastPhasePath(pid), "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

// Crash-surviving runtime telemetry for the detached terminal watchdog.
//
// Two alternating files keep the previous complete snapshot available if the
// Pi process dies while writing the next one. Values are metadata-only and
// bounded so the watchdog can safely include them in a postmortem log.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { watchdogStateDirectory } from "./terminal-restore.ts";

const SNAPSHOT_VERSION = 1;
const EVENT_LIMIT = 16;
const EVENT_LENGTH_LIMIT = 180;
const SNAPSHOT_FILE_LIMIT = 64 * 1024;
export const RUNTIME_HEARTBEAT_MS = 5_000;
const EVENT_PERSIST_DEBOUNCE_MS = 250;

export interface RuntimeSnapshotEvent {
  at: string;
  event: string;
}

export interface RuntimeSnapshot {
  version: number;
  sequence: number;
  timestamp: string;
  pid: number;
  ppid: number;
  uptimeMs: number;
  cwd: string;
  entrypoint: string;
  sessionFile?: string;
  terminalSession?: string;
  schedulerLagMs: number;
  memory?: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
  };
  cpu?: {
    userMicros: number;
    systemMicros: number;
  };
  resourceUsage?: {
    maxRssKb: number;
    fsRead: number;
    fsWrite: number;
    voluntaryContextSwitches: number;
    involuntaryContextSwitches: number;
  };
  systemMemory?: {
    free: number;
    total: number;
  };
  activeResources?: Record<string, number>;
  events: RuntimeSnapshotEvent[];
}

function sanitizeInline(value: unknown, limit: number): string {
  let text: string;
  try {
    text = String(value ?? "");
  } catch {
    text = "[unavailable]";
  }
  return text.replace(/[\r\n\t]+/g, " ").slice(0, limit);
}

export function runtimeSnapshotPath(pid: number, slot: 0 | 1): string {
  return path.join(watchdogStateDirectory(), `crash-runtime-${pid}-${slot}.json`);
}

export function clearRuntimeSnapshots(pid = process.pid): void {
  for (const slot of [0, 1] as const) {
    try {
      fs.unlinkSync(runtimeSnapshotPath(pid, slot));
    } catch {
      // ignore
    }
  }
}
function parseSnapshot(filePath: string, pid: number): RuntimeSnapshot | undefined {
  try {
    const stats = fs.statSync(filePath);
    if (stats.size <= 0 || stats.size > SNAPSHOT_FILE_LIMIT) return undefined;
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as RuntimeSnapshot;
    if (
      value.version !== SNAPSHOT_VERSION ||
      value.pid !== pid ||
      !Number.isFinite(value.sequence) ||
      !Number.isFinite(Date.parse(value.timestamp)) ||
      !Array.isArray(value.events)
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

export function readRuntimeSnapshot(pid: number): RuntimeSnapshot | undefined {
  const snapshots = ([0, 1] as const)
    .map((slot) => parseSnapshot(runtimeSnapshotPath(pid, slot), pid))
    .filter((value): value is RuntimeSnapshot => value !== undefined);
  snapshots.sort((a, b) => {
    const timestampDelta = Date.parse(b.timestamp) - Date.parse(a.timestamp);
    return timestampDelta || b.sequence - a.sequence;
  });
  return snapshots[0];
}

function activeResourceCounts(): Record<string, number> | undefined {
  try {
    const processWithResources = process as typeof process & {
      getActiveResourcesInfo?: () => string[];
    };
    const getActiveResourcesInfo = processWithResources.getActiveResourcesInfo;
    if (!getActiveResourcesInfo) return undefined;
    const counts = new Map<string, number>();
    for (const name of getActiveResourcesInfo.call(processWithResources)) {
      const key = sanitizeInline(name, 80);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Object.fromEntries(
      [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(0, 24),
    );
  } catch {
    return undefined;
  }
}

export class CrashRuntimeMonitor {
  private sequence = 0;
  private sessionFile: string | undefined;
  private schedulerLagMs = 0;
  private nextHeartbeatAt: number;
  private pendingPersist: NodeJS.Timeout | undefined;
  private readonly events: RuntimeSnapshotEvent[] = [];
  private readonly timer: NodeJS.Timeout;

  constructor(heartbeatMs = RUNTIME_HEARTBEAT_MS) {
    const interval = Math.max(250, heartbeatMs);
    this.nextHeartbeatAt = Date.now() + interval;
    this.note("monitor-start");
    this.timer = setInterval(() => {
      const now = Date.now();
      this.schedulerLagMs = Math.max(0, now - this.nextHeartbeatAt);
      this.nextHeartbeatAt = now + interval;
      this.persist();
    }, interval);
    this.timer.unref();
  }

  setSessionFile(sessionFile: string | undefined): void {
    this.sessionFile = sessionFile;
  }

  note(event: string): void {
    this.events.push({
      at: new Date().toISOString(),
      event: sanitizeInline(event, EVENT_LENGTH_LIMIT),
    });
    if (this.events.length > EVENT_LIMIT) {
      this.events.splice(0, this.events.length - EVENT_LIMIT);
    }
    if (this.pendingPersist) return;
    this.pendingPersist = setTimeout(() => {
      this.pendingPersist = undefined;
      this.persist();
    }, EVENT_PERSIST_DEBOUNCE_MS);
    this.pendingPersist.unref();
  }

  stop(clean = true): void {
    clearInterval(this.timer);
    if (this.pendingPersist) clearTimeout(this.pendingPersist);
    this.pendingPersist = undefined;
    if (clean) clearRuntimeSnapshots();
  }

  private persist(): void {
    try {
      const memory = process.memoryUsage();
      const cpu = process.cpuUsage();
      const usage = process.resourceUsage();
      const snapshot: RuntimeSnapshot = {
        version: SNAPSHOT_VERSION,
        sequence: ++this.sequence,
        timestamp: new Date().toISOString(),
        pid: process.pid,
        ppid: process.ppid,
        uptimeMs: Math.round(process.uptime() * 1_000),
        cwd: sanitizeInline(process.cwd(), 1_024),
        entrypoint: sanitizeInline(process.argv[1] ?? "unknown", 1_024),
        sessionFile: this.sessionFile
          ? sanitizeInline(this.sessionFile, 2_048)
          : undefined,
        terminalSession: process.env.WT_SESSION
          ? sanitizeInline(process.env.WT_SESSION, 160)
          : undefined,
        schedulerLagMs: this.schedulerLagMs,
        memory: {
          rss: memory.rss,
          heapTotal: memory.heapTotal,
          heapUsed: memory.heapUsed,
          external: memory.external,
          arrayBuffers: memory.arrayBuffers,
        },
        cpu: {
          userMicros: cpu.user,
          systemMicros: cpu.system,
        },
        resourceUsage: {
          maxRssKb: usage.maxRSS,
          fsRead: usage.fsRead,
          fsWrite: usage.fsWrite,
          voluntaryContextSwitches: usage.voluntaryContextSwitches,
          involuntaryContextSwitches: usage.involuntaryContextSwitches,
        },
        systemMemory: {
          free: os.freemem(),
          total: os.totalmem(),
        },
        activeResources: activeResourceCounts(),
        events: [...this.events],
      };
      const slot = (snapshot.sequence % 2) as 0 | 1;
      const filePath = runtimeSnapshotPath(process.pid, slot);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(snapshot), "utf8");
    } catch {
      // Runtime diagnostics must never create another fatal error.
    }
  }
}

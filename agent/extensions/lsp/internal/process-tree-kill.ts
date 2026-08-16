// process-tree-kill: Windows-safe process-tree reaping for tools and workers.
//
// Single module for taskkill /T (Windows) and process-group or direct signals
// (POSIX). Callers pass pid + options only.

import {
  spawn,
  spawnSync,
  type SpawnOptions,
} from "node:child_process";
import * as path from "node:path";

export interface KillOptions {
  /**
   * On POSIX, signal the process group (-pid) first, then fall back to the
   * direct pid. Use for jobs started with detached/new process groups (bg).
   * Default false (direct pid) — matches RPC worker children.
   */
  processGroup?: boolean;
}

export interface WindowsTreeKillOptions {
  spawnImpl?: typeof spawn;
  timeoutMs?: number;
}

function taskkillPath(): string {
  return path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "taskkill.exe",
  );
}

function killDirect(pid: number, signal?: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

function killGroupOrDirect(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    killDirect(pid, signal);
  }
}

function posixKill(pid: number, signal: NodeJS.Signals, processGroup: boolean): void {
  if (processGroup) killGroupOrDirect(pid, signal);
  else killDirect(pid, signal);
}

/** Interactive/async tree kill. */
export function killProcessTree(pid: number, options: KillOptions = {}): void {
  const processGroup = options.processGroup === true;
  if (process.platform === "win32") {
    try {
      const taskkill = spawn(
        taskkillPath(),
        ["/F", "/T", "/PID", String(pid)],
        { stdio: "ignore", windowsHide: true },
      );
      const fallback = () => killDirect(pid);
      taskkill.once("error", fallback);
      taskkill.once("close", (code) => {
        if (code !== 0) fallback();
      });
    } catch {
      killDirect(pid);
    }
    return;
  }

  posixKill(pid, "SIGTERM", processGroup);
  setTimeout(() => {
    posixKill(pid, "SIGKILL", processGroup);
  }, 1500).unref?.();
}

/**
 * Await bounded Windows taskkill completion. Used by async cleanup paths that
 * must not return before cmd/bat grandchildren have been reaped.
 */
export function killWindowsProcessTree(
  pid: number,
  options: WindowsTreeKillOptions = {},
): Promise<void> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const timeoutMs = Math.max(1, options.timeoutMs ?? 2_000);
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      const spawnOptions: SpawnOptions = {
        stdio: "ignore",
        windowsHide: true,
      };
      const child = spawnImpl(
        taskkillPath(),
        ["/PID", String(pid), "/T", "/F"],
        spawnOptions,
      );
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        finish();
      });
      child.once("error", () => {
        clearTimeout(timer);
        finish();
      });
    } catch {
      finish();
    }
  });
}

/**
 * Session teardown kill: best-effort synchronous reaping so taskkill/SIGKILL
 * are not left on unref timers that may never run during process exit.
 */
export function killProcessTreeSync(pid: number, options: KillOptions = {}): void {
  const processGroup = options.processGroup === true;
  if (process.platform === "win32") {
    try {
      spawnSync(taskkillPath(), ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 5000,
      });
    } catch {
      // fall through
    }
    killDirect(pid);
    return;
  }

  try {
    if (processGroup) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        killDirect(pid, "SIGKILL");
      }
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // ignore
  }
}

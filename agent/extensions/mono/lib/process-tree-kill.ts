// Windows-safe process-tree kill helpers shared by async RPC workers.
// Mirrors the patterns in bg-process.ts / amp-task.ts without coupling.

import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";

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

/** Interactive/async tree kill. */
export function killProcessTree(pid: number): void {
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

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // ignore
  }
  setTimeout(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
  }, 1500).unref?.();
}

/**
 * Session teardown kill: best-effort synchronous reaping so taskkill/SIGKILL
 * are not left on unref timers that may never run during process exit.
 */
export function killProcessTreeSync(pid: number): void {
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
    process.kill(pid, "SIGKILL");
  } catch {
    // ignore
  }
}

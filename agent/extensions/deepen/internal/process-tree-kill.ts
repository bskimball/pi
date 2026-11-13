// Standalone process-tree termination for deepen helper subprocesses.
// Duplicated per extension-independence invariant (no cross-extension imports).

import { spawn } from "node:child_process";
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
    // Process already exited.
  }
}

export function killProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn(
        taskkillPath(),
        ["/F", "/T", "/PID", String(pid)],
        { stdio: "ignore", windowsHide: true },
      );
      const fallback = () => killDirect(pid);
      killer.once("error", fallback);
      killer.once("close", (code) => {
        if (code !== 0) fallback();
      });
    } catch {
      killDirect(pid);
    }
    return;
  }

  killDirect(pid, "SIGTERM");
  setTimeout(() => {
    killDirect(pid, "SIGKILL");
  }, 1500).unref?.();
}

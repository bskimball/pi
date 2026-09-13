// Best-effort interactive terminal restore for unclean Pi exits.
//
// Pi's fullscreen TUI enables SGR mouse tracking and the alternate screen.
// Those modes are only cleared if `TuiAltScreen` stop runs. A native kill,
// V8 fatal, or process.exit that skips the TUI leaves the parent shell in
// raw/mouse mode — the leftover `^[[<35;…M` flood after a crash.
//
// Sequences match `@earendil-works/pi-tui` `tui-alt-screen.js` / `terminal.js`.
// Keep `terminal-restore-watchdog.mjs` in sync.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const TERMINAL_RESTORE_SEQUENCE = [
  "\x1b[?2026l",
  "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l",
  "\x1b[?2004l",
  "\x1b[<u",
  "\x1b[>4;0m",
  "\x1b[?7h",
  "\x1b[?1049l",
  "\x1b[?25h",
  "\x1b[0m",
].join("");

export function watchdogStateDirectory(): string {
  const dir = process.env.PI_TERMINAL_WATCHDOG_STATE_DIR;
  return dir && dir.length
    ? dir
    : path.join(os.homedir(), ".pi", "agent", ".tmp");
}

export function watchdogStatePath(pid = process.pid): string {
  return path.join(watchdogStateDirectory(), `term-watchdog-${pid}`);
}

export function markTerminalWatchdogLive(pid = process.pid): void {
  try {
    const filePath = watchdogStatePath(pid);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "live", "utf8");
  } catch {
    // ignore
  }
}

export function markTerminalWatchdogClean(pid = process.pid): void {
  try {
    fs.writeFileSync(watchdogStatePath(pid), "clean", "utf8");
  } catch {
    // ignore
  }
}

export function readTerminalWatchdogState(
  pid: number,
): "live" | "clean" | undefined {
  try {
    const value = fs.readFileSync(watchdogStatePath(pid), "utf8").trim();
    if (value === "live" || value === "clean") return value;
    return undefined;
  } catch {
    return undefined;
  }
}

export function shouldRestoreInteractiveTerminal(): boolean {
  if (process.env.PI_SUBAGENT === "1") return false;
  if (process.env.PI_TERMINAL_WATCHDOG_CHILD === "1") return false;
  return Boolean(process.stdout.isTTY);
}

function restoreInputMode(): boolean {
  let restored = true;
  try {
    process.stdin.setRawMode?.(false);
  } catch {
    restored = false;
  }
  try {
    process.stdin.pause();
  } catch {
    restored = false;
  }
  return restored;
}

/**
 * Synchronous restore for process-exit paths. Returns whether output teardown
 * was written; callers can leave the watchdog live when the write failed.
 */
export function restoreInteractiveTerminalSync(): boolean {
  if (!shouldRestoreInteractiveTerminal()) return true;
  let outputRestored = false;
  try {
    fs.writeSync(1, TERMINAL_RESTORE_SEQUENCE);
    outputRestored = true;
  } catch {
    // The detached watchdog may still be able to reopen the terminal.
  }
  const inputRestored = restoreInputMode();
  return outputRestored && inputRestored;
}

/** Normal best-effort restore outside process-exit handlers. */
export function restoreInteractiveTerminal(): void {
  if (!shouldRestoreInteractiveTerminal()) return;
  try {
    process.stdout.write(TERMINAL_RESTORE_SEQUENCE);
  } catch {
    // A restore path must never throw.
  }
  restoreInputMode();
}

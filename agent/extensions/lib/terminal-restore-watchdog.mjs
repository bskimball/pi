// Detached waiter: when the interactive Pi PID disappears without a JS
// shutdown, restore the terminal modes left behind by the fullscreen TUI.
// Portable across Windows console/ConPTY and POSIX terminals. Keep the output
// sequence in sync with terminal-restore.ts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TERMINAL_RESTORE_SEQUENCE = [
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

const POLL_MS = 250;

function watchedPid() {
  const raw = process.argv[2] || process.env.PI_WATCH_PID || "";
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function envOrDefault(name, fallback) {
  const value = process.env[name];
  return value && value.length ? value : fallback;
}

function stateDirectory() {
  return envOrDefault(
    "PI_TERMINAL_WATCHDOG_STATE_DIR",
    path.join(os.homedir(), ".pi", "agent", ".tmp"),
  );
}

function statePath(pid) {
  return path.join(stateDirectory(), `term-watchdog-${pid}`);
}

function lifecycleLogPath() {
  return envOrDefault(
    "PI_TERMINAL_WATCHDOG_LOG_PATH",
    path.join(os.homedir(), ".pi", "agent", "pi-lifecycle.log"),
  );
}

function crashLogPath() {
  return envOrDefault(
    "PI_TERMINAL_WATCHDOG_CRASH_LOG_PATH",
    path.join(os.homedir(), ".pi", "agent", "pi-crash.log"),
  );
}

function lastPhasePath(pid) {
  return path.join(stateDirectory(), `last-phase-${pid}`);
}

function readLastPhaseLine(pid) {
  try {
    const value = fs.readFileSync(lastPhasePath(pid), "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function appendCrashLog(message) {
  try {
    const logPath = crashLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(
      logPath,
      `\n=== terminal restore watchdog at ${new Date().toISOString()} ===\n${message}\n`,
      "utf8",
    );
  } catch {
    // ignore
  }
}

function readState(pid) {
  try {
    const value = fs.readFileSync(statePath(pid), "utf8").trim();
    return value === "live" || value === "clean" ? value : undefined;
  } catch {
    return undefined;
  }
}

function clearState(pid) {
  try {
    fs.unlinkSync(statePath(pid));
  } catch {
    // ignore
  }
}

function restoreInput() {
  try {
    process.stdin.setRawMode?.(false);
  } catch {
    // ignore
  }
  try {
    process.stdin.pause();
  } catch {
    // ignore
  }
}

function writeRestore() {
  try {
    fs.writeSync(1, TERMINAL_RESTORE_SEQUENCE);
  } catch {
    try {
      const fd = fs.openSync(
        process.platform === "win32" ? "\\\\.\\CONOUT$" : "/dev/tty",
        "w",
      );
      try {
        fs.writeSync(fd, TERMINAL_RESTORE_SEQUENCE);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // Best effort only.
    }
  }
  restoreInput();
}

function logLifecycle(message) {
  try {
    const logPath = lifecycleLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(
      logPath,
      `\n=== terminal restore watchdog at ${new Date().toISOString()} ===\n${message}\n`,
      "utf8",
    );
  } catch {
    // ignore
  }
}

const pid = watchedPid();
if (!pid || pid === process.pid) process.exit(0);

function onParentGone() {
  const state = readState(pid);
  if (state === "live") {
    writeRestore();
    const lastPhase = readLastPhaseLine(pid);
    const lastPhaseLine = lastPhase ? `last-phase: ${lastPhase}` : "last-phase: (none)";
    const message = `parent pid=${pid} disappeared uncleanly; restored terminal\n${lastPhaseLine}`;
    logLifecycle(message);
    appendCrashLog(message);
  }
  clearState(pid);
  process.exit(0);
}

if (!isAlive(pid)) onParentGone();

const timer = setInterval(() => {
  if (isAlive(pid)) return;
  clearInterval(timer);
  onParentGone();
}, POLL_MS);

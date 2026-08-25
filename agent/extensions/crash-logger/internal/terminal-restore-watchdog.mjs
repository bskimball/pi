// Detached waiter: when the interactive Pi PID disappears without a JS
// shutdown, restore the terminal modes left behind by the fullscreen TUI.
// Portable across Windows console/ConPTY and POSIX terminals. Keep the output
// sequence in sync with terminal-restore.ts.

import { spawn, spawnSync } from "node:child_process";
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

const WATCHDOG_LOG_MAX_BYTES = 1024 * 1024;
const WATCHDOG_LOG_KEEP_BYTES = 512 * 1024;
const WATCHDOG_LOG_LOCK_ATTEMPTS = 20;
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
    path.join(os.homedir(), ".pi", "agent", "logs", "pi-lifecycle.log"),
  );
}

function crashLogPath() {
  return envOrDefault(
    "PI_TERMINAL_WATCHDOG_CRASH_LOG_PATH",
    path.join(os.homedir(), ".pi", "agent", "logs", "pi-crash.log"),
  );
}


function runtimeSnapshotPath(pid, slot) {
  return path.join(stateDirectory(), `crash-runtime-${pid}-${slot}.json`);
}

function boundedInline(value, limit = 240) {
  try {
    return String(value ?? "")
      .replace(/[\r\n\t]+/g, " ")
      .slice(0, limit);
  } catch {
    return "[unavailable]";
  }
}

function readJson(filePath, limit = 64 * 1024) {
  try {
    const stats = fs.statSync(filePath);
    if (stats.size <= 0 || stats.size > limit) return undefined;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function readRuntimeSnapshot(pid) {
  const snapshots = [0, 1]
    .map((slot) => readJson(runtimeSnapshotPath(pid, slot)))
    .filter(
      (value) =>
        value &&
        value.version === 1 &&
        value.pid === pid &&
        Number.isFinite(value.sequence) &&
        Number.isFinite(Date.parse(value.timestamp)) &&
        Array.isArray(value.events),
    );
  snapshots.sort((a, b) => {
    const timestampDelta = Date.parse(b.timestamp) - Date.parse(a.timestamp);
    return timestampDelta || b.sequence - a.sequence;
  });
  return snapshots[0];
}

function clearRuntimeEvidence(pid) {
  for (const filePath of [
    runtimeSnapshotPath(pid, 0),
    runtimeSnapshotPath(pid, 1),
    lastPhasePath(pid),
  ]) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
  }
}

function processAliveLine(label, pid) {
  if (!Number.isInteger(pid) || pid <= 0) return `${label}=unknown`;
  return `${label}=${pid} alive=${isAlive(pid)}`;
}

function formatExitObservation(observation) {
  if (!observation) return "exit-observation: unavailable";
  if (!Number.isInteger(observation.code)) {
    return `exit-observation: source=${observation.source} unavailable error=${boundedInline(observation.error, 500)}`;
  }
  const unsigned = observation.code >>> 0;
  const hex = `0x${unsigned.toString(16).padStart(8, "0")}`;
  return `exit-observation: source=${observation.source} signed=${observation.code} unsigned=${unsigned} hex=${hex}`;
}

function startWindowsExitWatcher(pid, onExit) {
  if (process.platform !== "win32") return undefined;
  try {
    const command = [
      "$ErrorActionPreference='Stop'",
      `try {$p=[System.Diagnostics.Process]::GetProcessById(${pid});$p.EnableRaisingEvents=$true;$p.WaitForExit();$p.Refresh();[Console]::Out.Write($p.ExitCode)} catch {[Console]::Error.Write($_.Exception.Message);exit 2}`,
    ].join(";");
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-1_024);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-2_048);
    });
    child.once("error", (error) => {
      onExit({ source: "windows-process-handle", error: error.message });
    });
    child.once("close", (code) => {
      const exitCode = Number.parseInt(stdout.trim(), 10);
      onExit({
        source: "windows-process-handle",
        code: Number.isInteger(exitCode) ? exitCode : undefined,
        error:
          code === 0
            ? undefined
            : boundedInline(stderr || `watcher-exit=${String(code)}`, 500),
      });
    });
    return child;
  } catch (error) {
    onExit({
      source: "windows-process-handle",
      error: boundedInline(error?.message || error, 500),
    });
    return undefined;
  }
}

function formatSnapshot(snapshot, detectedAt) {
  if (!snapshot) return ["runtime-snapshot: unavailable"];
  const heartbeatAgeMs = Math.max(0, detectedAt - Date.parse(snapshot.timestamp));
  const lines = [
    `runtime-snapshot: at=${snapshot.timestamp} ageMs=${heartbeatAgeMs} sequence=${snapshot.sequence} uptimeMs=${snapshot.uptimeMs} schedulerLagMs=${snapshot.schedulerLagMs}`,
    `process: ${processAliveLine("ppid", snapshot.ppid)} cwd=${JSON.stringify(boundedInline(snapshot.cwd, 1_024))} entrypoint=${JSON.stringify(boundedInline(snapshot.entrypoint, 1_024))}`,
  ];
  if (snapshot.sessionFile) {
    lines.push(`session=${JSON.stringify(boundedInline(snapshot.sessionFile, 2_048))}`);
  }
  if (snapshot.terminalSession) {
    lines.push(`terminal-session=${boundedInline(snapshot.terminalSession, 160)}`);
  }
  if (snapshot.memory) {
    lines.push(
      `memory: rss=${snapshot.memory.rss} heapUsed=${snapshot.memory.heapUsed} heapTotal=${snapshot.memory.heapTotal} external=${snapshot.memory.external} arrayBuffers=${snapshot.memory.arrayBuffers}`,
    );
  }
  if (snapshot.systemMemory) {
    lines.push(
      `system-memory: free=${snapshot.systemMemory.free} total=${snapshot.systemMemory.total}`,
    );
  }
  if (snapshot.cpu) {
    lines.push(
      `cpu: userMicros=${snapshot.cpu.userMicros} systemMicros=${snapshot.cpu.systemMicros}`,
    );
  }
  if (snapshot.resourceUsage) {
    lines.push(
      `resource-usage: maxRssKb=${snapshot.resourceUsage.maxRssKb} fsRead=${snapshot.resourceUsage.fsRead} fsWrite=${snapshot.resourceUsage.fsWrite} voluntaryContextSwitches=${snapshot.resourceUsage.voluntaryContextSwitches} involuntaryContextSwitches=${snapshot.resourceUsage.involuntaryContextSwitches}`,
    );
  }
  if (snapshot.activeResources) {
    const resources = Object.entries(snapshot.activeResources)
      .map(([name, count]) => `${boundedInline(name, 80)}=${count}`)
      .join(",");
    lines.push(`active-resources: ${resources || "none"}`);
  }
  lines.push("recent-events:");
  for (const event of snapshot.events.slice(-16)) {
    lines.push(`  ${boundedInline(event.at, 40)} ${boundedInline(event.event, 180)}`);
  }
  return lines;
}

function windowsPostmortemCommand(pid, ppid, detectedAt) {
  const start = new Date(detectedAt - 90_000).toISOString();
  const end = new Date(detectedAt + 15_000).toISOString();
  const escapedStart = start.replace(/'/g, "''");
  const escapedEnd = end.replace(/'/g, "''");
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    `$start=[datetime]'${escapedStart}'`,
    `$end=[datetime]'${escapedEnd}'`,
    `$pids=@(${pid},${Number.isInteger(ppid) ? ppid : 0})`,
    "$processes=Get-CimInstance Win32_Process | Where-Object { $pids -contains [int]$_.ProcessId } | Select-Object ProcessId,ParentProcessId,Name,CreationDate,ExecutablePath",
    "$application=Get-WinEvent -FilterHashtable @{LogName='Application';StartTime=$start;EndTime=$end} | Where-Object { $_.ProviderName -in @('Application Error','Windows Error Reporting','.NET Runtime','Application Hang') } | Select-Object -First 12 TimeCreated,ProviderName,Id,LevelDisplayName,RecordId,ActivityId,ProcessId,ThreadId",
    "$system=Get-WinEvent -FilterHashtable @{LogName='System';StartTime=$start;EndTime=$end} | Where-Object { $_.Id -eq 2004 -or $_.ProviderName -match 'Resource-Exhaustion|Kernel-Power|WHEA' } | Select-Object -First 12 TimeCreated,ProviderName,Id,LevelDisplayName,RecordId,ActivityId,ProcessId,ThreadId",
    "[pscustomobject]@{processes=$processes;application=$application;system=$system} | ConvertTo-Json -Depth 6 -Compress",
  ].join(";");
}

function windowsPostmortem(pid, ppid, detectedAt) {
  if (process.platform !== "win32") return [];
  if (process.env.PI_TERMINAL_WATCHDOG_POSTMORTEM === "0") {
    return ["windows-postmortem: disabled"];
  }
  try {
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", windowsPostmortemCommand(pid, ppid, detectedAt)],
      { encoding: "utf8", timeout: 5_000, windowsHide: true, maxBuffer: 256 * 1024 },
    );
    const output = boundedInline(result.stdout, 240_000);
    if (result.status !== 0 || !output) {
      return [
        `windows-postmortem: unavailable status=${String(result.status)} error=${boundedInline(result.error?.message || result.stderr, 500)}`,
      ];
    }
    return [`windows-postmortem: ${output}`];
  } catch (error) {
    return [`windows-postmortem: failed ${boundedInline(error?.message || error, 500)}`];
  }
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
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // ignore
  }
}

function withLogLock(logPath, action) {
  const lockPath = `${logPath}.watchdog-lock`;
  let lockFd;
  try {
    for (let attempt = 0; attempt < WATCHDOG_LOG_LOCK_ATTEMPTS; attempt += 1) {
      try {
        lockFd = fs.openSync(lockPath, "wx");
        break;
      } catch {
        sleepSync(25);
      }
    }
    action(lockFd !== undefined);
  } finally {
    if (lockFd !== undefined) {
      try {
        fs.closeSync(lockFd);
        fs.unlinkSync(lockPath);
      } catch {
        // ignore
      }
    }
  }
}

function trimLogForAppend(logPath, incomingBytes) {
  try {
    const stats = fs.statSync(logPath);
    if (stats.size + incomingBytes < WATCHDOG_LOG_MAX_BYTES) return;
    const keepBytes = Math.min(stats.size, WATCHDOG_LOG_KEEP_BYTES);
    const fd = fs.openSync(logPath, "r");
    try {
      const tail = Buffer.allocUnsafe(keepBytes);
      fs.readSync(fd, tail, 0, keepBytes, stats.size - keepBytes);
      const firstNewline = tail.indexOf(0x0a);
      const boundedTail =
        firstNewline >= 0 ? tail.subarray(firstNewline + 1) : tail;
      fs.writeFileSync(logPath, boundedTail);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Log bounding is best-effort and must never hide the current incident.
  }
}

function appendCrashLog(message) {
  try {
    const logPath = crashLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    withLogLock(logPath, (locked) => {
      if (locked) {
        trimLogForAppend(logPath, Buffer.byteLength(message, "utf8") + 128);
      }
      fs.appendFileSync(
        logPath,
        `\n=== terminal restore watchdog at ${new Date().toISOString()} ===\n${message}\n`,
        "utf8",
      );
    });
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
    withLogLock(logPath, (locked) => {
      if (locked) {
        trimLogForAppend(logPath, Buffer.byteLength(message, "utf8") + 128);
      }
      fs.appendFileSync(
        logPath,
        `\n=== terminal restore watchdog at ${new Date().toISOString()} ===\n${message}\n`,
        "utf8",
      );
    });
  } catch {
    // ignore
  }
}

const pid = watchedPid();
if (!pid || pid === process.pid) process.exit(0);
let exitObservation;
let parentGoneHandled = false;
let parentGonePending = false;
let exitObservationTimer;
const exitWatcher = startWindowsExitWatcher(pid, (observation) => {
  exitObservation = observation;
  if (exitObservationTimer) clearTimeout(exitObservationTimer);
  if (parentGonePending && !parentGoneHandled) onParentGone();
});

function observeParentGone() {
  if (parentGoneHandled || parentGonePending) return;
  parentGonePending = true;
  if (process.platform === "win32" && exitWatcher && !exitObservation) {
    exitObservationTimer = setTimeout(onParentGone, 750);
    exitObservationTimer.unref();
    return;
  }
  onParentGone();
}
function onParentGone() {
  if (parentGoneHandled) return;
  parentGoneHandled = true;
  if (exitObservationTimer) clearTimeout(exitObservationTimer);
  const state = readState(pid);
  if (state === "live") {
    const detectedAt = Date.now();
    const snapshot = readRuntimeSnapshot(pid);
    writeRestore();
    const lastPhase = readLastPhaseLine(pid);
    const lastPhaseLine = lastPhase
      ? `last-phase: ${lastPhase}`
      : "last-phase: (none)";
    const message = [
      `parent pid=${pid} disappeared uncleanly; restored terminal`,
      `detector: pid=${process.pid} ppid=${process.ppid} platform=${process.platform} node=${process.version}`,
      formatExitObservation(exitObservation),
      lastPhaseLine,
      ...formatSnapshot(snapshot, detectedAt),
      ...windowsPostmortem(pid, snapshot?.ppid, detectedAt),
    ].join("\n");
    logLifecycle(message);
    appendCrashLog(message);
  }
  exitWatcher?.kill();
  clearState(pid);
  clearRuntimeEvidence(pid);
  process.exit(0);
}

if (!isAlive(pid)) observeParentGone();

const timer = setInterval(() => {
  if (isAlive(pid)) return;
  clearInterval(timer);
  observeParentGone();
}, POLL_MS);

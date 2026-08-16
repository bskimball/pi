// Persist fatal JavaScript errors that Pi normally only prints to the terminal,
// plus a separate bounded lifecycle trace for compaction and session exits.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeLastPhase } from "./crash-logger/internal/last-phase.ts";
import { installSegmenterSafety } from "./crash-logger/internal/segmenter-safety.ts";
import {
  markTerminalWatchdogClean,
  markTerminalWatchdogLive,
  restoreInteractiveTerminalSync,
  shouldRestoreInteractiveTerminal,
} from "./crash-logger/internal/terminal-restore.ts";

const INSTALL_KEY = Symbol.for("pi.crashLogger.installed");
const state = globalThis as typeof globalThis & { [INSTALL_KEY]?: boolean };

// Module load, not factory time: the first fullscreen paint can happen as
// soon as extensions are imported. Prototype wrap is idempotent.
installSegmenterSafety();
writeLastPhase("startup");

export const MAX_LOG_BYTES = 1024 * 1024;
const ROTATED_LOG_SUFFIX = ".log";

function rotatedLogPrefix(logPath: string): string {
  return `${path.basename(logPath, path.extname(logPath))}.rotated.`;
}

function errorText(value: unknown): string {
  if (value instanceof Error)
    return value.stack || `${value.name}: ${value.message}`;
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function rotateIfNeeded(logPath: string): void {
  try {
    if (fs.statSync(logPath).size < MAX_LOG_BYTES) return;

    // Rename the active file instead of rewriting it in place. Other Pi
    // processes may append concurrently: on POSIX an already-open writer keeps
    // writing to the renamed file, while on Windows the rename fails safely if
    // another process holds the file open. Neither case overwrites new evidence.
    const directory = path.dirname(logPath);
    const rotatedPrefix = rotatedLogPrefix(logPath);
    const rotatedPath = path.join(
      directory,
      `${rotatedPrefix}${Date.now()}.${process.pid}${ROTATED_LOG_SUFFIX}`,
    );
    fs.renameSync(logPath, rotatedPath);

    // Keep one complete rotated generation plus the active log. Unique names
    // avoid cross-process replacement races; cleanup is best-effort.
    const rotated = fs
      .readdirSync(directory)
      .filter(
        (name) =>
          name.startsWith(rotatedPrefix) &&
          name.endsWith(ROTATED_LOG_SUFFIX),
      )
      .map((name) => {
        const filePath = path.join(directory, name);
        return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of rotated.slice(1)) {
      try {
        fs.unlinkSync(stale.filePath);
      } catch {
        // Another process may still hold or have already removed this archive.
      }
    }
  } catch {
    // Rotation must never create another fatal error.
  }
}

function processMetadata(): string {
  const subagent = process.env.PI_SUBAGENT === "1";
  const processKind = subagent ? "subagent" : "main Pi";
  const subagentDetails = subagent
    ? ` agent=${process.env.PI_SUBAGENT_AGENT ?? "unknown"} model=${process.env.PI_SUBAGENT_MODEL ?? "unknown"}`
    : "";
  return [
    `kind=${processKind}${subagentDetails}`,
    `pid=${process.pid} ppid=${process.ppid} node=${process.version} platform=${process.platform}`,
    `cwd=${process.cwd()}`,
    `entrypoint=${JSON.stringify(process.argv[1] ?? "unknown")} argc=${Math.max(0, process.argv.length - 2)}`,
    `terminal=${JSON.stringify({
      TERM: process.env.TERM,
      WT_SESSION: process.env.WT_SESSION,
      COLORTERM: process.env.COLORTERM,
      MSYSTEM: process.env.MSYSTEM,
      PI_APEX_UI: process.env.PI_APEX_UI,
    })}`,
  ].join("\n");
}

function appendToLog(logName: string, kind: string, value: unknown): void {
  try {
    const logPath = path.join(os.homedir(), ".pi", "agent", logName);
    const body = [
      "",
      `=== ${kind} at ${new Date().toISOString()} ===`,
      processMetadata(),
      errorText(value),
      "",
    ].join("\n");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    rotateIfNeeded(logPath);
    fs.appendFileSync(logPath, body, "utf8");
  } catch {
    // A crash logger must never create another fatal error.
  }
}

function appendCrash(kind: string, value: unknown): void {
  appendToLog("pi-crash.log", kind, value);
}

function appendLifecycle(kind: string, value: unknown): void {
  appendToLog("pi-lifecycle.log", kind, value);
}

function processError(kind: string, value: unknown): void {
  appendCrash(kind, value);
}

export default function (pi: ExtensionAPI): void {
  // Before any TUI measurement. The host compositor still measures every
  // transcript line via Intl.Segmenter; default grapheme path is JS-only so
  // native ICU cannot abort Node on Windows. This is independent of Apex.
  installSegmenterSafety();
  writeLastPhase("startup");
  let sessionFile: string | undefined;
  const logLifecycle = (kind: string, event?: unknown) => {
    appendLifecycle(
      kind,
      [
        sessionFile ? `session=${sessionFile}` : "session=(unknown)",
        event == null ? undefined : errorText(event),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  };

  pi.on("session_start", (event, ctx) => {
    sessionFile = ctx.sessionManager.getSessionFile();
    writeLastPhase(`session_start ${event.reason}`);
    logLifecycle(`session start (${event.reason})`);
  });
  pi.on("session_before_compact", (event) => {
    logLifecycle(`compaction start (${event.reason})`, {
      willRetry: event.willRetry,
      tokensBefore: event.preparation.tokensBefore,
      messagesToSummarize: event.preparation.messagesToSummarize.length,
      turnPrefixMessages: event.preparation.turnPrefixMessages.length,
    });
  });
  pi.on("session_compact", (event) => {
    logLifecycle(`compaction complete (${event.reason})`, {
      willRetry: event.willRetry,
      tokensBefore: event.compactionEntry.tokensBefore,
      fromExtension: event.fromExtension,
    });
  });
  pi.on("session_shutdown", (event) => {
    writeLastPhase(`session_shutdown ${event.reason}`);
    logLifecycle(`session shutdown (${event.reason})`, {
      targetSessionFile: event.targetSessionFile,
    });
  });

  if (state[INSTALL_KEY]) return;
  state[INSTALL_KEY] = true;

  process.on("uncaughtExceptionMonitor", (error, origin) => {
    processError(`uncaughtException (${origin})`, error);
  });
  process.on("unhandledRejection", (reason) => {
    processError("unhandledRejection", reason);
  });
  process.stdout.on("error", (error) => {
    processError("stdout error", error);
  });
  process.stderr.on("error", (error) => {
    processError("stderr error", error);
  });
  process.on("exit", (code) => {
    writeLastPhase(`exit ${code}`);
    // 129 is Pi's emergencyTerminalExit: the TTY is already gone. Writing
    // restore sequences here re-triggers EIO and can loop the emergency path.
    const restored = code === 129 || restoreInteractiveTerminalSync();
    if (restored) markTerminalWatchdogClean();
    if (code === 0 || code == null) return;
    processError(
      `process exit ${code}`,
      [
        `process.exitCode=${process.exitCode ?? "unset"}`,
        "No uncaught JavaScript error reached the logger. Pi most likely called process.exit() or set process.exitCode.",
      ].join("\n"),
    );
  });

  startTerminalRestoreWatchdog();
}

function startTerminalRestoreWatchdog(): void {
  if (!shouldRestoreInteractiveTerminal()) return;
  if (process.env.PI_TERMINAL_WATCHDOG === "0") return;
  try {
    const script = path.join(
      os.homedir(),
      ".pi",
      "agent",
      "extensions",
      "crash-logger",
      "internal",
      "terminal-restore-watchdog.mjs",
    );
    if (!fs.existsSync(script)) return;
    markTerminalWatchdogLive();
    const child = spawn(process.execPath, [script, String(process.pid)], {
      detached: true,
      stdio: ["inherit", "inherit", "ignore"],
      windowsHide: true,
      env: {
        ...process.env,
        PI_TERMINAL_WATCHDOG_CHILD: "1",
      },
    });
    child.once("error", () => {
      markTerminalWatchdogClean();
    });
    child.unref();
  } catch {
    markTerminalWatchdogClean();
    // A restore helper must never create another fatal error.
  }
}

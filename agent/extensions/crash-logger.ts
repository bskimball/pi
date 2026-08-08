// Persist fatal JavaScript errors that Pi normally only prints to the terminal.
// This makes intermittent terminal exits diagnosable after the terminal closes.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const INSTALL_KEY = Symbol.for("pi.crashLogger.installed");
const state = globalThis as typeof globalThis & { [INSTALL_KEY]?: boolean };

export const MAX_LOG_BYTES = 1024 * 1024;
const ROTATED_LOG_PREFIX = "pi-crash.rotated.";
const ROTATED_LOG_SUFFIX = ".log";

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
    const rotatedPath = path.join(
      directory,
      `${ROTATED_LOG_PREFIX}${Date.now()}.${process.pid}${ROTATED_LOG_SUFFIX}`,
    );
    fs.renameSync(logPath, rotatedPath);

    // Keep one complete rotated generation plus the active log. Unique names
    // avoid cross-process replacement races; cleanup is best-effort.
    const rotated = fs
      .readdirSync(directory)
      .filter(
        (name) =>
          name.startsWith(ROTATED_LOG_PREFIX) &&
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

function append(kind: string, value: unknown): void {
  try {
    const logPath = path.join(os.homedir(), ".pi", "agent", "pi-crash.log");
    const subagent = process.env.PI_SUBAGENT === "1";
    const processKind = subagent ? "subagent" : "main Pi";
    const subagentDetails = subagent
      ? ` agent=${process.env.PI_SUBAGENT_AGENT ?? "unknown"} model=${process.env.PI_SUBAGENT_MODEL ?? "unknown"}`
      : "";
    const body = [
      "",
      `=== ${processKind} ${kind} at ${new Date().toISOString()} ===`,
      `pid=${process.pid} ppid=${process.ppid} node=${process.version} platform=${process.platform}${subagentDetails}`,
      `cwd=${process.cwd()}`,
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

function processError(kind: string, value: unknown): void {
  append(kind, value);
}

export default function (_pi: ExtensionAPI): void {
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
    if (code === 0 || code == null) return;
    processError(
      `process exit ${code}`,
      "No additional exit error was provided.",
    );
  });
}

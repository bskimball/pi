// Persist fatal JavaScript errors that Pi normally only prints to the terminal.
// This makes intermittent terminal exits diagnosable after the terminal closes.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const INSTALL_KEY = Symbol.for("pi.crashLogger.installed");
const state = globalThis as typeof globalThis & { [INSTALL_KEY]?: boolean };

function errorText(value: unknown): string {
  if (value instanceof Error)
    return value.stack || `${value.name}: ${value.message}`;
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
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
    fs.appendFileSync(logPath, body, "utf8");
  } catch {
    // A crash logger must never create another fatal error.
  }
}

function processError(kind: string, value: unknown): void {
  append(kind, value);
}

export default function (pi: ExtensionAPI): void {
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
  pi.on("session_shutdown", (event) => {
    processError(
      `session shutdown (${event.reason})`,
      event.targetSessionFile
        ? `Target session: ${event.targetSessionFile}`
        : "No target session.",
    );
  });
  process.on("exit", (code) => {
    // Record code 0 as well. Repeated Surveyor exits have followed Pi's clean
    // shutdown path, which previously left no evidence at all.
    processError(
      `process exit ${code ?? "unknown"}`,
      code === 0
        ? "Process exited cleanly. This can indicate Ctrl+D, /quit, a shutdown request, or external termination after graceful cleanup."
        : "No additional exit error was provided.",
    );
  });
}

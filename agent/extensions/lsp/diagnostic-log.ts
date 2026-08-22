import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MAX_LOG_BYTES = 1_000_000;

export type LspDiagnosticEvent = Record<string, unknown> & {
  event: string;
};

export type LspDiagnosticLogger = (event: LspDiagnosticEvent) => void;

function logPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "logs", "pi-lsp.log");
}

function rotateIfNeeded(path: string): void {
  try {
    if (statSync(path).size < MAX_LOG_BYTES) return;
    renameSync(path, `${path}.1`);
  } catch {
    // Missing and unrotatable logs both fail soft.
  }
}

export const logLspDiagnosticEvent: LspDiagnosticLogger = (event) => {
  try {
    const path = logPath();
    mkdirSync(dirname(path), { recursive: true });
    rotateIfNeeded(path);
    appendFileSync(
      path,
      `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...event })}\n`,
      "utf8",
    );
  } catch {
    // Instrumentation must never break LSP operations.
  }
};

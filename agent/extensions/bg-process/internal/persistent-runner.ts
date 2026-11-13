import { spawn } from "node:child_process";
import { appendFileSync, existsSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { appendStream, type JobStatus } from "./job-state.ts";
import { OUTPUT_LOG, OUTPUT_LOG_CAP, readJob, writeJob } from "./persistent-store.ts";
import { killProcessTreeSync } from "./process-tree-kill.ts";
import { shellInvocation } from "./shell-invocation.ts";

const directory = process.argv[2];
if (!directory) throw new Error("Background job directory is required.");
const job = readJob(directory);
job.runnerPid = process.pid;
writeJob(directory, job);

const shell = shellInvocation(job.command);
const child = spawn(shell.file, shell.args, {
  cwd: job.cwd,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
  detached: shell.detached,
  windowsHide: shell.windowsHide,
  windowsVerbatimArguments: shell.windowsVerbatimArguments,
});
job.pid = child.pid;
writeJob(directory, job);

let outputTimer: ReturnType<typeof setTimeout> | undefined;
const saveOutput = () => {
  if (outputTimer) return;
  outputTimer = setTimeout(() => {
    outputTimer = undefined;
    writeJob(directory, job);
  }, 50);
};

// Raw output log for the extension's live mirror. Sync writes keep stdout and
// stderr in arrival order. Best-effort: state.json still carries the bounded tail.
const outputLog = join(directory, OUTPUT_LOG);
let outputLogBytes = 0;
const appendOutputLog = (chunk: Buffer | string) => {
  const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
  try {
    appendFileSync(outputLog, bytes, { mode: 0o600 });
    outputLogBytes += bytes.length;
    if (outputLogBytes > OUTPUT_LOG_CAP) {
      truncateSync(outputLog, 0);
      outputLogBytes = 0;
      // Readers compare this counter, so a log that regrows past their offset
      // between reads is still detected as a reset.
      job.outputLogResets = (job.outputLogResets ?? 0) + 1;
      writeJob(directory, job);
    }
  } catch {
    // Log writes must never take down the runner.
  }
};

child.stdin.on("error", () => {});
child.stdout.on("error", () => {});
child.stderr.on("error", () => {});
child.stdout.on("data", (chunk: Buffer) => { appendStream(job.stdout, chunk); appendOutputLog(chunk); saveOutput(); });
child.stderr.on("data", (chunk: Buffer) => { appendStream(job.stderr, chunk); appendOutputLog(chunk); saveOutput(); });

const settle = (status: Exclude<JobStatus, "running">, code: number | null, signal: NodeJS.Signals | null) => {
  if (job.status !== "running") return;
  job.status = status;
  job.endedAt = Date.now();
  job.exitCode = code;
  job.signal = signal;
  clearInterval(controlTimer);
  clearTimeout(outputTimer);
  writeJob(directory, job);
};

child.once("error", error => {
  const text = `\nspawn error: ${error.message}\n`;
  appendStream(job.stderr, text);
  appendOutputLog(text);
  settle("failed", -1, null);
});
child.once("close", (code, signal) => {
  settle(job.killRequested ? "killed" : code === 0 ? "completed" : "failed", code, signal);
});

let lastKillAt = 0;
const requestStop = () => {
  if (job.status !== "running" || Date.now() - lastKillAt < 2_000) return;
  job.killRequested = true;
  writeJob(directory, job);
  const ownsTarget = process.platform !== "win32" || (child.exitCode === null && child.signalCode === null);
  if (child.pid && ownsTarget) {
    lastKillAt = Date.now();
    killProcessTreeSync(child.pid, { processGroup: true });
  }
};
// Control polling is runner work, not a UI/render timer. No Pi handles or pipes
// are retained: the runner owns the command until it exits or receives stop.
const controlTimer = setInterval(() => {
  if (existsSync(join(directory, "stop"))) requestStop();
}, 200);
process.once("SIGTERM", requestStop);
process.once("SIGINT", requestStop);
process.once("exit", () => {
  const ownsTarget = process.platform !== "win32" || (child.exitCode === null && child.signalCode === null);
  if (job.status === "running" && child.pid && ownsTarget) {
    killProcessTreeSync(child.pid, { processGroup: true });
  }
});

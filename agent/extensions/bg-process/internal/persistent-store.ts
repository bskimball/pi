import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendStream, STREAM_CAP, type JobState, type StreamBuf } from "./job-state.ts";

const JOB_ID = /^bg_[0-9a-f-]{36}$/;

export function sessionJobDirectory(agentDir: string, sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex");
  return join(agentDir, "bg-process", key);
}

export function writeJob(directory: string, job: JobState): void {
  const temporary = join(directory, `state-${process.pid}.tmp`);
  writeFileSync(temporary, JSON.stringify(job), { mode: 0o600 });
  renameSync(temporary, join(directory, "state.json"));
}

function validStream(value: StreamBuf | undefined): boolean {
  return !!value && typeof value.text === "string" && value.text.length <= STREAM_CAP
    && typeof value.bytes === "number" && Number.isFinite(value.bytes)
    && typeof value.truncated === "boolean";
}

export function readJob(directory: string): JobState {
  const job = JSON.parse(readFileSync(join(directory, "state.json"), "utf8")) as JobState;
  if (!job || !JOB_ID.test(job.id) || job.id !== basename(directory)
    || job.persistent !== true || typeof job.command !== "string" || typeof job.cwd !== "string"
    || typeof job.title !== "string" || !Number.isFinite(job.startedAt)
    || !["running", "completed", "failed", "killed"].includes(job.status)
    || !validStream(job.stdout) || !validStream(job.stderr)) {
    throw new Error(`Invalid persistent background job record: ${directory}`);
  }
  return job;
}

function runnerUnavailable(job: JobState, directory: string): boolean {
  let pid = job.runnerPid;
  if (!pid && existsSync(join(directory, "runner.pid"))) {
    pid = Number(readFileSync(join(directory, "runner.pid"), "utf8"));
  }
  if (!pid) return Date.now() - job.startedAt > 10_000;
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export function inspectJob(directory: string): JobState {
  const job = readJob(directory);
  if (job.status === "running" && runnerUnavailable(job, directory)) {
    job.status = "failed";
    job.runnerUnavailable = true;
    appendStream(job.stderr, "\nBackground runner unavailable; command exit and descendant state are unknown. Inspect the process before manual cleanup.\n");
  }
  return job;
}

export function readSessionJobs(root: string): Array<{ directory: string; job: JobState }> {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && JOB_ID.test(entry.name) && existsSync(join(root, entry.name, "state.json")))
    .map(entry => {
      const directory = join(root, entry.name);
      return { directory, job: inspectJob(directory) };
    })
    .sort((a, b) => a.job.startedAt - b.job.startedAt);
}

export function removeJob(directory: string): void {
  const job = inspectJob(directory);
  if (job.status === "running" || job.runnerUnavailable) return;
  rmSync(directory, { recursive: true });
}

async function waitForJob(directory: string, ready: (job: JobState) => boolean, timeout: number): Promise<JobState> {
  const deadline = Date.now() + timeout;
  while (true) {
    const job = inspectJob(directory);
    if (ready(job) || Date.now() >= deadline) return job;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

export async function startPersistentJob(directory: string, job: JobState): Promise<JobState> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeJob(directory, job);
  let runner: ChildProcess;
  try {
    runner = await new Promise<ChildProcess>((resolve, reject) => {
      const child = spawn(process.execPath, [
        "--experimental-transform-types",
        "--disable-warning=ExperimentalWarning",
        fileURLToPath(new URL("./persistent-runner.ts", import.meta.url)),
        directory,
      ], { cwd: job.cwd, env: process.env, detached: true, windowsHide: true, stdio: "ignore" });
      child.once("spawn", () => resolve(child));
      child.once("error", reject);
      child.unref();
    });
  } catch (error) {
    job.status = "failed";
    job.endedAt = Date.now();
    job.exitCode = -1;
    appendStream(job.stderr, `\nRunner launch failed: ${error instanceof Error ? error.message : String(error)}\n`);
    writeJob(directory, job);
    return job;
  }
  if (runner.pid) writeFileSync(join(directory, "runner.pid"), String(runner.pid), { mode: 0o600 });
  return waitForJob(directory, state => !!state.pid || state.status !== "running", 5_000);
}

export async function stopPersistentJob(directory: string): Promise<JobState> {
  const job = inspectJob(directory);
  if (job.status !== "running") return job;
  writeFileSync(join(directory, "stop"), "stop\n", { mode: 0o600 });
  return waitForJob(directory, state => state.status !== "running", 7_000);
}

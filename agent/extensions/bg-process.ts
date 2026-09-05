// bg-process: start/inspect/stop long-running shell jobs without blocking the agent.
//
// Tools: bg_start, bg_status, bg_list, bg_kill.
//
// Results stay bounded plain text and use Pi's stock tool rendering.

import {
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
} from "node:child_process";
import type { Readable } from "node:stream";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { killProcessTree, killProcessTreeSync } from "./bg-process/internal/process-tree-kill.ts";
import { JobRegistry } from "./bg-process/internal/job-registry.ts";
import { textResult, resolveCwd, validateCwd } from "./bg-process/internal/tool-result.ts";

// ---------------------------------------------------------------- constants

const MAX_RUNNING = 8;
const MAX_SETTLED = 24;
const STREAM_CAP = 48_000;
const STATUS_STREAM_CAP = 12_000;
const STATUS_LINE_CAP = 80;
const LIST_CMD_CAP = 120;
/** Follow-up commands carried by every settlement notice, model-side and UI. */
const BG_SETTLED_HINT =
  "Use bg_status for bounded logs, or bg_list to see jobs.";
const TITLE_CAP = 80;

type JobStatus = "running" | "completed" | "failed" | "killed";

interface StreamBuf {
  text: string;
  truncated: boolean;
  bytes: number;
}

interface BgJob {
  id: string;
  title: string;
  command: string;
  cwd: string;
  pid: number | undefined;
  status: JobStatus;
  startedAt: number;
  endedAt?: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: StreamBuf;
  stderr: StreamBuf;
  killRequested: boolean;
  notified: boolean;
  child?: ChildProcess;
}

// ---------------------------------------------------------------- helpers

function emptyStream(): StreamBuf {
  return { text: "", truncated: false, bytes: 0 };
}

function appendStream(buf: StreamBuf, chunk: Buffer | string): void {
  const piece = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  if (!piece) return;
  buf.bytes += Buffer.byteLength(piece, "utf8");
  const next = buf.text + piece;
  if (next.length <= STREAM_CAP) {
    buf.text = next;
    return;
  }
  buf.truncated = true;
  buf.text = next.slice(next.length - STREAM_CAP);
}

function cleanOneLine(value: unknown, max: number): string {
  const text = String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function formatAge(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m${String(rem).padStart(2, "0")}s`;
}


function shellInvocation(command: string): {
  file: string;
  args: string[];
  detached: boolean;
  windowsHide?: boolean;
} {
  if (process.platform === "win32") {
    const comspec =
      process.env.ComSpec?.trim() ||
      path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "cmd.exe",
      );
    return {
      file: comspec,
      args: ["/d", "/s", "/c", command],
      detached: false,
      windowsHide: true,
    };
  }
  const sh = process.env.SHELL?.trim() || "/bin/sh";
  return {
    file: sh,
    args: ["-c", command],
    detached: true,
  };
}


function tailForStatus(buf: StreamBuf, maxChars = STATUS_STREAM_CAP): {
  text: string;
  truncated: boolean;
  bytes: number;
} {
  let text = buf.text;
  let truncated = buf.truncated;
  if (text.length > maxChars) {
    text = text.slice(text.length - maxChars);
    truncated = true;
  }
  const lines = text.split(/\r?\n/);
  if (lines.length > STATUS_LINE_CAP) {
    text = lines.slice(lines.length - STATUS_LINE_CAP).join("\n");
    truncated = true;
  }
  return { text, truncated, bytes: buf.bytes };
}


type BgJobView = Omit<BgJob, "child" | "stdout" | "stderr" | "notified"> & {
  stdoutTail?: string;
  stderrTail?: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
};

/** Structured bounded job details for programmatic consumers. */
function jobView(job: BgJob, withOutput: boolean): BgJobView {
  const stdout = withOutput ? tailForStatus(job.stdout) : undefined;
  const stderr = withOutput ? tailForStatus(job.stderr) : undefined;
  return {
    id: job.id,
    title: job.title,
    command: cleanOneLine(job.command, LIST_CMD_CAP),
    cwd: job.cwd,
    pid: job.pid,
    status: job.status,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    exitCode: job.exitCode,
    signal: job.signal,
    killRequested: job.killRequested,
    stdoutTail: stdout?.text,
    stderrTail: stderr?.text,
    stdoutBytes: stdout?.bytes ?? job.stdout.bytes,
    stderrBytes: stderr?.bytes ?? job.stderr.bytes,
    stdoutTruncated: stdout?.truncated,
    stderrTruncated: stderr?.truncated,
  };
}

// ---------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
  const jobs = new JobRegistry<BgJob>();
  let nextId = 1;
  let agentBusy = false;
  let shuttingDown = false;

  const runningCount = () =>
    [...jobs.values()].filter((job) => job.status === "running").length;

  const pruneSettled = () => {
    jobs.pruneSettled((job) => job.status !== "running", MAX_SETTLED);
  };

  const summarizeJob = (job: BgJob, now = Date.now()): string => {
    const age = formatAge((job.endedAt ?? now) - job.startedAt);
    const pid = job.pid ?? "-";
    const exit =
      job.status === "running"
        ? "exit=-"
        : `exit=${job.exitCode ?? "null"}${job.signal ? ` signal=${job.signal}` : ""}`;
    return `${job.id}  ${job.status.padEnd(9)} pid=${pid}  ${exit}  age=${age}  ${cleanOneLine(job.title, TITLE_CAP)}  cwd=${job.cwd}`;
  };

  const formatStatus = (job: BgJob): string => {
    const now = Date.now();
    const stdout = tailForStatus(job.stdout);
    const stderr = tailForStatus(job.stderr);
    const lines = [
      summarizeJob(job, now),
      `command: ${cleanOneLine(job.command, LIST_CMD_CAP)}`,
      `started: ${new Date(job.startedAt).toISOString()}`,
    ];
    if (job.endedAt) lines.push(`ended:   ${new Date(job.endedAt).toISOString()}`);
    if (job.killRequested) lines.push("kill_requested: true");
    lines.push(
      "",
      `--- stdout (${stdout.bytes} bytes total${stdout.truncated ? ", truncated tail" : ""}) ---`,
      stdout.text || "(empty)",
      "",
      `--- stderr (${stderr.bytes} bytes total${stderr.truncated ? ", truncated tail" : ""}) ---`,
      stderr.text || "(empty)",
    );
    return lines.join("\n");
  };

  const jobNotifyLine = (job: BgJob): string => {
    return [
      `${job.id}: ${job.status}`,
      `title=${job.title}`,
      `cmd=${cleanOneLine(job.command, LIST_CMD_CAP)}`,
      `exit=${job.exitCode ?? "null"}${job.signal ? ` signal=${job.signal}` : ""}`,
    ].join("  ");
  };

  const drainSettledNotifications = () => {
    if (shuttingDown || agentBusy) return;
    const pending = jobs
      .entries()
      .map(({ item: job }) => job)
      .filter((job) => job.status !== "running" && !job.notified);
    if (!pending.length) return;

    for (const job of pending) job.notified = true;

    const lines = [
      pending.length === 1
        ? "Background process settled:"
        : `${pending.length} background processes settled:`,
      ...pending.map(jobNotifyLine),
      BG_SETTLED_HINT,
    ];
    try {
      pi.sendMessage(
        {
          customType: "bg-process-settled",
          content: lines.join("\n"),
          display: true,
          details: {
            jobs: pending.map((job) => ({
              id: job.id,
              status: job.status,
              exitCode: job.exitCode,
              signal: job.signal,
              title: job.title,
              command: cleanOneLine(job.command, LIST_CMD_CAP),
            })),
          },
        },
        { triggerTurn: true },
      );
    } catch {
      // Notification must never throw into process handlers.
      for (const job of pending) job.notified = false;
    }
  };

  const maybeNotifySettled = (job: BgJob) => {
    if (job.notified || shuttingDown || job.status === "running") return;
    if (agentBusy) return;
    drainSettledNotifications();
  };

  const settleJob = (
    job: BgJob,
    status: Exclude<JobStatus, "running">,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ) => {
    if (job.status !== "running") return;
    job.status = status;
    job.endedAt = Date.now();
    job.exitCode = exitCode;
    job.signal = signal;
    job.child = undefined;
    pruneSettled();
    maybeNotifySettled(job);
  };

  const attachChild = (
    job: BgJob,
    child: ChildProcessByStdio<null, Readable, Readable>,
  ) => {
    job.child = child;
    job.pid = child.pid;

    child.stdout.on("data", (chunk: Buffer) => appendStream(job.stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => appendStream(job.stderr, chunk));
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});

    child.on("error", (error) => {
      appendStream(job.stderr, `\nspawn error: ${error.message}\n`);
      settleJob(job, job.killRequested ? "killed" : "failed", -1, null);
    });

    child.on("close", (code, signal) => {
      if (job.status !== "running") return;
      if (job.killRequested) {
        settleJob(job, "killed", code, signal);
        return;
      }
      if (code === 0) settleJob(job, "completed", code, signal);
      else settleJob(job, "failed", code, signal);
    });
  };

  const killJob = (
    job: BgJob,
    reason: string,
    mode: "async" | "sync" = "async",
  ): string => {
    if (job.status !== "running") {
      return `${job.id} is already ${job.status} (exit=${job.exitCode ?? "null"}).`;
    }
    job.killRequested = true;
    const pid = job.pid ?? job.child?.pid;
    if (pid == null) {
      settleJob(job, "killed", null, null);
      return `${job.id} had no pid; marked killed (${reason}).`;
    }
    try {
      if (mode === "sync") killProcessTreeSync(pid, { processGroup: true });
      else killProcessTree(pid, { processGroup: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendStream(job.stderr, `\nkill error: ${message}\n`);
    }

    if (mode === "sync") {
      // Teardown path: do not wait for close; mark settled so state can clear.
      settleJob(job, "killed", job.exitCode, job.signal);
      return `${job.id} kill-sync (${reason}); process tree target pid=${pid}.`;
    }

    // Interactive path: re-kill once, then force settle so status cannot stick
    // on "running" forever if the tree refuses to exit cleanly.
    setTimeout(() => {
      if (job.status !== "running") return;
      try {
        process.kill(pid, 0);
        killProcessTree(pid, { processGroup: true });
      } catch {
        settleJob(job, "killed", job.exitCode, job.signal);
        return;
      }
      setTimeout(() => {
        if (job.status !== "running") return;
        appendStream(
          job.stderr,
          "\nkill timeout: forced settled; process may still be orphaned\n",
        );
        settleJob(job, "killed", job.exitCode, job.signal);
      }, 3000).unref?.();
    }, 2000).unref?.();
    return `${job.id} kill requested (${reason}); process tree target pid=${pid}.`;
  };

  // ------------------------------------------------------------ tools

  pi.registerTool({
    name: "bg_start",
    label: "Bg Start",
    description:
      "Start a long-running shell command in the background (dev servers, watchers). Returns immediately with a job id. Use bg_status/bg_list/bg_kill to inspect or stop. Prefer bash for short commands.",
    promptSnippet:
      "Start long-running background shell jobs (dev servers/watchers) without blocking.",
    promptGuidelines: [
      "Use bg_start for servers/watchers that must keep running; use bash for short commands.",
      "Do not pass interactive prompts; there is no stdin.",
      "Inspect with bg_status/bg_list and stop with bg_kill when finished.",
    ],
    parameters: Type.Object({
      command: Type.String({
        description:
          "Shell command to run (e.g. npm run dev). Executed via the platform shell.",
      }),
      title: Type.Optional(
        Type.String({
          description: "Short label for listings (defaults to the command).",
        }),
      ),
      working_dir: Type.Optional(
        Type.String({
          description:
            "Working directory (defaults to the session cwd). Must exist.",
        }),
      ),
    }),
    executionMode: "parallel",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const command = params.command?.trim();
      if (!command) {
        return textResult("command is required.", true, {
          bg: { message: "command is required." },
        });
      }

      // Reserve the slot before any yield so parallel bg_start calls cannot
      // exceed MAX_RUNNING even if this path later gains an await.
      if (runningCount() >= MAX_RUNNING) {
        const message = `Too many running background jobs (max ${MAX_RUNNING}). Stop one with bg_kill first.`;
        return textResult(message, true, { bg: { message } });
      }

      const cwd = resolveCwd(params.working_dir, ctx.cwd);
      const cwdError = validateCwd(cwd);
      if (cwdError) return textResult(cwdError, true, { bg: { message: cwdError } });

      const id = `bg_${nextId++}`;
      const title = cleanOneLine(params.title?.trim() || command, TITLE_CAP);
      const job: BgJob = {
        id,
        title,
        command,
        cwd,
        pid: undefined,
        status: "running",
        startedAt: Date.now(),
        exitCode: null,
        signal: null,
        stdout: emptyStream(),
        stderr: emptyStream(),
        killRequested: false,
        notified: false,
      };

      jobs.set(id, job);

      const shell = shellInvocation(command);
      let child: ChildProcessByStdio<null, Readable, Readable>;
      try {
        child = spawn(shell.file, shell.args, {
          cwd,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: shell.detached,
          windowsHide: shell.windowsHide,
        });
      } catch (error) {
        jobs.delete(id);
        const message = error instanceof Error ? error.message : String(error);
        return textResult(`Failed to spawn ${id}: ${message}`, true, {
          bg: { message: `Failed to spawn ${id}: ${message}` },
        });
      }

      attachChild(job, child);

      // Detached POSIX children should not keep the parent event loop only via
      // the process group; unref is intentionally skipped so close still fires.

      const text = [
        `started ${id}`,
        `pid: ${job.pid ?? "pending"}`,
        `title: ${job.title}`,
        `cwd: ${job.cwd}`,
        `command: ${cleanOneLine(job.command, LIST_CMD_CAP)}`,
        `status: running`,
        `Use bg_status id="${id}" for logs; bg_kill id="${id}" to stop.`,
      ].join("\n");
      return textResult(text, false, { bg: { job: jobView(job, false) } });
    },
  });

  pi.registerTool({
    name: "bg_status",
    label: "Bg Status",
    description:
      "Show status and bounded stdout/stderr tails for a background job started with bg_start.",
    promptSnippet: "Inspect a background job's status and recent logs.",
    parameters: Type.Object({
      id: Type.String({ description: "Job id from bg_start (e.g. bg_1)." }),
    }),
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const id = params.id?.trim();
      if (!id) {
        return textResult("id is required.", true, {
          bg: { message: "id is required." },
        });
      }
      const job = jobs.get(id);
      if (!job) {
        const message = `Unknown job "${id}". Use bg_list to see current jobs.`;
        return textResult(message, true, { bg: { message } });
      }
      return textResult(formatStatus(job), false, {
        bg: { job: jobView(job, true) },
      });
    },
  });

  pi.registerTool({
    name: "bg_list",
    label: "Bg List",
    description:
      "List background jobs started with bg_start (running and recent settled).",
    promptSnippet: "List running and recent settled background jobs.",
    parameters: Type.Object({
      include_settled: Type.Optional(
        Type.Boolean({
          description:
            "Include completed/failed/killed jobs (default true). Set false for running only.",
        }),
      ),
    }),
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const includeSettled = params.include_settled !== false;
      const now = Date.now();
      const rows = jobs
        .entries()
        .map(({ item: job }) => job)
        .filter((job) => includeSettled || job.status === "running");
      const running = rows.filter((job) => job.status === "running").length;
      const bg = {
        jobs: rows.map((job) => jobView(job, false)),
        running,
        total: rows.length,
        includeSettled,
      };

      if (!rows.length) {
        return textResult(
          includeSettled
            ? "No background jobs."
            : "No running background jobs.",
          false,
          { bg },
        );
      }

      const lines = [
        `background jobs (${running} running / ${rows.length} shown):`,
        ...rows.map((job) => {
          const cmd = cleanOneLine(job.command, LIST_CMD_CAP);
          return `${summarizeJob(job, now)}\n  cmd: ${cmd}`;
        }),
      ];
      return textResult(lines.join("\n"), false, { bg });
    },
  });

  pi.registerTool({
    name: "bg_kill",
    label: "Bg Kill",
    description:
      "Stop a background job and its process tree. On Windows uses taskkill /F /T; on POSIX signals the process group.",
    promptSnippet: "Stop a background job and its full process tree.",
    parameters: Type.Object({
      id: Type.String({ description: "Job id from bg_start (e.g. bg_1)." }),
    }),
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const id = params.id?.trim();
      if (!id) {
        return textResult("id is required.", true, {
          bg: { message: "id is required." },
        });
      }
      const job = jobs.get(id);
      if (!job) {
        const message = `Unknown job "${id}". Use bg_list to see current jobs.`;
        return textResult(message, true, { bg: { message } });
      }
      const message = killJob(job, "bg_kill");
      // Give the tree a brief moment so status often reflects the kill.
      await new Promise((resolve) => setTimeout(resolve, 150));
      return textResult(`${message}\n\n${formatStatus(job)}`, false, {
        bg: { job: jobView(job, true), message },
      });
    },
  });

  // ------------------------------------------------------------ lifecycle

  // Busy gate is start → settled only. Do not clear on agent_end: Pi may still
  // compact/retry/continue before agent_settled, and triggerTurn is unsafe then.
  pi.on("agent_start", () => {
    agentBusy = true;
  });
  pi.on("agent_settled", () => {
    agentBusy = false;
    drainSettledNotifications();
  });

  pi.on("session_shutdown", () => {
    shuttingDown = true;
    try {
      for (const { item: job } of jobs.entries()) {
        if (job.status !== "running") continue;
        try {
          killJob(job, "session_shutdown", "sync");
        } catch {
          // best effort
        }
      }
    } finally {
      jobs.clear();
    }
  });
}

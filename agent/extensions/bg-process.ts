// bg-process: start/inspect/stop long-running shell jobs without blocking the agent.
//
// Tools: bg_start, bg_status, bg_list, bg_kill.
// Plain bounded tool results only — no custom renderers or render timers.

import {
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessByStdio,
} from "node:child_process";
import type { Readable } from "node:stream";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------- constants

const MAX_RUNNING = 8;
const MAX_SETTLED = 24;
const STREAM_CAP = 48_000;
const STATUS_STREAM_CAP = 12_000;
const STATUS_LINE_CAP = 80;
const LIST_CMD_CAP = 120;
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

function resolveCwd(raw: string | undefined, fallback: string): string {
  const candidate = raw?.trim() ? raw.trim() : fallback;
  return path.resolve(candidate);
}

function validateCwd(cwd: string): string | undefined {
  try {
    if (!fs.existsSync(cwd)) {
      return `working_dir "${cwd}" does not exist. On Windows use a native path (e.g. C:/Users/...), not a bash-style path.`;
    }
    if (!fs.statSync(cwd).isDirectory()) {
      return `working_dir "${cwd}" is not a directory.`;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `working_dir "${cwd}" is not usable: ${message}`;
  }
  return undefined;
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

function taskkillPath(): string {
  return path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "taskkill.exe",
  );
}

function killDirect(pid: number, signal?: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

/** Interactive kill: async tree kill, good enough for bg_kill. */
function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      const taskkill = spawn(
        taskkillPath(),
        ["/F", "/T", "/PID", String(pid)],
        { stdio: "ignore", windowsHide: true },
      );
      const fallback = () => killDirect(pid);
      taskkill.once("error", fallback);
      taskkill.once("close", (code) => {
        if (code !== 0) fallback();
      });
    } catch {
      killDirect(pid);
    }
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    killDirect(pid, "SIGTERM");
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      killDirect(pid, "SIGKILL");
    }
  }, 1500).unref?.();
}

/**
 * Session teardown kill: best-effort synchronous reaping so taskkill/SIGKILL
 * are not left on unref timers that may never run during process exit.
 */
function killProcessTreeSync(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawnSync(
        taskkillPath(),
        ["/F", "/T", "/PID", String(pid)],
        { stdio: "ignore", windowsHide: true, timeout: 5000 },
      );
    } catch {
      // fall through
    }
    killDirect(pid);
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    killDirect(pid, "SIGKILL");
  }
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

function textResult(text: string, isError = false, details: unknown = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
    isError,
  };
}

// ---------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
  const jobs = new Map<string, BgJob>();
  const order: string[] = [];
  let nextId = 1;
  let agentBusy = false;
  let shuttingDown = false;

  const runningCount = () =>
    [...jobs.values()].filter((job) => job.status === "running").length;

  const pruneSettled = () => {
    const settled = order
      .map((id) => jobs.get(id))
      .filter((job): job is BgJob => !!job && job.status !== "running");
    if (settled.length <= MAX_SETTLED) return;
    const excess = settled.length - MAX_SETTLED;
    for (let i = 0; i < excess; i++) {
      const job = settled[i];
      jobs.delete(job.id);
      const idx = order.indexOf(job.id);
      if (idx >= 0) order.splice(idx, 1);
    }
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
    const pending = order
      .map((id) => jobs.get(id))
      .filter(
        (job): job is BgJob =>
          !!job && job.status !== "running" && !job.notified,
      );
    if (!pending.length) return;

    for (const job of pending) job.notified = true;

    const lines = [
      pending.length === 1
        ? "Background process settled:"
        : `${pending.length} background processes settled:`,
      ...pending.map(jobNotifyLine),
      "Use bg_status for bounded logs, or bg_list to see jobs.",
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
      if (mode === "sync") killProcessTreeSync(pid);
      else killProcessTree(pid);
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
        killProcessTree(pid);
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
      if (!command) return textResult("command is required.", true);

      // Reserve the slot before any yield so parallel bg_start calls cannot
      // exceed MAX_RUNNING even if this path later gains an await.
      if (runningCount() >= MAX_RUNNING) {
        return textResult(
          `Too many running background jobs (max ${MAX_RUNNING}). Stop one with bg_kill first.`,
          true,
        );
      }

      const cwd = resolveCwd(params.working_dir, ctx.cwd);
      const cwdError = validateCwd(cwd);
      if (cwdError) return textResult(cwdError, true);

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
      order.push(id);

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
        const idx = order.indexOf(id);
        if (idx >= 0) order.splice(idx, 1);
        const message = error instanceof Error ? error.message : String(error);
        return textResult(`Failed to spawn ${id}: ${message}`, true);
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
      return textResult(text);
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
      if (!id) return textResult("id is required.", true);
      const job = jobs.get(id);
      if (!job) {
        return textResult(
          `Unknown job "${id}". Use bg_list to see current jobs.`,
          true,
        );
      }
      return textResult(formatStatus(job));
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
      const rows = order
        .map((id) => jobs.get(id))
        .filter((job): job is BgJob => !!job)
        .filter((job) => includeSettled || job.status === "running");

      if (!rows.length) {
        return textResult(
          includeSettled
            ? "No background jobs."
            : "No running background jobs.",
        );
      }

      const lines = [
        `background jobs (${rows.filter((j) => j.status === "running").length} running / ${rows.length} shown):`,
        ...rows.map((job) => {
          const cmd = cleanOneLine(job.command, LIST_CMD_CAP);
          return `${summarizeJob(job, now)}\n  cmd: ${cmd}`;
        }),
      ];
      return textResult(lines.join("\n"));
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
      if (!id) return textResult("id is required.", true);
      const job = jobs.get(id);
      if (!job) {
        return textResult(
          `Unknown job "${id}". Use bg_list to see current jobs.`,
          true,
        );
      }
      const message = killJob(job, "bg_kill");
      // Give the tree a brief moment so status often reflects the kill.
      await new Promise((resolve) => setTimeout(resolve, 150));
      return textResult(`${message}\n\n${formatStatus(job)}`);
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
      for (const id of [...order]) {
        const job = jobs.get(id);
        if (!job || job.status !== "running") continue;
        try {
          killJob(job, "session_shutdown", "sync");
        } catch {
          // best effort
        }
      }
    } finally {
      jobs.clear();
      order.length = 0;
    }
  });
}

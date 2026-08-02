// bg-view: Mono receipts for the bg_* background-job tools.
//
// Presentation only. Everything is built from the structured `details.bg`
// payload that bg-process.ts attaches to each tool result, so no renderer ever
// re-parses the human-readable text body. All inputs are treated as untrusted:
// every field is coerced defensively and every list/line is bounded.

import { safeTruncateToWidth } from "./safe-text-layout.ts";
import { TREE, cleanInline, formatTokens } from "./ui-common.ts";
import { buildTreeLines, type TreeRow } from "./task-card.ts";
import {
  bgStatusKind,
  detailRow,
  emptyStateLines,
  finiteNumber,
  isTerminalKind,
  metaText,
  noteRow,
  previewLines,
  receiptHeader,
  safeLine,
  spanText,
  statusLabel,
  tailLines,
  type StatusKind,
  type StatusTheme,
} from "./status-view.ts";

/* ------------------------------------------------------------------ */
/* Payload shapes + coercion                                           */
/* ------------------------------------------------------------------ */

export interface BgJobView {
  id: string;
  title: string;
  command: string;
  cwd: string;
  pid?: number;
  status: string;
  startedAt?: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  killRequested?: boolean;
  stdoutTail?: string;
  stderrTail?: string;
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export interface BgPayload {
  job?: BgJobView;
  jobs?: BgJobView[];
  running?: number;
  total?: number;
  includeSettled?: boolean;
  message?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function coerceJob(value: unknown): BgJobView | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const id = safeLine(raw.id, 40);
  if (!id) return undefined;
  const exitCode = finiteNumber(raw.exitCode);
  return {
    id,
    title: safeLine(raw.title, 200),
    command: safeLine(raw.command, 400),
    cwd: safeLine(raw.cwd, 300),
    pid: finiteNumber(raw.pid),
    status: safeLine(raw.status, 20),
    startedAt: finiteNumber(raw.startedAt),
    endedAt: finiteNumber(raw.endedAt),
    exitCode: exitCode === undefined ? null : exitCode,
    signal: safeLine(raw.signal, 20) || null,
    killRequested: raw.killRequested === true,
    stdoutTail: typeof raw.stdoutTail === "string" ? raw.stdoutTail : "",
    stderrTail: typeof raw.stderrTail === "string" ? raw.stderrTail : "",
    stdoutBytes: finiteNumber(raw.stdoutBytes),
    stderrBytes: finiteNumber(raw.stderrBytes),
    stdoutTruncated: raw.stdoutTruncated === true,
    stderrTruncated: raw.stderrTruncated === true,
  };
}

/** Read the `details.bg` payload from a tool result; never throws. */
export function bgPayload(result: unknown): BgPayload | undefined {
  const details = record(record(result)?.details);
  const bg = record(details?.bg);
  if (!bg) return undefined;
  const jobs = Array.isArray(bg.jobs)
    ? bg.jobs
        .slice(0, 64)
        .map(coerceJob)
        .filter((job): job is BgJobView => !!job)
    : undefined;
  return {
    job: coerceJob(bg.job),
    jobs,
    running: finiteNumber(bg.running),
    total: finiteNumber(bg.total),
    includeSettled: bg.includeSettled !== false,
    message: safeLine(bg.message, 300),
  };
}

/* ------------------------------------------------------------------ */
/* Job-derived presentation                                            */
/* ------------------------------------------------------------------ */

export function jobKind(job: BgJobView): StatusKind {
  const kind = bgStatusKind(job.status);
  // A running job with a pending kill request reads as "waiting" (for the tree
  // to die) rather than as ordinary work in progress.
  if (kind === "running" && job.killRequested) return "waiting";
  return kind;
}

/** `pid 4821 · exit 1 · SIGTERM` — only the parts actually known. */
function jobMeta(job: BgJobView, kind: StatusKind): string {
  return metaText([
    job.pid !== undefined && `pid ${job.pid}`,
    isTerminalKind(kind) &&
      (job.exitCode === null || job.exitCode === undefined
        ? kind === "killed"
          ? "no exit code"
          : undefined
        : `exit ${job.exitCode}`),
    job.signal ? `signal ${job.signal}` : undefined,
  ]);
}

/** Prefer the caller's title; fall back to the command, then the id. */
function jobSubject(job: BgJobView): string {
  return job.title || job.command || job.id;
}

function streamNote(
  label: string,
  bytes: number | undefined,
  truncated: boolean | undefined,
  empty: boolean,
): string {
  if (empty && !bytes) return `${label}: empty`;
  const size = bytes === undefined ? "" : ` ${formatTokens(bytes)} bytes`;
  return `${label}:${size}${truncated ? " (tail)" : ""}`;
}

/* ------------------------------------------------------------------ */
/* Cards                                                               */
/* ------------------------------------------------------------------ */

export interface BgCardOptions {
  tool: string;
  expanded: boolean;
  /** Extra hint row rendered last (e.g. next-step guidance). */
  hint?: string;
  /** Overrides the derived state label (e.g. `kill requested`). */
  label?: string;
}

/**
 * The single-job card used by bg_start, bg_status and bg_kill.
 *
 * Collapsed shows a bounded output tail; expanded widens the tail and adds
 * command/cwd rows. Both are flat: header + one level of tree children.
 */
export function bgJobCard(
  theme: StatusTheme,
  width: number,
  job: BgJobView,
  options: BgCardOptions,
): string[] {
  const now = Date.now();
  const kind = jobKind(job);
  const header = receiptHeader(theme, width, {
    tool: options.tool,
    id: job.id,
    subject: jobSubject(job),
    meta: jobMeta(job, kind),
    kind,
    label: options.label,
    duration: spanText(job.startedAt, job.endedAt, now),
  });

  const rows: TreeRow[] = [];
  const outLimit = options.expanded ? 24 : 3;
  const errLimit = options.expanded ? 12 : 2;
  const stdout = tailLines(job.stdoutTail, outLimit);
  const stderr = tailLines(job.stderrTail, errLimit);

  if (options.expanded) {
    if (job.command && job.command !== jobSubject(job)) {
      rows.push(noteRow(theme, width, `command: ${job.command}`));
    }
    if (job.cwd) rows.push(noteRow(theme, width, `cwd: ${job.cwd}`));
  }

  if (stdout.length || job.stdoutBytes) {
    rows.push({
      line: (rail) =>
        safeTruncateToWidth(
          `${theme.fg("dim", rail)} ${theme.fg(
            "muted",
            streamNote("stdout", job.stdoutBytes, job.stdoutTruncated, !stdout.length),
          )}`,
          width,
        ),
      continuation: stdout,
      continuationToken: "toolOutput",
    });
  }
  if (stderr.length || job.stderrBytes) {
    rows.push({
      line: (rail) =>
        safeTruncateToWidth(
          `${theme.fg("dim", rail)} ${theme.fg(
            stderr.length ? "warning" : "muted",
            streamNote("stderr", job.stderrBytes, job.stderrTruncated, !stderr.length),
          )}`,
          width,
        ),
      continuation: stderr,
      continuationToken: "error",
    });
  }
  if (!rows.length && !isTerminalKind(kind)) {
    rows.push(noteRow(theme, width, "no output yet"));
  }
  if (options.hint) {
    rows.push(noteRow(theme, width, options.hint, "muted"));
  }

  return buildTreeLines(theme, width, header, rows);
}

/** The scannable bg_list table. */
export function bgListCard(
  theme: StatusTheme,
  width: number,
  payload: BgPayload,
  expanded: boolean,
): string[] {
  const jobs = payload.jobs ?? [];
  if (!jobs.length) {
    return emptyStateLines(
      theme,
      width,
      "bg_list",
      payload.includeSettled ? "no background jobs" : "nothing running",
      "bg_start runs a command in the background and returns a job id.",
    );
  }

  const now = Date.now();
  const running = payload.running ?? jobs.filter((job) => jobKind(job) === "running").length;
  const total = payload.total ?? jobs.length;
  const header = receiptHeader(theme, width, {
    tool: "bg_list",
    subject: `${running} running`,
    meta: metaText([
      total !== running ? `${total} shown` : undefined,
      payload.includeSettled ? undefined : "running only",
    ]),
  });

  const limit = expanded ? 32 : 10;
  const shown = jobs.slice(-limit);
  const hidden = jobs.length - shown.length;
  const rows: TreeRow[] = [];
  if (hidden > 0) {
    rows.push(noteRow(theme, width, `${hidden} older jobs hidden`, "muted"));
  }
  for (const job of shown) {
    const kind = jobKind(job);
    rows.push(
      detailRow(theme, width, {
        kind,
        id: job.id,
        text: jobSubject(job),
        detail: metaText([
          isTerminalKind(kind) && kind !== "succeeded"
            ? statusLabel(kind)
            : undefined,
          job.exitCode !== null && job.exitCode !== undefined && kind !== "running"
            ? `exit ${job.exitCode}`
            : undefined,
          expanded && job.pid !== undefined ? `pid ${job.pid}` : undefined,
        ]),
        duration: spanText(job.startedAt, job.endedAt, now),
      }),
    );
  }
  return buildTreeLines(theme, width, header, rows);
}

/** Compact fallback used when a result carries no structured payload. */
export function bgFallbackLines(
  theme: StatusTheme,
  width: number,
  tool: string,
  text: unknown,
  isError: boolean,
): string[] {
  const lines = tailLines(text, 4, 300);
  const header = receiptHeader(theme, width, {
    tool,
    kind: isError ? "failed" : "unknown",
    rootGlyph: TREE.receipt,
  });
  if (!lines.length) return [header];
  return [
    header,
    ...previewLines(theme, width, lines, isError ? "error" : "toolOutput"),
  ];
}

/** One-line call row shown while a bg tool is in flight. */
export function bgCallLine(
  theme: StatusTheme,
  width: number,
  tool: string,
  args: unknown,
  started: boolean,
): string {
  const raw = record(args);
  const id = safeLine(raw?.id, 40);
  const command = cleanInline(raw?.title || raw?.command, 200);
  return receiptHeader(theme, width, {
    tool,
    id: id || undefined,
    subject: command || undefined,
    kind: started ? "running" : "queued",
    label: started ? "working" : "queued",
    rootGlyph: TREE.receipt,
  });
}

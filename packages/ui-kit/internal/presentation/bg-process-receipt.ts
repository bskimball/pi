// bg-process-receipt: Apex chrome for the headless bg-process extension —
// both the `bg-process-settled` notice and the four bg_* tool receipts.
//
// bg-process owns execute and the model-facing payloads; Apex cannot import
// that extension, so the notice arrives through a message renderer and the
// tool receipts through the shared headless ToolExecutionComponent wrap.
// All payload reads are structural.
//
// PI_APEX_UI=0 skips both. The model still receives the prose body.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { apexPresentationEnabled } from "./presentation.ts";
import { boundedOutput, toolRenderers } from "./tool-receipt.ts";
import { cleanInline } from "./ui-common.ts";
import {
  installHeadlessReceipts,
  registerHeadlessReceipt,
} from "./headless-receipts.ts";
import {
  noticeComponent,
  type NoticeRow,
  type StatusKind,
} from "./notice-view.ts";
import { metaText, safeLine } from "./receipt-tree.ts";

export const BG_PROCESS_SETTLED_TYPE = "bg-process-settled";

/** Follow-up commands carried by every settlement notice. Matches bg-process. */
export const BG_SETTLED_HINT =
  "Use bg_status for bounded logs, or bg_list to see jobs.";

export interface BgSettledJob {
  id?: unknown;
  status?: unknown;
  exitCode?: unknown;
  signal?: unknown;
  title?: unknown;
  command?: unknown;
}

export interface BgSettledDetails {
  jobs?: unknown;
}

/** Map a bg-process job status (possibly malformed) onto the notice vocabulary. */
export function bgStatusKind(status: unknown): StatusKind {
  switch (String(status ?? "")) {
    case "running":
      return "running";
    case "completed":
      return "succeeded";
    case "failed":
      return "failed";
    case "killed":
      return "killed";
    default:
      return "unknown";
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function detailRecord(value: unknown): BgSettledJob | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as BgSettledJob;
}

/** Structured job rows for the notice; empty means fall through to Pi default. */
export function bgProcessNoticeRows(details: unknown): NoticeRow[] {
  const payload = details as BgSettledDetails | undefined;
  const raw = Array.isArray(payload?.jobs) ? payload.jobs : [];
  const rows: NoticeRow[] = [];
  for (const entry of raw.slice(0, 24)) {
    const record = detailRecord(entry);
    if (!record) continue;
    const id = safeLine(record.id, 40);
    if (!id) continue;
    const title = safeLine(record.title, 80);
    const command = safeLine(record.command, 120);
    const exit = finiteNumber(record.exitCode);
    const signal = safeLine(record.signal, 24);
    rows.push({
      kind: bgStatusKind(record.status),
      id,
      subject: title || undefined,
      detail: metaText([
        exit !== undefined
          ? `exit ${exit}`
          : record.exitCode === null
            ? "exit null"
            : undefined,
        signal || undefined,
      ]),
      // Skip a command preview that only repeats the title.
      preview: command && command !== title ? command : undefined,
    });
  }
  return rows;
}

type BgStartArgs = { command?: string; title?: string; working_dir?: string };
type BgStatusArgs = { id?: string };
type BgListArgs = { include_settled?: boolean };
type BgKillArgs = { id?: string };

/** Structural read of the `bg` payload every bg-process tool attaches. */
function bgDetails(result: any): Record<string, unknown> {
  const details =
    result?.details && typeof result.details === "object"
      ? (result.details as Record<string, unknown>)
      : undefined;
  const bg = details?.bg;
  return bg && typeof bg === "object" ? (bg as Record<string, unknown>) : {};
}

function bgJob(result: any): Record<string, unknown> {
  const job = bgDetails(result).job;
  return job && typeof job === "object" ? (job as Record<string, unknown>) : {};
}

/** `exit N` / `exit null` / signal, only once the job stopped running. */
function settledMeta(job: Record<string, unknown>, status: string): string[] {
  if (status === "running") return [];
  const parts: string[] = [];
  const exit = finiteNumber(job.exitCode);
  if (exit !== undefined) parts.push(`exit ${exit}`);
  else if (job.exitCode === null) parts.push("exit null");
  const signal = cleanInline(job.signal, 16);
  if (signal) parts.push(`signal ${signal}`);
  return parts;
}

/** Header: `title (command)` when both are known and differ. */
export function bgStartReceiptArg(
  args: BgStartArgs | undefined,
  budget: number,
): string {
  const title = cleanInline(args?.title, 60);
  const command = cleanInline(args?.command, 120);
  const label =
    title && command && title !== command
      ? `${title} (${command})`
      : title || command;
  return cleanInline(label || "start", Math.max(8, budget));
}

export function bgStatusReceiptArg(
  args: BgStatusArgs | undefined,
  budget: number,
): string {
  return cleanInline(cleanInline(args?.id, 40) || "status", Math.max(8, budget));
}

export function bgListReceiptArg(
  args: BgListArgs | undefined,
  budget: number,
): string {
  if (args === undefined) return cleanInline("list", Math.max(8, budget));
  return cleanInline(
    args.include_settled === false ? "running only" : "all",
    Math.max(8, budget),
  );
}

export function bgKillReceiptArg(
  args: BgKillArgs | undefined,
  budget: number,
): string {
  return cleanInline(cleanInline(args?.id, 40) || "kill", Math.max(8, budget));
}

function previewLines(output: string): string[] {
  return output ? boundedOutput(output, 4, 1200) : [];
}

function bodyLines(output: string): string[] {
  return output ? boundedOutput(output, 80) : [];
}

export const bgStartReceiptRenderers = toolRenderers<BgStartArgs>({
  surface: "bg_start",
  title: "bg_start",
  arg: bgStartReceiptArg,
  stats(result) {
    const job = bgJob(result);
    const status = cleanInline(job.status, 16) || "running";
    const pid = finiteNumber(job.pid);
    return [status, pid !== undefined ? `pid ${pid}` : undefined]
      .filter(Boolean)
      .join(" · ");
  },
  preview: previewLines,
  body: bodyLines,
});

export const bgStatusReceiptRenderers = toolRenderers<BgStatusArgs>({
  surface: "bg_status",
  title: "bg_status",
  arg: bgStatusReceiptArg,
  stats(result) {
    const job = bgJob(result);
    const status = cleanInline(job.status, 16);
    if (!status) return "";
    return [status, ...settledMeta(job, status)].join(" · ");
  },
  preview: previewLines,
  body: bodyLines,
});

export const bgListReceiptRenderers = toolRenderers<BgListArgs>({
  surface: "bg_list",
  title: "bg_list",
  arg: bgListReceiptArg,
  stats(result) {
    const bg = bgDetails(result);
    const running = finiteNumber(bg.running);
    const total = finiteNumber(bg.total);
    return [
      running !== undefined ? `${running} running` : undefined,
      total !== undefined ? `${total} total` : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
  },
  preview: previewLines,
  body: bodyLines,
});

export const bgKillReceiptRenderers = toolRenderers<BgKillArgs>({
  surface: "bg_kill",
  title: "bg_kill",
  arg: bgKillReceiptArg,
  stats(result) {
    const job = bgJob(result);
    const status = cleanInline(job.status, 16);
    if (!status) return "";
    return [status, ...settledMeta(job, status)].join(" · ");
  },
  preview: previewLines,
  body: bodyLines,
});

/**
 * Attach Apex chrome to bg-process: receipts for the four bg_* tools plus the
 * `bg-process-settled` notice renderer.
 */
export function installBgProcessReceipts(pi: ExtensionAPI): void {
  if (!apexPresentationEnabled()) return;
  registerHeadlessReceipt("bg_start", bgStartReceiptRenderers);
  registerHeadlessReceipt("bg_status", bgStatusReceiptRenderers);
  registerHeadlessReceipt("bg_list", bgListReceiptRenderers);
  registerHeadlessReceipt("bg_kill", bgKillReceiptRenderers);
  installHeadlessReceipts();
  pi.registerMessageRenderer<BgSettledDetails>(
    BG_PROCESS_SETTLED_TYPE,
    (message, options, theme) => {
      const rows = bgProcessNoticeRows(message.details);
      // No structured jobs means a malformed payload; fall through to Pi's
      // default rendering rather than showing an empty receipt.
      if (!rows.length) return undefined;
      return noticeComponent(theme, {
        channel: "bg process",
        rows,
        hint: BG_SETTLED_HINT,
        expanded: options.expanded,
        pad: options.outputPad,
      });
    },
  );
}

import { registerHeadlessReceipt } from "./headless-receipts.ts";
import { boundedOutput, toolRenderers } from "./tool-receipt.ts";
import { cleanInline } from "./ui-common.ts";

type ShippingArgs = { operation?: string; task?: string; path?: string; delivery?: string };
type Summary = Record<string, any>;

function summaryLines(summary: Summary): string[] {
  const lines: string[] = [];
  if (summary.blocker) lines.push(`blocked: ${cleanInline(summary.blocker, 240)}`);
  if (summary.next) lines.push(`next: ${cleanInline(summary.next, 240)}`);
  const destination = [summary.remote, summary.target].filter(Boolean).join("/");
  const identity = [summary.branch, destination ? `-> ${destination}` : "", summary.delivery, summary.route].filter(Boolean);
  if (identity.length) lines.push(cleanInline(identity.join(" · "), 240));
  const evidence: string[] = [];
  if (typeof summary.gates?.passed === "number" && Array.isArray(summary.checks)) {
    const current = typeof summary.head === "string" && summary.gates.head === summary.head;
    evidence.push(`checks ${summary.gates.passed}/${summary.checks.length}${current ? "" : " (stale)"}`);
  }
  if (summary.review?.verdict) {
    const current = typeof summary.head === "string" && summary.review.head === summary.head;
    evidence.push(`review ${cleanInline(summary.review.verdict, 24)}${current ? "" : " (stale)"}`);
  }
  if (Array.isArray(summary.dirty) && summary.dirty.length) evidence.push(`${summary.dirty.length} dirty`);
  if (evidence.length) lines.push(evidence.join(" · "));
  if (summary.checkpoint) lines.push(`commit ${cleanInline(summary.checkpoint, 12)} · ${cleanInline(summary.path, 160)}`);
  if (summary.landed?.commit) lines.push(`landed ${cleanInline(summary.landed.commit, 12)}`);
  if (summary.pr?.url) lines.push(cleanInline(summary.pr.url, 240));
  if (Array.isArray(summary.preserved) && summary.preserved.length) lines.push(`${summary.preserved.length} paths preserved`);
  return lines;
}

export const shippingReceiptRenderers = toolRenderers<ShippingArgs>({
  surface: "shipping",
  title: "shipping",
  arg: (args, budget) => cleanInline(
    [args?.operation, args?.task || (args?.operation === "status" ? "all tasks" : ""), args?.path, args?.delivery].filter(Boolean).join(" · "), budget),
  stats(result) {
    const details = result.details;
    if (Array.isArray(details?.tasks)) return `${details.tasks.length} tasks · ${details.worktrees?.length ?? 0} worktrees`;
    return cleanInline(details?.state || (details?.checkpoint ? "checkpointed" : ""), 32);
  },
  preview(output, result) {
    const details = result.details;
    if (!details || typeof details !== "object") return output ? boundedOutput(output, 4, 1200) : [];
    if (Array.isArray(details.tasks)) {
      const rows = details.tasks.slice(0, 3).map((task: Summary) => cleanInline(
        `${task.task} · ${task.state}${task.blocker ? ` · blocked: ${task.blocker}` : ""}`, 240));
      if (details.tasks.length > 3) rows.push(`... ${details.tasks.length - 3} more tasks; expand for details`);
      if (!rows.length) rows.push("No shipping tasks recorded.");
      return rows;
    }
    const lines = summaryLines(details);
    return lines.length ? lines : output ? boundedOutput(output, 4, 1200) : [];
  },
  body: (output) => output ? boundedOutput(output, 80) : [],
});

export function installShippingReceipts(): void {
  registerHeadlessReceipt("shipping", shippingReceiptRenderers);
}

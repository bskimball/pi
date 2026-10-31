import { saveReport } from "./report-file.ts";
import { extractLastReportFence } from "./report-schema.ts";
import { boundText, cleanOneLine } from "./text-bounds.ts";

export const SETTLED_RESULT_CHARS = 12_000;
export const SETTLED_RESULT_LINES = 120;
const HANDOFF_CHARS = 6_000;
const HANDOFF_LINES = 60;
const HANDOFF_KEYS = ["outcome", "findings", "validation", "blockers", "uncertainties"] as const;

export const HANDOFF_INSTRUCTION = `Include a compact handoff in your final response in a fenced \`\`\`handoff JSON block. Required string keys: ${HANDOFF_KEYS.join(", ")}.
The handoff is the lead's default view; the complete response is retained separately. Compress wording, not findings. Include EVERY actionable finding with severity, file/location, decisive evidence, and consequence; every validation result, blocker, and uncertainty. Number findings so none disappear. Use "none" where appropriate. Remove repeated context, narration, long quotations, and redundant explanation. Aim for at most ${HANDOFF_CHARS} characters and ${HANDOFF_LINES} lines, but never omit findings to fit; oversized handoffs fall back to full-file retrieval. Do not claim the handoff is mechanically verified against the full response. If a report-schema fence is requested, include it separately and honor its contract too.`;

function compactHandoff(text: string): string | undefined {
  const fences = [...text.matchAll(/```handoff\s*\r?\n([\s\S]*?)```/gi)];
  const raw = fences.at(-1)?.[1];
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const sections: string[] = [];
  for (const key of HANDOFF_KEYS) {
    if (!(key in value)) return undefined;
    const section: unknown = Reflect.get(value, key);
    if (typeof section !== "string" || !section.trim()) return undefined;
    sections.push(`${key}: ${section.trim()}`);
  }
  const rendered = sections.join("\n");
  if (rendered.length > HANDOFF_CHARS || rendered.split(/\r?\n/).length > HANDOFF_LINES) return undefined;
  return rendered;
}

/** Complete reports stay on disk; only intact handoffs enter the lead context. */
export function formatDeliveredResult(
  value: unknown,
  incomplete?: { killReason?: string; recent: { tool: string; summary: string }[] },
): { text: string; truncated: boolean; reportFile?: string } {
  const fullText = boundText(value, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY).text;
  const heading = incomplete?.killReason
    ? `INCOMPLETE: ${cleanOneLine(incomplete.killReason, 200)}.\n`
    : "";
  const handoff = compactHandoff(fullText);
  const oversized = fullText.length + heading.length > SETTLED_RESULT_CHARS
    || `${heading}${fullText}`.split(/\r?\n/).length > SETTLED_RESULT_LINES;
  if (!handoff && !oversized) {
    if (heading && !fullText.trim()) {
      return { text: `${heading}No final report. Recent activity (unverified):\n${(incomplete?.recent ?? []).slice(-8).map((a) => `- ${cleanOneLine(a.tool, 40)}: ${cleanOneLine(a.summary, 120)}`).join("\n") || "- (none recorded)"}`, truncated: false };
    }
    return { text: `${heading}${fullText}`, truncated: false };
  }

  const { reportFile } = saveReport(`${heading}${fullText}`);
  const report = extractLastReportFence(fullText);
  const schemaReport = report === undefined ? "" : `\n\n\`\`\`report\n${report.trim()}\n\`\`\``;
  const link = `\n\nComplete report: ${JSON.stringify(reportFile)}. Read with read (offset/limit) for supporting detail.`;
  const compact = `${heading}--- compact handoff (worker-authored) ---\n${handoff}${schemaReport}${link}`;
  if (handoff && compact.length <= SETTLED_RESULT_CHARS && compact.split(/\r?\n/).length <= SETTLED_RESULT_LINES) {
    return { text: compact, truncated: false, reportFile };
  }
  const fallback = `${heading}No complete compact handoff fits the delivery budget (missing, invalid, or oversized handoff/report schema). No report excerpt was substituted.`;
  const withSchema = `${fallback}${schemaReport}${link} Read the complete report before drawing conclusions.`;
  return {
    text: withSchema.length <= SETTLED_RESULT_CHARS && withSchema.split(/\r?\n/).length <= SETTLED_RESULT_LINES
      ? withSchema
      : `${fallback}${link} The schema report is available in the complete file. Read the complete report before drawing conclusions.`,
    truncated: true,
    reportFile,
  };
}

import { boundText } from "./text-bounds.ts";
import { SETTLED_RESULT_CHARS, SETTLED_RESULT_LINES } from "./worker-status.ts";

const FINAL_MARKER = "--- final ---";

/** Replace every `{{prev}}` with a char-capped previous-step report. */
export function substitutePrev(template: string, previous: string, cap = SETTLED_RESULT_CHARS): string {
  const capped = boundText(previous, cap, Number.POSITIVE_INFINITY).text;
  return template.split("{{prev}}").join(capped);
}

/**
 * Assemble task_chain output so per-step digest lines always survive.
 * The last report is tail-capped into remaining SETTLED_RESULT budget.
 */
export function assembleChainDigest(
  digestLines: readonly string[],
  lastReport: string,
  maxChars = SETTLED_RESULT_CHARS,
  maxLines = SETTLED_RESULT_LINES,
): { text: string; truncated: boolean } {
  const digest = digestLines.join("\n");
  const prefix = digest ? `${digest}\n\n${FINAL_MARKER}\n` : `${FINAL_MARKER}\n`;
  const prefixChars = prefix.length;
  const prefixLines = prefix.split(/\r?\n/).length;
  const reportBudgetChars = Math.max(0, maxChars - prefixChars);
  const reportBudgetLines = Math.max(1, maxLines - prefixLines + 1);
  const report = boundText(lastReport, reportBudgetChars, reportBudgetLines);
  return {
    text: `${prefix}${report.text}`,
    truncated: report.truncated,
  };
}

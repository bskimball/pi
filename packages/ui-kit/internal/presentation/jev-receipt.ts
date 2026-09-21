// jev-receipt: kit chrome for the headless jev classifier tool.
//
// agent/extensions/jev owns execute; the kit cannot import that extension.
// Receipts attach through the shared headless wrap, like web-search. Deleting
// the jev directory leaves no kit dependency behind.
//
// PI_UI_CHROME=0 (deprecated PI_APEX_UI=0 alias) skips the wrap. Any existing
// presentation on the tool wins. Stock pi shows the model-facing JSON.

import { apexPresentationEnabled } from "./presentation.ts";
import { boundedOutput, toolRenderers } from "./tool-receipt.ts";
import { cleanInline } from "./ui-common.ts";
import {
  installHeadlessReceipts,
  registerHeadlessReceipt,
} from "./headless-receipts.ts";

export const JEV_TOOL = "jev";

export type JevArgs = {
  state?: string;
  questions?: Record<string, unknown>;
  includeProbabilities?: boolean;
};

type JevAnswer = Record<string, unknown>;

function detailsOf(result: any): Record<string, unknown> {
  return result?.details && typeof result.details === "object"
    ? (result.details as Record<string, unknown>)
    : {};
}

function answersFrom(details: Record<string, unknown>): Record<string, JevAnswer> | undefined {
  const answers = details.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return undefined;
  return answers as Record<string, JevAnswer>;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatNative(value: unknown): string | undefined {
  const num = finiteNumber(value);
  return num === undefined ? undefined : String(num);
}

function formatProbabilities(probs: unknown): string | undefined {
  if (!probs || typeof probs !== "object" || Array.isArray(probs)) return undefined;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(probs as Record<string, unknown>)) {
    const num = formatNative(value);
    const name = cleanInline(key, 40);
    if (num === undefined || !name) continue;
    parts.push(`${name}=${num}`);
  }
  return parts.length ? parts.join(", ") : undefined;
}

function formatLegend(legend: unknown): string | undefined {
  if (!legend || typeof legend !== "object") return undefined;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(legend as Record<string, unknown>)) {
    const label = cleanInline(typeof value === "string" ? value : JSON.stringify(value), 60);
    if (!label) continue;
    parts.push(`${cleanInline(key, 12)}=${label}`);
  }
  return parts.length ? parts.join(", ") : undefined;
}

function jevUsageLine(details: Record<string, unknown>): string | undefined {
  const usage = details.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const record = usage as Record<string, unknown>;
  const input = finiteNumber(record.input_tokens);
  const output = finiteNumber(record.output_tokens);
  const parts: string[] = [];
  if (input !== undefined) parts.push(`in ${input}`);
  if (output !== undefined) parts.push(`out ${output}`);
  return parts.length ? parts.join(" · ") : undefined;
}

/**
 * One collapsed line per answer. Choice shows the selected option and native
 * confidence; Noul shows the native numeric value only (never a yes/no label);
 * Score shows the native numeric score and confidence (never a denominator).
 */
function answerLine(
  id: string,
  answer: JevAnswer,
  opts: { probs: boolean; showType: boolean },
): string | undefined {
  const name = cleanInline(id, 60);
  if (!name || !answer || typeof answer !== "object") return undefined;
  const tag = opts.showType && typeof answer.type === "string"
    ? ` (${cleanInline(answer.type, 12)})`
    : "";
  if (answer.type === "choice") {
    const choice = cleanInline(answer.choice, 80);
    const conf = formatNative(answer.confidence);
    if (!choice || conf === undefined) return undefined;
    let line = `${name}${tag}: ${choice} (conf ${conf})`;
    if (opts.probs) {
      const probs = formatProbabilities(answer.probabilities);
      if (probs) line += ` [${cleanInline(probs, 200)}]`;
    }
    return line;
  }
  if (answer.type === "noul") {
    const value = formatNative(answer.noul);
    if (value === undefined) return undefined;
    return `${name}${tag}: ${value}`;
  }
  if (answer.type === "score") {
    const score = formatNative(answer.score);
    const conf = formatNative(answer.confidence);
    if (score === undefined || conf === undefined) return undefined;
    let line = `${name}${tag}: ${score} (conf ${conf})`;
    if (opts.probs) {
      const probs = formatProbabilities(answer.probabilities);
      if (probs) line += ` [${cleanInline(probs, 200)}]`;
    }
    return line;
  }
  return `${name}: (unsupported answer type)`;
}

function answerLines(details: Record<string, unknown>, withProbs: boolean): string[] {
  const answers = answersFrom(details);
  if (!answers) return [];
  const lines: string[] = [];
  for (const [id, answer] of Object.entries(answers)) {
    const line = answerLine(id, answer, { probs: withProbs, showType: false });
    if (line) lines.push(line);
  }
  return lines;
}

function expandedLines(details: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const model = typeof details.model === "string" ? cleanInline(details.model, 64) : "";
  const usage = jevUsageLine(details);
  const head = [model ? `model ${model}` : "", usage ?? ""].filter(Boolean).join(" · ");
  if (head) lines.push(head);
  const answers = answersFrom(details);
  if (!answers) return lines;
  for (const [id, answer] of Object.entries(answers)) {
    const line = answerLine(id, answer, { probs: false, showType: true });
    if (!line) continue;
    lines.push(line);
    const probs = formatProbabilities((answer as JevAnswer).probabilities);
    if (probs) lines.push(`  probs: ${cleanInline(probs, 300)}`);
    if ((answer as JevAnswer).type === "score") {
      const legend = formatLegend((answer as JevAnswer).legend);
      if (legend) lines.push(`  levels: ${cleanInline(legend, 300)}`);
    }
  }
  return lines;
}

/** Compact header: question count plus leading ids and types. Never a state dump. */
export function jevReceiptArg(args: JevArgs | undefined, budget: number): string {
  const questions = args?.questions && typeof args.questions === "object" && !Array.isArray(args.questions)
    ? (args.questions as Record<string, unknown>)
    : undefined;
  const ids = questions ? Object.keys(questions) : [];
  if (!ids.length) return "decide";
  const head = ids.slice(0, 2).map((id) => {
    const question = questions![id];
    const kind = question && typeof question === "object" && !Array.isArray(question)
      && typeof (question as Record<string, unknown>).type === "string"
      ? String((question as Record<string, unknown>).type)
      : "?";
    return `${cleanInline(id, 40)} (${cleanInline(kind, 12)})`;
  });
  const more = ids.length > 2 ? ` +${ids.length - 2} more` : "";
  return cleanInline(
    `${ids.length} question${ids.length === 1 ? "" : "s"}: ${head.join(", ")}${more}`,
    Math.max(8, budget),
  );
}

export const jevReceiptRenderers = toolRenderers<JevArgs>({
  surface: JEV_TOOL,
  title: JEV_TOOL,
  arg: jevReceiptArg,
  stats(result) {
    return jevUsageLine(detailsOf(result)) ?? "";
  },
  preview(output, result, args) {
    const details = detailsOf(result);
    const lines = answerLines(details, args?.includeProbabilities === true);
    if (!lines.length) return output ? boundedOutput(output, 4, 1200) : [];
    const usage = jevUsageLine(details);
    const room = usage ? 3 : 4;
    const visibleCount = lines.length > room ? room - 1 : room;
    const shown = lines.slice(0, visibleCount);
    const omitted = lines.length - shown.length;
    if (omitted > 0) shown.push(`... ${omitted} more answer${omitted === 1 ? "" : "s"}`);
    const all = usage ? [...shown, usage] : shown;
    return boundedOutput(all.join("\n"), 4, 1200);
  },
  body(output, result) {
    const details = detailsOf(result);
    const lines = expandedLines(details);
    if (!lines.length) return output ? boundedOutput(output, 80) : [];
    return boundedOutput(lines.join("\n"), 80);
  },
});

/** Attach kit receipts to the headless jev tool. */
export function installJevReceipts(): void {
  if (!apexPresentationEnabled()) return;
  registerHeadlessReceipt(JEV_TOOL, jevReceiptRenderers);
  installHeadlessReceipts();
}

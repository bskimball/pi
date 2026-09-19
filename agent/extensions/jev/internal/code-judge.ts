// Pure clean-code judgment helpers. No Pi imports, I/O, or network.
//
// Noul questions only. In measured paired examples, Nouls sharply separated an
// over-engineered implementation from a plain function while a complexity Score
// remained uncertain, so findings use high-probability bad traits and low-probability
// good traits without a Score gate.

import type { JevAnswer, JevQuestion } from "./client.ts";

export interface JudgeFinding {
  id: string;
  label: string;
  probability: number;
}

export const JUDGE_THRESHOLD = 0.8;
export const MAX_JUDGE_ADVISORY_CHARS = 200;

export const CODE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "rb", "php",
  "c", "h", "cc", "cpp", "hpp", "cs", "swift", "kt", "scala", "sh", "sql",
]);

export function isJudgeableFile(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  const basename = segments.at(-1) ?? "";
  if (segments.includes("node_modules") || segments.some(segment => ["test", "tests", "__tests__"].includes(segment))) return false;
  if (/\.(?:test|spec)\./.test(basename)) return false;
  if (basename === "package-lock.json" || basename === "bun.lock" || basename.endsWith(".lock")) return false;
  if (basename.endsWith(".min.js") || basename.endsWith(".d.ts")) return false;
  const extension = basename.includes(".") ? basename.slice(basename.lastIndexOf(".") + 1) : "";
  return CODE_FILE_EXTENSIONS.has(extension);
}

/** Declaration order is report order. Good traits fire when their statement is probably false. */
export const JUDGE_QUESTIONS: Record<string, {
  label: string;
  polarity: "bad" | "good";
  instructions: string;
  criteria?: { true?: string; false?: string };
}> = {
  speculative_abstraction: {
    label: "speculative abstraction",
    polarity: "bad",
    instructions: "The code contains an abstraction such as an interface, factory, strategy, or layer with one implementation or one caller that would be simpler as a plain function.",
    criteria: {
      true: "A single-use abstraction adds structure without a demonstrated need.",
      false: "The abstractions serve multiple implementations or callers, or are simpler than the alternative.",
    },
  },
  dead_or_unreachable: {
    label: "dead or unreachable logic",
    polarity: "bad",
    instructions: "The code contains dead, unreachable, or no-op branches that can never behave differently.",
    criteria: {
      true: "At least one branch is unreachable, dead, or behaviorally inert.",
      false: "Every branch is reachable and can affect behavior meaningfully.",
    },
  },
  duplicated_logic: {
    label: "duplicated non-trivial logic",
    polarity: "bad",
    instructions: "The code repeats the same non-trivial logic where one shared implementation is clearly warranted.",
    criteria: {
      true: "Substantive repeated logic should have one shared implementation.",
      false: "Any similarity is trivial, incidental, or clearer when kept separate.",
    },
  },
  naming_reveals_intent: {
    label: "names obscure intent",
    polarity: "good",
    instructions: "The names in the code clearly reveal intent without needing comments.",
    criteria: {
      true: "Names communicate purpose and behavior on their own.",
      false: "Understanding intent depends on comments or inference around vague names.",
    },
  },
  single_responsibility: {
    label: "units mix responsibilities",
    polarity: "good",
    instructions: "Each unit in the code has one clear reason to change.",
    criteria: {
      true: "Each unit has one cohesive responsibility.",
      false: "At least one unit combines responsibilities that would change for different reasons.",
    },
  },
};

export function buildJudgeQuestions(): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = Object.create(null);
  for (const [id, definition] of Object.entries(JUDGE_QUESTIONS)) {
    questions[id] = {
      type: "noul",
      instructions: definition.instructions,
      ...(definition.criteria ? { criteria: definition.criteria } : {}),
    };
  }
  return questions;
}

export function collectFindings(
  answers: Record<string, JevAnswer | undefined>,
  threshold: number,
): JudgeFinding[] {
  const findings: JudgeFinding[] = [];
  for (const [id, definition] of Object.entries(JUDGE_QUESTIONS)) {
    const answer = answers[id];
    if (!answer || answer.type !== "noul") continue;
    const fires = definition.polarity === "bad"
      ? answer.noul >= threshold
      : answer.noul <= 1 - threshold;
    if (fires) findings.push({ id, label: definition.label, probability: answer.noul });
  }
  return findings;
}

export function formatJudgeAdvisory(path: string, findings: JudgeFinding[]): string | null {
  if (findings.length === 0) return null;
  const basename = path.replace(/\\/g, "/").split("/").at(-1) || path;
  const parts = findings.map(finding => `${finding.label} (p=${finding.probability.toFixed(2)})`);
  const line = `Jev review hint for ${basename}: ${parts.join("; ")}. Advisory only, not a blocking gate.`;
  return line.length > MAX_JUDGE_ADVISORY_CHARS
    ? `${line.slice(0, MAX_JUDGE_ADVISORY_CHARS - 1)}…`
    : line;
}

export function truncateForJudging(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const boundedMax = Math.max(0, maxChars);
  const prefix = content.slice(0, boundedMax);
  const newline = prefix.lastIndexOf("\n");
  const kept = newline >= 0 ? prefix.slice(0, newline) : prefix;
  return `${kept}\n[truncated for Jev judging]`;
}

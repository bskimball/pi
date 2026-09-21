// Pure memory_write triage helpers. No Pi imports, I/O, or network.

import type { JevAnswer, JevQuestion } from "./client.ts";

export interface MemoryTriageFinding {
  id: string;
  label: string;
  probability: number;
}

export const MAX_MEMORY_STATE_CHARS = 4000;
export const MAX_MEMORY_ADVISORY_CHARS = 200;

/** Local mirror of continual-memory/store.ts SECRETISH (duplicated: no cross-extension
 *  imports) widened with generic credential keywords. Best-effort only; secret-shaped
 *  text is never sent to Jev. A miss here is still safe when memory_write refused
 *  first (errors skip evaluation), but the store patterns must stay a subset. */
export const SECRETISH =
  /(?:\b(?:sk-[a-zA-Z0-9_-]{16,}|ghp_[a-zA-Z0-9]{20,}|xox[baprs]-[a-zA-Z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|api[_-]?key|secret|token|password|bearer)/i;

export const MEMORY_TRIAGE_QUESTIONS: Record<string, {
  label: string;
  kind: "noul-bad" | "noul-good" | "score";
  instructions: string;
  criteria?: { true?: string; false?: string } | string[];
}> = {
  is_ephemeral_task_dump: {
    label: "ephemeral task dump",
    kind: "noul-bad",
    instructions:
      "This memory is a session-specific dump (scratch, current task, one-off notes) that should stay local rather than global.",
    criteria: {
      true: "The content is tied to this session or a single task and will not help later sessions.",
      false: "The content is a reusable fact or lesson, not a dump of current work.",
    },
  },
  is_durable_lesson: {
    label: "not a durable lesson",
    kind: "noul-good",
    instructions:
      "This memory captures a durable lesson, preference, or fact that later sessions should reuse.",
    criteria: {
      true: "A later session would benefit from this without the original context.",
      false: "It is too situational or incomplete to reuse later.",
    },
  },
  reusability: {
    label: "low reusability",
    kind: "score",
    instructions: "How reusable is this memory across future sessions?",
    criteria: ["session-only", "sometimes reusable", "durable across projects"],
  },
};

export function looksSecretish(text: string): boolean {
  return SECRETISH.test(text);
}

export function buildMemoryTriageQuestions(): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = Object.create(null);
  for (const [id, definition] of Object.entries(MEMORY_TRIAGE_QUESTIONS)) {
    if (definition.kind === "score") {
      questions[id] = {
        type: "score",
        instructions: definition.instructions,
        criteria: Array.isArray(definition.criteria) ? definition.criteria : ["session-only", "sometimes reusable", "durable across projects"],
      };
    } else {
      questions[id] = {
        type: "noul",
        instructions: definition.instructions,
        ...(definition.criteria && !Array.isArray(definition.criteria) ? { criteria: definition.criteria } : {}),
      };
    }
  }
  return questions;
}

export function collectMemoryTriageFindings(
  answers: Record<string, JevAnswer | undefined>,
  options: { threshold: number; goodTraitBar?: number },
): MemoryTriageFinding[] {
  const threshold = options.threshold;
  const goodTraitBar = options.goodTraitBar ?? threshold;
  const findings: MemoryTriageFinding[] = [];
  for (const [id, definition] of Object.entries(MEMORY_TRIAGE_QUESTIONS)) {
    const answer = answers[id];
    if (!answer) continue;
    if (definition.kind === "noul-bad" && answer.type === "noul" && answer.noul >= threshold) {
      findings.push({ id, label: definition.label, probability: answer.noul });
    } else if (definition.kind === "noul-good" && answer.type === "noul" && answer.noul < goodTraitBar) {
      findings.push({ id, label: definition.label, probability: answer.noul });
    } else if (definition.kind === "score" && answer.type === "score" && answer.score <= 1) {
      findings.push({ id, label: definition.label, probability: answer.confidence });
    }
  }
  return findings;
}

export function formatMemoryTriageAdvisory(findings: MemoryTriageFinding[]): string | null {
  if (findings.length === 0) return null;
  const parts = findings.map((finding) => `${finding.label} (p=${finding.probability.toFixed(2)})`);
  const line = `Jev memory hint: consider local rather than global scope; ${parts.join("; ")}. Advisory only.`;
  return line.length > MAX_MEMORY_ADVISORY_CHARS
    ? `${line.slice(0, MAX_MEMORY_ADVISORY_CHARS - 1)}…`
    : line;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export interface MemoryEntry {
  title: string;
  content: string;
  reason: string;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

/** Parse a created/updated entry from the tool result. Null on delete, error, or empty. */
export function parseMemoryEntry(
  input: unknown,
  content: unknown,
  details: unknown,
): MemoryEntry | null {
  if (!isRecord(input)) return null;
  const action = typeof input.action === "string" ? input.action : "";
  if (action !== "create" && action !== "update") return null;
  const fromDetails = isRecord(details) ? details : Object.create(null) as Record<string, unknown>;
  const entry = isRecord(fromDetails.entry) ? fromDetails.entry : fromDetails;
  const title = typeof entry.title === "string"
    ? entry.title
    : typeof input.title === "string"
      ? input.title
      : "";
  const body = typeof entry.content === "string"
    ? entry.content
    : typeof input.content === "string"
      ? input.content
      : textFromContent(content);
  const reason = typeof entry.reason === "string"
    ? entry.reason
    : typeof input.reason === "string"
      ? input.reason
      : "";
  if (!title.trim() && !body.trim()) return null;
  return {
    title: title.slice(0, MAX_MEMORY_STATE_CHARS),
    content: body.slice(0, MAX_MEMORY_STATE_CHARS),
    reason: reason.slice(0, 400),
  };
}

export function formatMemoryState(entry: MemoryEntry): string {
  const text = `title: ${entry.title}\nreason: ${entry.reason}\ncontent: ${entry.content}`;
  return text.length > MAX_MEMORY_STATE_CHARS ? text.slice(0, MAX_MEMORY_STATE_CHARS) : text;
}

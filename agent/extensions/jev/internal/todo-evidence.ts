// Pure todo-completion evidence helpers. No Pi imports, I/O, or network.

import type { JevAnswer, JevQuestion } from "./client.ts";

export interface TodoEvidenceFinding {
  id: string;
  label: string;
  probability: number;
}

export const MAX_TODO_STATE_CHARS = 600;
export const MAX_TODO_ITEMS = 3;
export const MAX_TODO_ADVISORY_CHARS = 200;

export const TODO_EVIDENCE_QUESTIONS: Record<string, {
  label: string;
  polarity: "good" | "bad";
  instructions: string;
  criteria?: { true?: string; false?: string };
}> = {
  has_observable_evidence: {
    label: "missing observable evidence",
    polarity: "good",
    instructions:
      "The completion note cites observable evidence that the work is done (a file, test, command result, or concrete artifact), not only an intention.",
    criteria: {
      true: "The note names a concrete artifact or result that would let a stranger verify completion.",
      false: "The note is empty, vague, or only restates the intent without evidence.",
    },
  },
  premature_completion: {
    label: "premature completion",
    polarity: "bad",
    instructions:
      "This item is being marked completed before the work it describes is actually finished.",
    criteria: {
      true: "The note or title indicates unfinished, blocked, or planned work marked complete.",
      false: "The described work appears finished.",
    },
  },
};

export function buildTodoEvidenceQuestions(): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = Object.create(null);
  for (const [id, definition] of Object.entries(TODO_EVIDENCE_QUESTIONS)) {
    questions[id] = {
      type: "noul",
      instructions: definition.instructions,
      ...(definition.criteria ? { criteria: definition.criteria } : {}),
    };
  }
  return questions;
}

export function collectTodoEvidenceFindings(
  answers: Record<string, JevAnswer | undefined>,
  threshold: number,
): TodoEvidenceFinding[] {
  const findings: TodoEvidenceFinding[] = [];
  for (const [id, definition] of Object.entries(TODO_EVIDENCE_QUESTIONS)) {
    const answer = answers[id];
    if (!answer || answer.type !== "noul") continue;
    const fires = definition.polarity === "bad"
      ? answer.noul >= threshold
      : answer.noul < threshold;
    if (fires) findings.push({ id, label: definition.label, probability: answer.noul });
  }
  return findings;
}

export function formatTodoEvidenceAdvisory(itemTitle: string, findings: TodoEvidenceFinding[]): string | null {
  if (findings.length === 0) return null;
  const title = itemTitle.replace(/[\r\n\t]+/g, " ").trim().slice(0, 80) || "todo";
  const parts = findings.map((finding) => `${finding.label} (p=${finding.probability.toFixed(2)})`);
  const line = `Jev todo hint for ${title}: ${parts.join("; ")}. Advisory only.`;
  return line.length > MAX_TODO_ADVISORY_CHARS
    ? `${line.slice(0, MAX_TODO_ADVISORY_CHARS - 1)}…`
    : line;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export interface TodoSnapshotItem {
  key: string;
  title: string;
  note: string;
  status: string;
}

/** Current todo_write list. Prefers input.todos, then details.todos. */
export function snapshotTodos(input: unknown, details: unknown): TodoSnapshotItem[] {
  const source = isRecord(input) && Array.isArray(input.todos)
    ? input.todos
    : isRecord(details) && Array.isArray(details.todos)
      ? details.todos
      : [];
  const items: TodoSnapshotItem[] = [];
  for (const item of source) {
    if (!isRecord(item)) continue;
    const status = typeof item.status === "string" ? item.status : "";
    const title = typeof item.content === "string"
      ? item.content
      : typeof item.title === "string"
        ? item.title
        : "";
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const key = id || title.trim();
    if (!key) continue;
    items.push({
      key,
      title,
      note: typeof item.note === "string" ? item.note : "",
      status,
    });
  }
  return items;
}

/** Newly flipped to completed vs last-seen statuses. Missing prev counts as new. */
export function diffTodoTransitions(
  prev: ReadonlyMap<string, string>,
  current: TodoSnapshotItem[],
): Array<{ title: string; note: string }> {
  const flipped: Array<{ title: string; note: string }> = [];
  for (const item of current) {
    if (item.status !== "completed") continue;
    if (!item.note.trim()) continue;
    if (prev.get(item.key) === "completed") continue;
    flipped.push({ title: item.title, note: item.note });
    if (flipped.length >= MAX_TODO_ITEMS) break;
  }
  return flipped;
}

export function nextTodoStatusMap(current: TodoSnapshotItem[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of current) map.set(item.key, item.status);
  return map;
}

/** Items currently completed with a note (no prior-status diff). */
export function readTodoTransitions(input: unknown, details: unknown): Array<{ title: string; note: string }> {
  return snapshotTodos(input, details)
    .filter((item) => item.status === "completed" && item.note.trim())
    .slice(0, MAX_TODO_ITEMS)
    .map((item) => ({ title: item.title, note: item.note }));
}

export function formatTodoState(item: { title: string; note: string }): string {
  const title = item.title.replace(/[\r\n\t]+/g, " ").trim();
  const note = item.note.replace(/[\r\n\t]+/g, " ").trim();
  const text = `title: ${title}\nnote: ${note}`;
  return text.length > MAX_TODO_STATE_CHARS ? text.slice(0, MAX_TODO_STATE_CHARS) : text;
}

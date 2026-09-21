// Pure task_wait oracle-trigger helpers. No Pi imports, I/O, or network.

import type { JevAnswer, JevQuestion } from "./client.ts";

export interface OracleTriggerFinding {
  id: string;
  label: string;
  probability: number;
}

export const MAX_ORACLE_ADVISORY_CHARS = 200;

export const ORACLE_TRIGGER_QUESTIONS: Record<string, {
  label: string;
  instructions: string;
  criteria?: { true?: string; false?: string };
}> = {
  touches_security_boundary: {
    label: "touches a security boundary",
    instructions:
      "The settled worker report describes work that touches authentication, secrets, identity, authorization, or a destructive confirmation boundary.",
    criteria: {
      true: "Security, secrets, identity, or a confirmation boundary is involved.",
      false: "No security boundary is involved.",
    },
  },
  warrants_deep_review: {
    label: "warrants deep review",
    instructions:
      "This settled report describes a change that should get a second, slower review (oracle or human) before it is treated as done.",
    criteria: {
      true: "The work is high-stakes, irreversible, or too large to accept from a single pass.",
      false: "A single-pass review is enough.",
    },
  },
};

export function buildOracleTriggerQuestions(): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = Object.create(null);
  for (const [id, definition] of Object.entries(ORACLE_TRIGGER_QUESTIONS)) {
    questions[id] = {
      type: "noul",
      instructions: definition.instructions,
      ...(definition.criteria ? { criteria: definition.criteria } : {}),
    };
  }
  return questions;
}

export function collectOracleTriggerFindings(
  answers: Record<string, JevAnswer | undefined>,
  threshold: number,
): OracleTriggerFinding[] {
  const findings: OracleTriggerFinding[] = [];
  for (const [id, definition] of Object.entries(ORACLE_TRIGGER_QUESTIONS)) {
    const answer = answers[id];
    if (!answer || answer.type !== "noul") continue;
    if (answer.noul >= threshold) findings.push({ id, label: definition.label, probability: answer.noul });
  }
  return findings;
}

export function formatOracleTriggerAdvisory(findings: OracleTriggerFinding[]): string | null {
  if (findings.length === 0) return null;
  const parts = findings.map((finding) => `${finding.label} (p=${finding.probability.toFixed(2)})`);
  const line = `Jev review hint: ${parts.join("; ")}. Advisory only.`;
  return line.length > MAX_ORACLE_ADVISORY_CHARS
    ? `${line.slice(0, MAX_ORACLE_ADVISORY_CHARS - 1)}…`
    : line;
}

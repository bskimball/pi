// Pure routing-advisory helpers. No Pi imports, I/O, or network.
//
// Guard questions only. A complexity Score is deliberately absent: measured on a
// request that weakened a confirmation boundary, complexity scored 1.29 ("routine")
// while these guards scored 0.89-0.95. Difficulty and stakes are orthogonal, so the
// advisory reports stakes and lets the lead decide.

import type { JevAnswer, JevQuestion } from "./client.ts";

/** Fires when the guard's probability reaches this bound. */
export const ADVISORY_THRESHOLD = 0.8;

/** Longest advisory appended to a turn. Keeps the injected preface bounded. */
export const MAX_ADVISORY_CHARS = 400;

export interface GuardDefinition {
  /** Short phrase shown to the lead when the guard fires. */
  label: string;
  /** Statement Jev evaluates the truth of. */
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export interface GuardFinding {
  id: string;
  label: string;
  probability: number;
}

/**
 * Declaration order is report order. Each guard is independent: one firing never
 * suppresses another, because a request can be both underspecified and risky.
 */
export const ROUTING_GUARDS: Record<string, GuardDefinition> = {
  crosses_trust_boundary: {
    label: "touches a trust boundary",
    instructions:
      "The work this request implies will touch an authentication, identity, session, IPC, destructive-action, or user-confirmation trust boundary.",
    criteria: {
      true: "A security, identity, or confirmation boundary is involved.",
      false: "No trust boundary is involved.",
    },
  },
  weakens_safety_control: {
    label: "weakens an existing safety control",
    instructions:
      "This request asks to remove, bypass, disable, or loosen an existing safety check, confirmation prompt, validation, or guardrail.",
    criteria: {
      true: "An existing protection would be removed or loosened.",
      false: "No existing protection is weakened.",
    },
  },
  sounds_easier_than_it_is: {
    label: "larger blast radius than the phrasing suggests",
    instructions:
      "The request is phrased as small, quick, or simple, but its actual risk or blast radius is significantly larger than that phrasing suggests.",
    criteria: {
      true: "Phrased as trivial but actually consequential.",
      false: "The phrasing matches the real scope.",
    },
  },
  scope_is_underspecified: {
    label: "underspecified scope",
    instructions:
      "This request is too large or too ambiguous to execute directly, and a plan or one scoping question should come before writing code.",
    criteria: {
      true: "Needs a plan or a scoping question first.",
      false: "Specific enough to act on directly.",
    },
  },
};

/** Build the Noul questions for every guard. Count stays well under MAX_QUESTIONS. */
export function buildRoutingQuestions(): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = Object.create(null);
  for (const [id, guard] of Object.entries(ROUTING_GUARDS)) {
    questions[id] = {
      type: "noul",
      instructions: guard.instructions,
      ...(guard.criteria ? { criteria: guard.criteria } : {}),
    };
  }
  return questions;
}

/**
 * Collect guards at or above `threshold`, in declaration order. Missing and
 * non-noul answers are skipped: a partial response still yields usable guards.
 */
export function collectGuardFindings(
  answers: Record<string, JevAnswer | undefined>,
  threshold: number,
): GuardFinding[] {
  const findings: GuardFinding[] = [];
  for (const [id, guard] of Object.entries(ROUTING_GUARDS)) {
    const answer = answers[id];
    if (!answer || answer.type !== "noul") continue;
    if (answer.noul >= threshold) {
      findings.push({ id, label: guard.label, probability: answer.noul });
    }
  }
  return findings;
}

/**
 * One advisory line, or null when nothing fired. Silence is the common case.
 *
 * Advisory only: it reports what Jev observed and never instructs the lead to
 * skip review, change mode, or dispatch a particular agent.
 */
export function formatRoutingAdvisory(findings: GuardFinding[]): string | null {
  if (findings.length === 0) return null;
  const parts = findings.map((finding) => `${finding.label} (p=${finding.probability.toFixed(2)})`);
  const line = `Jev routing advisory: ${parts.join("; ")}. Weigh this before acting; it is a hint, not a verdict.`;
  return line.length > MAX_ADVISORY_CHARS ? `${line.slice(0, MAX_ADVISORY_CHARS - 1)}\u2026` : line;
}

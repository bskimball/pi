// Pure skill-routing helpers. No Pi imports, I/O, or network.

import type { JevAnswer, JevQuestion } from "./client.ts";

export interface SkillCandidate {
  name: string;
  description: string;
}

export const NONE_OPTION = "none_needed";

const MAX_CHOICE_OPTIONS = 32;
const MAX_OPTION_KEY_CHARS = 80;

function fallbackKey(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `skill_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** Empty sanitized names use a deterministic FNV-1a-derived key. */
export function toOptionKey(skillName: string): string {
  const key = skillName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_OPTION_KEY_CHARS)
    .replace(/_+$/g, "");
  return key || fallbackKey(skillName);
}

export function buildSkillQuestion(candidates: SkillCandidate[]): JevQuestion {
  if (candidates.length < 1) throw new Error("Skill routing needs at least one candidate.");
  if (candidates.length + 1 > MAX_CHOICE_OPTIONS) {
    throw new Error(`Skill routing supports at most ${MAX_CHOICE_OPTIONS - 1} candidates plus ${NONE_OPTION}.`);
  }
  const criteria: Record<string, string> = Object.create(null);
  for (const candidate of candidates) {
    const key = toOptionKey(candidate.name);
    // Assigning a duplicate key would silently drop a skill from the catalog.
    if (key === NONE_OPTION || key in criteria) {
      throw new Error(`Skill routing option key "${key}" collides; rename the skill or adjust toOptionKey.`);
    }
    criteria[key] = candidate.description;
  }
  criteria[NONE_OPTION] = "No skill is a clear fit; proceed without loading one.";
  return {
    type: "choice",
    instructions: `Select the ONE skill whose instructions would most improve handling of the request, or ${NONE_OPTION} if no skill is a clear fit.`,
    criteria,
  };
}

export function resolveSkillChoice(
  answer: JevAnswer | undefined,
  candidates: SkillCandidate[],
  threshold: number,
): {
  skill: SkillCandidate | null;
  reason: "selected" | "none_needed" | "below_threshold" | "unusable";
  winner: string;
  probability: number;
} {
  if (!answer || answer.type !== "choice") {
    return { skill: null, reason: "unusable", winner: "", probability: 0 };
  }
  const winner = answer.choice;
  const probabilities = answer.probabilities as Record<string, number> | undefined;
  const probability = probabilities === undefined ? answer.confidence : probabilities[winner];
  if (typeof probability !== "number" || !Number.isFinite(probability)) {
    return { skill: null, reason: "unusable", winner, probability: 0 };
  }

  const matches = candidates.filter(candidate => toOptionKey(candidate.name) === winner);
  if (matches.length > 1 || (winner === NONE_OPTION && matches.length > 0)) {
    return { skill: null, reason: "unusable", winner, probability };
  }
  if (winner === NONE_OPTION) {
    return { skill: null, reason: "none_needed", winner, probability };
  }
  if (matches.length !== 1) {
    return { skill: null, reason: "unusable", winner, probability };
  }
  if (probability < threshold) {
    return { skill: null, reason: "below_threshold", winner, probability };
  }
  return { skill: matches[0]!, reason: "selected", winner, probability };
}

export function formatSkillAdvisory(skill: SkillCandidate, probability: number): string {
  const name = skill.name.replace(/\s+/g, " ").trim();
  return `Jev skill match: ${name} (p=${probability.toFixed(2)}). Load it with the read tool if this turn needs it.`;
}

// Pure skill-routing helpers. No Pi imports, I/O, or network.

import type { JevAnswer, JevQuestion } from "./client.ts";

export interface SkillCandidate {
  name: string;
  description: string;
  /** Exact discovered SKILL.md path, retained only for in-memory follow-through matching. */
  filePath: string;
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

export const BREADTH_ID = "spans_multiple_skills";

export function buildSkillBreadthQuestion(candidates: SkillCandidate[]): JevQuestion {
  const names = candidates.map(candidate => candidate.name.replace(/[\r\n\t\x00-\x1f\x7f]+/g, " ").slice(0, 60));
  const catalog = names.join(", ");
  return { type: "noul", instructions: `Answering this request well requires more than one of these skills because it spans multiple systems, channels, or workflows. Available skills: ${catalog}.` };
}

const MAX_BREADTH_SKILLS = 12;

export function buildSkillRelevanceQuestions(candidates: SkillCandidate[], answer: JevAnswer | undefined): Record<string, JevQuestion> {
  const probabilities = answer?.type === "choice" ? answer.probabilities : undefined;
  const ranked = [...candidates].sort((a, b) => (probabilities?.[toOptionKey(b.name)] ?? 0) - (probabilities?.[toOptionKey(a.name)] ?? 0));
  const questions: Record<string, JevQuestion> = Object.create(null);
  for (const candidate of ranked.slice(0, MAX_BREADTH_SKILLS)) {
    questions[toOptionKey(candidate.name)] = {
      type: "noul",
      instructions: `The ${candidate.name} skill is relevant to handling this request.`,
      criteria: { true: candidate.description },
    };
  }
  return questions;
}

export interface SuggestedSkill { skill: SkillCandidate; probability: number }

export function resolveSkillSuggestions(
  decision: SkillChoiceResult,
  candidates: SkillCandidate[],
  breadth: number,
  breadthThreshold: number,
  relevance: Record<string, JevAnswer> | undefined,
  asked: Record<string, JevQuestion> | undefined,
): SuggestedSkill[] {
  const fallback = decision.skill ? [{ skill: decision.skill, probability: decision.probability }] : [];
  if (breadth < breadthThreshold || !relevance || !asked) return fallback;
  const keys = Object.keys(asked);
  if (!keys.length || keys.some(key => relevance[key]?.type !== "noul" || !Number.isFinite((relevance[key] as { noul?: number }).noul))) return fallback;
  const selected = candidates.filter(candidate => {
    const key = toOptionKey(candidate.name);
    return key in asked && relevance[key]?.type === "noul" && relevance[key].noul >= breadthThreshold;
  }).map(skill => ({ skill, probability: (relevance[toOptionKey(skill.name)] as { noul: number }).noul }));
  if (decision.skill && !selected.some(item => item.skill === decision.skill)) fallback.forEach(item => selected.push(item));
  return selected.sort((a, b) => b.probability - a.probability || a.skill.name.localeCompare(b.skill.name));
}

export type SkillChoiceReason =
  | "selected"
  | "none_needed"
  | "below_confidence"
  | "below_probability"
  | "below_margin"
  | "unusable";

export interface SkillRouterPolicy {
  minConfidence: number;
  minProbability: number;
  minMargin: number;
}

export interface SkillChoiceResult {
  skill: SkillCandidate | null;
  reason: SkillChoiceReason;
  winner: string;
  probability: number;
  runnerUp: string;
  margin: number;
  confidence: number;
}

function emptyDecision(reason: SkillChoiceReason, winner = "", probability = 0, confidence = 0): SkillChoiceResult {
  return { skill: null, reason, winner, probability, runnerUp: "", margin: 0, confidence };
}

/**
 * Gate order when a skill wins (all three must pass): confidence, then probability, then margin.
 * Margin is SATISFIED when `probabilities` is absent or has fewer than two entries.
 */
export function resolveSkillChoice(
  answer: JevAnswer | undefined,
  candidates: SkillCandidate[],
  policy: SkillRouterPolicy,
): SkillChoiceResult {
  if (!answer || answer.type !== "choice") {
    return emptyDecision("unusable");
  }
  const winner = answer.choice;
  const confidence = answer.confidence;
  const probabilities = answer.probabilities as Record<string, number> | undefined;
  const probability = probabilities === undefined ? answer.confidence : probabilities[winner];
  if (typeof probability !== "number" || !Number.isFinite(probability)) {
    return emptyDecision("unusable", winner, 0, typeof confidence === "number" ? confidence : 0);
  }

  const matches = candidates.filter(candidate => toOptionKey(candidate.name) === winner);
  if (matches.length > 1 || (winner === NONE_OPTION && matches.length > 0)) {
    return { skill: null, reason: "unusable", winner, probability, runnerUp: "", margin: 0, confidence };
  }
  if (winner === NONE_OPTION) {
    return { skill: null, reason: "none_needed", winner, probability, runnerUp: "", margin: 0, confidence };
  }
  if (matches.length !== 1) {
    return { skill: null, reason: "unusable", winner, probability, runnerUp: "", margin: 0, confidence };
  }

  let runnerUp = "";
  let margin = 0;
  let marginSatisfied = true;
  if (probabilities !== undefined) {
    // Privacy boundary: the classifier must only echo keys it was offered. An
    // unoffered key (a path, prompt fragment, or other leaked text) must never
    // reach telemetry as runnerUp, so a malformed distribution is unusable.
    const offered = new Set<string>([NONE_OPTION]);
    for (const candidate of candidates) offered.add(toOptionKey(candidate.name));
    for (const key of Object.keys(probabilities)) {
      if (!offered.has(key)) {
        return { skill: null, reason: "unusable", winner, probability, runnerUp: "", margin: 0, confidence };
      }
    }
    const entries = Object.entries(probabilities).filter(([, value]) => typeof value === "number" && Number.isFinite(value));
    if (entries.length >= 2) {
      let runner = Number.NEGATIVE_INFINITY;
      for (const [key, value] of entries) {
        if (key === winner) continue;
        if (value > runner) {
          runner = value;
          runnerUp = key;
        }
      }
      if (Number.isFinite(runner)) {
        margin = probability - runner;
        marginSatisfied = margin >= policy.minMargin;
      }
    }
  }

  if (confidence < policy.minConfidence) {
    return { skill: null, reason: "below_confidence", winner, probability, runnerUp, margin, confidence };
  }
  if (probability < policy.minProbability) {
    return { skill: null, reason: "below_probability", winner, probability, runnerUp, margin, confidence };
  }
  if (!marginSatisfied) {
    return { skill: null, reason: "below_margin", winner, probability, runnerUp, margin, confidence };
  }
  return { skill: matches[0]!, reason: "selected", winner, probability, runnerUp, margin, confidence };
}

export function formatSkillAdvisory(suggestions: SuggestedSkill[]): string {
  const names = suggestions.map(({ skill, probability }) => `${skill.name.replace(/[\r\n\t\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80)} (p=${probability.toFixed(2)})`);
  if (suggestions.length === 1) {
    return `Jev skill match: ${names[0]}. Candidate only — it does not narrow the request's scope. Load it with the read tool if this turn needs it.`;
  }
  const prefix = "Jev skill matches (this request appears to span multiple systems): ";
  const suffix = ". Consider all of them; the user's request defines scope, not this list.";
  let listed = "";
  let count = 0;
  for (const name of names) {
    const next = listed ? `${listed}, ${name}` : name;
    const remaining = names.length - count - 1;
    const marker = remaining ? `, +${remaining} more` : "";
    if (prefix.length + next.length + marker.length + suffix.length > 400) break;
    listed = next;
    count += 1;
  }
  return `${prefix}${listed}${count < names.length ? `, +${names.length - count} more` : ""}${suffix}`;
}

// Pure Hydra turn-signal helpers for Jev. No Pi imports, I/O, or network.
//
// Piggybacks on Jev's before_agent_start batch when Hydra routing is active
// (process.env.PI_HYDRA_TIER is "standard", "high", or "max") so Hydra receives
// task reasoning depth and domain in the same single HTTP round-trip as skill
// routing and guard advisories.

import type { JevAnswer, JevQuestion } from "./client.ts";

export const HYDRA_DEPTH_ID = "hydra_reasoning_depth";
export const HYDRA_DOMAIN_ID = "hydra_task_domain";

export type HydraTaskDomain = "coding" | "reasoning" | "fast_edit" | "research";

export interface HydraTurnSignal {
  /** Score on [1..4] from Jev's ordered levels (1=quick/trivial, 4=frontier reasoning). */
  reasoningDepth: number;
  depthConfidence: number;
  domain: HydraTaskDomain;
  domainConfidence: number;
}

export function isHydraActive(envValue = process.env.PI_HYDRA_TIER): boolean {
  return envValue === "standard" || envValue === "high" || envValue === "max";
}

export const MIN_HYDRA_PROMPT_CHARS = 6;
export const MAX_RECENT_ASSISTANT_CHARS = 1_500;

export function buildHydraQuestions(): Record<string, JevQuestion> {
  return {
    [HYDRA_DEPTH_ID]: {
      type: "score",
      instructions:
        "Rate the reasoning depth and technical difficulty required to satisfy the user's request (including any referenced plan in the prior assistant context).",
      criteria: [
        "Level 1 (Trivial/Mechanical): Pure status check, single-line typo or config tweak, git commit/push command, or simple direct question requiring no code investigation or multi-step edits.",
        "Level 2 (Standard Coding/Diagnosis): Investigating a bug symptom across files, implementing a feature or UI behavior, wiring an API/IPC handler, or updating tests.",
        "Level 3 (Complex Multi-File/Architecture): Cross-module implementation across multiple files/processes, state/IPC coordination, non-obvious debugging, or careful refactoring.",
        "Level 4 (Frontier Architecture/Invariants): Deep architectural design, subtle race/concurrency/security invariant analysis, or ambiguous high-stakes system trade-offs.",
      ],
    },
    [HYDRA_DOMAIN_ID]: {
      type: "choice",
      instructions:
        "Select the primary execution domain that best characterizes the user's request (accounting for any prior assistant context it approves or continues).",
      criteria: {
        coding: "Investigating bugs in code, writing, refactoring, or fixing application/extension code, UI components, IPC, tests, or scripts.",
        reasoning: "Deep debugging of subtle defects, code review, architectural planning, or trade-off analysis.",
        fast_edit: "Quick shell/git command execution, trivial one-line config/text tweak, or simple direct question with no code investigation.",
        research: "Exploring documentation, summarizing existing behavior, or gathering external information without editing code.",
      },
    },
  };
}

const VALID_DOMAINS = new Set<HydraTaskDomain>(["coding", "reasoning", "fast_edit", "research"]);

export function parseHydraSignal(
  answers: Record<string, JevAnswer | undefined>,
): HydraTurnSignal | undefined {
  const depthAns = answers[HYDRA_DEPTH_ID];
  const domainAns = answers[HYDRA_DOMAIN_ID];
  const rawDepth =
    depthAns?.type === "score" && Number.isFinite(depthAns.score)
      ? Math.max(1, Math.min(4, depthAns.score))
      : undefined;
  const domain =
    domainAns?.type === "choice" && VALID_DOMAINS.has(domainAns.choice as HydraTaskDomain)
      ? (domainAns.choice as HydraTaskDomain)
      : undefined;
  if (rawDepth === undefined && domain === undefined) return undefined;

  const effectiveDomain: HydraTaskDomain = domain ?? "coding";
  const depthConfidence =
    depthAns?.type === "score" && Number.isFinite(depthAns.confidence) ? depthAns.confidence : 0;
  const domainConfidence =
    domainAns?.type === "choice" && Number.isFinite(domainAns.confidence) ? domainAns.confidence : 0;

  let reasoningDepth = rawDepth ?? 2.2;
  // Coding and reasoning turns require real code investigation or multi-step edits:
  // never let an uncertain or symptom-phrased coding prompt collapse below Level 2 (2.0),
  // and floor low-confidence coding depth at 2.2 so it routes to a mid-tier coding model.
  if (effectiveDomain === "coding") {
    const floor = depthConfidence < 0.65 ? 2.2 : 2.0;
    reasoningDepth = Math.max(floor, reasoningDepth);
  } else if (effectiveDomain === "reasoning") {
    reasoningDepth = Math.max(2.8, reasoningDepth);
  }

  return {
    reasoningDepth,
    depthConfidence,
    domain: effectiveDomain,
    domainConfidence,
  };
}

/**
 * Extract bounded text from the most recent assistant message in the session branch
 * so short follow-up prompts ("implement both steps", "do option 2") carry the plan
 * or diagnosis they refer to when Jev classifies the turn.
 */
export function extractRecentAssistantContext(
  entries: readonly unknown[] | undefined,
  maxChars = MAX_RECENT_ASSISTANT_CHARS,
): string | undefined {
  if (!Array.isArray(entries) || entries.length === 0 || maxChars <= 0) return undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as {
      type?: unknown;
      message?: { role?: unknown; content?: unknown };
    } | undefined;
    if (!entry || entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    const textParts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string" && text.trim()) textParts.push(text.trim());
      }
    }
    if (textParts.length === 0) continue;
    const combined = textParts.join("\n\n").trim();
    if (!combined) continue;
    const sliced = combined.length > maxChars
      ? `…${combined.slice(combined.length - (maxChars - 1))}`
      : combined;
    return `Prior assistant context (the turn immediately preceding this user request):\n${sliced}`;
  }
  return undefined;
}

export function formatHydraAdvisory(
  signal: HydraTurnSignal,
  routed?: { model?: string; thinking?: string; score?: number; switchedModel?: boolean },
): string {
  const target = routed?.model
    ? `${routed.model}${routed.thinking ? ` (${routed.thinking})` : ""}`
    : routed?.thinking
      ? `thinking=${routed.thinking}`
      : undefined;
  const scorePart = typeof routed?.score === "number" && Number.isFinite(routed.score)
    ? `, score=${routed.score.toFixed(2)}`
    : "";
  return target
    ? `Jev Hydra route: ${target} [depth=${signal.reasoningDepth.toFixed(1)}, domain=${signal.domain}${scorePart}].`
    : `Jev Hydra signal: depth=${signal.reasoningDepth.toFixed(1)}, domain=${signal.domain}.`;
}

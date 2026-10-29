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

export function buildHydraQuestions(): Record<string, JevQuestion> {
  return {
    [HYDRA_DEPTH_ID]: {
      type: "score",
      instructions:
        "Rate the reasoning depth and technical difficulty required to satisfy the user's request.",
      criteria: [
        "Level 1 (Quick/Mechanical): Simple lookup, status check, single-line typo fix, formatting, or straightforward question.",
        "Level 2 (Standard Implementation): Routine single-file or localized feature implementation, test update, or clear bug fix.",
        "Level 3 (Complex Multi-File/Debugging): Cross-module implementation, non-obvious bug diagnosis, state synchronization, or careful refactoring.",
        "Level 4 (Frontier Architecture/Invariants): Deep architectural design, subtle race/concurrency/security invariant analysis, or ambiguous high-stakes system trade-offs.",
      ],
    },
    [HYDRA_DOMAIN_ID]: {
      type: "choice",
      instructions:
        "Select the primary execution domain that best characterizes the user's request.",
      criteria: {
        coding: "Writing, refactoring, or fixing application/extension code, tests, or scripts.",
        reasoning: "Deep debugging, code review, architectural planning, or trade-off analysis.",
        fast_edit: "Quick command execution, small config tweak, formatting, or simple direct answer.",
        research: "Exploring codebases, reading documentation, or gathering external information.",
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
  const reasoningDepth =
    depthAns?.type === "score" && Number.isFinite(depthAns.score)
      ? Math.max(1, Math.min(4, depthAns.score))
      : undefined;
  const domain =
    domainAns?.type === "choice" && VALID_DOMAINS.has(domainAns.choice as HydraTaskDomain)
      ? (domainAns.choice as HydraTaskDomain)
      : undefined;
  if (reasoningDepth === undefined && domain === undefined) return undefined;
  return {
    reasoningDepth: reasoningDepth ?? 2,
    depthConfidence: depthAns?.type === "score" && Number.isFinite(depthAns.confidence) ? depthAns.confidence : 0,
    domain: domain ?? "coding",
    domainConfidence: domainAns?.type === "choice" && Number.isFinite(domainAns.confidence) ? domainAns.confidence : 0,
  };
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

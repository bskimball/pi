// Pure Hydra turn-signal helpers for Jev. No Pi imports, I/O, or network.
//
// Piggybacks on Jev's before_agent_start batch when Hydra routing is active
// (process.env.PI_HYDRA_TIER is "standard", "high", or "max") so Hydra receives
// task reasoning depth and domain in the same single HTTP round-trip as skill
// routing and guard advisories.

import type { JevAnswer, JevQuestion } from "./client.ts";

export const HYDRA_DEPTH_ID = "hydra_reasoning_depth";
export const HYDRA_DOMAIN_ID = "hydra_task_domain";

export type HydraTaskDomain = "coding" | "design" | "reasoning" | "fast_edit" | "research" | "writing" | "conversation";

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
        "Rate the reasoning depth and technical difficulty required to satisfy the user's request (including any referenced plan or bug context in the prior assistant turn).",
      criteria: [
        "Level 1 (Quick/Single Lookup): Greeting, git commit/push, single-line text/config tweak, or a one-step factual lookup (e.g. 'where is X stored?').",
        "Level 2 (Standard Implementation or Multi-Step Investigation): Implementing or updating a localized feature/test, or investigating a ticket, contract, or codebase behavior across multiple reads/commands.",
        "Level 3 (Complex Multi-File Coding or Cross-System Diagnosis): Multi-file feature implementation across processes/IPC/UI, diagnosing why an integration or workflow failed end-to-end, or probing external API/schema constraints to design a change.",
        "Level 4 (Frontier Architecture or Subtle Invariants): Deep architectural design, subtle concurrency/race/security invariant analysis, or ambiguous high-stakes system trade-offs.",
      ],
    },
    [HYDRA_DOMAIN_ID]: {
      type: "choice",
      instructions:
        "Select the primary execution domain that best characterizes the user's request (accounting for any prior assistant context it approves or continues).",
      criteria: {
        coding: "Writing, refactoring, or fixing backend, CLI, data, IPC, state, build/config, tests, scripts, or non-visual application logic.",
        design: "Building, styling, redesigning, or polishing UI components, frontend layouts, pages, CSS, animations, visual hierarchy, design systems, diagrams, or data visualizations in code.",
        reasoning: "Diagnosing why something failed, was rejected, or behaved unexpectedly (system, integration, tool, or workflow), deep debugging, code review, architectural planning, or trade-off analysis.",
        fast_edit: "Quick shell/git command execution, trivial one-line config/text tweak, or single-step factual lookup.",
        research: "Multi-step lookup or verification across external systems, tickets, contracts, documentation, or codebase files without editing code or diagnosing a failure.",
        writing: "Creative or prose work: drafting docs, emails, posts, copy, or stories; brainstorming, naming, or non-code ideation.",
        conversation: "Discussion, explanation, advice, or planning conversation with the user that needs no code edits or multi-step tool investigation.",
      },
    },
  };
}

const VALID_DOMAINS = new Set<HydraTaskDomain>(["coding", "design", "reasoning", "fast_edit", "research", "writing", "conversation"]);

export function parseHydraSignal(
  answers: Record<string, JevAnswer | undefined>,
): HydraTurnSignal | undefined {
  const depthAns = answers[HYDRA_DEPTH_ID];
  const domainAns = answers[HYDRA_DOMAIN_ID];
  // Jev's Score primitive returns a 0-based index on [0 .. criteria.length - 1] ([0..3] for 4 levels).
  // Convert [0..3] -> [1..4] so Level 1 = 1.0, Level 2 = 2.0, Level 3 = 3.0, Level 4 = 4.0.
  const rawDepth =
    depthAns?.type === "score" && Number.isFinite(depthAns.score)
      ? Math.max(1, Math.min(4, depthAns.score + 1))
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
  // and floor low-confidence coding/research prompts at 2.2 so they route to a capable model.
  if (effectiveDomain === "coding") {
    const floor = depthConfidence < 0.65 ? 2.2 : 2.0;
    reasoningDepth = Math.max(floor, reasoningDepth);
  } else if (effectiveDomain === "design") {
    const floor = depthConfidence < 0.65 ? 2.6 : 2.4;
    reasoningDepth = Math.max(floor, reasoningDepth);
  } else if (effectiveDomain === "reasoning") {
    reasoningDepth = Math.max(2.85, reasoningDepth);
  } else if (effectiveDomain === "research" && domainConfidence < 0.55) {
    reasoningDepth = Math.max(2.2, reasoningDepth);
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

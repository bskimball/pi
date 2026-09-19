import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { evaluateJev } from "./internal/client.ts";
import type { JevAnswer, JevQuestion } from "./internal/client.ts";
import {
  buildJudgeQuestions,
  collectFindings,
  formatJudgeAdvisory,
  isJudgeableFile,
  truncateForJudging,
} from "./internal/code-judge.ts";
import { loadFeatureConfig } from "./internal/feature-config.ts";
import {
  noteWait,
  pollAdvisory,
  readWaitObservation,
  readWaitResult,
  reportStatusAdvisory,
} from "./internal/lifecycle.ts";
import {
  buildRoutingQuestions,
  collectGuardFindings,
  formatRoutingAdvisory,
} from "./internal/routing-advisory.ts";
import {
  buildSkillQuestion,
  formatSkillAdvisory,
  resolveSkillChoice,
  type SkillCandidate,
} from "./internal/skill-router.ts";

const MAX_CONTENT_CHARS = 30_000;
/** Caps classifier latency added to the task_wait result path (evaluateJev's own cap is 30s). */
const CLASSIFIER_DEADLINE_MS = 2_500;
/** Choice needs at least one real skill beside none_needed, and client.ts caps options at 32. */
const MAX_ROUTED_SKILLS = 31;
/** Below this, a prompt carries too little signal to classify; skips the call entirely. */
const MIN_PROMPT_CHARS = 24;
/** Bounds the prompt text sent to Jev. Well under the client's 64,000-char request cap. */
const MAX_PROMPT_CHARS = 8_000;

/**
 * Run one advisory evaluation under its own deadline, chained to the turn's signal.
 * Returns null on any failure: advisory features never interrupt a turn.
 */
async function evaluateAdvisory(
  state: string,
  questions: Record<string, JevQuestion>,
  deadlineMs: number,
  parent: AbortSignal | undefined,
  modelRegistry: Parameters<typeof evaluateJev>[2],
): Promise<Record<string, JevAnswer> | null> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), deadlineMs);
  try {
    const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal;
    const response = await evaluateJev({ state, questions }, signal, modelRegistry);
    return response.answers;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const CriterionSchema = Type.Union([
  Type.String(),
  Type.Record(Type.String(), Type.Unknown()),
  Type.Array(Type.Unknown()),
]);

const QuestionsSchema = Type.Record(
  Type.String(),
  Type.Union([
    Type.Object({
      type: Type.Literal("choice"),
      instructions: Type.String({ minLength: 1 }),
      criteria: Type.Record(Type.String(), CriterionSchema),
    }),
    Type.Object({
      type: Type.Literal("score"),
      instructions: Type.String({ minLength: 1 }),
      criteria: Type.Array(CriterionSchema, { minItems: 2, maxItems: 10 }),
    }),
    Type.Object({
      type: Type.Literal("noul"),
      instructions: Type.String({ minLength: 1 }),
      criteria: Type.Optional(Type.Object({
        true: Type.Optional(Type.String()),
        false: Type.Optional(Type.String()),
      })),
    }),
  ]),
  { minProperties: 1, maxProperties: 16 },
);

type OutAnswer = Record<string, unknown>;

function stripProbabilities(answers: OutAnswer): OutAnswer {
  const out: OutAnswer = Object.create(null);
  for (const [id, answer] of Object.entries(answers)) {
    if (answer && typeof answer === "object" && "probabilities" in (answer as Record<string, unknown>)) {
      const { probabilities: _dropped, ...rest } = answer as Record<string, unknown>;
      out[id] = rest;
    } else {
      out[id] = answer;
    }
  }
  return out;
}

function stripLegends(answers: OutAnswer): OutAnswer {
  const out: OutAnswer = Object.create(null);
  for (const [id, answer] of Object.entries(answers)) {
    if (answer && typeof answer === "object" && "legend" in (answer as Record<string, unknown>)) {
      const { legend: _dropped, ...rest } = answer as Record<string, unknown>;
      out[id] = rest;
    } else {
      out[id] = answer;
    }
  }
  return out;
}

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "jev",
    label: "Jev Decision",
    description: [
      "Classify text against explicit criteria and return calibrated probabilities, using Choice (pick one option), Score (rank on a labeled scale), or Noul (probability a statement holds).",
      "Use when a judgment must be consistent, thresholded, or applied the same way across many items: routing, ranking, triage, extraction, relevance, and verifying whether output actually satisfies a stated requirement.",
      "Use it instead of writing a throwaway LLM prompt-and-parse step, and instead of eyeballing a repeated judgment call.",
      "Batch independent questions over the same state in one call; they are evaluated together and cost one round trip.",
      "Not for generation, summarization, code edits, search, or anything needing fresh facts — it only judges the state you pass in.",
      "Advisory only: it dispatches nothing. Low confidence, or a noul near 0.5, means gather evidence or escalate, not act automatically.",
    ].join(" "),
    promptSnippet:
      "Judge text against explicit criteria with calibrated probabilities (Choice/Score/Noul) for routing, ranking, triage, extraction, and verification.",
    promptGuidelines: [
      "Reach for jev when a decision repeats, needs a threshold, or should stay consistent across items: routing to a handler, ranking candidates, triaging input, extracting a labeled field, or verifying that output meets a stated requirement. Prefer it over an ad-hoc LLM prompt-and-parse step for the same judgment.",
      "Write criteria a stranger could apply without extra context, and batch independent questions over one state into a single call rather than issuing several.",
      "Prefer Noul for yes/no judgments; it discriminates far better than Score, whose confidence is often too flat to threshold on. Use Choice when exactly one option must win.",
      "Treat the result as evidence, not a verdict: act on clear signal, and on low confidence or a noul near 0.5 gather more evidence or ask, rather than proceeding automatically.",
    ],
    parameters: Type.Object({
      state: Type.String({ minLength: 1 }),
      questions: QuestionsSchema,
      includeProbabilities: Type.Optional(Type.Boolean()),
    }),
    executionMode: "parallel",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const includeProbabilities = params?.includeProbabilities === true;
      const response = await evaluateJev(
        { state: params?.state, questions: params?.questions },
        signal,
        ctx.modelRegistry,
      );
      let answersOut: OutAnswer = Object.create(null);
      for (const [id, answer] of Object.entries(response.answers)) {
        if (answer.type === "choice") {
          answersOut[id] = includeProbabilities
            ? answer
            : { type: answer.type, choice: answer.choice, confidence: answer.confidence };
        } else if (answer.type === "score") {
          answersOut[id] = includeProbabilities
            ? answer
            : { type: answer.type, score: answer.score, confidence: answer.confidence, legend: answer.legend };
        } else {
          answersOut[id] = answer;
        }
      }
      const notices: string[] = [];
      let probabilitiesOmitted = false;
      let legendsOmitted = false;
      const render = (answers: OutAnswer): string => JSON.stringify({
        model: response.model,
        answers,
        usage: response.usage,
        ...(probabilitiesOmitted ? { probabilitiesOmitted: true } : {}),
        ...(legendsOmitted ? { legendsOmitted: true } : {}),
        ...(notices.length ? { notice: notices.join(" ") } : {}),
      });
      let text = render(answersOut);
      if (text.length > MAX_CONTENT_CHARS && includeProbabilities) {
        answersOut = stripProbabilities(answersOut);
        probabilitiesOmitted = true;
        notices.push("Probability distributions omitted to fit the 30,000-character tool-output bound; full answers remain in details.");
        text = render(answersOut);
      }
      if (text.length > MAX_CONTENT_CHARS) {
        answersOut = stripLegends(answersOut);
        legendsOmitted = true;
        notices.push("Score legends omitted to fit the 30,000-character tool-output bound; full answers remain in details.");
        text = render(answersOut);
      }
      if (text.length > MAX_CONTENT_CHARS) {
        throw new Error(`Jev response exceeds the ${MAX_CONTENT_CHARS}-character output bound even without distributions or legends. Request fewer questions; no result was truncated.`);
      }
      return {
        content: [{ type: "text" as const, text }],
        details: { model: response.model, answers: response.answers, usage: response.usage },
      };
    },
  });

  // Skill routing and the routing advisory share one call: Jev evaluates every
  // question in a request in parallel, so the second feature is near-free once
  // the first has paid the round trip.
  pi.on("before_agent_start", async (event, ctx) => {
    const config = loadFeatureConfig();
    if (!config.skillRouter.enabled && !config.routingAdvisory.enabled) return undefined;

    const prompt = event.prompt?.trim() ?? "";
    if (prompt.length < MIN_PROMPT_CHARS) return undefined;
    const state = prompt.length > MAX_PROMPT_CHARS ? prompt.slice(0, MAX_PROMPT_CHARS) : prompt;

    // Skills that opt out of model invocation are never auto-suggested.
    const candidates: SkillCandidate[] = (event.systemPromptOptions?.skills ?? [])
      .filter((skill) => !skill.disableModelInvocation && skill.name && skill.description)
      .map((skill) => ({ name: skill.name, description: skill.description }))
      .slice(0, MAX_ROUTED_SKILLS);

    const questions: Record<string, JevQuestion> = Object.create(null);
    const routeSkills = config.skillRouter.enabled && candidates.length > 0;
    if (routeSkills) {
      try {
        questions.skill = buildSkillQuestion(candidates);
      } catch {
        // A malformed catalog disables routing for this turn, never the turn itself.
      }
    }
    if (config.routingAdvisory.enabled) Object.assign(questions, buildRoutingQuestions());
    if (Object.keys(questions).length === 0) return undefined;

    const deadlineMs = Math.max(config.skillRouter.deadlineMs, config.routingAdvisory.deadlineMs);
    const answers = await evaluateAdvisory(state, questions, deadlineMs, ctx.signal, ctx.modelRegistry);
    if (!answers) return undefined;

    const lines: string[] = [];
    if (questions.skill) {
      const decision = resolveSkillChoice(answers.skill, candidates, config.skillRouter.threshold);
      if (decision.reason === "selected" && decision.skill) {
        lines.push(formatSkillAdvisory(decision.skill, decision.probability));
      }
    }
    if (config.routingAdvisory.enabled) {
      const advisory = formatRoutingAdvisory(collectGuardFindings(answers, config.routingAdvisory.threshold));
      if (advisory) lines.push(advisory);
    }
    if (lines.length === 0) return undefined;

    return { systemPrompt: `${event.systemPrompt}\n\n${lines.join("\n")}` };
  });

  pi.on("tool_result", async (event, ctx) => {
    const config = loadFeatureConfig();
    if (
      config.codeJudge.enabled
      && !event.isError
      && (event.toolName === "edit" || event.toolName === "write")
    ) {
      const path = typeof event.input?.path === "string" ? event.input.path : "";
      if (path && isJudgeableFile(path)) {
        // write carries full content; edit carries only a unified patch in details.
        const patch = (event.details as { patch?: unknown } | undefined)?.patch;
        const source = typeof event.input?.content === "string"
          ? event.input.content
          : typeof patch === "string" ? patch : "";
        if (source.trim().length > 0) {
          const answers = await evaluateAdvisory(
            `file: ${path}\n\n${truncateForJudging(source, config.codeJudge.maxChars)}`,
            buildJudgeQuestions(),
            config.codeJudge.deadlineMs,
            ctx.signal,
            ctx.modelRegistry,
          );
          const hint = answers
            ? formatJudgeAdvisory(path, collectFindings(answers, config.codeJudge.threshold))
            : null;
          if (hint) {
            return {
              content: [
                ...(Array.isArray(event.content) ? event.content : []),
                { type: "text" as const, text: hint },
              ],
            };
          }
        }
      }
    }

    const observation = readWaitObservation(event.toolName, event.content, event.details);
    if (!observation) return undefined;

    const consecutive = noteWait(observation.workerId, observation.generation, observation.settled);
    const advisories: string[] = [];
    const pollNote = pollAdvisory(consecutive, observation.workerId);
    if (pollNote) advisories.push(pollNote);

    const audit = observation.settled
      ? readWaitResult(event.toolName, event.content, event.details)
      : null;
    if (audit) {
      const statusNote = reportStatusAdvisory(audit);
      if (statusNote) advisories.push(statusNote);

      const broken = audit.reportStatus === "missing" || audit.reportStatus === "invalid";
      if (!broken && audit.reportBody.trim().length >= 200 && audit.mission.trim().length > 0) {
        const report = audit.reportBody.length > 6000
          ? audit.reportBody.slice(audit.reportBody.length - 6000)
          : audit.reportBody;
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(), CLASSIFIER_DEADLINE_MS);
        try {
          const parent = ctx.signal;
          const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal;
          const response = await evaluateJev(
            {
              state: `mission:\n${audit.mission}\n\nreport:\n${report}`,
              questions: {
                concrete_outcome: {
                  type: "noul",
                  instructions: "Does this report state a concrete outcome or conclusion, rather than only describing what was attempted?",
                },
                matches_mission: {
                  type: "noul",
                  instructions: "Is this report about the stated mission topic?",
                },
              },
            },
            signal,
            ctx.modelRegistry,
          );
          const concrete = response.answers.concrete_outcome;
          if (concrete?.type === "noul" && concrete.noul < 0.3) {
            advisories.push(`Jev: report looks like attempt-description rather than a concrete outcome (noul=${concrete.noul}).`);
          }
          const matches = response.answers.matches_mission;
          if (matches?.type === "noul" && matches.noul < 0.3) {
            advisories.push(`Jev: report does not appear to address the stated mission (noul=${matches.noul}).`);
          }
        } catch {
          // Fail open: deterministic advisories still apply; never annotate the classifier failure.
        } finally {
          clearTimeout(timer);
        }
      }
    }

    if (advisories.length === 0) return undefined;
    return {
      content: [
        ...(Array.isArray(event.content) ? event.content : []),
        { type: "text" as const, text: advisories.join("\n") },
      ],
    };
  });
}

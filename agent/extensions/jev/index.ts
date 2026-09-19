import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { Type } from "typebox";
import { evaluateJev } from "./internal/client.ts";
import type { JevAnswer, JevQuestion } from "./internal/client.ts";
import { buildJudgeQuestions, collectFindings, formatJudgeAdvisory, isJudgeableFile, truncateForJudging } from "./internal/code-judge.ts";
import { loadFeatureConfig } from "./internal/feature-config.ts";
import { noteWait, pollAdvisory, readWaitObservation, readWaitResult, reportStatusAdvisory, resetLifecycleState } from "./internal/lifecycle.ts";
import { buildRoutingQuestions, collectGuardFindings, formatRoutingAdvisory } from "./internal/routing-advisory.ts";
import { buildSkillQuestion, formatSkillAdvisory, resolveSkillChoice, type SkillCandidate } from "./internal/skill-router.ts";
import { JEV_SUGGESTION_TYPE, registerSuggestionReceipt, type JevSuggestionDetails } from "./internal/suggestion-receipt.ts";
import { logTelemetry, nextEphemeralId, normalizeToolPath, workspaceIdForCwd, type EvaluationStatus } from "./internal/telemetry.ts";

const MAX_CONTENT_CHARS = 30_000;
/** Caps classifier latency added to the task_wait result path (evaluateJev's own cap is 30s). */
const CLASSIFIER_DEADLINE_MS = 2_500;
/** Choice needs at least one real skill beside none_needed, and client.ts caps options at 32. */
const MAX_ROUTED_SKILLS = 31;
/** Below this, a prompt carries too little signal to classify; skips the call entirely. */
const MIN_PROMPT_CHARS = 24;
/** Bounds the prompt text sent to Jev. Well under the client's 64,000-char request cap. */
const MAX_PROMPT_CHARS = 8_000;
/** Bounds the project-context slice sent with the prompt. Keeps per-turn input near current cost. */
const MAX_CONTEXT_CHARS = 1_500;

interface AdvisoryResult {
  status: "completed";
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
  elapsedMs: number;
  evaluationId: string;
}

interface AdvisoryFailure {
  status: Exclude<EvaluationStatus, "success" | "no-match" | "skipped">;
  elapsedMs: number;
  evaluationId: string;
}

type AdvisoryOutcome = AdvisoryResult | AdvisoryFailure;

/** Footer key for the ambient advisory status line. */
const STATUS_KEY = "jev";

/** AGENTS.md section that lists host workflows and the skill that owns each. */
const SKILLS_SECTION_MARKER = "### Skills";

interface AdvisoryMeter {
  calls: number;
  tokens: number;
}

/**
 * Slice the host project's workflow index (AGENTS.md `### Skills` section) so
 * Jev sees project context alongside the bare user prompt. The per-skill
 * catalog remains the Choice options; this is state, not a second vote. It
 * fails open: any misshape returns undefined and routing falls back to the
 * bare prompt exactly as before.
 */
export function extractWorkflowIndex(
  contextFiles: Array<{ path: string; content: string }> | undefined,
  cwd: string,
  maxChars = MAX_CONTEXT_CHARS,
): string | undefined {
  if (!contextFiles || contextFiles.length === 0 || maxChars <= 0) return undefined;
  // Deepest project file wins; the global agent-dir context carries no skills table.
  // No marker anywhere means the host declares no workflow index: stay on the
  // bare prompt rather than mislabeling unrelated context as one.
  const deepest = [...contextFiles]
    .filter((file) => typeof file.content === "string")
    .sort((a, b) => b.path.length - a.path.length)
    .find((file) => file.content.includes(SKILLS_SECTION_MARKER));
  if (!deepest) return undefined;
  const markerAt = deepest.content.indexOf(SKILLS_SECTION_MARKER);
  const section = deepest.content.slice(markerAt).trim();
  if (!section) return undefined;
  const label = deepest.path.replace(/\\/g, "/").split("/").at(-1) ?? deepest.path;
  const prefix = `Project workflow index (${label}, cwd ${cwd.replace(/\\/g, "/")}):\n`;
  const budget = Math.max(0, maxChars - prefix.length);
  if (budget <= 1) return undefined;
  // maxChars bounds the whole block: reserve one char so the ellipsis never overflows it.
  const body = section.length > budget ? `${section.slice(0, budget - 1).trimEnd()}\u2026` : section;
  return `${prefix}${body}`;
}

/** Record one automatic call and publish the running per-session total to the footer. */
function publishStatus(ctx: { ui?: { setStatus?: (key: string, text: string | undefined) => void } }, meter: AdvisoryMeter, result: AdvisoryResult, note: string): void {
  meter.calls += 1;
  meter.tokens += result.usage.input_tokens + result.usage.output_tokens;
  try {
    const label = meter.calls === 1 ? "call" : "calls";
    ctx.ui?.setStatus?.(STATUS_KEY, `jev ${note} · ${meter.calls} ${label}, ${meter.tokens.toLocaleString()} tok`);
  } catch {
    // The footer is cosmetic; never let it affect a turn.
  }
}

/**
 * Run one advisory evaluation under its own deadline, chained to the turn's signal.
 * Returns a metadata-only failure outcome: advisory features never interrupt a turn.
 */
async function evaluateAdvisory(
  state: string,
  questions: Record<string, JevQuestion>,
  deadlineMs: number,
  parent: AbortSignal | undefined,
  modelRegistry: Parameters<typeof evaluateJev>[2],
): Promise<AdvisoryOutcome> {
  const evaluationId = nextEphemeralId("eval");
  const startedAt = Date.now();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), deadlineMs);
  try {
    const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal;
    const response = await evaluateJev({ state, questions }, signal, modelRegistry);
    return {
      status: "completed",
      answers: response.answers,
      usage: response.usage,
      elapsedMs: Date.now() - startedAt,
      evaluationId,
    };
  } catch {
    const status = parent?.aborted ? "cancelled" : deadline.signal.aborted ? "timeout" : "error";
    return { status, elapsedMs: Date.now() - startedAt, evaluationId };
  } finally {
    clearTimeout(timer);
  }
}

const CriterionSchema = Type.Union([Type.String(), Type.Record(Type.String(), Type.Unknown()), Type.Array(Type.Unknown())]);

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
      criteria: Type.Optional(
        Type.Object({
          true: Type.Optional(Type.String()),
          false: Type.Optional(Type.String()),
        }),
      ),
    }),
  ]),
  { minProperties: 1, maxProperties: 16 },
);

type OutAnswer = Record<string, unknown>;

function turnSources(config: ReturnType<typeof loadFeatureConfig>): string[] {
  return [config.skillRouter.enabled ? "skill-router" : undefined, config.routingAdvisory.enabled ? "routing-advisory" : undefined].filter((source): source is string => !!source);
}

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
  registerSuggestionReceipt(pi);

  let sessionId = nextEphemeralId("session");
  let workspaceId = workspaceIdForCwd(process.cwd());
  let sessionEpoch = 0;
  const advisoryMeter: AdvisoryMeter = { calls: 0, tokens: 0 };
  const pendingSkills = new Map<string, string>();
  const pendingCode = new Map<string, { suggestionId: string; originatingToolCallId: string }>();

  const resetSessionState = (ctx?: { cwd?: string; ui?: { setStatus?: (key: string, text: string | undefined) => void } }) => {
    sessionId = nextEphemeralId("session");
    workspaceId = workspaceIdForCwd(ctx?.cwd ?? process.cwd());
    sessionEpoch += 1;
    pendingSkills.clear();
    pendingCode.clear();
    advisoryMeter.calls = 0;
    advisoryMeter.tokens = 0;
    resetLifecycleState();
    try {
      ctx?.ui?.setStatus?.(STATUS_KEY, undefined);
    } catch {}
  };

  pi.on("session_start", (_event, ctx) => resetSessionState(ctx));

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
    promptSnippet: "Judge text against explicit criteria with calibrated probabilities (Choice/Score/Noul) for routing, ranking, triage, extraction, and verification.",
    promptGuidelines: [
      "Reach for jev when a decision repeats, needs a threshold, or should stay consistent across items: routing to a handler, ranking candidates, triaging input, extracting a labeled field, or verifying that output meets a stated requirement. Prefer it over an ad-hoc LLM prompt-and-parse step for the same judgment.",
      "Write criteria a stranger could apply without extra context, and batch independent questions over one state into a single call rather than issuing several.",
      "Use Noul for yes/no judgments, Choice when exactly one option must win, and Score for ranking on an explicit labeled scale.",
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
      const response = await evaluateJev({ state: params?.state, questions: params?.questions }, signal, ctx.modelRegistry);
      let answersOut: OutAnswer = Object.create(null);
      for (const [id, answer] of Object.entries(response.answers)) {
        if (answer.type === "choice") {
          answersOut[id] = includeProbabilities
            ? answer
            : {
                type: answer.type,
                choice: answer.choice,
                confidence: answer.confidence,
              };
        } else if (answer.type === "score") {
          answersOut[id] = includeProbabilities
            ? answer
            : {
                type: answer.type,
                score: answer.score,
                confidence: answer.confidence,
                legend: answer.legend,
              };
        } else {
          answersOut[id] = answer;
        }
      }
      const notices: string[] = [];
      let probabilitiesOmitted = false;
      let legendsOmitted = false;
      const render = (answers: OutAnswer): string =>
        JSON.stringify({
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
        details: {
          model: response.model,
          answers: response.answers,
          usage: response.usage,
        },
      };
    },
  });

  // Skill routing and the routing advisory share one call: Jev evaluates every
  // question in a request in parallel, so the second feature is near-free once
  // the first has paid the round trip.
  pi.on("before_agent_start", async (event, ctx) => {
    workspaceId = workspaceIdForCwd(ctx.cwd);
    const config = loadFeatureConfig();
    if (!config.skillRouter.enabled && !config.routingAdvisory.enabled) return undefined;

    const prompt = event.prompt?.trim() ?? "";
    if (prompt.length < MIN_PROMPT_CHARS) {
      logTelemetry({
        event: "evaluation",
        sessionId,
        workspaceId,
        sources: turnSources(config),
        status: "skipped",
        skipReason: "short-prompt",
        thresholds: {
          skill: config.skillRouter.enabled ? config.skillRouter.threshold : undefined,
          risk: config.routingAdvisory.enabled ? config.routingAdvisory.threshold : undefined,
        },
      });
      return undefined;
    }
    const trimmed = prompt.length > MAX_PROMPT_CHARS ? prompt.slice(0, MAX_PROMPT_CHARS) : prompt;

    // Skills that opt out of model invocation are never auto-suggested.
    const candidates: SkillCandidate[] = (event.systemPromptOptions?.skills ?? [])
      .filter((skill) => !skill.disableModelInvocation && skill.name && skill.description && skill.filePath)
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
      }))
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
    if (Object.keys(questions).length === 0) {
      logTelemetry({
        event: "evaluation",
        sessionId,
        workspaceId,
        sources: turnSources(config),
        status: "skipped",
        skipReason: "no-questions",
        thresholds: {
          skill: config.skillRouter.enabled ? config.skillRouter.threshold : undefined,
          risk: config.routingAdvisory.enabled ? config.routingAdvisory.threshold : undefined,
        },
      });
      return undefined;
    }

    const sources = turnSources(config).filter((source) => source !== "skill-router" || !!questions.skill);
    const deadlineMs = Math.max(questions.skill ? config.skillRouter.deadlineMs : 0, config.routingAdvisory.enabled ? config.routingAdvisory.deadlineMs : 0);
    // Bare request plus the host workflow index: which project skills own which
    // workflows. Case 16:511 needed this ("missed work-wise" named none of
    // mail/calendar/Teams, but AGENTS.md maps those workflows to m365).
    // Appended only when a skill Choice is actually being asked, so the
    // routing-advisory-only path (bare prompt, guard Nouls) is untouched.
    const workflowIndex = questions.skill
      ? extractWorkflowIndex(event.systemPromptOptions?.contextFiles, ctx.cwd)
      : undefined;
    const state = workflowIndex
      ? `User request:\n${trimmed}\n\n${workflowIndex}`
      : trimmed;
    const epoch = sessionEpoch;
    const result = await evaluateAdvisory(state, questions, deadlineMs, ctx.signal, ctx.modelRegistry);
    if (epoch !== sessionEpoch) return undefined;
    if (result.status !== "completed") {
      logTelemetry({
        event: "evaluation",
        sessionId,
        workspaceId,
        evaluationId: result.evaluationId,
        sources,
        status: result.status,
        elapsedMs: result.elapsedMs,
        thresholds: {
          skill: questions.skill ? config.skillRouter.threshold : undefined,
          risk: config.routingAdvisory.enabled ? config.routingAdvisory.threshold : undefined,
        },
      });
      return undefined;
    }

    const lines: string[] = [];
    const notes: string[] = [];
    let selectedSkill: { name: string; probability: number } | undefined;
    let skillDecision: ReturnType<typeof resolveSkillChoice> | undefined;
    const receiptFindings: JevSuggestionDetails["findings"] = [];
    if (questions.skill) {
      const decision = resolveSkillChoice(result.answers.skill, candidates, config.skillRouter.threshold);
      skillDecision = decision;
      if (decision.reason === "selected" && decision.skill) {
        lines.push(formatSkillAdvisory(decision.skill, decision.probability));
        notes.push(`skill=${decision.skill.name}`);
        selectedSkill = {
          name: decision.skill.name,
          probability: decision.probability,
        };
      }
    }
    if (config.routingAdvisory.enabled) {
      const findings = collectGuardFindings(result.answers, config.routingAdvisory.threshold);
      const advisory = formatRoutingAdvisory(findings);
      if (advisory) {
        lines.push(advisory);
        notes.push(`${findings.length} guard${findings.length === 1 ? "" : "s"}`);
        receiptFindings.push(
          ...findings.map((finding) => ({
            id: finding.id,
            label: finding.label,
            probability: finding.probability,
          })),
        );
      }
    }
    const evaluationStatus = lines.length > 0 ? "success" : "no-match";
    logTelemetry({
      event: "evaluation",
      sessionId,
      workspaceId,
      evaluationId: result.evaluationId,
      sources,
      status: evaluationStatus,
      elapsedMs: result.elapsedMs,
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
      skill: selectedSkill?.name,
      probability: selectedSkill?.probability,
      findings: receiptFindings.map(({ id, probability }) => ({
        id,
        probability,
      })),
      skillDecision: skillDecision
        ? {
            reason: skillDecision.reason,
            winner: skillDecision.winner.slice(0, 80),
            probability: skillDecision.probability,
            threshold: config.skillRouter.threshold,
            candidateCount: candidates.length,
          }
        : undefined,
      thresholds: {
        skill: questions.skill ? config.skillRouter.threshold : undefined,
        risk: config.routingAdvisory.enabled ? config.routingAdvisory.threshold : undefined,
      },
      contextIncluded: questions.skill ? workflowIndex !== undefined : undefined,
    });
    publishStatus(ctx, advisoryMeter, result, notes.length > 0 ? notes.join(" · ") : "quiet");
    if (lines.length === 0) return undefined;

    const suggestionId = nextEphemeralId("suggestion");
    if (selectedSkill) {
      const candidate = candidates.find((skill) => skill.name === selectedSkill.name);
      if (candidate) {
        const skillPath = normalizeToolPath(candidate.filePath, ctx.cwd);
        // Latest suggestion wins per target, so one later read cannot double-credit stale prompts.
        pendingSkills.set(skillPath, suggestionId);
      }
    }
    logTelemetry({
      event: "suggestion",
      sessionId,
      workspaceId,
      evaluationId: result.evaluationId,
      suggestionId,
      sources,
      status: "success",
      skill: selectedSkill?.name,
      probability: selectedSkill?.probability,
      findings: receiptFindings.map(({ id, probability }) => ({
        id,
        probability,
      })),
    });
    const details: JevSuggestionDetails = {
      kind: "turn",
      skill: selectedSkill,
      findings: receiptFindings,
    };
    return {
      systemPrompt: event.systemPrompt,
      message: {
        customType: JEV_SUGGESTION_TYPE,
        content: [{ type: "text" as const, text: lines.join("\n") }],
        display: true,
        details,
      },
    };
  });

  pi.on("tool_result", async (event, ctx) => {
    workspaceId = workspaceIdForCwd(ctx.cwd);
    const eventEpoch = sessionEpoch;
    const rawPath = typeof event.input?.path === "string" ? event.input.path : "";
    const normalizedPath = rawPath ? normalizeToolPath(rawPath, ctx.cwd) : "";

    if (!event.isError && event.toolName === "read" && normalizedPath) {
      const suggestionId = pendingSkills.get(normalizedPath);
      if (suggestionId) {
        pendingSkills.delete(normalizedPath);
        logTelemetry({
          event: "read-after-suggestion",
          sessionId,
          workspaceId,
          suggestionId,
          toolCallId: event.toolCallId,
          proxy: "read-after-suggestion",
        });
      }
    }

    if (!event.isError && (event.toolName === "edit" || event.toolName === "write") && normalizedPath) {
      const finding = pendingCode.get(normalizedPath);
      if (finding && finding.originatingToolCallId !== event.toolCallId) {
        pendingCode.delete(normalizedPath);
        logTelemetry({
          event: "edit-after-finding",
          sessionId,
          workspaceId,
          suggestionId: finding.suggestionId,
          toolCallId: event.toolCallId,
          originatingToolCallId: finding.originatingToolCallId,
          proxy: "edit-after-finding",
        });
      }
    }

    const config = loadFeatureConfig();
    if (config.codeJudge.enabled && !event.isError && (event.toolName === "edit" || event.toolName === "write")) {
      const path = rawPath;
      if (path && isJudgeableFile(path)) {
        // write carries full content; edit carries only a unified patch in details.
        const patch = (event.details as { patch?: unknown } | undefined)?.patch;
        const source = typeof event.input?.content === "string" ? event.input.content : typeof patch === "string" ? patch : "";
        if (source.trim().length > 0) {
          const result = await evaluateAdvisory(
            `file: ${path}\n\n${truncateForJudging(source, config.codeJudge.maxChars)}`,
            buildJudgeQuestions(),
            config.codeJudge.deadlineMs,
            ctx.signal,
            ctx.modelRegistry,
          );
          if (eventEpoch !== sessionEpoch) return undefined;
          if (result.status !== "completed") {
            logTelemetry({
              event: "evaluation",
              sessionId,
              workspaceId,
              evaluationId: result.evaluationId,
              source: "code-judge",
              status: result.status,
              elapsedMs: result.elapsedMs,
              thresholds: { code: config.codeJudge.threshold },
              toolCallId: event.toolCallId,
            });
          } else {
            const findings = collectFindings(result.answers, config.codeJudge.threshold);
            const hint = formatJudgeAdvisory(path, findings);
            logTelemetry({
              event: "evaluation",
              sessionId,
              workspaceId,
              evaluationId: result.evaluationId,
              source: "code-judge",
              status: findings.length > 0 ? "success" : "no-match",
              elapsedMs: result.elapsedMs,
              inputTokens: result.usage.input_tokens,
              outputTokens: result.usage.output_tokens,
              findings: findings.map(({ id, probability }) => ({
                id,
                probability,
              })),
              thresholds: { code: config.codeJudge.threshold },
              toolCallId: event.toolCallId,
            });
            publishStatus(ctx, advisoryMeter, result, findings.length > 0 ? `judge ${findings.length} on ${basename(path)}` : "no findings");
            if (hint) {
              const suggestionId = nextEphemeralId("suggestion");
              const receiptFindings = findings.map(({ id, label, probability }) => ({ id, label, probability }));
              // Latest finding wins per file, preventing one later edit from crediting stale findings.
              pendingCode.set(normalizedPath, {
                suggestionId,
                originatingToolCallId: event.toolCallId,
              });
              logTelemetry({
                event: "suggestion",
                sessionId,
                workspaceId,
                evaluationId: result.evaluationId,
                suggestionId,
                source: "code-judge",
                status: "success",
                findings: findings.map(({ id, probability }) => ({
                  id,
                  probability,
                })),
                originatingToolCallId: event.toolCallId,
              });
              pi.appendEntry<JevSuggestionDetails>(JEV_SUGGESTION_TYPE, {
                kind: "code",
                file: basename(path)
                  .replace(/[\r\n\t]+/g, " ")
                  .slice(0, 100),
                findings: receiptFindings,
              });
              return {
                content: [...(Array.isArray(event.content) ? event.content : []), { type: "text" as const, text: hint }],
              };
            }
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

    const audit = observation.settled ? readWaitResult(event.toolName, event.content, event.details) : null;
    if (audit) {
      const statusNote = reportStatusAdvisory(audit);
      if (statusNote) advisories.push(statusNote);

      const broken = audit.reportStatus === "missing" || audit.reportStatus === "invalid";
      if (!broken && audit.reportBody.trim().length >= 200 && audit.mission.trim().length > 0) {
        const report = audit.reportBody.length > 6000 ? audit.reportBody.slice(audit.reportBody.length - 6000) : audit.reportBody;
        const outcome = await evaluateAdvisory(
          `mission:\n${audit.mission}\n\nreport:\n${report}`,
          {
            concrete_outcome: {
              type: "noul",
              instructions: "Does this report state a concrete outcome or conclusion, rather than only describing what was attempted?",
            },
            matches_mission: {
              type: "noul",
              instructions: "Is this report about the stated mission topic?",
            },
          },
          CLASSIFIER_DEADLINE_MS,
          ctx.signal,
          ctx.modelRegistry,
        );
        if (eventEpoch !== sessionEpoch) return undefined;
        if (outcome.status !== "completed") {
          logTelemetry({
            event: "evaluation",
            sessionId,
            workspaceId,
            evaluationId: outcome.evaluationId,
            source: "task-wait-audit",
            status: outcome.status,
            elapsedMs: outcome.elapsedMs,
            toolCallId: event.toolCallId,
          });
        } else {
          const concrete = outcome.answers.concrete_outcome;
          if (concrete?.type === "noul" && concrete.noul < 0.3) {
            advisories.push(`Jev: report looks like attempt-description rather than a concrete outcome (noul=${concrete.noul}).`);
          }
          const matches = outcome.answers.matches_mission;
          if (matches?.type === "noul" && matches.noul < 0.3) {
            advisories.push(`Jev: report does not appear to address the stated mission (noul=${matches.noul}).`);
          }
          logTelemetry({
            event: "evaluation",
            sessionId,
            workspaceId,
            evaluationId: outcome.evaluationId,
            source: "task-wait-audit",
            status: advisories.some((item) => item.startsWith("Jev:")) ? "success" : "no-match",
            elapsedMs: outcome.elapsedMs,
            inputTokens: outcome.usage.input_tokens,
            outputTokens: outcome.usage.output_tokens,
            toolCallId: event.toolCallId,
          });
          publishStatus(ctx, advisoryMeter, outcome, advisories.some((item) => item.startsWith("Jev:")) ? "report finding" : "no findings");
        }
      }
    }

    if (advisories.length === 0) return undefined;
    return {
      content: [...(Array.isArray(event.content) ? event.content : []), { type: "text" as const, text: advisories.join("\n") }],
    };
  });
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { evaluateJev } from "./internal/client.ts";
import {
  noteWait,
  pollAdvisory,
  readWaitObservation,
  readWaitResult,
  reportStatusAdvisory,
} from "./internal/lifecycle.ts";

const MAX_CONTENT_CHARS = 30_000;
/** Caps classifier latency added to the task_wait result path (evaluateJev's own cap is 30s). */
const CLASSIFIER_DEADLINE_MS = 2_500;

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
    description: "Evaluate bounded text decisions with Choice, Score, or Noul. Use one question for a one-off classifier or batch independent questions over the same state. Advisory only: no generation, tool execution, or worker dispatch. Low confidence or noul near 0.5 requires more evidence or escalation, not automatic action.",
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

  pi.on("tool_result", async (event, ctx) => {
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

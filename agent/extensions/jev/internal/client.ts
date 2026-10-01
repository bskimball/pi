import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const JEV_CONFIG_FILE_NAME = "jev.json";
export const JEV_ENV_VAR = "TYPESAFE_API_KEY";

/** Pi classifier catalog IDs used when jev.json names no model. */
const JEV_DEFAULT_MODEL = "jev-latest";
const JEV_CF_DEFAULT_MODEL = "typesafe/jev";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_SERIALIZED_CHARS = 64_000;
const MAX_QUESTIONS = 16;
const MAX_ID_CHARS = 80;
const MAX_MODEL_CHARS = 128;
const MAX_CHOICE_OPTIONS = 32;
const MAX_SCORE_LEVELS = 10;
const MIN_SCORE_LEVELS = 2;

type ModelRegistry = ExtensionContext["modelRegistry"];
type PiClassifierContext = Parameters<ModelRegistry["classify"]>[1];
type PiClassifierResult = Awaited<ReturnType<ModelRegistry["classify"]>>;

export type Criterion = string | Record<string, unknown> | unknown[];
export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, Criterion> }
  | { type: "score"; instructions: string; criteria: Criterion[] }
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } };
export interface JevRequest {
  state: string;
  questions: Record<string, JevQuestion>;
}
export type JevAnswer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; legend: unknown; probabilities: Record<string, number> }
  | { type: "noul"; noul: number };
export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function redact(value: string, ...keys: Array<string | undefined>): string {
  let result = String(value ?? "");
  for (const key of keys) {
    if (key) result = result.split(key).join("[REDACTED]");
  }
  return result;
}

function sanitizeDetail(value: string, key?: string): string {
  return redact(value, key).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 700);
}

/** Config root, mirroring the Exa algorithm: env dir, XDG, then home. */
export function getJevRoot(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim()
    || (process.env.XDG_CONFIG_HOME?.trim() ? join(process.env.XDG_CONFIG_HOME.trim(), "pi") : join(homedir(), ".pi"));
}

export function getJevConfigPath(): string {
  return join(getJevRoot(), JEV_CONFIG_FILE_NAME);
}

function expandEnv(value: string): string {
  const match = value.trim().match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/);
  if (!match) return value.trim();
  return process.env[match[1] || match[2] || ""]?.trim() || "";
}

function isCriterion(value: unknown): value is Criterion {
  return typeof value === "string" || isRecord(value) || Array.isArray(value);
}

/**
 * Resolved Jev target. Auth belongs to Pi now (stored credentials, env, or
 * models.json); `apiKey` here only forwards an explicit jev.json override,
 * which Pi honors per-field over its own resolution.
 */
interface JevTarget {
  provider: string;
  model: string;
  apiKey?: string;
}

/** Resolve provider + model + optional explicit key. Throws actionable, key-free errors. */
function resolveJevTarget(): JevTarget {
  const configPath = getJevConfigPath();
  let fileProvider: unknown;
  let fileApiKey: unknown;
  let fileModel: unknown;
  let filePresent = false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    filePresent = true;
    if (!isRecord(parsed)) throw new Error("expected a JSON object");
    fileProvider = parsed.provider;
    fileApiKey = parsed.apiKey;
    fileModel = parsed.model;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || filePresent) {
      // JSON parse errors can quote the secret-bearing input. Never forward them.
      throw new Error(`Jev config unreadable at ${configPath}. Expected a JSON object with optional provider, apiKey, and model; fix or remove the file.`);
    }
  }
  let provider = "typesafe";
  if (fileProvider !== undefined) {
    if (typeof fileProvider !== "string" || !fileProvider.trim() || fileProvider.trim().length > MAX_MODEL_CHARS) {
      throw new Error(`Jev config provider at ${configPath} must be a non-empty string of at most ${MAX_MODEL_CHARS} characters.`);
    }
    provider = fileProvider.trim();
  }
  if (fileApiKey !== undefined && typeof fileApiKey !== "string") {
    throw new Error(`Jev config apiKey at ${configPath} must be a string.`);
  }
  let model: string | undefined;
  if (fileModel !== undefined) {
    if (typeof fileModel !== "string" || !fileModel.trim() || fileModel.trim().length > MAX_MODEL_CHARS) {
      throw new Error(`Jev config model at ${configPath} must be a non-empty string of at most ${MAX_MODEL_CHARS} characters.`);
    }
    model = fileModel.trim();
  }
  model ??= provider === "cloudflare-workers-ai" ? JEV_CF_DEFAULT_MODEL : provider === "typesafe" ? JEV_DEFAULT_MODEL : undefined;
  if (!model) {
    throw new Error(`Jev config model at ${configPath} is required when provider is "${provider}". Pick a Pi classifier model (e.g. "typesafe/jev" on cloudflare-workers-ai).`);
  }
  // A non-empty TYPESAFE_API_KEY overrides file apiKey for the typesafe
  // provider, as before. Pi reads the same env itself; passing it explicitly
  // keeps file-vs-env precedence deterministic.
  const environment = provider === "typesafe" ? process.env[JEV_ENV_VAR]?.trim() : undefined;
  const fileKey = typeof fileApiKey === "string" ? expandEnv(fileApiKey) : "";
  const apiKey = environment || fileKey || undefined;
  return apiKey ? { provider, model, apiKey } : { provider, model };
}

function validateQuestion(id: string, question: JevQuestion): void {
  if (!isRecord(question)) throw new Error(`Jev question "${id}" must be an object.`);
  if (typeof question.instructions !== "string" || !question.instructions.trim()) {
    throw new Error(`Jev question "${id}" needs non-empty instructions.`);
  }
  if (question.type === "choice") {
    if (!isRecord(question.criteria)) throw new Error(`Jev Choice "${id}" needs a criteria map of 2-${MAX_CHOICE_OPTIONS} options.`);
    const options = Object.keys(question.criteria);
    if (options.length < 2 || options.length > MAX_CHOICE_OPTIONS) {
      throw new Error(`Jev Choice "${id}" needs 2-${MAX_CHOICE_OPTIONS} options, got ${options.length}.`);
    }
    for (const option of options) {
      if (!option.trim() || option.length > MAX_ID_CHARS) throw new Error(`Jev Choice "${id}" has an invalid option name (non-empty, at most ${MAX_ID_CHARS} chars).`);
      if (!isCriterion(question.criteria[option])) throw new Error(`Jev Choice "${id}" option "${option}" must be a string, object, or array description.`);
    }
    return;
  }
  if (question.type === "score") {
    if (!Array.isArray(question.criteria) || question.criteria.length < MIN_SCORE_LEVELS || question.criteria.length > MAX_SCORE_LEVELS) {
      throw new Error(`Jev Score "${id}" needs an ordered criteria array of ${MIN_SCORE_LEVELS}-${MAX_SCORE_LEVELS} levels.`);
    }
    for (const level of question.criteria) {
      if (!isCriterion(level)) throw new Error(`Jev Score "${id}" levels must be strings, objects, or arrays.`);
    }
    return;
  }
  if (question.type === "noul") {
    const criteria = question.criteria;
    if (criteria !== undefined) {
      if (!isRecord(criteria)) throw new Error(`Jev Noul "${id}" criteria must be an object with optional true/false strings.`);
      for (const side of ["true", "false"] as const) {
        if (criteria[side] !== undefined && typeof criteria[side] !== "string") {
          throw new Error(`Jev Noul "${id}" criteria.${side} must be a string.`);
        }
      }
    }
    return;
  }
  throw new Error(`Jev question "${id}" has unknown type "${(question as { type?: unknown }).type}"; expected choice, score, or noul.`);
}

/** Shared request validation; direct callers cannot bypass the boundary. */
export function validateJevRequest(request: JevRequest): void {
  if (!isRecord(request)) throw new Error("Jev request must be an object with state and questions.");
  if (typeof request.state !== "string" || !request.state.trim()) {
    throw new Error("Jev state must be a non-empty string.");
  }
  if (!isRecord(request.questions)) throw new Error("Jev questions must be a map of question ID to typed question.");
  const ids = Object.keys(request.questions);
  if (ids.length < 1 || ids.length > MAX_QUESTIONS) {
    throw new Error(`Jev needs 1-${MAX_QUESTIONS} questions, got ${ids.length}.`);
  }
  for (const id of ids) {
    if (!id.trim() || id.length > MAX_ID_CHARS) {
      throw new Error(`Jev question IDs must be non-empty and at most ${MAX_ID_CHARS} characters.`);
    }
    validateQuestion(id, request.questions[id] as JevQuestion);
  }
}

function finite01(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function saneTokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Locate the native answers object inside a captured raw response body.
 * Typesafe returns it directly (`{answers, usage, model}`); gateway-style
 * envelopes nest it under `result`, possibly inside a completed run record
 * (`{result: {state: "Completed", result: <native>}}`).
 */
function rawAnswers(body: unknown): Record<string, unknown> | undefined {
  if (isRecord(body) && isRecord(body.answers)) return body.answers as Record<string, unknown>;
  if (isRecord(body) && "result" in body) {
    const run = (body as Record<string, unknown>).result;
    if (isRecord(run) && isRecord(run.answers)) return run.answers as Record<string, unknown>;
    if (isRecord(run) && isRecord(run.result) && isRecord((run.result as Record<string, unknown>).answers)) {
      return (run.result as Record<string, unknown>).answers as Record<string, unknown>;
    }
  }
  return undefined;
}

function rawModel(body: unknown): string | undefined {
  if (isRecord(body) && typeof body.model === "string" && body.model.trim()) return body.model;
  return undefined;
}

/**
 * Validate Pi's parsed result against our request and recover the score
 * extras (probabilities, legend) Pi's typed answers drop, from the captured
 * raw body. Missing extras are malformed, never invented.
 */
function validateJevResponse(result: PiClassifierResult, rawBody: unknown, request: JevRequest): JevResponse {
  const raw = rawAnswers(rawBody);
  const model = rawModel(rawBody) ?? result.model;
  if (!model || model.length > MAX_MODEL_CHARS) {
    throw new Error("Jev response model was missing or invalid; treating as malformed.");
  }
  const usage = {
    input_tokens: saneTokens(result.usage?.input),
    output_tokens: saneTokens(result.usage?.output),
  };
  const answers: Record<string, JevAnswer> = Object.create(null);
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = (result.answers as Record<string, unknown>)[id];
    if (!isRecord(answer)) throw new Error(`Jev response is missing the answer for question "${id}"; treating as malformed.`);
    if (question.type === "choice") {
      if (answer.type !== "choice" || typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice)) {
        throw new Error(`Jev Choice "${id}" selected an unoffered option; treating as malformed.`);
      }
      if (!finite01(answer.confidence) || !isRecord(answer.probabilities)
        || !Object.values(answer.probabilities).every(finite01)) {
        throw new Error(`Jev Choice "${id}" has invalid confidence/probabilities; treating as malformed.`);
      }
      answers[id] = { type: "choice", choice: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities as Record<string, number> };
    } else if (question.type === "score") {
      const top = question.criteria.length - 1;
      if (answer.type !== "score" || typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > top) {
        throw new Error(`Jev Score "${id}" is outside [0, ${top}]; treating as malformed.`);
      }
      if (!finite01(answer.confidence)) {
        throw new Error(`Jev Score "${id}" has invalid confidence/probabilities/legend; treating as malformed.`);
      }
      const rawAnswer = raw?.[id];
      if (!isRecord(rawAnswer) || !isRecord(rawAnswer.probabilities)
        || !Object.values(rawAnswer.probabilities).every(finite01) || !Object.hasOwn(rawAnswer, "legend")) {
        throw new Error(`Jev Score "${id}" has invalid confidence/probabilities/legend; treating as malformed.`);
      }
      answers[id] = { type: "score", score: answer.score, confidence: answer.confidence, legend: rawAnswer.legend, probabilities: rawAnswer.probabilities as Record<string, number> };
    } else {
      // Our noul travels as Pi's bool and returns as {type: "bool", probability}.
      if (answer.type !== "bool" || typeof answer.probability !== "number" || !Number.isFinite(answer.probability) || answer.probability < 0 || answer.probability > 1) {
        throw new Error(`Jev Noul "${id}" is outside [0, 1]; treating as malformed.`);
      }
      answers[id] = { type: "noul", noul: answer.probability };
    }
  }
  return { model, answers, usage };
}

/**
 * One advisory Jev evaluation via Pi's built-in classifier runtime
 * (`modelRegistry.classify`). Pi owns transport and auth (stored credentials,
 * env, models.json); an explicit jev.json apiKey is forwarded per-field.
 * No retry: a retry may incur another charge (`maxRetries: 0`).
 * Throws bounded, redacted Errors; never logs secrets.
 */
export async function evaluateJev(
  request: JevRequest,
  signal?: AbortSignal,
  modelRegistry?: ModelRegistry,
): Promise<JevResponse> {
  if (signal?.aborted) throw new Error("Jev request aborted before dispatch; no request was sent.");
  validateJevRequest(request);
  const serialized = JSON.stringify({ state: request.state, questions: request.questions });
  if (serialized.length > MAX_SERIALIZED_CHARS) {
    throw new Error(`Jev request is ${serialized.length} chars (limit ${MAX_SERIALIZED_CHARS}). Narrow the state or split the questions; input is never truncated automatically.`);
  }
  const target = resolveJevTarget();
  if (signal?.aborted) throw new Error("Jev request aborted before dispatch; no request was sent.");
  if (!modelRegistry || typeof modelRegistry.getModelOfType !== "function" || typeof modelRegistry.classify !== "function") {
    throw new Error("Jev needs Pi's classifier runtime (modelRegistry.getModelOfType/classify), which is unavailable here. Run inside Pi 0.99+ with a configured classifier provider.");
  }
  const model = modelRegistry.getModelOfType("classifier", target.provider, target.model);
  if (!model) {
    throw new Error(`Jev classifier "${target.provider}/${target.model}" is not in Pi's model catalog. List available classifiers with models.getAvailableOfType("classifier") (codemode) or check the provider is configured; no fallback provider is attempted.`);
  }
  if (!target.apiKey && typeof modelRegistry.hasConfiguredAuth === "function" && !modelRegistry.hasConfiguredAuth(model as unknown as Parameters<ModelRegistry["hasConfiguredAuth"]>[0])) {
    throw new Error(`Jev classifier "${target.provider}/${target.model}" has no configured auth. For typesafe set ${JEV_ENV_VAR} or add {"apiKey": "..."} to ${getJevConfigPath()}; for other providers run /login or add models.json credentials (never paste the key in chat).`);
  }
  if (signal?.aborted) throw new Error("Jev request aborted before dispatch; no request was sent.");

  // Pi types state as a JSON object, but its transports forward state
  // opaquely and Jev natively accepts string state, so forward our string
  // unchanged to keep the wire payload identical. Rich criteria likewise pass
  // through, cast only to satisfy Pi's narrower string-only typings.
  const piQuestions: PiClassifierContext["questions"] = Object.create(null);
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type === "choice") {
      piQuestions[id] = { type: "choice", instructions: question.instructions, criteria: question.criteria as unknown as Record<string, string> };
    } else if (question.type === "score") {
      piQuestions[id] = { type: "score", instructions: question.instructions, criteria: question.criteria as unknown as string[] };
    } else {
      piQuestions[id] = {
        type: "bool",
        instructions: question.instructions,
        criteria: question.criteria as { true: string; false: string },
      };
    }
  }
  const context = {
    state: request.state as unknown as PiClassifierContext["state"],
    questions: piQuestions,
  };

  // Pi's typed answers drop score probabilities/legend, which our tool and
  // receipts display. Capture the raw JSON body via a wrapped fetch and
  // recover them from it. Single attempt only.
  let rawBody: unknown;
  const capturingFetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
    const response = await globalThis.fetch(input, init);
    try {
      rawBody = await response.clone().json();
    } catch {
      // Non-JSON or unreadable bodies surface as Pi errors or malformed
      // responses below; never throw from the capture path.
    }
    return response;
  }) as typeof globalThis.fetch;

  let result: PiClassifierResult;
  try {
    result = await modelRegistry.classify(model, context, {
      signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxRetries: 0,
      fetch: capturingFetch,
      ...(target.apiKey ? { apiKey: target.apiKey } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw new Error("Jev request aborted after dispatch; completion/billing is unknown.");
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Jev request failed: ${sanitizeDetail(message, target.apiKey)}`);
  }
  if (result.stopReason !== "stop") {
    if (signal?.aborted) throw new Error("Jev request aborted after dispatch; completion/billing is unknown.");
    if (result.errorMessage && /timed out/i.test(result.errorMessage)) {
      throw new Error("Jev request timed out after 30s; completion/billing is unknown.");
    }
    throw new Error(`Jev request failed: ${sanitizeDetail(result.errorMessage ?? result.stopReason, target.apiKey)}`);
  }
  try {
    return validateJevResponse(result, rawBody, request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(sanitizeDetail(message, target.apiKey));
  }
}

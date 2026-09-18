import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_DEFAULT_MODEL = "jev-1.13.0";
export const JEV_CF_MODEL = "typesafe/jev";
export const JEV_CONFIG_FILE_NAME = "jev.json";
export const JEV_ENV_VAR = "TYPESAFE_API_KEY";

export type JevProvider = "typesafe" | "cloudflare-workers-ai";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_SERIALIZED_CHARS = 64_000;
const MAX_ERROR_BODY_CHARS = 500;
const MAX_QUESTIONS = 16;
const MAX_ID_CHARS = 80;
const MAX_MODEL_CHARS = 128;
const MAX_CHOICE_OPTIONS = 32;
const MAX_SCORE_LEVELS = 10;
const MIN_SCORE_LEVELS = 2;

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

/** Resolved Jev configuration. `key` is present only for the Typesafe provider. */
interface JevResolvedConfig {
  provider: JevProvider;
  model: string;
  key?: string;
}

/** Resolve provider + model + key. Throws actionable, key-free errors. */
function resolveJevConfig(): JevResolvedConfig {
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
      throw new Error(`Jev config unreadable at ${configPath}. Expected a JSON object with optional provider, apiKey, and model; fix or remove the file before env-only usage via ${JEV_ENV_VAR}.`);
    }
  }
  let provider: JevProvider = "typesafe";
  if (fileProvider !== undefined) {
    if (fileProvider !== "typesafe" && fileProvider !== "cloudflare-workers-ai") {
      throw new Error(`Jev config provider at ${configPath} must be "typesafe" or "cloudflare-workers-ai".`);
    }
    provider = fileProvider;
  }
  if (fileApiKey !== undefined && typeof fileApiKey !== "string") {
    throw new Error(`Jev config apiKey at ${configPath} must be a string.`);
  }
  let model = provider === "cloudflare-workers-ai" ? JEV_CF_MODEL : JEV_DEFAULT_MODEL;
  if (fileModel !== undefined) {
    if (typeof fileModel !== "string" || !fileModel.trim() || fileModel.trim().length > MAX_MODEL_CHARS) {
      throw new Error(`Jev config model at ${configPath} must be a non-empty string of at most ${MAX_MODEL_CHARS} characters.`);
    }
    model = fileModel.trim();
  }
  if (provider === "cloudflare-workers-ai") {
    // Cloudflare auth resolves per call from Pi's configured Cloudflare
    // credential via the injected model registry; nothing secret is stored here.
    return { provider, model };
  }
  const environment = process.env[JEV_ENV_VAR]?.trim();
  if (environment) return { provider, model, key: environment };
  if (typeof fileApiKey !== "string") {
    throw new Error(`Jev API key is required. Set ${JEV_ENV_VAR} or add {"apiKey": "..."} to ${configPath} (never paste the key in chat).`);
  }
  const key = expandEnv(fileApiKey);
  if (!key) {
    throw new Error(`Jev API key is required. Set ${JEV_ENV_VAR} or add {"apiKey": "..."} to ${configPath} (never paste the key in chat).`);
  }
  return { provider, model, key };
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

function validateJevResponse(body: unknown, request: JevRequest): JevResponse {
  if (!isRecord(body)) throw new Error("Jev response was not a JSON object; treating as malformed.");
  if (typeof body.model !== "string" || !body.model.trim() || body.model.length > MAX_MODEL_CHARS) {
    throw new Error("Jev response model was missing or invalid; treating as malformed.");
  }
  if (!isRecord(body.answers)) throw new Error("Jev response answers were missing; treating as malformed.");
  if (!isRecord(body.usage)) throw new Error("Jev response usage was missing; treating as malformed.");
  const inputTokens = body.usage.input_tokens;
  const outputTokens = body.usage.output_tokens;
  if (typeof inputTokens !== "number" || !Number.isFinite(inputTokens) || inputTokens < 0
    || typeof outputTokens !== "number" || !Number.isFinite(outputTokens) || outputTokens < 0) {
    throw new Error("Jev response usage counts were invalid; treating as malformed.");
  }
  const answers: Record<string, JevAnswer> = Object.create(null);
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = body.answers[id];
    if (!isRecord(answer)) throw new Error(`Jev response is missing the answer for question "${id}"; treating as malformed.`);
    if (answer.type !== question.type) {
      throw new Error(`Jev answer "${id}" came back as "${String(answer.type)}" for a "${question.type}" question; treating as malformed.`);
    }
    if (question.type === "choice") {
      if (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice)) {
        throw new Error(`Jev Choice "${id}" selected an unoffered option; treating as malformed.`);
      }
      if (!finite01(answer.confidence) || !isRecord(answer.probabilities)
        || !Object.values(answer.probabilities).every(finite01)) {
        throw new Error(`Jev Choice "${id}" has invalid confidence/probabilities; treating as malformed.`);
      }
      answers[id] = { type: "choice", choice: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities as Record<string, number> };
    } else if (question.type === "score") {
      const top = question.criteria.length - 1;
      if (typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > top) {
        throw new Error(`Jev Score "${id}" is outside [0, ${top}]; treating as malformed.`);
      }
      if (!finite01(answer.confidence) || !isRecord(answer.probabilities)
        || !Object.values(answer.probabilities).every(finite01) || !Object.hasOwn(answer, "legend")) {
        throw new Error(`Jev Score "${id}" has invalid confidence/probabilities/legend; treating as malformed.`);
      }
      answers[id] = { type: "score", score: answer.score, confidence: answer.confidence, legend: answer.legend, probabilities: answer.probabilities as Record<string, number> };
    } else {
      if (typeof answer.noul !== "number" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
        throw new Error(`Jev Noul "${id}" is outside [0, 1]; treating as malformed.`);
      }
      answers[id] = { type: "noul", noul: answer.noul };
    }
  }
  return { model: body.model, answers, usage: { input_tokens: inputTokens, output_tokens: outputTokens } };
}

/**
 * One advisory Jev evaluation. Typesafe posts {state, model, questions} to the
 * System One endpoint. Cloudflare posts {model, input: {state, questions}} to
 * the account's /ai/run route using the injected Pi model registry to resolve
 * the configured Cloudflare token + account ID transiently (no stored copy).
 * No retry: a retry may incur another charge. Throws bounded, redacted
 * Errors; never logs secrets.
 */
export async function evaluateJev(
  request: JevRequest,
  signal?: AbortSignal,
  modelRegistry?: ExtensionContext["modelRegistry"],
): Promise<JevResponse> {
  if (signal?.aborted) throw new Error("Jev request aborted before dispatch; no request was sent.");
  validateJevRequest(request);
  const serialized = JSON.stringify({ state: request.state, questions: request.questions });
  if (serialized.length > MAX_SERIALIZED_CHARS) {
    throw new Error(`Jev request is ${serialized.length} chars (limit ${MAX_SERIALIZED_CHARS}). Narrow the state or split the questions; input is never truncated automatically.`);
  }
  const resolved = resolveJevConfig();
  if (signal?.aborted) throw new Error("Jev request aborted before dispatch; no request was sent.");
  let url: string;
  let headers: Record<string, string>;
  let body: string;
  let redactKeys: Array<string | undefined>;
  if (resolved.provider === "cloudflare-workers-ai") {
    if (!modelRegistry) {
      throw new Error("Jev Cloudflare mode needs Pi's configured Cloudflare credential (model registry unavailable). Configure Cloudflare auth in Pi; no direct Typesafe fallback is attempted.");
    }
    const carrier = modelRegistry.getAvailable().find((m) => m.provider === "cloudflare-workers-ai")
      ?? modelRegistry.getAll().find((m) => m.provider === "cloudflare-workers-ai");
    if (!carrier) {
      throw new Error("Jev Cloudflare mode needs a configured cloudflare-workers-ai model in Pi; none is available. Configure Cloudflare auth; no direct Typesafe fallback is attempted.");
    }
    const cfAuth = await modelRegistry.getApiKeyAndHeaders(carrier).catch(() => undefined);
    if (!cfAuth?.ok) {
      throw new Error("Jev Cloudflare auth is unavailable; configure Cloudflare credentials in Pi. No direct Typesafe fallback is attempted.");
    }
    const accountId = cfAuth.env?.["CLOUDFLARE_ACCOUNT_ID"];
    if (!cfAuth.apiKey || !accountId) {
      throw new Error("Jev Cloudflare auth is missing the API token or account ID; configure Cloudflare auth in Pi (stored credential or CLOUDFLARE_API_KEY / CLOUDFLARE_ACCOUNT_ID). No direct Typesafe fallback is attempted.");
    }
    url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run`;
    headers = { "Authorization": `Bearer ${cfAuth.apiKey}`, "Content-Type": "application/json" };
    body = JSON.stringify({ model: resolved.model, input: { state: request.state, questions: request.questions } });
    redactKeys = [cfAuth.apiKey, accountId];
  } else {
    if (!resolved.key) {
      throw new Error(`Jev API key is required. Set ${JEV_ENV_VAR} or add {"apiKey": "..."} to ${getJevConfigPath()} (never paste the key in chat).`);
    }
    url = JEV_ENDPOINT;
    headers = { "Authorization": `Bearer ${resolved.key}`, "Content-Type": "application/json" };
    body = JSON.stringify({ state: request.state, model: resolved.model, questions: request.questions });
    redactKeys = [resolved.key];
  }
  if (signal?.aborted) throw new Error("Jev request aborted before dispatch; no request was sent.");
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  try {
    const response = await fetch(url, { method: "POST", headers, body, signal: requestSignal });
    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      const bodyText = redact(raw, ...redactKeys).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_ERROR_BODY_CHARS);
      const retryAfter = response.status === 429 ? response.headers.get("retry-after") : null;
      const retryNote = retryAfter
        ? ` Retry after ${redact(retryAfter, ...redactKeys).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 64)}; not retried automatically.`
        : "";
      throw new Error(`HTTP ${response.status}: ${bodyText}.${retryNote}`);
    }
    const envelope: unknown = await response.json().catch(() => undefined);
    if (resolved.provider === "cloudflare-workers-ai" && isRecord(envelope) && envelope.success === false) {
      throw new Error(`Cloudflare reported an unsuccessful evaluation: ${JSON.stringify(envelope.errors ?? [])}`);
    }
    // Workers AI may nest a completed gateway result inside its API envelope.
    // Typesafe returns the native Jev body directly.
    let candidate: unknown = envelope;
    if (resolved.provider === "cloudflare-workers-ai" && isRecord(envelope) && "result" in envelope) {
      candidate = (envelope as Record<string, unknown>).result;
    }
    if (resolved.provider === "cloudflare-workers-ai" && isRecord(candidate) && "state" in candidate && "result" in candidate) {
      if (candidate.state !== "Completed" || !isRecord(candidate.result)) {
        const stateText = typeof candidate.state === "string" ? candidate.state : "unknown";
        throw new Error(`Cloudflare Jev evaluation did not complete (state: ${stateText}); treating as failed with no retry.`);
      }
      candidate = candidate.result;
    }
    return validateJevResponse(candidate, request);
  } catch (error) {
    if (signal?.aborted) throw new Error("Jev request aborted after dispatch; completion/billing is unknown.");
    if (timeoutSignal.aborted) throw new Error("Jev request timed out after 30s; completion/billing is unknown.");
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Jev request failed: ${redact(message, ...redactKeys).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 700)}`);
  }
}

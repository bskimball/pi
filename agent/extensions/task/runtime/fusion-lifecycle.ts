// fusion-lifecycle: task-owned Fusion sidekick lifecycle.
//
// Owns the designated-worker sequences: configuration handshake, readiness
// and prompt-only reuse, prompt acceptance, parking, parent-session
// isolation, transcript lookup, and the lead/sidekick gates. Transport
// (process spawn, RPC framing) stays in async-task.ts, bound through the
// dependency surface below. Sequencing failures report in thrown errors.

import {
  isLiveLifecycle,
  splitQualifiedModel,
  type WorkerLifecycle,
} from "./worker-runtime.ts";
import { parseReportSchema, reportInstruction } from "./report-schema.ts";
import { missionFromPrompt } from "./mission-from-prompt.ts";
import type { ReportStatus } from "./report-schema.ts";

export const FUSION_EPHEMERAL_AGENTS = [
  "librarian",
  "stevedore",
  "oracle",
  "picasso",
] as const;

export type FusionEphemeralAgent = (typeof FUSION_EPHEMERAL_AGENTS)[number];

export function isFusionEphemeralAgent(name: string): boolean {
  return (FUSION_EPHEMERAL_AGENTS as readonly string[]).includes(name);
}

export interface FusionModelChoice {
  provider: string;
  modelId: string;
  thinking?: string;
}

export interface FusionPairConfig {
  lead: FusionModelChoice;
  sidekick: FusionModelChoice;
}

/** `provider/model` for the configured sidekick, if a pair is present. */
export function fusionModelId(
  pair: FusionPairConfig | undefined,
): string | undefined {
  if (!pair) return undefined;
  return `${pair.sidekick.provider}/${pair.sidekick.modelId}`;
}

/** Minimal structural worker view; the full Worker satisfies this. */
export interface FusionWorkerState {
  id: string;
  fusion?: boolean;
  closed: boolean;
  lifecycle: WorkerLifecycle;
  generation?: number;
  cwd?: string;
  model?: string;
  thinking?: string;
  initialPrompt?: string;
  mission?: string;
  fallbackReplaySafe?: boolean;
  reportSchema?: string;
  parsedReport?: Record<string, unknown> | null;
  reportStatus?: ReportStatus;
  reportError?: string;
  modelAttempts?: Array<string | undefined>;
  modelAttemptIndex?: number;
  fusionParentSessionId?: string;
  sessionFile?: string;
  client?: FusionTransport | undefined | null;
}

/** Minimal request surface; satisfied by RpcClient and test doubles. */
export interface FusionTransport {
  readonly isClosed: boolean;
  request(
    command: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{ success: boolean; error?: string }>;
}

export interface PersistedTranscript {
  parentSessionId: string;
  sessionFile: string;
  sessionId?: string;
  cwd: string;
}

export interface ReuseInputs {
  model?: string;
  context?: string;
  reportSchema?: string;
  /** Already resolved against the caller cwd; compared verbatim. */
  cwd?: string;
}

export type ReuseOutcome =
  | { kind: "none" }
  | { kind: "parked"; worker: FusionWorkerState }
  | { kind: "conflict"; reason: string }
  | { kind: "invalid"; reason: string }
  | { kind: "reused"; worker: FusionWorkerState }
  | { kind: "failed"; worker: FusionWorkerState; reason: string };

export type PromptOutcome =
  | { kind: "accepted"; worker: FusionWorkerState }
  | { kind: "failed"; worker: FusionWorkerState; reason: string };

/** Concrete owner callbacks bound by async-task.ts. */
export interface FusionLifecycleDeps<TWorker extends FusionWorkerState> {
  listWorkers(): Iterable<TWorker>;
  startGeneration(worker: TWorker): void;
  settleFailed(worker: TWorker, error: string): void;
  parkWorker(worker: TWorker, reason: string): void;
  abortAndPark(worker: TWorker, reason: string): Promise<void>;
  notify(worker: TWorker): void;
  pushError(worker: TWorker, message: string): void;
  /** Last-known session branch for transcript verification on rollback. */
  readBranch(): readonly unknown[];
}

/**
 * Handshake contract mirrored in prompt-commands/modes.ts switchMode (kept
 * structural; the two extensions never import each other). `acknowledged`
 * must be set synchronously because the bus swallows listener exceptions;
 * `rollback` restores the prior pair plus live worker identity.
 */
export interface FusionConfigureEvent {
  fusion?: FusionPairConfig;
  acknowledged?: boolean;
  error?: string;
  promise?: Promise<void>;
  rollback?: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const MODEL_TIMEOUT_MS = 30_000;

async function safeRequest(
  applier: FusionTransport,
  command: Record<string, unknown>,
): Promise<{ success: boolean; error?: string }> {
  try {
    return await applier.request(command, MODEL_TIMEOUT_MS);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface PriorSidekickIdentity {
  modelId?: string;
  thinking?: string;
}

/**
 * Sequential sidekick model update: set_model first, then set_thinking.
 * A thinking failure compensates by restoring the prior model and thinking;
 * transport throws count as rejections. Every outcome is reported in the
 * thrown error or the resolved identity — nothing fails silently.
 */
export async function applySidekickModel(
  applier: FusionTransport,
  next: FusionModelChoice,
  prior?: PriorSidekickIdentity,
): Promise<{ model: string; thinking?: string }> {
  const model = await safeRequest(applier, {
    type: "set_model",
    provider: next.provider,
    modelId: next.modelId,
  });
  if (!model.success) {
    throw new Error(
      `Fusion sidekick model update rejected: ${model.error ?? "unknown"}`,
    );
  }
  if (next.thinking) {
    const thinking = await safeRequest(applier, {
      type: "set_thinking_level",
      level: next.thinking,
    });
    if (!thinking.success) {
      const notes: string[] = [];
      const restore = splitQualifiedModel(prior?.modelId);
      if (restore) {
        const back = await safeRequest(applier, {
          type: "set_model",
          provider: restore.provider,
          modelId: restore.modelId,
        });
        notes.push(
          back.success
            ? "model restored"
            : `model restore also failed: ${back.error ?? "unknown"}`,
        );
        if (back.success && prior?.thinking) {
          const rethink = await safeRequest(applier, {
            type: "set_thinking_level",
            level: prior.thinking,
          });
          notes.push(
            rethink.success
              ? "thinking restored"
              : `thinking restore also failed: ${rethink.error ?? "unknown"}`,
          );
        }
      } else {
        notes.push(
          `prior model ${prior?.modelId ?? "unknown"} is not restorable`,
        );
      }
      throw new Error(
        `Fusion sidekick thinking update rejected (${thinking.error ?? "unknown"}); ${notes.join("; ")}`,
      );
    }
  }
  return { model: `${next.provider}/${next.modelId}`, thinking: next.thinking };
}

export class FusionLifecycle<TWorker extends FusionWorkerState> {
  private pair: FusionPairConfig | undefined;
  private readonly deps: FusionLifecycleDeps<TWorker>;

  constructor(
    deps: FusionLifecycleDeps<TWorker>,
    pair?: FusionPairConfig,
  ) {
    this.deps = deps;
    this.pair = pair;
  }

  get configured(): FusionPairConfig | undefined {
    return this.pair;
  }

  /** Sync the pair from pi:modes:changed (no handshake; configure owns that). */
  trackPair(pair: FusionPairConfig | undefined): void {
    this.pair = pair;
  }

  /** The primary (earliest-registered) non-closed Fusion sidekick, if any. */
  find(): TWorker | undefined {
    for (const worker of this.deps.listWorkers()) {
      if (worker.fusion && !worker.closed) return worker;
    }
    return undefined;
  }

  /** Every non-closed Fusion sidekick. Parallel sidekicks own disjoint paths. */
  findAll(): TWorker[] {
    const found: TWorker[] = [];
    for (const worker of this.deps.listWorkers()) {
      if (worker.fusion && !worker.closed) found.push(worker);
    }
    return found;
  }

  /** Whether `id` names a non-closed Fusion sidekick. */
  owns(id: string | undefined): boolean {
    if (!id) return false;
    return this.findAll().some((worker) => worker.id === id);
  }

  /** Sidekicks whose current generation is still live. */
  live(): TWorker[] {
    return this.findAll().filter((worker) => isLiveLifecycle(worker.lifecycle));
  }

  /**
   * Configuration handshake for pi:fusion:configure. Captures the prior
   * pair and live worker identity synchronously, acknowledges, then
   * applies the new sidekick model sequentially.
   */
  attachConfigure(event: FusionConfigureEvent): void {
    if (!event.fusion) {
      event.error = "Fusion pair configuration is required.";
      return;
    }
    const priorPair = this.pair ? structuredClone(this.pair) : undefined;
    // Snapshot every sidekick's identity: the apply fans out to all live
    // transports and rollback restores each one from its own snapshot.
    const targets = this.findAll().map((worker) => ({
      worker,
      priorModel: worker.model,
      priorThinking: worker.thinking,
      priorAttempts: worker.modelAttempts ? [...worker.modelAttempts] : undefined,
      priorAttemptIndex: worker.modelAttemptIndex,
      priorParentSessionId: worker.fusionParentSessionId,
      priorHadLive: !worker.closed && !!worker.client && !worker.client.isClosed,
    }));
    this.pair = event.fusion;
    event.acknowledged = true;
    event.rollback = async () => {
      this.pair = priorPair;
      const failures: string[] = [];
      for (const target of targets) {
        const current = target.worker;
        if (current.closed) continue;
        if (!current.client || current.client.isClosed) {
          this.deps.parkWorker(
            current,
            "Fusion reconfigure rolled back; transport lost, parking",
          );
          if (target.priorHadLive) {
            const kept = this.findTranscript(
              this.deps.readBranch(),
              target.priorParentSessionId,
            );
            if (!kept) {
              failures.push(
                `${current.id}: sidekick transport lost with no persisted transcript`,
              );
            }
          }
          continue;
        }
        if (!priorPair) continue;
        // Cached identity updates only after full success. It cannot prove
        // that a rejected or timed-out RPC left the remote model unchanged.
        const restore = splitQualifiedModel(target.priorModel);
        if (!restore) {
          failures.push(
            `${current.id}: cannot restore model ${target.priorModel ?? "unknown"}`,
          );
          continue;
        }
        try {
          const applied = await applySidekickModel(
            current.client,
            {
              provider: restore.provider,
              modelId: restore.modelId,
              thinking: target.priorThinking,
            },
            undefined,
          );
          current.model = applied.model;
          current.thinking = applied.thinking;
          if (target.priorAttempts) current.modelAttempts = target.priorAttempts;
          if (target.priorAttemptIndex !== undefined) {
            current.modelAttemptIndex = target.priorAttemptIndex;
          }
          this.deps.notify(current);
        } catch (error) {
          failures.push(
            `${current.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (failures.length) {
        throw new Error(`Fusion rollback incomplete: ${failures.join("; ")}`);
      }
    };
    const liveTargets = targets.filter(
      (target) => !!target.worker.client && !target.worker.client.isClosed,
    );
    if (!liveTargets.length) return;
    const sidekick = event.fusion.sidekick;
    // Sequential per worker; a failure on any sidekick fails the whole
    // configure so the caller's rollback restores every snapshot.
    event.promise = (async () => {
      for (const { worker } of liveTargets) {
        const client = worker.client!;
        const { model, thinking } = await applySidekickModel(
          client,
          sidekick,
          worker.model
            ? { modelId: worker.model, thinking: worker.thinking }
            : undefined,
        );
        worker.model = model;
        worker.thinking = thinking;
        worker.modelAttempts = [model];
        worker.modelAttemptIndex = 0;
        this.deps.notify(worker);
      }
    })().catch((error) => {
      event.error = error instanceof Error ? error.message : String(error);
      throw error;
    });
  }

  /**
   * task_start reuse: continue a settled sidekick's transcript when one is
   * idle, park dead transports for resume, or report `none` so the caller
   * spawns an additional parallel sidekick. Prompt-only apart from a
   * validated per-generation report contract.
   */
  async reuse(
    prompt: string,
    inputs: ReuseInputs,
    promptTimeoutMs: number,
  ): Promise<ReuseOutcome> {
    const all = this.findAll();
    if (!all.length) return { kind: "none" };
    if (inputs.model?.trim()) {
      return {
        kind: "conflict",
        reason:
          `Fusion sidekick reuse accepts only a prompt; the sidekick model is owned by /mode configure, ` +
          `not by a fresh worker. Run /mode configure to change it.`,
      };
    }
    if (inputs.context !== undefined && inputs.context !== "fresh") {
      return {
        kind: "conflict",
        reason:
          `Fusion sidekick reuse continues the designated transcript for this session; ` +
          `per-assignment context separation is not available. Split the work across prompts, ` +
          `or start a new parent session for a clean transcript.`,
      };
    }
    // Dead transports park for a later transcript resume; every remaining
    // sidekick either runs (leave it alone) or is idle (reusable).
    let parked: TWorker | undefined;
    for (const candidate of all) {
      if (!candidate.client || candidate.client.isClosed) {
        this.deps.parkWorker(
          candidate,
          "Fusion sidekick transport lost; parking for transcript resume",
        );
        parked ??= candidate;
      }
    }
    const idle = all.filter(
      (candidate) =>
        !candidate.closed &&
        !!candidate.client &&
        !candidate.client.isClosed &&
        !isLiveLifecycle(candidate.lifecycle) &&
        (inputs.cwd === undefined ||
          candidate.cwd === undefined ||
          inputs.cwd === candidate.cwd),
    );
    if (!idle.length) {
      // Every live sidekick is busy (or in another cwd): the caller spawns a
      // parallel sidekick, resuming a parked transcript when one exists.
      return parked ? { kind: "parked", worker: parked } : { kind: "none" };
    }
    const worker = idle[0];
    const client = worker.client!;
    const schema = inputs.reportSchema?.trim() || undefined;
    if (schema) {
      const parsed = parseReportSchema(schema);
      if (parsed.error) {
        return { kind: "invalid", reason: `Invalid reportSchema: ${parsed.error}` };
      }
      worker.reportSchema = schema;
      worker.parsedReport = null;
      worker.reportStatus = "missing";
      worker.reportError = undefined;
    }
    worker.initialPrompt = prompt;
    worker.mission = missionFromPrompt(prompt);
    worker.fallbackReplaySafe = false;
    this.deps.startGeneration(worker);
    // A new contract must reach the child as well as the settlement parser:
    // fresh spawns embed it in the initial system prompt, so reuse carries
    // the same instruction alongside the generation prompt.
    const outgoing = schema ? `${prompt}\n\n${reportInstruction(schema)}` : prompt;
    const accepted = await this.acceptPrompt(worker, client, outgoing, promptTimeoutMs);
    if (accepted.kind === "accepted") return { kind: "reused", worker };
    return accepted;
  }

  /**
   * Prompt acceptance shared by reuse and task_send prompt mode. Rejection
   * settles (known-safe); a transport throw holds the single-writer gate
   * via abort-and-park instead of releasing it.
   */
  async acceptPrompt(
    worker: TWorker,
    client: FusionTransport,
    message: string,
    promptTimeoutMs: number,
  ): Promise<PromptOutcome> {
    let response: { success: boolean; error?: string };
    try {
      response = await client.request(
        { type: "prompt", message },
        promptTimeoutMs,
      );
    } catch (error) {
      const transport = error instanceof Error ? error.message : String(error);
      this.deps.pushError(worker, transport);
      await this.deps.abortAndPark(
        worker,
        `Fusion prompt transport failed (${transport}); holding single-writer gate`,
      );
      return { kind: "failed", worker, reason: `prompt failed: ${transport}` };
    }
    if (!response.success) {
      const messageText = response.error ?? "prompt rejected";
      this.deps.pushError(worker, messageText);
      this.deps.settleFailed(worker, messageText);
      return { kind: "failed", worker, reason: `prompt rejected: ${messageText}` };
    }
    return { kind: "accepted", worker };
  }

  /** Park every settled/failed sidekick when leaving Fusion mode. */
  parkForModeLeave(): void {
    for (const worker of this.findAll()) {
      if (worker.lifecycle === "settled" || worker.lifecycle === "failed") {
        // Keep the transcript file; a later Fusion entry restores it explicitly.
        this.deps.parkWorker(worker, "fusion parked");
      }
    }
  }

  /** Park Fusion workers bound to a different parent session. */
  isolateSession(sessionId: string | undefined): void {
    for (const worker of this.deps.listWorkers()) {
      if (worker.fusion && worker.fusionParentSessionId !== sessionId) {
        this.deps.parkWorker(worker, "Fusion parent session changed");
      }
    }
  }

  /**
   * Latest persisted transcript for a parent session, skipping files still
   * attached to a non-closed sidekick so two workers never share one
   * transcript. Pure over entries.
   */
  findTranscript(
    entries: readonly unknown[],
    parentSessionId: string | undefined,
    excludeSessionFiles: ReadonlySet<string> = new Set(),
  ): PersistedTranscript | undefined {
    if (!parentSessionId) return undefined;
    let found: PersistedTranscript | undefined;
    for (const entry of entries) {
      if (!isRecord(entry) || entry.type !== "custom") continue;
      if (
        entry.customType !== "fusion-sidekick-session" ||
        !isRecord(entry.data)
      ) {
        continue;
      }
      const data = entry.data;
      if (data.parentSessionId !== parentSessionId) continue;
      if (typeof data.sessionFile !== "string") continue;
      if (excludeSessionFiles.has(data.sessionFile)) continue;
      found = {
        parentSessionId,
        sessionFile: data.sessionFile,
        sessionId:
          typeof data.sessionId === "string" ? data.sessionId : undefined,
        cwd: typeof data.cwd === "string" ? data.cwd : "",
      };
    }
    return found;
  }

  /** Sidekick-side gate. Returns the block reason, if any. */
  gateSidekick(toolName: string): string | undefined {
    if (
      toolName.startsWith("task") ||
      toolName === "todo_write" ||
      toolName === "intercom"
    ) {
      return "Fusion sidekick cannot dispatch agents, write the lead's plan, or coordinate peer sessions.";
    }
    return undefined;
  }

  /**
   * Lead-side gates while in Fusion mode. Returns the block reason, if any.
   * The lead retains full tools (edit, write, bash, powershell) to work in
   * parallel with the sidekick; parallelism is governed by brief-scoped path
   * ownership rather than runtime tool blocks.
   */
  gateLead(toolName: string, inputId: string | undefined): string | undefined {
    if (
      toolName === "task_chain" ||
      toolName === "task_rebind"
    ) {
      return "Fusion permits only its sidekicks.";
    }
    if (
      toolName.startsWith("task_") &&
      toolName !== "task_start" &&
      toolName !== "task_list"
    ) {
      if (!this.owns(inputId)) {
        return "Fusion task operations are scoped to its sidekicks.";
      }
    }
    return undefined;
  }
}

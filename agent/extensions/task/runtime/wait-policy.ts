export const WAIT_DEFAULT_TIMEOUT_SEC = 600;
export const WAIT_REWAIT_COOLDOWN_MS = 60_000;

/** Parent-side wait defaults. Distinct from the worker hard-kill `timeoutSec`. */
export const WAIT_TIMEOUT_BY_AGENT: Readonly<Record<string, number>> = {
  artisan: 900,
  inspector: 1200,
  machinist: 900,
  oracle: 1200,
  stevedore: 1200,
};

export function defaultWaitTimeoutSec(agent?: string): number {
  if (!agent) return WAIT_DEFAULT_TIMEOUT_SEC;
  return WAIT_TIMEOUT_BY_AGENT[agent.toLowerCase()] ?? WAIT_DEFAULT_TIMEOUT_SEC;
}

export function resolveWaitTimeoutSec(options: {
  explicitTimeoutSec?: number;
  agent?: string;
}): number {
  const explicit = options.explicitTimeoutSec;
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return Math.max(0, explicit);
  }
  return defaultWaitTimeoutSec(options.agent);
}

export type RewaitDecision =
  | { allow: true }
  | { allow: false; remainingSec: number; lastTimeoutSec: number };

/**
 * Immediate same-generation re-wait after a timeout is a poll loop.
 * A longer explicit timeoutSec is a deliberate reconnect and is allowed.
 */
export function evaluateRewait(options: {
  generation: number;
  lastWaitTimeoutAt?: number;
  lastWaitTimeoutSec?: number;
  lastWaitGeneration?: number;
  explicitTimeoutSec?: number;
  now?: number;
  cooldownMs?: number;
}): RewaitDecision {
  if (
    options.lastWaitTimeoutAt == null ||
    options.lastWaitGeneration !== options.generation
  ) {
    return { allow: true };
  }
  const cooldown = options.cooldownMs ?? WAIT_REWAIT_COOLDOWN_MS;
  const elapsed = (options.now ?? Date.now()) - options.lastWaitTimeoutAt;
  if (elapsed >= cooldown) return { allow: true };
  const lastTimeoutSec = options.lastWaitTimeoutSec ?? 0;
  const explicit = options.explicitTimeoutSec;
  if (
    typeof explicit === "number" &&
    Number.isFinite(explicit) &&
    explicit > lastTimeoutSec
  ) {
    return { allow: true };
  }
  return {
    allow: false,
    remainingSec: Math.max(1, Math.ceil((cooldown - elapsed) / 1000)),
    lastTimeoutSec,
  };
}

export function formatRewaitRejected(options: {
  id: string;
  remainingSec: number;
  lastTimeoutSec: number;
}): string {
  return [
    `${options.id} same-generation re-wait is blocked for ${options.remainingSec}s after a ${options.lastTimeoutSec}s timeout.`,
    "Worker was NOT killed and is still running.",
    "Do independent lead work, start another independent slice, or task_wait a different live worker.",
    "Pass a longer timeoutSec only after that work if you still need this generation.",
  ].join("\n");
}

export type WaitOutcome<T> = T | "timeout" | "interrupted";

/**
 * Wait for a generation snapshot without coupling cancellation of the caller
 * to cancellation of the worker. Worker termination is an explicit task_abort
 * operation; an interrupted parent turn only detaches this waiter.
 */
export function waitForSnapshot<T>(options: {
  signal?: AbortSignal;
  timeoutMs: number;
  register: (resolve: (snapshot: T) => void) => () => void;
}): Promise<WaitOutcome<T>> {
  return new Promise((resolve) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    let unregister = () => {};

    const finish = (value: WaitOutcome<T>) => {
      if (done) return;
      done = true;
      options.signal?.removeEventListener("abort", onSignalAbort);
      if (timer) clearTimeout(timer);
      unregister();
      resolve(value);
    };

    const onSignalAbort = () => finish("interrupted");
    if (options.signal?.aborted) {
      finish("interrupted");
      return;
    }
    options.signal?.addEventListener("abort", onSignalAbort);

    unregister = options.register((snapshot) => finish(snapshot));
    // Registration may discover an already-settled generation and resolve
    // synchronously. In that case finish() ran before unregister was assigned.
    if (done) {
      unregister();
      return;
    }

    if (options.timeoutMs > 0) {
      timer = setTimeout(() => finish("timeout"), options.timeoutMs);
      timer.unref?.();
    }
  });
}

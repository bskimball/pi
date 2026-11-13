// Mirrors background jobs to the Apex desktop app over a loopback capability
// bridge. Enabled only when APEX_BACKGROUND_JOBS_URL and
// APEX_BACKGROUND_JOBS_TOKEN are both set; otherwise createApexMirror returns
// undefined and callers do nothing.
//
// Transport: POST <url> with a bearer token and body
// {"method":"sync","params":{"events":[...]}}. Response {"ok":true,
// "result":{"stop":[ids]}} carries job ids the user asked to stop in Apex.
// Failures drop the batch silently; a 401 disables the mirror for the process.
//
// Keep this file free of TS-only syntax that Node's strip-types mode rejects
// (parameter properties, enums), so the smoke test can import it directly.

export type MirrorJobStatus = "completed" | "failed" | "killed";

export interface MirrorJob {
  id: string;
  title: string;
  command: string;
  cwd: string;
  pid?: number;
  persistent: boolean;
  startedAt: number;
}

export type MirrorEvent =
  | { type: "started"; job: MirrorJob; output?: string }
  | { type: "output"; id: string; data: string }
  | { type: "detached"; id: string }
  | {
      type: "settled";
      id: string;
      status: MirrorJobStatus;
      exitCode: number | null;
      signal: string | null;
    };

export interface ApexMirror {
  started(job: MirrorJob, output?: string): void;
  output(id: string, data: string): void;
  settled(
    id: string,
    status: MirrorJobStatus,
    exitCode: number | null,
    signal: string | null,
  ): void;
  /** Still-running jobs this process stopped following (session switch). */
  detached(ids: string[]): void;
  dispose(): void;
}

const BATCH_DELAY_MS = 100;
/** Minimum spacing between request starts; caps traffic at ~600 calls/min. */
const MIN_GAP_MS = 100;
const HEARTBEAT_MS = 1_000;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_EVENTS_PER_CALL = 200;
const MAX_BYTES_PER_CALL = 512 * 1024;
const MAX_PENDING_OUTPUT = 256 * 1024;
const OUTPUT_TRUNCATED_MARK = "\n[… output truncated …]\n";

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function eventBytes(event: MirrorEvent): number {
  switch (event.type) {
    case "started":
      return (
        byteLength(event.job.id) +
        byteLength(event.job.title) +
        byteLength(event.job.command) +
        byteLength(event.job.cwd) +
        (event.output ? byteLength(event.output) : 0)
      );
    case "output":
      return byteLength(event.data);
    case "detached":
    case "settled":
      return byteLength(event.id);
  }
}

/** Keeps the last `max` bytes of text, dropping any split leading character. */
function tailBytes(text: string, max: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return text;
  let start = bytes.length - max;
  // Skip UTF-8 continuation bytes so the tail begins on a character boundary.
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

function parseStopIds(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const record = body as { ok?: unknown; result?: { stop?: unknown } };
  const stop = record.result?.stop;
  if (record.ok !== true || !Array.isArray(stop)) return [];
  return stop.filter((id): id is string => typeof id === "string");
}

class LoopbackMirror implements ApexMirror {
  private readonly url: string;
  private readonly token: string;
  private readonly onStop: (ids: string[]) => void;
  private readonly running = new Set<string>();
  private queue: MirrorEvent[] = [];
  private inFlight: Promise<void> | undefined;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  /** Set by dispose() or a 401: no further scheduling or stop delivery. */
  private closed = false;

  constructor(url: string, token: string, onStop: (ids: string[]) => void) {
    this.url = url;
    this.token = token;
    this.onStop = onStop;
  }

  started(job: MirrorJob, output?: string): void {
    if (this.closed) return;
    this.running.add(job.id);
    this.enqueue({
      type: "started",
      job: {
        id: job.id,
        title: job.title,
        command: job.command,
        cwd: job.cwd,
        ...(job.pid === undefined ? {} : { pid: job.pid }),
        persistent: job.persistent,
        startedAt: job.startedAt,
      },
      ...(output ? { output } : {}),
    });
    this.ensureHeartbeat();
  }

  output(id: string, data: string): void {
    if (this.closed || !data) return;
    const last = this.queue[this.queue.length - 1];
    if (last?.type === "output" && last.id === id) last.data += data;
    else this.queue.push({ type: "output", id, data });
    this.capPendingOutput(id);
    this.arm(BATCH_DELAY_MS);
  }

  settled(
    id: string,
    status: MirrorJobStatus,
    exitCode: number | null,
    signal: string | null,
  ): void {
    if (this.closed) return;
    this.running.delete(id);
    this.enqueue({ type: "settled", id, status, exitCode, signal });
    if (this.running.size === 0) this.stopHeartbeat();
  }

  detached(ids: string[]): void {
    if (this.closed) return;
    for (const id of ids) {
      this.running.delete(id);
      this.enqueue({ type: "detached", id });
    }
    if (this.running.size === 0) this.stopHeartbeat();
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    // Best-effort final drain, fire-and-forget. Waits for any in-flight call so
    // requests stay serial; the host may exit before it completes.
    const pending = this.inFlight ?? Promise.resolve();
    void pending.then(() => this.drainRemaining()).catch(() => {});
  }

  private enqueue(event: MirrorEvent): void {
    this.queue.push(event);
    this.arm(BATCH_DELAY_MS);
  }

  /** Coalesced pending output for one id is bounded to the last 256 KB. */
  private capPendingOutput(id: string): void {
    let bytes = 0;
    for (const event of this.queue) {
      if (event.type === "output" && event.id === id) bytes += byteLength(event.data);
    }
    if (bytes <= MAX_PENDING_OUTPUT) return;

    let combined = "";
    let firstIndex = -1;
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const event = this.queue[index];
      if (event.type !== "output" || event.id !== id) continue;
      combined = event.data + combined;
      firstIndex = index;
      this.queue.splice(index, 1);
    }
    // Reinsert at the first output position; settled/started ordering holds.
    this.queue.splice(firstIndex, 0, {
      type: "output",
      id,
      data: OUTPUT_TRUNCATED_MARK + tailBytes(combined, MAX_PENDING_OUTPUT),
    });
  }

  private arm(delay: number): void {
    if (this.closed || this.inFlight || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, delay);
    this.flushTimer.unref?.();
  }

  private ensureHeartbeat(): void {
    if (this.closed || this.heartbeat) return;
    this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private clearTimers(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.stopHeartbeat();
  }

  /** Empty sync so Apex can deliver stop requests while jobs run. */
  private beat(): void {
    if (this.closed || this.inFlight || this.flushTimer || this.queue.length) return;
    if (Date.now() - this.lastSentAt < HEARTBEAT_MS - 100) return;
    void this.flush();
  }

  private takeBatch(): MirrorEvent[] {
    const batch: MirrorEvent[] = [];
    let bytes = 0;
    while (this.queue.length && batch.length < MAX_EVENTS_PER_CALL) {
      const next = eventBytes(this.queue[0]);
      if (batch.length && bytes + next > MAX_BYTES_PER_CALL) break;
      bytes += next;
      batch.push(this.queue.shift()!);
    }
    return batch;
  }

  private flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const events = this.takeBatch();
    const sending = this.send(events).finally(() => {
      if (this.inFlight === sending) this.inFlight = undefined;
      if (this.closed || !this.queue.length) return;
      // Leftover events from a busy period: keep the MIN_GAP_MS request spacing.
      this.arm(Math.max(0, MIN_GAP_MS - (Date.now() - this.lastSentAt)));
    });
    this.inFlight = sending;
    return sending;
  }

  /** One POST. Never throws; a failed batch is dropped. */
  private async send(events: MirrorEvent[]): Promise<void> {
    this.lastSentAt = Date.now();
    let stop: string[] = [];
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ method: "sync", params: { events } }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 401) {
        this.disableAfterUnauthorized();
        return;
      }
      const text = await response.text();
      if (response.status === 200) stop = parseStopIds(JSON.parse(text));
    } catch {
      // Network or parse failure: drop this batch silently.
    }
    if (!this.closed && stop.length) {
      try {
        this.onStop(stop);
      } catch {
        // A stop handler must never break the mirror loop.
      }
    }
  }

  private disableAfterUnauthorized(): void {
    this.closed = true;
    this.queue = [];
    this.running.clear();
    this.clearTimers();
  }

  private async drainRemaining(): Promise<void> {
    // Sequential batches; a 401 clears the queue, which ends the loop.
    while (this.queue.length) {
      await this.send(this.takeBatch());
    }
  }
}

/**
 * Returns a mirror when both env vars are present, otherwise undefined.
 * `onStop` receives job ids Apex asked to stop; it runs outside any tool call.
 */
export function createApexMirror(
  onStop: (ids: string[]) => void,
  env: NodeJS.ProcessEnv = process.env,
): ApexMirror | undefined {
  const url = env.APEX_BACKGROUND_JOBS_URL?.trim();
  const token = env.APEX_BACKGROUND_JOBS_TOKEN?.trim();
  if (!url || !token) return undefined;
  return new LoopbackMirror(url, token, onStop);
}

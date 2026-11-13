import type { ApexMirror } from "./apex-mirror.ts";
import type { JobState } from "./job-state.ts";
import { OutputLogTail } from "./persistent-store.ts";

/** Output replayed to Apex when a running persistent job is first seen. */
const OUTPUT_REPLAY_BYTES = 64 * 1024;

/**
 * Follows persistent jobs (owned by detached runners) for the Apex mirror:
 * announces each running job once with a replay of its output.log, forwards
 * new output on every refresh, re-announces when the runner records the pid,
 * and reports settlement. Jobs already settled on first sight are not mirrored.
 */
export class PersistentMirror {
  private readonly tracked = new Map<string, { tail: OutputLogTail; pidAnnounced: boolean }>();

  private readonly mirror: ApexMirror;

  constructor(mirror: ApexMirror) {
    this.mirror = mirror;
  }

  sync(job: JobState, directory: string): void {
    const resets = job.outputLogResets ?? 0;
    const entry = this.tracked.get(job.id);
    if (!entry) {
      if (job.status !== "running") return;
      const tail = new OutputLogTail(directory);
      this.tracked.set(job.id, { tail, pidAnnounced: job.pid !== undefined });
      this.mirror.started(job, tail.start(OUTPUT_REPLAY_BYTES, resets));
      return;
    }
    if (job.status === "running") {
      if (!entry.pidAnnounced && job.pid !== undefined) {
        entry.pidAnnounced = true;
        this.mirror.started(job);
      }
      this.mirror.output(job.id, entry.tail.read(resets));
      return;
    }
    this.tracked.delete(job.id);
    this.mirror.output(job.id, entry.tail.finish(resets));
    this.mirror.settled(job.id, job.status, job.exitCode, job.signal);
  }

  /** Stop following every job (session switch); Apex marks them detached. */
  detachAll(): void {
    if (!this.tracked.size) return;
    this.mirror.detached([...this.tracked.keys()]);
    this.tracked.clear();
  }

  clear(): void {
    this.tracked.clear();
  }
}

// activity-ledger: shared tool-activity bookkeeping for Tasks and Workers.
//
// Pure state machine. Call sites supply tool names/summaries from JSON-line or
// RPC events; idle/kill policy lives elsewhere in each owning task runtime.

export type ActivityStatus = "running" | "completed" | "error";

export interface Activity {
  id: string;
  tool: string;
  summary: string;
  status: ActivityStatus;
  startedAt: number;
  duration?: number;
}

export interface ActivityLedgerOptions {
  /** Max retained activities (oldest dropped). Default 40. */
  maxActivities?: number;
}

function closeActivity(
  activity: Activity | undefined,
  status: ActivityStatus = "completed",
): void {
  if (!activity || activity.status !== "running") return;
  activity.status = status;
  activity.duration = Date.now() - activity.startedAt;
}

/**
 * Tracks overlapping tool calls: identified calls by toolCallId, anonymous
 * calls as a LIFO stack so an anonymous end never closes an identified start.
 */
export class ActivityLedger {
  readonly activities: Activity[] = [];
  private readonly runningById = new Map<string, Activity>();
  private readonly runningAnonymous: Activity[] = [];
  private anonymousSeq = 0;
  private readonly maxActivities: number;

  constructor(options: ActivityLedgerOptions = {}) {
    this.maxActivities = Math.max(1, options.maxActivities ?? 40);
  }

  hasActiveTools(): boolean {
    return this.runningById.size > 0 || this.runningAnonymous.length > 0;
  }

  get runningCount(): number {
    return this.runningById.size + this.runningAnonymous.length;
  }

  /** Snapshot for TaskDetails / WorkerView (shallow copy of each row). */
  snapshot(): Activity[] {
    return this.activities.map((activity) => ({ ...activity }));
  }

  /** Running activities only (live tools). */
  running(): Activity[] {
    return [
      ...this.runningById.values(),
      ...this.runningAnonymous,
    ].filter((activity) => activity.status === "running");
  }

  start(tool: string, summary: string, toolCallId?: string): Activity {
    const activity: Activity = {
      id: toolCallId ?? `anon#${this.anonymousSeq++}`,
      tool,
      summary,
      status: "running",
      startedAt: Date.now(),
    };
    if (toolCallId) {
      // A repeated id means the previous one will never get its own end event.
      closeActivity(this.runningById.get(toolCallId));
      this.runningById.set(toolCallId, activity);
    } else {
      this.runningAnonymous.push(activity);
    }
    this.activities.push(activity);
    if (this.activities.length > this.maxActivities) {
      this.activities.splice(0, this.activities.length - this.maxActivities);
    }
    return activity;
  }

  end(toolCallId: string | undefined, isError = false): Activity | undefined {
    let activity: Activity | undefined;
    if (toolCallId == null) {
      activity = this.runningAnonymous.pop();
    } else {
      activity = this.runningById.get(toolCallId);
      this.runningById.delete(toolCallId);
    }
    closeActivity(activity, isError ? "error" : "completed");
    return activity;
  }

  closeAll(status: ActivityStatus = "completed"): void {
    for (const activity of this.runningById.values()) {
      closeActivity(activity, status);
    }
    for (const activity of this.runningAnonymous) {
      closeActivity(activity, status);
    }
    this.runningById.clear();
    this.runningAnonymous.length = 0;
  }

  /** Readonly views for worker-runtime predicates that only need sizes. */
  asActivityState(): {
    runningById: ReadonlyMap<string, unknown>;
    runningAnonymous: readonly unknown[];
  } {
    return {
      runningById: this.runningById,
      runningAnonymous: this.runningAnonymous,
    };
  }
}

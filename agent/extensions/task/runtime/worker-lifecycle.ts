import { assign, initialTransition, setup, transition, type SnapshotFrom } from "xstate";

export type WorkerLifecycle = "starting" | "running" | "retrying" | "compacting" | "settled" | "aborting" | "failed" | "closed";
export type WorkerLifecycleEvent = { type: "START" | "AGENT_START" | "RETRY" | "RETRY_END" | "COMPACT" | "COMPACT_END" | "SETTLE" | "FAIL" | "ABORT" | "CLOSE" | "EXIT" | "DISPOSE_FAILED" | "RELEASE" };

// Generation settlement does not release a persistent RPC process or its slot.
// EXIT and CLOSE own process lifetime independently of generation completion.
export const workerLifecycleMachine = setup({
  types: { context: {} as { process: "alive" | "exited" | "closed" }, events: {} as WorkerLifecycleEvent },
  guards: { alive: ({ context }) => context.process === "alive", notClosed: ({ context }) => context.process !== "closed" },
  actions: {
    exited: assign({ process: "exited" }),
    closed: assign({ process: "closed" }),
  },
}).createMachine({
  id: "worker", initial: "starting", context: { process: "alive" },
  on: {
    RELEASE: { actions: "exited", guard: "alive" },
    CLOSE: { target: ".closed", actions: "closed", guard: "notClosed" },
    DISPOSE_FAILED: { target: ".failed", actions: "closed", guard: "notClosed" },
  },
  states: {
    starting: { on: { START: { target: "running", guard: "alive" }, AGENT_START: { target: "running", guard: "alive" }, RETRY: { target: "retrying", guard: "alive" }, COMPACT: { target: "compacting", guard: "alive" }, SETTLE: "settled", FAIL: "failed", ABORT: { target: "aborting", guard: "alive" }, EXIT: { target: "failed", actions: "exited", guard: "notClosed" } } },
    running: { on: { START: { target: "running", reenter: true, guard: "alive" }, RETRY: { target: "retrying", guard: "alive" }, COMPACT: { target: "compacting", guard: "alive" }, SETTLE: "settled", FAIL: "failed", ABORT: { target: "aborting", guard: "alive" }, EXIT: { target: "failed", actions: "exited", guard: "notClosed" } } },
    retrying: { on: { START: { target: "running", guard: "alive" }, AGENT_START: { target: "running", guard: "alive" }, RETRY_END: { target: "running", guard: "alive" }, COMPACT: { target: "compacting", guard: "alive" }, SETTLE: "settled", FAIL: "failed", ABORT: { target: "aborting", guard: "alive" }, EXIT: { target: "failed", actions: "exited", guard: "notClosed" } } },
    compacting: { on: { START: { target: "running", guard: "alive" }, AGENT_START: { target: "running", guard: "alive" }, COMPACT_END: { target: "running", guard: "alive" }, RETRY: { target: "retrying", guard: "alive" }, SETTLE: "settled", FAIL: "failed", ABORT: { target: "aborting", guard: "alive" }, EXIT: { target: "failed", actions: "exited", guard: "notClosed" } } },
    aborting: { on: { SETTLE: "settled", FAIL: "failed", EXIT: { target: "failed", actions: "exited", guard: "notClosed" } } },
    settled: { on: { START: { target: "running", guard: "alive" }, EXIT: { actions: "exited", guard: "notClosed" } } },
    failed: { on: { START: { target: "running", guard: "alive" }, EXIT: { actions: "exited", guard: "notClosed" } } },
    closed: {},
  },
});
export type WorkerLifecycleSnapshot = SnapshotFrom<typeof workerLifecycleMachine>;
export function initialWorkerLifecycle(lifecycle: WorkerLifecycle, process: "alive" | "exited" | "closed"): WorkerLifecycleSnapshot {
  const [initial] = initialTransition(workerLifecycleMachine);
  return workerLifecycleMachine.resolveState({ value: lifecycle, context: { ...initial.context, process } });
}
export function advanceWorkerLifecycle(snapshot: WorkerLifecycleSnapshot, event: WorkerLifecycleEvent): WorkerLifecycleSnapshot {
  return transition(workerLifecycleMachine, snapshot, event)[0];
}

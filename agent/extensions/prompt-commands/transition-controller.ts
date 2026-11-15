import { assign, initialTransition, setup, transition } from "xstate";

type Operation = "switching" | "restoring" | "routing" | "presentation";
type Event =
  | { type: "BEGIN"; operation: Operation; token: number }
  | { type: "END"; token: number }
  | { type: "MODEL_BLOCK"; reason: string | false }
  | { type: "RECOVERY_BLOCK"; reason: string | false }
  | { type: "PIN"; value: boolean }
  | { type: "LEAD"; key: string | undefined };

const machine = setup({
  types: {
    context: {} as { token: number; modelBlock: string | false; recoveryBlock: string | false; pinned: boolean; failedLead: string | undefined },
    events: {} as Event,
  },
  guards: {
    current: ({ context, event }) => event.type === "END" && context.token === event.token,
    modelBlocked: ({ event }) => event.type === "MODEL_BLOCK" && !!event.reason,
    recoveryBlocked: ({ event }) => event.type === "RECOVERY_BLOCK" && !!event.reason,
    pin: ({ event }) => event.type === "PIN" && event.value,
    failed: ({ event }) => event.type === "LEAD" && !!event.key,
  },
  actions: {
    rememberToken: assign({ token: ({ context, event }) => event.type === "BEGIN" ? event.token : context.token }),
    modelBlock: assign({ modelBlock: ({ context, event }) => event.type === "MODEL_BLOCK" ? event.reason : context.modelBlock }),
    recoveryBlock: assign({ recoveryBlock: ({ context, event }) => event.type === "RECOVERY_BLOCK" ? event.reason : context.recoveryBlock }),
    pin: assign({ pinned: ({ context, event }) => event.type === "PIN" ? event.value : context.pinned }),
    lead: assign({ failedLead: ({ context, event }) => event.type === "LEAD" ? event.key : context.failedLead }),
  },
}).createMachine({
  id: "mode-transition",
  type: "parallel",
  context: { token: 0, modelBlock: false, recoveryBlock: false, pinned: false, failedLead: undefined },
  states: {
    operation: {
      initial: "ready",
      states: {
        ready: {
          on: {
            BEGIN: (["switching", "restoring", "routing", "presentation"] as const).map(operation => ({
              guard: ({ event }: { event: Event }) => event.type === "BEGIN" && event.operation === operation,
              target: operation,
              actions: "rememberToken" as const,
            })),
          },
        },
        switching: { on: { END: { guard: "current", target: "ready" } } },
        restoring: { on: { END: { guard: "current", target: "ready" } } },
        routing: { on: { END: { guard: "current", target: "ready" } } },
        presentation: { on: { END: { guard: "current", target: "ready" } } },
      },
    },
    model: {
      initial: "available",
      on: { MODEL_BLOCK: [
        { guard: "modelBlocked", target: ".blocked", actions: "modelBlock" },
        { target: ".available", actions: "modelBlock" },
      ] },
      states: { available: {}, blocked: {} },
    },
    recovery: {
      initial: "coherent",
      on: { RECOVERY_BLOCK: [
        { guard: "recoveryBlocked", target: ".blocked", actions: "recoveryBlock" },
        { target: ".coherent", actions: "recoveryBlock" },
      ] },
      states: { coherent: {}, blocked: {} },
    },
    selection: {
      initial: "automatic",
      on: { PIN: [
        { guard: "pin", target: ".pinned", actions: "pin" },
        { target: ".automatic", actions: "pin" },
      ] },
      states: { automatic: {}, pinned: {} },
    },
    lead: {
      initial: "healthy",
      on: { LEAD: [
        { guard: "failed", target: ".failed", actions: "lead" },
        { target: ".healthy", actions: "lead" },
      ] },
      states: { healthy: {}, failed: {} },
    },
  },
});

/** Pure transitions own admission and completion; side effects stay in their extension. */
export function createTransitionController() {
  let [snapshot] = initialTransition(machine);
  let sequence = 0;
  const waiters = new Set<() => void>();
  const send = (event: Event) => { [snapshot] = transition(machine, snapshot, event); };
  return {
    get busy() { return !snapshot.matches({ operation: "ready" }); },
    get phase() { return snapshot.value; },
    get modelBlocked() { return snapshot.matches({ model: "blocked" }) ? snapshot.context.modelBlock : false; },
    set modelBlocked(reason: string | false) { send({ type: "MODEL_BLOCK", reason }); },
    get recoveryBlocked() { return snapshot.matches({ recovery: "blocked" }) ? snapshot.context.recoveryBlock : false; },
    set recoveryBlocked(reason: string | false) { send({ type: "RECOVERY_BLOCK", reason }); },
    get manualPin() { return snapshot.matches({ selection: "pinned" }); },
    set manualPin(value: boolean) { send({ type: "PIN", value }); },
    get failedLead() { return snapshot.matches({ lead: "failed" }) ? snapshot.context.failedLead : undefined; },
    set failedLead(key: string | undefined) { send({ type: "LEAD", key }); },
    begin(operation: Operation): number | undefined {
      const token = ++sequence;
      send({ type: "BEGIN", operation, token });
      return snapshot.context.token === token ? token : undefined;
    },
    async acquire(operation: Operation): Promise<number> {
      while (!snapshot.matches({ operation: "ready" })) {
        await new Promise<void>(resolve => waiters.add(resolve));
      }
      const token = ++sequence;
      send({ type: "BEGIN", operation, token });
      return token;
    },
    end(token: number) {
      send({ type: "END", token });
      if (snapshot.matches({ operation: "ready" })) {
        for (const resolve of waiters) resolve();
        waiters.clear();
      }
    },
  };
}

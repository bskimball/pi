import { createMachine, initialTransition, transition } from "xstate";

/** A reminder belongs to one session; Pi mode defers consumption, not reset. */
export const reminderMachine = createMachine({
  types: {} as { events: { type: "compact" | "consume" | "reset" } },
  id: "memory-reminder",
  initial: "clear",
  on: { reset: { target: ".clear" } },
  states: {
    clear: { on: { compact: "pending" } },
    pending: { on: { consume: "clear" } },
  },
});

export function createReminderState() {
  let [snapshot] = initialTransition(reminderMachine);
  return {
    get pending() { return snapshot.matches("pending"); },
    send(type: "compact" | "consume" | "reset") {
      [snapshot] = transition(reminderMachine, snapshot, { type });
    },
  };
}

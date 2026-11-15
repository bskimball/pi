import { assign, initialTransition, setup, transition } from "xstate";
import type { Input } from "@earendil-works/pi-tui";

type Context = {
  panelCollapsed: boolean;
  dockPane: "todos" | "agents";
  selectedAgent: number;
  peekItemId: string | undefined;
  generation: number;
  owner: number;
  peekInput: { mode: "steer" | "follow_up" | "prompt"; id: string; label: string; editor: Input } | undefined;
  peekConfirm: { action: "abort" | "close"; id: string } | undefined;
  peekStatus: string | undefined;
};
type Event =
  | { type: "DOCK"; style: "plain" | "styled" | "unmounted" }
  | { type: "SELECT"; patch: Partial<Pick<Context, "panelCollapsed" | "dockPane" | "selectedAgent">> }
  | { type: "OPEN" | "CYCLE"; id: string }
  | { type: "CLOSE" }
  | { type: "BEGIN"; value: string }
  | { type: "RESOLVE"; value: string; generation: number }
  | { type: "INPUT"; value: Context["peekInput"] }
  | { type: "CONFIRM"; value: Context["peekConfirm"] }
  | { type: "STATUS"; value: string | undefined; generation?: number };

const machine = setup({ types: { context: {} as Context, events: {} as Event } }).createMachine({
  id: "dockInteraction",
  type: "parallel",
  context: { panelCollapsed: false, dockPane: "todos", selectedAgent: 0, peekItemId: undefined, generation: 0, owner: 0, peekInput: undefined, peekConfirm: undefined, peekStatus: undefined },
  on: { SELECT: { actions: assign(({ event }) => event.patch) } },
  states: {
    dock: {
      initial: "unmounted",
      on: { DOCK: [
        { guard: ({ event }) => event.style === "styled", target: ".styled" },
        { guard: ({ event }) => event.style === "plain", target: ".plain" },
        { target: ".unmounted" },
      ] },
      states: { unmounted: {}, plain: {}, styled: {} },
    },
    peek: {
      initial: "closed",
      states: {
        closed: { on: { OPEN: { target: "open", actions: assign(({ context, event }) => ({ peekItemId: event.id, generation: context.generation + 1, owner: context.owner + 1 })) } } },
        open: {
          initial: "browsing",
          on: {
            CLOSE: { target: "closed", actions: assign(({ context }) => ({ peekItemId: undefined, generation: context.generation + 1, owner: context.owner + 1, peekInput: undefined, peekConfirm: undefined, peekStatus: undefined })) },
            CYCLE: { target: ".browsing", actions: assign(({ context, event }) => ({ peekItemId: event.id, generation: context.generation + 1, peekInput: undefined, peekConfirm: undefined, peekStatus: undefined })) },
            INPUT: { target: ".resolving", actions: assign(({ context, event }) => ({ peekInput: event.value, generation: context.generation + (event.value ? 1 : 0), peekConfirm: event.value ? undefined : context.peekConfirm })) },
            CONFIRM: { target: ".resolving", actions: assign(({ context, event }) => ({ peekConfirm: event.value, generation: context.generation + (event.value ? 1 : 0), peekInput: event.value ? undefined : context.peekInput })) },
            BEGIN: { target: ".awaiting", actions: assign(({ context, event }) => ({ generation: context.generation + 1, peekInput: undefined, peekConfirm: undefined, peekStatus: event.value })) },
            RESOLVE: { guard: ({ context, event }) => event.generation === context.generation, target: ".browsing", actions: assign(({ event }) => ({ peekStatus: event.value })) },
            STATUS: { guard: ({ context, event }) => event.generation === undefined || event.generation === context.generation, actions: assign(({ event }) => ({ peekStatus: event.value })) },
          },
          states: {
            resolving: { always: [
              { guard: ({ context }) => Boolean(context.peekInput), target: "editing" },
              { guard: ({ context }) => Boolean(context.peekConfirm), target: "confirming" },
              { target: "browsing" },
            ] },
            browsing: {}, editing: {}, confirming: {}, awaiting: {},
          },
        },
      },
    },
  },
});

/** Pure snapshots own interaction state; no actor, subscriptions, or render timers. */
export function createDockInteraction() {
  let [snapshot] = initialTransition(machine);
  return {
    get context(): Readonly<Context> { return snapshot.context; },
    get mounted() { return !snapshot.matches({ dock: "unmounted" }); },
    get styled() { return snapshot.matches({ dock: "styled" }); },
    get editing() { return snapshot.matches({ peek: { open: "editing" } }); },
    get confirming() { return snapshot.matches({ peek: { open: "confirming" } }); },
    get open() { return snapshot.matches({ peek: "open" }); },
    send(event: Event) { [snapshot] = transition(machine, snapshot, event); },
    owns(generation: number) { return snapshot.matches({ peek: "open" }) && snapshot.context.generation === generation; },
  };
}

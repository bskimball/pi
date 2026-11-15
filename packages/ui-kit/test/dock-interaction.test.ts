import assert from "node:assert/strict";
import { it } from "node:test";
import { createDockInteraction } from "../internal/todo/dock-interaction.ts";

it("dock and peek remain orthogonal, with exclusive footer ownership", () => {
  const state = createDockInteraction();
  state.send({ type: "DOCK", style: "plain" });
  state.send({ type: "OPEN", id: "task_1" });
  state.send({ type: "CONFIRM", value: { id: "task_1", action: "abort" } });
  assert.equal(state.confirming, true);
  state.send({ type: "CONFIRM", value: undefined });
  assert.equal(state.confirming, false);
  state.send({ type: "DOCK", style: "styled" });
  assert.equal(state.open, true);
  assert.equal(state.styled, true);
  state.send({ type: "BEGIN", value: "aborting" });
  assert.equal(state.context.peekConfirm, undefined);
  assert.equal(state.confirming, false);
});

it("a newer action on the same worker owns its completion", () => {
  const state = createDockInteraction();
  state.send({ type: "OPEN", id: "task_1" });
  state.send({ type: "BEGIN", value: "first" });
  const first = state.context.generation;
  state.send({ type: "BEGIN", value: "second" });
  const second = state.context.generation;
  state.send({ type: "RESOLVE", generation: first, value: "stale" });
  assert.equal(state.context.peekStatus, "second");
  state.send({ type: "RESOLVE", generation: second, value: "done" });
  assert.equal(state.context.peekStatus, "done");
});

it("session close invalidates pending actions and overlay ownership", () => {
  const state = createDockInteraction();
  state.send({ type: "OPEN", id: "task_1" });
  const owner = state.context.owner;
  state.send({ type: "BEGIN", value: "sending" });
  const generation = state.context.generation;
  state.send({ type: "CLOSE" });
  state.send({ type: "OPEN", id: "task_1" });
  assert.notEqual(state.context.owner, owner);
  assert.equal(state.owns(generation), false);
  state.send({ type: "RESOLVE", generation, value: "stale" });
  assert.equal(state.context.peekStatus, undefined);
});

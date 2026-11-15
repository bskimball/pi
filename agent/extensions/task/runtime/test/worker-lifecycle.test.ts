import assert from "node:assert/strict";
import { it } from "node:test";
import { advanceWorkerLifecycle as step, initialWorkerLifecycle as initial } from "../worker-lifecycle.ts";
import { WorkerRuntime, workerStateLabel } from "../worker-runtime.ts";
import { ActivityLedger } from "../activity-ledger.ts";

it("separates settled generation reuse from process exit and capacity", () => {
  const settled = step(initial("running", "alive"), { type: "SETTLE" });
  assert.equal(settled.value, "settled");
  assert.equal(settled.context.process, "alive");
  assert.equal(step(settled, { type: "START" }).value, "running");
  const exited = step(settled, { type: "EXIT" });
  assert.equal(exited.value, "settled");
  assert.equal(exited.context.process, "exited");
  assert.equal(step(exited, { type: "START" }).value, "settled");
});

it("rejects retry and compaction events during abort and after terminal settlement", () => {
  const aborting = step(initial("retrying", "alive"), { type: "ABORT" });
  for (const type of ["RETRY", "RETRY_END", "COMPACT", "COMPACT_END", "AGENT_START"] as const) {
    assert.equal(step(aborting, { type }).value, "aborting");
    assert.equal(step(initial("failed", "alive"), { type }).value, "failed");
  }
  assert.equal(step(aborting, { type: "SETTLE" }).value, "settled");
  const closed = step(aborting, { type: "CLOSE" });
  assert.equal(closed.context.process, "closed");
  assert.equal(step(closed, { type: "START" }).value, "closed");
});

it("clears terminal questions and protects terminal status from stale UI views", () => {
  const runtime = new WorkerRuntime();
  const worker = {
    lifecycle: "running" as const, phase: "model" as const, countsTowardCap: true, closed: false,
    updatedAt: 0, renderVersion: 0, fallbackEpoch: 0, fallbackInProgress: false,
    fallbackAwaitingAgentStart: false, errors: [], ledger: new ActivityLedger(),
    pendingUi: new Map([["question", { id: "question", method: "input", receivedAt: 0, expectsReply: true }]]),
  };
  runtime.transitionLifecycle(worker, "FAIL");
  assert.equal(worker.pendingUi.size, 0);
  assert.equal(worker.countsTowardCap, true);
  for (const lifecycle of ["failed", "settled", "closed"] as const) {
    assert.equal(workerStateLabel({ lifecycle, phase: "none", waitingUi: [{}] }), lifecycle);
  }
  runtime.transitionLifecycle(worker, "CLOSE");
  assert.equal(worker.closed, true);
  assert.equal(worker.countsTowardCap, false);
});

it("keeps close absorbing across duplicate close and late process exits", () => {
  const closed = step(initial("running", "alive"), { type: "CLOSE" });
  for (const type of ["RELEASE", "EXIT", "DISPOSE_FAILED", "CLOSE", "START", "AGENT_START"] as const) {
    const next = step(closed, { type });
    assert.equal(next.value, "closed");
    assert.equal(next.context.process, "closed");
  }
  const released = step(initial("retrying", "alive"), { type: "RELEASE" });
  for (const type of ["START", "AGENT_START", "RETRY_END", "COMPACT", "ABORT"] as const) {
    assert.equal(released.can({ type }), false);
    assert.equal(step(released, { type }).context.process, "exited");
  }
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { waitForSnapshot } from "./wait-policy.ts";

describe("async task wait policy", () => {
  it("detaches an interrupted waiter without running worker cancellation", async () => {
    const controller = new AbortController();
    let resolveSnapshot: ((value: string) => void) | undefined;
    let detached = 0;
    let workerAborted = 0;

    const waiting = waitForSnapshot({
      signal: controller.signal,
      timeoutMs: 1_000,
      register(resolve) {
        resolveSnapshot = resolve;
        return () => {
          detached += 1;
        };
      },
    });

    controller.abort();

    assert.equal(await waiting, "interrupted");
    assert.equal(detached, 1);
    assert.equal(workerAborted, 0);

    // A later worker settlement is harmless after the waiter detached.
    resolveSnapshot?.("settled");
    assert.equal(detached, 1);
  });

  it("times out and detaches without resolving or aborting the worker", async () => {
    let detached = 0;

    const outcome = await waitForSnapshot({
      timeoutMs: 5,
      register() {
        return () => {
          detached += 1;
        };
      },
    });

    assert.equal(outcome, "timeout");
    assert.equal(detached, 1);
  });

  it("returns the generation snapshot and detaches on settlement", async () => {
    let detached = 0;

    const outcome = await waitForSnapshot({
      timeoutMs: 1_000,
      register(resolve) {
        queueMicrotask(() => resolve({ generation: 3 }));
        return () => {
          detached += 1;
        };
      },
    });

    assert.deepEqual(outcome, { generation: 3 });
    assert.equal(detached, 1);
  });

  it("cleans up when registration finds an already-settled generation", async () => {
    let detached = 0;

    const outcome = await waitForSnapshot({
      timeoutMs: 1_000,
      register(resolve) {
        resolve("settled");
        return () => {
          detached += 1;
        };
      },
    });

    assert.equal(outcome, "settled");
    assert.equal(detached, 1);
  });
});

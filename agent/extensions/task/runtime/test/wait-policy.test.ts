import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultWaitTimeoutSec,
  evaluateRewait,
  resolveWaitTimeoutSec,
  waitForSnapshot,
  WAIT_DEFAULT_TIMEOUT_SEC,
} from "../wait-policy.ts";
import {
  DISPATCH_USAGE,
  formatDispatchAck,
  formatDispatchPrompt,
  formatDispatchWaitYield,
  nextDispatchId,
} from "../dispatch-steer.ts";

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
    let dispatchAttached = 0;
    let dispatchDetached = 0;

    const outcome = await waitForSnapshot({
      timeoutMs: 1_000,
      register(resolve) {
        resolve("settled");
        return () => {
          detached += 1;
        };
      },
      registerDispatchWake() {
        dispatchAttached += 1;
        return () => {
          dispatchDetached += 1;
        };
      },
    });

    assert.equal(outcome, "settled");
    assert.equal(detached, 1);
    assert.equal(dispatchAttached, 0);
    assert.equal(dispatchDetached, 0);
  });
});

describe("parent wait timeout defaults", () => {
  it("uses 600s for unlisted agents and 1200s for oracle/stevedore/inspector", () => {
    assert.equal(defaultWaitTimeoutSec(), WAIT_DEFAULT_TIMEOUT_SEC);
    assert.equal(defaultWaitTimeoutSec("scout"), 600);
    assert.equal(defaultWaitTimeoutSec("oracle"), 1200);
    assert.equal(defaultWaitTimeoutSec("stevedore"), 1200);
    assert.equal(defaultWaitTimeoutSec("inspector"), 1200);
    assert.equal(defaultWaitTimeoutSec("machinist"), 900);
    assert.equal(defaultWaitTimeoutSec("artisan"), 900);
  });

  it("lets an explicit timeoutSec override the agent default, including zero", () => {
    assert.equal(
      resolveWaitTimeoutSec({ explicitTimeoutSec: 90, agent: "oracle" }),
      90,
    );
    assert.equal(resolveWaitTimeoutSec({ explicitTimeoutSec: 0, agent: "oracle" }), 0);
    assert.equal(resolveWaitTimeoutSec({ agent: "oracle" }), 1200);
  });
});

describe("same-generation re-wait cooldown", () => {
  it("blocks an implicit re-wait until the cooldown elapses", () => {
    const blocked = evaluateRewait({
      generation: 1,
      lastWaitTimeoutAt: 1_000,
      lastWaitTimeoutSec: 600,
      lastWaitGeneration: 1,
      now: 1_000 + 10_000,
      cooldownMs: 60_000,
    });
    assert.deepEqual(blocked, {
      allow: false,
      remainingSec: 50,
      lastTimeoutSec: 600,
    });
  });

  it("allows a longer explicit timeoutSec reconnect during the cooldown", () => {
    const allowed = evaluateRewait({
      generation: 1,
      lastWaitTimeoutAt: 1_000,
      lastWaitTimeoutSec: 600,
      lastWaitGeneration: 1,
      explicitTimeoutSec: 1200,
      now: 1_000 + 10_000,
    });
    assert.equal(allowed.allow, true);
  });

  it("blocks an equal or shorter explicit timeoutSec during the cooldown", () => {
    const blocked = evaluateRewait({
      generation: 1,
      lastWaitTimeoutAt: 1_000,
      lastWaitTimeoutSec: 600,
      lastWaitGeneration: 1,
      explicitTimeoutSec: 600,
      now: 1_000 + 10_000,
      cooldownMs: 60_000,
    });
    assert.deepEqual(blocked, {
      allow: false,
      remainingSec: 50,
      lastTimeoutSec: 600,
    });
  });

  it("allows an implicit re-wait once the cooldown elapses", () => {
    const allowed = evaluateRewait({
      generation: 1,
      lastWaitTimeoutAt: 1_000,
      lastWaitTimeoutSec: 600,
      lastWaitGeneration: 1,
      now: 1_000 + 60_000,
      cooldownMs: 60_000,
    });
    assert.equal(allowed.allow, true);
  });

  it("allows a new generation without waiting out the cooldown", () => {
    const allowed = evaluateRewait({
      generation: 2,
      lastWaitTimeoutAt: 1_000,
      lastWaitTimeoutSec: 600,
      lastWaitGeneration: 1,
      now: 1_000 + 10_000,
    });
    assert.equal(allowed.allow, true);
  });
});

describe("dispatch wait wake vs timeout", () => {
  it("wakes waitForSnapshot with dispatchId without timeout cooldown semantics", async () => {
    let detached = 0;
    let wake: ((id: string) => void) | undefined;
    const waiting = waitForSnapshot({
      timeoutMs: 5_000,
      register() {
        return () => {
          detached += 1;
        };
      },
      registerDispatchWake(fn) {
        wake = fn;
        return () => {
          detached += 1;
        };
      },
    });
    wake?.("d-test-1");
    const outcome = await waiting;
    assert.deepEqual(outcome, { dispatchId: "d-test-1" });
    assert.equal(detached, 2);
    assert.notEqual(outcome, "timeout");
    assert.notEqual(outcome, "interrupted");
  });

  it("unregisters a synchronously resolving dispatch wake exactly once", async () => {
    let dispatchDetached = 0;
    const outcome = await waitForSnapshot({
      timeoutMs: 1_000,
      register() {
        return () => {};
      },
      registerDispatchWake(wake) {
        wake("d-sync");
        return () => {
          dispatchDetached += 1;
        };
      },
    });
    assert.deepEqual(outcome, { dispatchId: "d-sync" });
    assert.equal(dispatchDetached, 1);
  });

  it("cleared timeout fields after dispatch yield allow ordinary reconnect", () => {
    const afterYield = evaluateRewait({
      generation: 1,
      lastWaitTimeoutAt: undefined,
      lastWaitTimeoutSec: undefined,
      lastWaitGeneration: undefined,
      now: 1_000 + 10_000,
      cooldownMs: 60_000,
    });
    assert.equal(afterYield.allow, true);
  });
})

describe("dispatch steer copy", () => {
  it("builds unique ids, parent-queued ack, and delegation-routed prompt", () => {
    const a = nextDispatchId(1, 0);
    const b = nextDispatchId(1, 1);
    assert.notEqual(a, b);
    const prompt = formatDispatchPrompt(a, "add a second slice");
    assert.match(prompt, /Preserve existing tasks/i);
    assert.match(prompt, /isolated worktrees/i);
    assert.match(prompt, /active delegation policy/i);
    assert.match(prompt, /Do NOT perform substantial work inline ahead of running workers/i);
    assert.match(prompt, /artisan for visual\/UI/i);
    assert.match(prompt, /add a second slice/);
    assert.match(
      formatDispatchAck(a),
      /Recorded .* parent steering requested\. Route under active delegation policy/,
    );
    assert.match(formatDispatchWaitYield(a), /not a timeout/);
    assert.equal(DISPATCH_USAGE, "Usage: /dispatch <request>");
  });
});

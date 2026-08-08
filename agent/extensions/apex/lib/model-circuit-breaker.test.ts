import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_OPEN_COOLDOWN_MS,
  createModelCircuitBreaker,
  isQualifyingCircuitFailure,
} from "./model-circuit-breaker.ts";
import { shouldRetryModelFallback } from "./worker-runtime.ts";

function tempStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), "pi-circuit-")), "model-circuits.json");
}

describe("model circuit breaker", () => {
  it("opens after the failure threshold and skips the model", () => {
    let now = 1_000_000;
    const breaker = createModelCircuitBreaker({
      path: tempStorePath(),
      now: () => now,
    });
    const primary = "provider/primary";
    const fallback = "provider/fallback";

    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      now += 1_000;
      breaker.recordFailure(primary, "503: auth_unavailable");
    }

    const decision = breaker.selectAttempt([primary, fallback], 0);
    assert.equal(decision.model, fallback);
    assert.equal(decision.index, 1);
    assert.equal(decision.failSafe, false);
    assert.deepEqual(decision.skipped, [primary]);
  });

  it("allows exactly one half-open trial after cooldown", () => {
    let now = 2_000_000;
    const path = tempStorePath();
    const breaker = createModelCircuitBreaker({ path, now: () => now });
    const primary = "provider/primary";
    const fallback = "provider/fallback";

    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      now += 1_000;
      breaker.recordFailure(primary, "rate limit exceeded");
    }

    now += CIRCUIT_OPEN_COOLDOWN_MS + 1;
    const first = breaker.selectAttempt([primary, fallback], 0);
    assert.equal(first.model, primary);
    assert.equal(first.index, 0);
    assert.ok(first.halfOpenToken);
    assert.equal(first.failSafe, false);

    const second = breaker.selectAttempt([primary, fallback], 0);
    assert.equal(second.model, fallback);
    assert.equal(second.index, 1);
    assert.deepEqual(second.skipped, [primary]);
    assert.equal(second.halfOpenToken, undefined);
  });

  it("closes the circuit on success recovery", () => {
    let now = 3_000_000;
    const breaker = createModelCircuitBreaker({
      path: tempStorePath(),
      now: () => now,
    });
    const primary = "provider/primary";
    const fallback = "provider/fallback";

    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      now += 1_000;
      breaker.recordFailure(primary, "model not found");
    }
    assert.equal(
      breaker.selectAttempt([primary, fallback], 0).model,
      fallback,
    );

    now += CIRCUIT_OPEN_COOLDOWN_MS + 1;
    const probe = breaker.selectAttempt([primary, fallback], 0);
    assert.equal(probe.model, primary);
    assert.ok(probe.halfOpenToken);

    now += 5_000;
    breaker.recordSuccess(primary);

    const after = breaker.selectAttempt([primary, fallback], 0);
    assert.equal(after.model, primary);
    assert.equal(after.index, 0);
    assert.equal(after.halfOpenToken, undefined);
    assert.deepEqual(after.skipped, []);
    assert.equal(breaker.peek(primary), undefined);
  });

  it("tolerates a missing or corrupt store", () => {
    const path = tempStorePath();
    writeFileSync(path, "{not-json", "utf8");
    const breaker = createModelCircuitBreaker({
      path,
      now: () => 4_000_000,
    });
    const decision = breaker.selectAttempt(
      ["provider/a", "provider/b"],
      0,
    );
    assert.equal(decision.model, "provider/a");
    assert.equal(decision.failSafe, false);
    assert.doesNotThrow(() =>
      breaker.recordFailure("provider/a", "503 service unavailable"),
    );
    assert.doesNotThrow(() => breaker.recordSuccess("provider/a"));
  });

  it("does not open on non-qualifying failures", () => {
    let now = 5_000_000;
    const breaker = createModelCircuitBreaker({
      path: tempStorePath(),
      now: () => now,
    });
    const primary = "provider/primary";
    const fallback = "provider/fallback";

    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD + 2; i++) {
      now += 1_000;
      breaker.recordFailure(primary, "tool execution failed");
      breaker.recordFailure(primary, "abort requested");
      breaker.recordFailure(primary, "implementation failed");
      breaker.recordFailure(primary, "context window exceeded");
    }

    assert.equal(isQualifyingCircuitFailure("tool execution failed"), false);
    assert.equal(isQualifyingCircuitFailure("503: auth_unavailable"), true);

    const decision = breaker.selectAttempt([primary, fallback], 0);
    assert.equal(decision.model, primary);
    assert.deepEqual(decision.skipped, []);
    assert.equal(breaker.peek(primary), undefined);
  });

  it("fail-safe keeps the first candidate when every circuit is open", () => {
    let now = 6_000_000;
    const breaker = createModelCircuitBreaker({
      path: tempStorePath(),
      now: () => now,
    });
    const a = "provider/a";
    const b = "provider/b";

    for (const model of [a, b]) {
      for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
        now += 1_000;
        breaker.recordFailure(model, "provider unavailable");
      }
    }

    const decision = breaker.selectAttempt([a, b], 0);
    assert.equal(decision.model, a);
    assert.equal(decision.index, 0);
    assert.equal(decision.failSafe, true);
    assert.ok(decision.skipped.includes(a));
    assert.ok(decision.skipped.includes(b));
    // State must remain so a later healthy window still skips until cooldown.
    assert.ok(breaker.peek(a)?.openUntil);
  });

  it("does not weaken shouldRetryModelFallback safety", () => {
    const retryable = {
      hasNextAttempt: true,
      fallbackInProgress: false,
      killReason: undefined,
      resultText: "",
      modelError: "503: auth_unavailable",
      activitiesStarted: 0,
    };
    assert.equal(shouldRetryModelFallback(retryable), true);
    assert.equal(
      shouldRetryModelFallback({ ...retryable, resultText: "partial" }),
      false,
    );
    assert.equal(
      shouldRetryModelFallback({ ...retryable, activitiesStarted: 1 }),
      false,
    );
    assert.equal(
      shouldRetryModelFallback({
        ...retryable,
        modelError: "tool execution failed",
      }),
      false,
    );
  });
});

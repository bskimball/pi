import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createAbortError,
  isAbortError,
  raceAbort,
  throwIfAborted,
} from "../abort.ts";
import { LspClient } from "../client.ts";

describe("abort helpers", () => {
  it("throwIfAborted and isAbortError", () => {
    const ac = new AbortController();
    throwIfAborted(ac.signal);
    ac.abort();
    assert.throws(() => throwIfAborted(ac.signal), (err: Error) => {
      assert.equal(err.name, "AbortError");
      return true;
    });
    assert.equal(isAbortError(createAbortError()), true);
    assert.equal(isAbortError(new Error("other")), false);
  });

  it("raceAbort rejects promptly when signal aborts", async () => {
    const ac = new AbortController();
    const slow = new Promise<string>((resolve) => {
      setTimeout(() => resolve("late"), 5_000);
    });
    const raced = raceAbort(slow, ac.signal);
    setTimeout(() => ac.abort(), 20);
    await assert.rejects(raced, (err: Error) => {
      assert.equal(err.name, "AbortError");
      return true;
    });
  });

  it("waitForPushDiagnostics rejects and clears waiters on abort", async () => {
    // Minimal client without starting a process — exercise waiter abort path only.
    const client = new LspClient({
      command: "false",
      args: [],
      cwd: process.cwd(),
      rootPath: process.cwd(),
      languageKey: "go",
      requestTimeoutMs: 5_000,
      initializeTimeoutMs: 5_000,
      diagnosticsWaitMs: 5_000,
    });

    const ac = new AbortController();
    const wait = client.waitForPushDiagnostics("file:///tmp/x.go", 10_000, ac.signal);
    setTimeout(() => ac.abort(), 30);
    await assert.rejects(wait, (err: Error) => {
      assert.equal(err.name, "AbortError");
      return true;
    });
  });
});

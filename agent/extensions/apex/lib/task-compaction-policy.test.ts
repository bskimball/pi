import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  contextCheckpointNote,
  shouldCheckpointTimedOutWait,
} from "./task-compaction-policy.ts";

const RESERVE_TOKENS = 44_000;

describe("async task compaction policy", () => {
  it("checkpoints timed-out waits at the configured reserve boundary", () => {
    const usage = {
      percent: 80,
      tokens: 220_000 - RESERVE_TOKENS + 1,
      contextWindow: 220_000,
    };

    assert.equal(shouldCheckpointTimedOutWait(usage, RESERVE_TOKENS), true);
    assert.equal(
      contextCheckpointNote(usage, RESERVE_TOKENS),
      "Parent context is 80% full; ending this turn so Pi can auto-compact while the worker continues.",
    );
  });

  it("keeps ordinary wait timeouts non-terminating below the reserve boundary", () => {
    const usage = {
      percent: 79.9,
      tokens: 220_000 - RESERVE_TOKENS,
      contextWindow: 220_000,
    };

    assert.equal(shouldCheckpointTimedOutWait(usage, RESERVE_TOKENS), false);
    assert.equal(contextCheckpointNote(usage, RESERVE_TOKENS), undefined);
  });

  it("adapts the reserve boundary to the active model context window", () => {
    assert.equal(
      shouldCheckpointTimedOutWait(
        {
          percent: 31.25,
          tokens: 20_001,
          contextWindow: 64_000,
        },
        RESERVE_TOKENS,
      ),
      true,
    );
    assert.equal(
      shouldCheckpointTimedOutWait(
        {
          percent: 65.6,
          tokens: 84_001,
          contextWindow: 128_000,
        },
        RESERVE_TOKENS,
      ),
      true,
    );
  });

  it("does not checkpoint when context usage is unknown", () => {
    assert.equal(
      shouldCheckpointTimedOutWait(
        {
          percent: null,
          tokens: null,
          contextWindow: 220_000,
        },
        RESERVE_TOKENS,
      ),
      false,
    );
    assert.equal(
      shouldCheckpointTimedOutWait(undefined, RESERVE_TOKENS),
      false,
    );
  });
});

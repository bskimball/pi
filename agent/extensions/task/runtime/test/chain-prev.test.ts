import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assembleChainDigest, substitutePrev } from "../chain-prev.ts";
import { SETTLED_RESULT_CHARS } from "../worker-status.ts";

describe("substitutePrev", () => {
  it("replaces every {{prev}} occurrence", () => {
    assert.equal(
      substitutePrev("use {{prev}} then {{prev}}", "alpha"),
      "use alpha then alpha",
    );
  });

  it("caps substitution length", () => {
    const out = substitutePrev("x{{prev}}y", "abcdefghij", 4);
    assert.equal(out, "xghijy");
  });

  it("leaves templates without {{prev}} unchanged", () => {
    assert.equal(substitutePrev("no placeholder", "ignored"), "no placeholder");
  });
});

describe("assembleChainDigest", () => {
  it("preserves digest when the last report exceeds the budget", () => {
    const digest = ["step 1 ok scout · 1s · report: ok (1 keys)"];
    const report = "R".repeat(SETTLED_RESULT_CHARS + 500);
    const out = assembleChainDigest(digest, report);
    assert.ok(out.text.startsWith(digest[0]));
    assert.ok(out.text.includes("--- final ---"));
    assert.ok(out.truncated);
    assert.ok(out.text.length <= SETTLED_RESULT_CHARS);
  });

  it("keeps a mid-chain failure reason when the report is huge", () => {
    const digest = [
      "step 1 failed machinist · 2s · report: missing",
      "stopped: step 1 process exited (code=1)",
    ];
    const report = "Z".repeat(SETTLED_RESULT_CHARS);
    const out = assembleChainDigest(digest, report);
    assert.ok(out.text.includes("stopped: step 1 process exited (code=1)"));
    assert.ok(out.text.includes("--- final ---"));
  });
});

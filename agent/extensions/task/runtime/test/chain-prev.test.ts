import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { substitutePrev } from "../chain-prev.ts";

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

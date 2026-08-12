import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JobRegistry } from "./job-registry.ts";

describe("JobRegistry", () => {
  it("preserves insertion order and replaces in place", () => {
    const reg = new JobRegistry<{ n: number }>();
    reg.set("a", { n: 1 });
    reg.set("b", { n: 2 });
    reg.set("a", { n: 3 });
    assert.deepEqual(
      reg.entries().map((e) => [e.id, e.item.n]),
      [
        ["a", 3],
        ["b", 2],
      ],
    );
  });

  it("prunes oldest settled only", () => {
    const reg = new JobRegistry<{ live: boolean }>();
    reg.set("s1", { live: false });
    reg.set("live", { live: true });
    reg.set("s2", { live: false });
    reg.set("s3", { live: false });
    reg.pruneSettled((item) => !item.live, 1);
    assert.equal(reg.has("s1"), false);
    assert.equal(reg.has("s2"), false);
    assert.equal(reg.has("s3"), true);
    assert.equal(reg.has("live"), true);
  });
});

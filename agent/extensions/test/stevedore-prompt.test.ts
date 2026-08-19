import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const prompt = await readFile(
  new URL("../../agents/stevedore.md", import.meta.url),
  "utf8",
);

describe("stevedore verification-only prompt", () => {
  it("keeps integrated verification separate from shipping mechanics", () => {
    assert.match(prompt, /integrated-verification and release specialist/);
    assert.match(
      prompt,
      /this section replaces Worktree resolution, Shipping pre-flight, Git rules, Deploy, and the shipping Report back template/,
    );
    assert.match(prompt, /after all writers have settled/);
    assert.match(prompt, /Run exactly those gates once over the combined worktree/);
    assert.match(prompt, /Do not deploy, stage, commit, push, inventory unrelated dirty files, or edit code/);
    assert.match(prompt, /Do not apply formatter or lint fixes/);
    assert.match(prompt, /Report only: worktree confirmed/);
  });
});

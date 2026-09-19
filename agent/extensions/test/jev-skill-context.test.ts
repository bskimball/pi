import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { extractWorkflowIndex } = await import(
  "../jev/index.ts"
);

const WORK_AGENTS = `stuff before

### Skills (\`.agents/skills/\`)

| When | Read |
| --- | --- |
| Mail, calendar, Teams, Graph execution via \`@bdk/microsoft-graph\` | [.agents/skills/m365/SKILL.md](.agents/skills/m365/SKILL.md) |
| Autotask CLI, preview/apply, tickets, time, opportunities | [.agents/skills/autotask/SKILL.md](.agents/skills/autotask/SKILL.md) |
`;

describe("extractWorkflowIndex", () => {
  it("returns the skills section of the deepest project context file", () => {
    const out = extractWorkflowIndex(
      [
        { path: "/global/AGENTS.md", content: "global context, no marker" },
        { path: "C:/Users/bskim/Work/AGENTS.md", content: WORK_AGENTS },
      ],
      "C:/Users/bskim/Work",
    );
    assert.ok(out);
    assert.match(out!, /### Skills/);
    assert.match(out!, /m365/);
    assert.match(out!, /AGENTS\.md/);
  });

  it("fails open on missing, misshapen, or index-less context", () => {
    assert.equal(extractWorkflowIndex(undefined, "C:/Work"), undefined);
    assert.equal(extractWorkflowIndex([], "C:/Work"), undefined);
    assert.equal(
      extractWorkflowIndex([{ path: "a", content: "" }], "C:/Work"),
      undefined,
    );
    // No skills table means no workflow index: unrelated context is not mislabeled.
    assert.equal(
      extractWorkflowIndex(
        [{ path: "C:/Work/AGENTS.md", content: "general project notes, no skill table" }],
        "C:/Work",
      ),
      undefined,
    );
  });

  it("caps output at the char budget with an ellipsis", () => {
    const out = extractWorkflowIndex(
      [{ path: "C:/Work/AGENTS.md", content: WORK_AGENTS }],
      "C:/Work",
      120,
    );
    assert.ok(out);
    assert.ok(out!.length <= 120, `got ${out!.length} chars`);
    assert.match(out!, /\u2026$/);
  });

  it("keeps the bare prompt intact when there is no project context", () => {
    const trimmed = "Is there anything that I've missed work-wise today?";
    const workflowIndex = extractWorkflowIndex(undefined, "C:/Work");
    const state = workflowIndex
      ? `User request:\n${trimmed}\n\n${workflowIndex}`
      : trimmed;
    assert.equal(state, trimmed);
  });

  it("composes prompt plus workflow index for the m365 case", () => {
    const trimmed = "Is there anything that I've missed work-wise today?";
    const workflowIndex = extractWorkflowIndex(
      [{ path: "C:/Users/bskim/Work/AGENTS.md", content: WORK_AGENTS }],
      "C:/Users/bskim/Work",
    );
    assert.ok(workflowIndex);
    const state = `User request:\n${trimmed}\n\n${workflowIndex}`;
    assert.match(state, /missed work-wise/);
    assert.match(state, /### Skills/);
    assert.ok(state.length <= trimmed.length + 1500 + 30);
  });
});

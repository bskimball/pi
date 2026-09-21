import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JevAnswer } from "../jev/internal/client.ts";
import { resolveSkillChoice, type SkillCandidate, type SkillRouterPolicy } from "../jev/internal/skill-router.ts";
import { collectFindings } from "../jev/internal/code-judge.ts";
import { extractWorkflowIndex } from "../jev/internal/workflow-index.ts";

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

const POLICY: SkillRouterPolicy = { minConfidence: 0.6, minProbability: 0.55, minMargin: 0.15 };

const CANDIDATES: SkillCandidate[] = [
  { name: "mail", description: "mail skill", filePath: "/skills/mail/SKILL.md" },
  { name: "cal", description: "cal skill", filePath: "/skills/cal/SKILL.md" },
];

function choice(partial: {
  choice: string;
  confidence: number;
  probabilities?: Record<string, number>;
}): JevAnswer {
  return { type: "choice", choice: partial.choice, confidence: partial.confidence, probabilities: partial.probabilities } as JevAnswer;
}

describe("resolveSkillChoice three-part gate", () => {
  it("selects a decisive winner that clears all three bars", () => {
    const decision = resolveSkillChoice(
      choice({
        choice: "mail",
        confidence: 0.9,
        probabilities: { mail: 0.8, cal: 0.1, none_needed: 0.1 },
      }),
      CANDIDATES,
      POLICY,
    );
    assert.equal(decision.reason, "selected");
    assert.equal(decision.skill?.name, "mail");
    assert.equal(decision.runnerUp, "cal");
    assert.ok(decision.margin >= POLICY.minMargin);
  });

  it("rejects a thin margin even when probability is high (0.70 vs 0.62)", () => {
    const decision = resolveSkillChoice(
      choice({
        choice: "mail",
        confidence: 0.85,
        probabilities: { mail: 0.7, cal: 0.62, none_needed: 0.0 },
      }),
      CANDIDATES,
      POLICY,
    );
    assert.equal(decision.reason, "below_margin");
    assert.equal(decision.skill, null);
    assert.equal(decision.runnerUp, "cal");
    assert.ok(Math.abs(decision.margin - 0.08) < 1e-9);
  });

  it("rejects a winner below min probability", () => {
    const decision = resolveSkillChoice(
      choice({
        choice: "mail",
        confidence: 0.9,
        probabilities: { mail: 0.5, cal: 0.1, none_needed: 0.05 },
      }),
      CANDIDATES,
      POLICY,
    );
    assert.equal(decision.reason, "below_probability");
  });

  it("rejects low confidence even with a wide margin", () => {
    const decision = resolveSkillChoice(
      choice({
        choice: "mail",
        confidence: 0.4,
        probabilities: { mail: 0.8, cal: 0.1, none_needed: 0.05 },
      }),
      CANDIDATES,
      POLICY,
    );
    assert.equal(decision.reason, "below_confidence");
  });

  it("selects on confidence fallback when probabilities are absent (does not fail closed on margin)", () => {
    const decision = resolveSkillChoice(
      choice({ choice: "mail", confidence: 0.8 }),
      CANDIDATES,
      POLICY,
    );
    assert.equal(decision.reason, "selected");
    assert.equal(decision.probability, 0.8);
    assert.equal(decision.runnerUp, "");
    assert.equal(decision.margin, 0);
  });

  it("returns none_needed without applying the three-part gate", () => {
    const decision = resolveSkillChoice(
      choice({
        choice: "none_needed",
        confidence: 0.3,
        probabilities: { none_needed: 0.4, mail: 0.3, cal: 0.3 },
      }),
      CANDIDATES,
      POLICY,
    );
    assert.equal(decision.reason, "none_needed");
    assert.equal(decision.skill, null);
  });

  it("counts none_needed as runner-up when the margin is thin", () => {
    const decision = resolveSkillChoice(
      choice({
        choice: "mail",
        confidence: 0.85,
        probabilities: { mail: 0.7, none_needed: 0.62, cal: 0.05 },
      }),
      CANDIDATES,
      POLICY,
    );
    assert.equal(decision.reason, "below_margin");
    assert.equal(decision.runnerUp, "none_needed");
    assert.ok(Math.abs(decision.margin - 0.08) < 1e-9);
  });

  it("returns unusable when a probability key was never offered", () => {
    const decision = resolveSkillChoice(
      choice({
        choice: "mail",
        confidence: 0.9,
        probabilities: { mail: 0.7, none_needed: 0.1, "C:/secret/plans.md": 0.62 },
      }),
      CANDIDATES,
      POLICY,
    );
    assert.equal(decision.reason, "unusable");
    assert.equal(decision.runnerUp, "");
  });
});

function noul(value: number): JevAnswer {
  return { type: "noul", noul: value };
}

describe("collectFindings", () => {
  it("fires a bad trait when evidence is sufficient", () => {
    const findings = collectFindings(
      {
        evidence_sufficient: noul(0.9),
        speculative_abstraction: noul(0.85),
      },
      0.8,
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.id, "speculative_abstraction");
  });

  it("suppresses all findings when evidence_sufficient is below the bar", () => {
    const findings = collectFindings(
      {
        evidence_sufficient: noul(0.3),
        speculative_abstraction: noul(0.85),
      },
      0.8,
    );
    assert.equal(findings.length, 0);
  });

  it("does not fire a good trait at noul 0.19", () => {
    const findings = collectFindings(
      {
        evidence_sufficient: noul(0.9),
        naming_reveals_intent: noul(0.19),
      },
      0.8,
    );
    assert.equal(findings.length, 0);
  });

  it("fires a good trait at noul 0.05", () => {
    const findings = collectFindings(
      {
        evidence_sufficient: noul(0.9),
        naming_reveals_intent: noul(0.05),
      },
      0.8,
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.id, "naming_reveals_intent");
  });

  it("treats missing evidence_sufficient as 0 and suppresses findings", () => {
    const findings = collectFindings(
      {
        speculative_abstraction: noul(0.85),
      },
      0.8,
    );
    assert.equal(findings.length, 0);
  });
});

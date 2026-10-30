import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JevAnswer } from "../jev/internal/client.ts";
import { buildSkillBreadthQuestion, buildSkillRelevanceQuestions, formatSkillAdvisory, resolveSkillChoice, resolveSkillSuggestions, type SkillCandidate, type SkillRouterPolicy } from "../jev/internal/skill-router.ts";
import { collectFindings } from "../jev/internal/code-judge.ts";
import { extractWorkflowIndex } from "../jev/internal/workflow-index.ts";
import { buildHydraQuestions, extractRecentAssistantContext, formatHydraAdvisory, HYDRA_DEPTH_ID, HYDRA_DOMAIN_ID, isHydraActive, MIN_HYDRA_PROMPT_CHARS, parseHydraSignal } from "../jev/internal/hydra-signal.ts";
import { registerSuggestionReceipt } from "../jev/internal/suggestion-receipt.ts";

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

describe("breadth skill routing", () => {
  const candidates = [
    { name: "autotask", description: "tickets", filePath: "/autotask/SKILL.md" },
    { name: "m365", description: "mail", filePath: "/m365/SKILL.md" },
    { name: "ninjaone", description: "devices", filePath: "/ninjaone/SKILL.md" },
  ];
  const answer = choice({ choice: "ninjaone", confidence: 0.9, probabilities: { ninjaone: 0.98, autotask: 0.81, m365: 0.78, none_needed: 0.01 } });
  const decision = resolveSkillChoice(answer, candidates, POLICY);
  const asked = buildSkillRelevanceQuestions(candidates, answer);
  const relevance = { ninjaone: noul(0.98), autotask: noul(0.81), m365: noul(0.78) };

  it("selects every above-bar skill, orders by relevance and formats a scope-safe advisory", () => {
    const matches = resolveSkillSuggestions(decision, candidates, 0.82, 0.6, relevance, asked);
    assert.deepEqual(matches.map(match => match.skill.name), ["ninjaone", "autotask", "m365"]);
    assert.equal(formatSkillAdvisory(matches), "Jev skill matches (this request appears to span multiple systems): ninjaone (p=0.98), autotask (p=0.81), m365 (p=0.78). Consider all of them; the user's request defines scope, not this list.");
  });

  it("keeps a single winner below the breadth bar", () => {
    const matches = resolveSkillSuggestions(decision, candidates, 0.59, 0.6, relevance, asked);
    assert.deepEqual(matches.map(match => match.skill.name), ["ninjaone"]);
    assert.equal(formatSkillAdvisory(matches), "Jev skill match: ninjaone (p=0.98). Candidate only — it does not narrow the request's scope. Load it with the read tool if this turn needs it.");
  });

  it("bounds fitting and overflowing lists and labels omissions", () => {
    const long = Array.from({ length: 12 }, (_, i) => ({ skill: { name: `${i}-${"a".repeat(76)}`, description: "", filePath: "" }, probability: 0.8 }));
    const fitting = formatSkillAdvisory(long.slice(0, 2));
    const overflowing = formatSkillAdvisory(long);
    assert.ok(fitting.length <= 400);
    assert.ok(overflowing.length <= 400);
    assert.doesNotMatch(fitting, /\+\d+ more/);
    assert.match(overflowing, /\+\d+ more/);
    assert.match(overflowing, /the user's request defines scope/);
  });

  it("provides the catalog in the independent breadth question", () => {
    const question = buildSkillBreadthQuestion(candidates);
    assert.match(question.instructions, /autotask, m365, ninjaone/);
    assert.ok(question.instructions.length < 3000);
  });

  it("treats missing or malformed first-pass breadth as single-skill routing", () => {
    for (const breadthAnswer of [undefined, choice({ choice: "ninjaone", confidence: 0.9 })]) {
      const breadth = breadthAnswer?.type === "noul" ? breadthAnswer.noul : undefined;
      const matches = resolveSkillSuggestions(decision, candidates, breadth ?? 0, 0.6, undefined, undefined);
      assert.deepEqual(matches.map(match => match.skill.name), ["ninjaone"]);
    }
  });

  it("falls back to the winner on a partial or unusable second answer", () => {
    for (const partial of [{ ninjaone: noul(0.9) }, { ...relevance, m365: choice({ choice: "m365", confidence: 0.9 }) }]) {
      assert.deepEqual(resolveSkillSuggestions(decision, candidates, 0.82, 0.6, partial, asked).map(match => match.skill.name), ["ninjaone"]);
    }
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

describe("hydra turn signal", () => {
  it("detects active hydra env tiers and builds score+choice questions", () => {
    const saved = process.env.PI_HYDRA_TIER;
    try {
      delete process.env.PI_HYDRA_TIER;
      assert.equal(isHydraActive(undefined), false);
    } finally {
      if (saved === undefined) delete process.env.PI_HYDRA_TIER;
      else process.env.PI_HYDRA_TIER = saved;
    }
    assert.equal(isHydraActive("off"), false);
    assert.equal(isHydraActive("standard"), true);
    assert.equal(isHydraActive("high"), true);
    assert.equal(isHydraActive("max"), true);

    const q = buildHydraQuestions();
    assert.equal(q[HYDRA_DEPTH_ID]?.type, "score");
    assert.equal(q[HYDRA_DOMAIN_ID]?.type, "choice");
    assert.equal(typeof (q[HYDRA_DOMAIN_ID] as any)?.criteria?.design, "string");
  });

  it("parses 0-based Jev score [0..3] into 1-based depth [1..4] and floors low-confidence coding/research", () => {
    const parsed = parseHydraSignal({
      [HYDRA_DEPTH_ID]: { type: "score", score: 2.6, confidence: 0.88, legend: [], probabilities: {} },
      [HYDRA_DOMAIN_ID]: { type: "choice", choice: "reasoning", confidence: 0.91, probabilities: {} },
    });
    assert.deepEqual(parsed, {
      reasoningDepth: 3.6,
      depthConfidence: 0.88,
      domain: "reasoning",
      domainConfidence: 0.91,
    });
    assert.equal(parseHydraSignal({}), undefined);

    // 0-based score 0.4 -> 1.4 on [1..4]; low-confidence coding prompt floors at 2.2 so it never drops into Level 1 fast_edit/Haiku.
    const lowConfCoding = parseHydraSignal({
      [HYDRA_DEPTH_ID]: { type: "score", score: 0.4, confidence: 0.48, legend: [], probabilities: {} },
      [HYDRA_DOMAIN_ID]: { type: "choice", choice: "coding", confidence: 0.52, probabilities: {} },
    });
    assert.equal(lowConfCoding?.reasoningDepth, 2.2);
    assert.equal(lowConfCoding?.domain, "coding");

    // 0-based score 1.4 (HAL screenshot prompt) -> 2.4 on [1..4] (mid-to-complex coding).
    const screenshotCoding = parseHydraSignal({
      [HYDRA_DEPTH_ID]: { type: "score", score: 1.4, confidence: 0.48, legend: [], probabilities: {} },
      [HYDRA_DOMAIN_ID]: { type: "choice", choice: "coding", confidence: 0.52, probabilities: {} },
    });
    assert.equal(screenshotCoding?.reasoningDepth, 2.4);

    // High-confidence Level 1 lookup (0-based score 0.749 -> 1.749 < 1.75, domain="research", conf=0.84) stays unrounded below 1.75.
    const quickLookup = parseHydraSignal({
      [HYDRA_DEPTH_ID]: { type: "score", score: 0.749, confidence: 0.83, legend: [], probabilities: {} },
      [HYDRA_DOMAIN_ID]: { type: "choice", choice: "research", confidence: 0.84, probabilities: {} },
    });
    assert.ok(quickLookup && Math.abs(quickLookup.reasoningDepth - 1.749) < 1e-9 && quickLookup.reasoningDepth < 1.75);

    // Low-confidence research (e.g. domainConfidence 0.28 on an integration/feature prompt) floors at 2.2.
    const ambiguousResearch = parseHydraSignal({
      [HYDRA_DEPTH_ID]: { type: "score", score: 0.0, confidence: 0.69, legend: [], probabilities: {} },
      [HYDRA_DOMAIN_ID]: { type: "choice", choice: "research", confidence: 0.28, probabilities: {} },
    });
    assert.equal(ambiguousResearch?.reasoningDepth, 2.2);

    // UI/design domain floors at 2.4 (or 2.6 when low-confidence) so frontend/UI work never collapses into a shallow fast lookup.
    const designTurn = parseHydraSignal({
      [HYDRA_DEPTH_ID]: { type: "score", score: 0.8, confidence: 0.85, legend: [], probabilities: {} },
      [HYDRA_DOMAIN_ID]: { type: "choice", choice: "design", confidence: 0.92, probabilities: {} },
    });
    assert.equal(designTurn?.domain, "design");
    assert.equal(designTurn?.reasoningDepth, 2.4);
  });

  it("extracts recent assistant context for short follow-up prompts like 'implement both steps'", () => {
    assert.ok("implement both steps".length >= MIN_HYDRA_PROMPT_CHARS);
    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "Why does screenshot say captured without saving?" }] } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "checking files" },
            { type: "text", text: "Two steps are needed:\n1. Persist PNG to disk in main/screenshots.ts.\n2. Render thumbnail + Save/Copy in renderer/process-trace.tsx." },
          ],
        },
      },
    ];
    const ctxText = extractRecentAssistantContext(branch);
    assert.ok(ctxText);
    assert.match(ctxText!, /Prior assistant context/);
    assert.match(ctxText!, /Persist PNG to disk/);
    assert.equal(extractRecentAssistantContext([]), undefined);
  });

  it("formats hydra advisory and renders hydra row in jev-suggestion receipt even when no skill or guard fires", () => {
    const signal = {
      reasoningDepth: 1.4,
      depthConfidence: 0.92,
      domain: "fast_edit" as const,
      domainConfidence: 0.89,
    };
    const text = formatHydraAdvisory(signal, {
      model: "claude-bridge/claude-sonnet-5-5",
      thinking: "low",
      score: 0.78,
      switchedModel: true,
    });
    assert.equal(text, "Jev Hydra route: claude-bridge/claude-sonnet-5-5 (low) [depth=1.4, domain=fast_edit, score=0.78].");

    let entryRenderer: any;
    registerSuggestionReceipt({
      registerMessageRenderer() {},
      registerEntryRenderer(_type: string, fn: any) {
        entryRenderer = fn;
      },
    } as any);
    const savedChrome = process.env.PI_UI_CHROME;
    process.env.PI_UI_CHROME = "0";
    try {
      const comp = entryRenderer(
        {
          data: {
            kind: "turn",
            skills: [],
            findings: [],
            hydra: {
              ...signal,
              model: "claude-bridge/claude-sonnet-5-5",
              thinking: "low",
              score: 0.78,
              switchedModel: true,
            },
          },
        },
        { expanded: false },
        {},
      );
      assert.ok(comp, "renders component when only hydra details are present");
      const rendered = comp.render(100).join("\n");
      assert.match(rendered, /hydra: claude-bridge\/claude-sonnet-5-5 \(low\) \(d=1\.4\/fast_edit · score=0\.78\)/);
    } finally {
      if (savedChrome === undefined) delete process.env.PI_UI_CHROME;
      else process.env.PI_UI_CHROME = savedChrome;
    }
  });
});

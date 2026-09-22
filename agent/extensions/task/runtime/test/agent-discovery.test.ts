import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  modelAttempts,
  orchestrateAgentList,
  orchestrateAgentParamDescription,
  resolveAgentThinking,
  stripRegularModeCarveout,
  type AgentDef,
} from "../agent-discovery.ts";

function def(partial: Partial<AgentDef> & Pick<AgentDef, "name">): AgentDef {
  return {
    description: "",
    fallbackModels: [],
    inheritSkills: true,
    body: "",
    file: "",
    ...partial,
  };
}

describe("modelAttempts", () => {
  const oracle = def({
    name: "oracle",
    model: "local-proxy/gpt-5.6-sol",
    fallbackModels: [
      "local-proxy/grok-4.6",
      "local-proxy/claude-fable-5",
    ],
  });

  it("uses the configured primary then declared fallbacks", () => {
    assert.deepEqual(modelAttempts(oracle), [
      "local-proxy/gpt-5.6-sol",
      "local-proxy/grok-4.6",
      "local-proxy/claude-fable-5",
    ]);
  });

  it("ignores a lead model override when none is passed", () => {
    assert.deepEqual(
      modelAttempts(oracle, undefined),
      modelAttempts(oracle),
    );
  });

  it("rebinding a fallback session keeps that model first and skips the failed primary", () => {
    assert.deepEqual(modelAttempts(oracle, "local-proxy/grok-4.6"), [
      "local-proxy/grok-4.6",
      "local-proxy/claude-fable-5",
    ]);
  });
});

describe("resolveAgentThinking", () => {
  it("uses each agent's configured thinking level, including oracle", () => {
    assert.equal(
      resolveAgentThinking(def({ name: "oracle", thinking: "high" }), "high"),
      "high",
    );
    assert.equal(
      resolveAgentThinking(def({ name: "oracle", thinking: "high" }), "max"),
      "high",
    );
    assert.equal(
      resolveAgentThinking(def({ name: "machinist", thinking: "low" }), "high"),
      "low",
    );
  });
});

describe("stripRegularModeCarveout", () => {
  it("removes inline-staying carve-outs but keeps the UI/prose exclusion", () => {
    assert.equal(
      stripRegularModeCarveout(
        "Visual design and UI specialist for substantial frontend work. Ordinary frontend implementation stays with the lead in regular mode.",
      ),
      "Visual design and UI specialist for substantial frontend work.",
    );
    assert.equal(
      stripRegularModeCarveout(
        "Implementation specialist for non-visual slices. Long or multi-file work alone is not a reason to delegate in regular mode. Not for UI or prose deliverables.",
      ),
      "Implementation specialist for non-visual slices. Not for UI or prose deliverables.",
    );
  });

  it("keeps regular-mode sentences that are not inline carve-outs", () => {
    const description =
      "Fast, cheap read-only browser verification. Live-page checks route here in regular and orchestrate modes.";
    assert.equal(stripRegularModeCarveout(description), description);
  });

  it("leaves descriptions without carve-outs untouched", () => {
    const description = "Deep independent code reviewer and debugger.";
    assert.equal(stripRegularModeCarveout(description), description);
  });
});

describe("orchestrateAgentList", () => {
  const agents = new Map([
    ["artisan", def({ name: "artisan", description: "Visual design specialist. Ordinary frontend implementation stays with the lead in regular mode." })],
    ["machinist", def({ name: "machinist", description: "Non-visual slices. Long or multi-file work alone is not a reason to delegate in regular mode. Not for UI or prose deliverables." })],
    ["strategist", def({ name: "strategist", description: "Work planner." })],
  ]);

  it("strips carve-outs, keeps exclusions, and excludes the Work crew", () => {
    const list = orchestrateAgentList(agents);
    assert.doesNotMatch(list, /in regular mode/);
    assert.match(list, /- artisan: Visual design specialist\./);
    assert.match(list, /Not for UI or prose deliverables\./);
    assert.doesNotMatch(list, /strategist/);
  });
});

describe("orchestrateAgentParamDescription", () => {
  it("routes all visual/UI work to artisan and keeps machinist non-visual", () => {
    const agents = new Map([
      ["artisan", def({ name: "artisan" })],
      ["machinist", def({ name: "machinist" })],
      ["stevedore", def({ name: "stevedore" })],
    ]);
    const description = orchestrateAgentParamDescription(agents);
    assert.doesNotMatch(description, /in regular mode/);
    assert.match(
      description,
      /all visual and UI implementation slices, including mechanical or appearance-preserving ones, to artisan/,
    );
    assert.match(description, /non-visual implementation slices to machinist/);
    assert.match(
      description,
      /This parameter chooses a specialist after delegation is justified; it does not decide whether to delegate\./,
    );
  });

  it("drops clauses naming agents absent from the catalog", () => {
    const description = orchestrateAgentParamDescription(
      new Map([["machinist", def({ name: "machinist" })]]),
    );
    assert.doesNotMatch(description, /artisan/);
    assert.match(description, /non-visual implementation slices to machinist/);
  });
});

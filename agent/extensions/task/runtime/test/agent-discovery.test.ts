import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  modelAttempts,
  resolveAgentThinking,
  resolveOracleThinking,
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

describe("resolveOracleThinking", () => {
  it("keeps configured high when the parent is lower", () => {
    assert.equal(resolveOracleThinking("high", "medium"), "high");
    assert.equal(resolveOracleThinking("high", "low"), "high");
  });

  it("steps above the parent when parent thinking is the same or higher", () => {
    assert.equal(resolveOracleThinking("high", "high"), "xhigh");
    assert.equal(resolveOracleThinking("high", "xhigh"), "max");
    assert.equal(resolveOracleThinking("high", "max"), "max");
  });

  it("does not drop below configured when parent thinking is unknown", () => {
    assert.equal(resolveOracleThinking("high", undefined), "high");
    assert.equal(resolveOracleThinking("high", "mystery"), "high");
  });
});

describe("resolveAgentThinking", () => {
  it("raises only oracle, leaving other specialists on their configured level", () => {
    assert.equal(
      resolveAgentThinking(def({ name: "oracle", thinking: "high" }), "high"),
      "xhigh",
    );
    assert.equal(
      resolveAgentThinking(def({ name: "machinist", thinking: "low" }), "high"),
      "low",
    );
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  modelAttempts,
  resolveAgentThinking,
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

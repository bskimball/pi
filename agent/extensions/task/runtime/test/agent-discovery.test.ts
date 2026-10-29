import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  modelAttempts,
  parseAgentFile,
  orchestrateAgentList,
  orchestrateAgentParamDescription,
  resolveAgentThinking,
  resolveSubagentModelsAndThinking,
  scopeRebindAttempts,
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

describe("apexBrowser opt-in", () => {
  it("enables inspector but not ordinary specialists", () => {
    const inspector = parseAgentFile(fileURLToPath(new URL("../../../../agents/inspector.md", import.meta.url)));
    const oracle = parseAgentFile(fileURLToPath(new URL("../../../../agents/oracle.md", import.meta.url)));
    assert.ok(inspector);
    assert.ok(oracle);
    assert.equal(inspector.apexBrowser, true);
    assert.equal(oracle.apexBrowser, false);
  });
});

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

  it("disables declared fallbacks only when explicitly requested", () => {
    assert.deepEqual(modelAttempts(oracle, "openai-codex/gpt-6.1-sol", false), [
      "openai-codex/gpt-6.1-sol",
    ]);
    assert.deepEqual(modelAttempts(oracle, undefined, false), [oracle.model]);
    assert.deepEqual(modelAttempts(oracle, "openai-codex/gpt-6.1-sol"), [
      "openai-codex/gpt-6.1-sol",
      ...oracle.fallbackModels,
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

  it("routes subagent models and thinking via Hydra when PI_HYDRA_TIER is active and no explicit model override is passed", () => {
    const inspector = def({
      name: "inspector",
      model: "antigravity/gemini-3.8-flash",
      fallbackModels: ["openai/gpt-6.1-terra"],
      thinking: "medium",
    });
    const saved = process.env.PI_HYDRA_TIER;
    process.env.PI_HYDRA_TIER = "high";
    try {
      const routed = resolveSubagentModelsAndThinking({
        def: inspector,
        parentThinking: "high",
        ctx: {},
        emitEvent: (ev, payload: any) => {
          if (ev === "pi:hydra:subagent-route") {
            payload.models = ["claude-bridge/claude-sonnet-5-5", "openai/gpt-6.1-sol"];
            payload.thinking = "low";
          }
        },
      });
      assert.deepEqual(routed.attempts, [
        "claude-bridge/claude-sonnet-5-5",
        "openai/gpt-6.1-sol",
        "antigravity/gemini-3.8-flash",
        "openai/gpt-6.1-terra",
      ]);
      assert.equal(routed.thinking, "low");

      // Explicit model override bypasses Hydra primary selection
      const overridden = resolveSubagentModelsAndThinking({
        def: inspector,
        parentThinking: "high",
        modelOverride: "xai/grok-4.7",
        ctx: {},
        emitEvent: () => {
          throw new Error("should not emit hydra route when modelOverride is provided");
        },
      });
      assert.equal(overridden.attempts[0], "xai/grok-4.7");
      assert.equal(overridden.thinking, "medium");
    } finally {
      if (saved === undefined) delete process.env.PI_HYDRA_TIER;
      else process.env.PI_HYDRA_TIER = saved;
    }
  });

  it("restricts Hydra attempts to the active scope and fails closed when nothing is in scope", () => {
    const inspector = def({
      name: "inspector",
      model: "antigravity/gemini-3.8-flash",
      fallbackModels: ["openai/gpt-6.1-terra", "claude-bridge/claude-haiku-5-5"],
      thinking: "medium",
    });
    const scout = def({
      name: "scout",
      model: "antigravity/gemini-3.8-flash",
      fallbackModels: ["claude-bridge/claude-haiku-5-5"],
      thinking: "medium",
    });
    const savedTier = process.env.PI_HYDRA_TIER;
    const savedScope = process.env.PI_HYDRA_SCOPE;
    process.env.PI_HYDRA_TIER = "high";
    process.env.PI_HYDRA_SCOPE = "openai";
    try {
      const routed = resolveSubagentModelsAndThinking({
        def: inspector,
        ctx: {},
        emitEvent: (_ev, payload: any) => {
          payload.models = ["claude-bridge/claude-sonnet-5-5", "openai/gpt-6.1-sol"];
          payload.scope = "openai";
          payload.thinking = "low";
        },
      });
      assert.deepEqual(routed.attempts, ["openai/gpt-6.1-sol", "openai/gpt-6.1-terra"], "static fallbacks are filtered to the scope");
      assert.equal(routed.error, undefined);

      const staticOnly = resolveSubagentModelsAndThinking({
        def: inspector,
        ctx: {},
        emitEvent: (_ev, payload: any) => {
          payload.models = [];
          payload.scope = "openai";
          payload.scopeExhausted = true;
        },
      });
      assert.deepEqual(staticOnly.attempts, ["openai/gpt-6.1-terra"], "in-scope static fallback still runs when Hydra ranking is exhausted");

      const blocked = resolveSubagentModelsAndThinking({
        def: scout,
        ctx: {},
        emitEvent: (_ev, payload: any) => {
          payload.models = [];
          payload.scope = "openai";
          payload.scopeExhausted = true;
        },
      });
      assert.deepEqual(blocked.attempts, []);
      assert.match(blocked.error ?? "", /refusing out-of-scope fallback/);
    } finally {
      if (savedTier === undefined) delete process.env.PI_HYDRA_TIER;
      else process.env.PI_HYDRA_TIER = savedTier;
      if (savedScope === undefined) delete process.env.PI_HYDRA_SCOPE;
      else process.env.PI_HYDRA_SCOPE = savedScope;
    }
  });
});

describe("scopeRebindAttempts", () => {
  const chain = ["openai/gpt-6.1-sol", "local-proxy/claude-opus-5-5", "openai-codex/gpt-6-astra", "xai/grok-4.7"];

  it("filters a rebind fallback chain to the active scope", () => {
    assert.deepEqual(scopeRebindAttempts(chain, "oracle", "openai").attempts, [
      "openai/gpt-6.1-sol",
      "openai-codex/gpt-6-astra",
    ]);
  });

  it("fails closed when no rebind candidate is in scope", () => {
    const blocked = scopeRebindAttempts(["local-proxy/claude-opus-5-5"], "oracle", "openai");
    assert.deepEqual(blocked.attempts, []);
    assert.match(blocked.error ?? "", /refusing out-of-scope rebind/);
  });

  it("leaves the chain unchanged without a scope", () => {
    const saved = process.env.PI_HYDRA_SCOPE;
    delete process.env.PI_HYDRA_SCOPE;
    try {
      assert.deepEqual(scopeRebindAttempts(chain, "oracle").attempts, chain);
    } finally {
      if (saved !== undefined) process.env.PI_HYDRA_SCOPE = saved;
    }
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

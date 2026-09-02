import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { agentParamDescription, discoverAgents, routingHint } = await import(
  "../task/runtime/agent-discovery.ts"
);

type Catalog = Parameters<typeof routingHint>[0];

function catalogOf(...names: string[]): Catalog {
  return new Map(
    names.map((name) => [name, { name, description: "", fallbackModels: [], inheritSkills: true, body: "", file: "" }]),
  ) as Catalog;
}

describe("routing hint", () => {
  it("names a destination for prose work without making machinist a catch-all", () => {
    const hint = routingHint(catalogOf("artisan", "inspector", "machinist", "scribe"));
    assert.match(hint, /to scribe/);
    assert.match(hint, /docs/);
    assert.match(hint, /independent separable non-visual implementation slices to machinist/);
    assert.doesNotMatch(hint, /other non-visual/);
  });

  it("omits clauses for agents missing from the catalog", () => {
    const hint = routingHint(catalogOf("machinist"));
    assert.doesNotMatch(hint, /scribe|artisan|inspector/);
    assert.match(hint, /to machinist/);
  });

  it("stays a grammatical sentence when the leading clause drops out", () => {
    for (const catalog of [
      catalogOf("artisan", "inspector", "machinist", "scribe"),
      catalogOf("inspector", "machinist", "scribe"),
      catalogOf("scribe"),
    ]) {
      const hint = routingHint(catalog);
      assert.match(hint, /^This parameter chooses a specialist after delegation is justified/);
      assert.match(hint, /\.$/);
      assert.doesNotMatch(hint, /Route ;|; ;|Route \./);
    }
  });

  it("describes the real catalog without naming an agent that does not exist", () => {
    const agents = discoverAgents();
    const description = agentParamDescription(agents);
    for (const name of ["artisan", "inspector", "scribe", "machinist", "stevedore"]) {
      assert.ok(agents.has(name), `expected ${name} in the shipped catalog`);
      assert.ok(description.includes(name));
    }
    assert.match(description, /^Agent to run\. One of: /);
    assert.match(description, /after delegation is justified/);
    assert.match(description, /substantial visual design/);
    assert.match(description, /live-page checks to inspector/);
    assert.doesNotMatch(description, /only on explicit user request in regular mode/);
    assert.doesNotMatch(description, /UI\/frontend\/styling\/layout implementation to artisan/);
  });

});

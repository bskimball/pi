import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { agentParamDescription, discoverAgents, routingHint } = await import(
  "../apex/lib/agent-discovery.ts"
);

type Catalog = Parameters<typeof routingHint>[0];

function catalogOf(...names: string[]): Catalog {
  return new Map(
    names.map((name) => [name, { name, description: "", fallbackModels: [], inheritSkills: true, body: "", file: "" }]),
  ) as Catalog;
}

describe("routing hint", () => {
  it("names a destination for prose work so docs do not fall through to machinist", () => {
    const hint = routingHint(catalogOf("artisan", "inspector", "machinist", "scribe"));
    assert.match(hint, /to scribe/);
    assert.match(hint, /docs/);
    // The prose clause must precede the machinist catch-all, or "non-visual"
    // swallows documentation before scribe is ever considered.
    assert.ok(hint.indexOf("to scribe") < hint.indexOf("to machinist"));
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
      assert.match(hint, /^Route /);
      assert.match(hint, /\.$/);
      assert.doesNotMatch(hint, /Route ;|; ;|Route \./);
    }
  });

  it("describes the real catalog without naming an agent that does not exist", () => {
    const agents = discoverAgents();
    const description = agentParamDescription(agents);
    for (const name of ["artisan", "inspector", "scribe", "machinist"]) {
      assert.ok(agents.has(name), `expected ${name} in the shipped catalog`);
      assert.ok(description.includes(name));
    }
    assert.match(description, /^Agent to run\. One of: /);
  });
});

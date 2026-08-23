import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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
    for (const name of ["artisan", "inspector", "scribe", "machinist"]) {
      assert.ok(agents.has(name), `expected ${name} in the shipped catalog`);
      assert.ok(description.includes(name));
    }
    assert.match(description, /^Agent to run\. One of: /);
    assert.match(description, /after delegation is justified/);
    assert.match(description, /substantial visual design/);
    assert.doesNotMatch(description, /UI\/frontend\/styling\/layout implementation to artisan/);
  });

  it("keeps the task and Apex routing helpers identical", () => {
    const taskHelper = fs.readFileSync(
      path.resolve("agent/extensions/task/runtime/agent-discovery.ts"),
      "utf8",
    );
    const apexHelper = fs.readFileSync(
      path.resolve("agent/extensions/apex/internal/runtime/agent-discovery.ts"),
      "utf8",
    );
    assert.equal(apexHelper, taskHelper);
  });

  it("protects the regular-mode inline and specialist thresholds", () => {
    const system = fs.readFileSync(path.resolve("agent/SYSTEM.md"), "utf8");
    const asyncTask = fs.readFileSync(
      path.resolve("agent/extensions/task/async-task.ts"),
      "utf8",
    );
    const advisor = fs.readFileSync(path.resolve("agent/agents/advisor.md"), "utf8");

    assert.match(system, /Keep coherent implementation in the main model even when it is long-running, multi-file, or frontend-heavy/);
    assert.match(system, /machinist only for an independent separable non-visual implementation slice/);
    assert.match(system, /advisor only when the user explicitly asks for it in regular mode/);
    assert.match(system, /lead normally runs lint, format checks, typechecks, tests, and builds directly/);
    assert.match(asyncTask, /Multi-file, long-running, or frontend work may remain inline in regular mode/);
    assert.doesNotMatch(asyncTask, /delegates all multi-file implementation/);
    assert.match(advisor, /In regular mode, only when the user explicitly requests advisor consultation/);
  });
});

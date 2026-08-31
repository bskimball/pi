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
    assert.match(description, /live-page checks to inspector/);
    assert.doesNotMatch(description, /only on explicit user request in regular mode/);
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
    const promptCommands = fs.readFileSync(
      path.resolve("agent/extensions/prompt-commands.ts"),
      "utf8",
    );
    const asyncTask = fs.readFileSync(
      path.resolve("agent/extensions/task/async-task.ts"),
      "utf8",
    );
    const advisor = fs.readFileSync(path.resolve("agent/agents/advisor.md"), "utf8");
    const inspector = fs.readFileSync(path.resolve("agent/agents/inspector.md"), "utf8");
    const oracle = fs.readFileSync(path.resolve("agent/agents/oracle.md"), "utf8");
    const stevedore = fs.readFileSync(path.resolve("agent/agents/stevedore.md"), "utf8");

    assert.match(promptCommands, /Keep coherent implementation in the main model even when it is long-running, multi-file, or frontend-heavy/);
    assert.match(system, /Use \*\*machinist\*\* only for an independent separable non-visual implementation slice/);
    assert.match(promptCommands, /advisor only when the user explicitly asks for it in regular mode/);
    assert.match(system, /lead normally runs lint, format checks, typechecks, tests, and builds directly/);
    assert.match(system, /If you delegate multiple truly independent units, you SHOULD dispatch them in parallel/);
    assert.match(system, /MUST NOT serialize truly independent delegated units merely to keep one specialist in flight/);
    assert.match(system, /Default to one active writer for a feature vertical or shared runtime contract/);
    assert.match(system, /close one milestone before opening the next/);
    assert.match(system, /"Continue" resumes and finishes the current open milestone/);
    assert.match(system, /Every implementation brief must state one validation obligation/);
    assert.match(system, /One correction cycle/);
    assert.match(system, /task_send mode=prompt/);
    assert.match(system, /Never start a third writer attempt automatically/);
    assert.match(system, /`ADVISORY` means non-blocking hardening/);
    assert.match(system, /injected mode card — Regular or Orchestrate, never both/);
    assert.match(promptCommands, /Specialist-first, not never-inline/);
    assert.match(promptCommands, /control-plane work/);
    assert.match(promptCommands, /If you dispatch multiple subagents, you SHOULD use that fan-out for truly independent units in parallel/);
    assert.match(promptCommands, /When multiple writer slices are already truly independent, you SHOULD launch them in parallel up to that cap/);
    assert.match(system, /diagnostic experiment plan/);
    assert.match(system, /Do not send Oracle an open-ended brief that combines diagnosis with exhaustive experiment execution/);
    assert.match(system, /Live-page checks go to inspector/);
    assert.match(system, /Live-page checks go to inspector in both modes/);
    assert.match(system, /That pass is one Inspector dispatch/);
    assert.match(system, /Implementation is done by the lead or by specialists per the injected mode card; Inspector and Oracle verify/);
    assert.match(system, /The implementer does not close review/);
    assert.match(system, /Oracle reviews the actual diff/);
    assert.match(system, /regardless of diff size/);
    assert.match(system, /A non-behavioral typo or comment\/identifier correction may use focused inline review/);
    assert.doesNotMatch(system, /Small inline work with an obvious diff: your own focused review is enough/);
    assert.doesNotMatch(system, /A typo or single-token edit may use focused inline review/);
    assert.doesNotMatch(system, /CSS-only chrome/);
    assert.doesNotMatch(system, /inspector only when the user explicitly requests it/);
    assert.doesNotMatch(system, /drive browser checks yourself/);
    assert.match(asyncTask, /Multi-file, long-running, or frontend work may remain inline in regular mode/);
    assert.match(asyncTask, /Duplicate task_start rejected/);
    assert.match(asyncTask, /defaultReportSchemaForAgent/);
    assert.doesNotMatch(asyncTask, /delegates all multi-file implementation/);
    assert.match(advisor, /In regular mode, only when the user explicitly requests advisor consultation/);
    assert.match(inspector, /Live-page checks route here in regular and orchestrate modes/);
    assert.match(inspector, /Do not use 29300 for that pass/);
    assert.match(inspector, /Named project endpoint/);
    assert.doesNotMatch(inspector, /only when the user explicitly requests Inspector/);
    assert.doesNotMatch(inspector, /materially helps/);
    assert.match(oracle, /stop before that mechanical expansion/);
    assert.match(oracle, /do not execute the matrix yourself/);
    assert.match(stevedore, /## Diagnostic experiment mode/);
    assert.match(stevedore, /Do not broaden the experiment/);
  });
});

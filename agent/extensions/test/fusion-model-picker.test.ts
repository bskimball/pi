import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FusionModelPicker, pickFusionModel } from "../prompt-commands/model-picker.ts";

const theme = { fg: (_key: string, text: string) => text } as Theme;
const models = Array.from({ length: 50 }, (_, index) => ({ provider: "local-proxy", id: `model-${String(index).padStart(2, "0")}`, name: `Model ${index}` })) as Model<Api>[];

function picker(scope = new Set<string>(), previous?: string) {
  let selected: Model<Api> | undefined;
  let completed = false;
  let rows = 24;
  const view = new FusionModelPicker("Fusion sidekick model", models, scope, previous, theme, () => rows, model => { selected = model; completed = true; });
  return { view, get selected() { return selected; }, get completed() { return completed; }, resize: (height: number) => { rows = height; } };
}

test("scrolls beyond the first viewport with arrows and pages while keeping selection visible", () => {
  const state = picker();
  assert.doesNotMatch(state.view.render(100).join("\n"), /model-30/);
  for (let index = 0; index < 30; index++) state.view.handleInput("\u001b[B");
  let output = state.view.render(100);
  assert.match(output.join("\n"), /model-30/);
  assert.match(output.join("\n"), /31\/50/);
  assert.ok(output.length <= 14);
  state.view.handleInput("\u001b[6~");
  assert.match(state.view.render(100).join("\n"), /model-38/);
  state.view.handleInput("\u001b[5~");
  state.view.handleInput("\r");
  assert.equal(state.selected?.id, "model-30");
});

test("search finds models outside the initial viewport and cancellation is non-selecting", () => {
  const state = picker();
  state.view.handleInput("model-49");
  assert.match(state.view.render(100).join("\n"), /model-49/);
  assert.doesNotMatch(state.view.render(100).join("\n"), /model-00/);
  state.view.handleInput("\r");
  assert.equal(state.selected?.id, "model-49");
  const canceled = picker();
  canceled.view.handleInput("\u001b");
  assert.equal(canceled.completed, true);
  assert.equal(canceled.selected, undefined);
});

test("uses configured scope with Tab to all configured models and seeds current role", () => {
  const state = picker(new Set(["local-proxy/model-02"]), "local-proxy/model-49");
  assert.match(state.view.render(100).join("\n"), /your model scope/);
  assert.doesNotMatch(state.view.render(100).join("\n"), /model-49/);
  state.view.handleInput("\t");
  assert.match(state.view.render(100).join("\n"), /all configured providers/);
  assert.match(state.view.render(100).join("\n"), /model-49/);
  state.view.handleInput("\r");
  assert.equal(state.selected?.id, "model-49");
});

test("resizes its viewport, bounds row widths, and handles no matches without selecting", () => {
  const state = picker();
  state.resize(16);
  for (const width of [50, 80, 120]) {
    const lines = state.view.render(width);
    assert.ok(lines.length <= 16);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }
  state.view.handleInput("no such model zzz");
  for (const width of [50, 80, 120]) {
    const lines = state.view.render(width);
    assert.match(lines.join("\n"), /No matching models/);
    assert.ok(lines.length <= 16);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }
  state.view.handleInput("\r");
  assert.equal(state.completed, false);
});

test("RPC selection offers configured provider/model identities through select, without refresh or input", async () => {
  const available = [...models].reverse();
  let refreshed = 0;
  let offered: string[] = [];
  let answer: string | undefined = "local-proxy/model-49";
  const ctx: any = {
    mode: "rpc", modelRegistry: { refresh: async () => { refreshed++; }, getAvailable: () => available },
    ui: { select: async (_title: string, options: string[]) => { offered = options; return answer; }, input: async () => assert.fail("input must not be used"), notify() {} },
  };
  assert.equal(await pickFusionModel(ctx, "Fusion lead"), available[0], "returns the exact model object");
  assert.equal(offered.length, models.length);
  assert.equal(offered[0], "local-proxy/model-00", "sorted by provider/id");
  await pickFusionModel(ctx, "Fusion lead", { provider: "local-proxy", modelId: "model-30" });
  assert.equal(offered[0], "local-proxy/model-30", "prior selection first");
  assert.equal(offered[1], "local-proxy/model-00");
  answer = undefined;
  assert.equal(await pickFusionModel(ctx, "Fusion lead"), undefined, "cancel returns undefined");
  assert.equal(refreshed, 0, "the registry snapshot is used without refresh");
  const warnings: string[] = [];
  ctx.modelRegistry.getAvailable = () => [];
  ctx.ui.notify = (text: string) => warnings.push(text);
  assert.equal(await pickFusionModel(ctx, "Fusion lead"), undefined);
  assert.match(warnings.join("\n"), /No models available/);
});

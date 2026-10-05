import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  createExtensionRuntime,
  ExtensionRunner,
  initTheme,
  ToolExecutionComponent,
  type Extension,
  type ExtensionAPI,
  type ToolRendererResolver,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
  getHeadlessReceiptState,
  installHeadlessReceipts,
  registerHeadlessReceipt,
  registerHeadlessReceiptPrefix,
  rememberedToolDefinition,
  resolveHeadlessToolRenderers,
} from "../internal/presentation/headless-receipts.ts";

function renderers(label: string): ToolRenderers {
  const component = () => ({ render: () => [label], invalidate() {} });
  return { renderCall: component, renderResult: component, renderShell: "self" };
}

function runtime() {
  const resolvers: ToolRendererResolver[] = [];
  let active = true;
  const pi = {
    getFlag() { if (!active) throw new Error("invalidated runtime"); },
    registerToolRenderer(resolver: ToolRendererResolver) { resolvers.push(resolver); },
  } as unknown as ExtensionAPI;
  // Exercise Pi's actual resolver chain. Session/model services are unused by it.
  const runner = new ExtensionRunner(
    [{ toolRenderers: resolvers } as Extension], createExtensionRuntime(), process.cwd(),
    {} as never, {} as never,
  );
  return { pi, resolvers, runner, invalidate() { active = false; } };
}

describe("public receipt renderer resolver", () => {
  let previousChrome: string | undefined;
  beforeEach(() => {
    previousChrome = process.env.PI_UI_CHROME;
    process.env.PI_UI_CHROME = "1";
    const state = getHeadlessReceiptState();
    state.registry.clear();
    state.prefixes.length = 0;
    state.seenDefinitions.clear();
    state.owner = undefined;
  });
  afterEach(() => {
    if (previousChrome === undefined) delete process.env.PI_UI_CHROME;
    else process.env.PI_UI_CHROME = previousChrome;
    getHeadlessReceiptState().owner = undefined;
  });

  it("registers once per runtime and leaves Pi's component prototype untouched", () => {
    const before = Object.getOwnPropertyDescriptors(ToolExecutionComponent.prototype);
    const first = runtime();
    installHeadlessReceipts(first.pi);
    installHeadlessReceipts(first.pi);
    assert.equal(first.resolvers.length, 1);
    assert.deepEqual(Object.getOwnPropertyDescriptors(ToolExecutionComponent.prototype), before);
    first.invalidate();
    const next = runtime();
    installHeadlessReceipts(next.pi);
    assert.equal(next.resolvers.length, 1);
    assert.deepEqual(Object.getOwnPropertyDescriptors(ToolExecutionComponent.prototype), before);
  });

  it("composes with Pi's resolver chain while preserving or explicitly overriding owners", () => {
    const host = runtime();
    const mine = renderers("KIT");
    const owned = renderers("OWNER");
    registerHeadlessReceipt("headless", mine as Required<ToolRenderers>);
    registerHeadlessReceipt("override", mine as Required<ToolRenderers>, { overrideOwned: true });
    installHeadlessReceipts(host.pi);
    host.resolvers.push(() => owned);
    assert.equal(host.runner.resolveToolRenderers("headless", () => undefined)?.renderCall, owned.renderCall);
    assert.equal(host.runner.resolveToolRenderers("override", () => undefined)?.renderCall, mine.renderCall);
    assert.equal(rememberedToolDefinition("headless"), owned);
    assert.equal(host.runner.resolveToolRenderers("unregistered", () => undefined), owned);
  });

  it("handles resumed MCP tools before registration, longest prefixes, and exact overrides", () => {
    const host = runtime();
    const broad = renderers("BROAD");
    const narrow = renderers("NARROW");
    const exact = renderers("EXACT");
    registerHeadlessReceiptPrefix("mcp__", broad as Required<ToolRenderers>);
    registerHeadlessReceiptPrefix("mcp__server__", narrow as Required<ToolRenderers>);
    registerHeadlessReceipt("mcp__server__read", exact as Required<ToolRenderers>);
    installHeadlessReceipts(host.pi);
    assert.equal(host.runner.resolveToolRenderers("mcp__other__read", () => undefined)?.renderCall, broad.renderCall);
    assert.equal(host.runner.resolveToolRenderers("mcp__server__list", () => undefined)?.renderCall, narrow.renderCall);
    assert.equal(host.runner.resolveToolRenderers("mcp__server__read", () => undefined)?.renderCall, exact.renderCall);
  });

  it("supports chrome-off startup and live switches on a real existing Pi component", () => {
    initTheme("dark");
    process.env.PI_UI_CHROME = "0";
    const host = runtime();
    const mine = renderers("KIT-RECEIPT");
    registerHeadlessReceipt("probe", mine as Required<ToolRenderers>);
    installHeadlessReceipts(host.pi);
    assert.equal(host.resolvers.length, 1);
    const selected = host.runner.resolveToolRenderers("probe", () => undefined);
    const row = new ToolExecutionComponent("probe", "id", {}, { showImages: false }, selected,
      { requestRender() {} } as never, process.cwd());
    assert.doesNotMatch(row.render(80).join("\n"), /KIT-RECEIPT/);
    process.env.PI_UI_CHROME = "1";
    row.invalidate();
    assert.match(row.render(80).join("\n"), /KIT-RECEIPT/);
    process.env.PI_UI_CHROME = "0";
    row.invalidate();
    assert.doesNotMatch(row.render(80).join("\n"), /KIT-RECEIPT/);
  });

  it("suppresses stale owner chrome and bounds remembered owner renderers", () => {
    const owned = renderers("OWNER");
    registerHeadlessReceipt("powershell", renderers("KIT") as Required<ToolRenderers>, {
      overrideOwned: true, suppressOwnedWhenDisabled: true,
    });
    const selected = resolveHeadlessToolRenderers("powershell", () => owned);
    process.env.PI_UI_CHROME = "0";
    assert.equal(selected?.renderCall, undefined);
    assert.equal(selected?.renderShell, "default");
    for (let i = 0; i < 300; i++) resolveHeadlessToolRenderers(`tool_${i}`, () => owned);
    assert.equal(getHeadlessReceiptState().seenDefinitions.size, 256);
    const host = runtime();
    installHeadlessReceipts(host.pi);
    assert.equal(getHeadlessReceiptState().seenDefinitions.size, 0);
  });
});

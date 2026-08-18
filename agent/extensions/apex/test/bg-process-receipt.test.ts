import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { safeVisibleWidth } from "../internal/presentation/safe-text-layout.ts";
import {
  bgKillReceiptArg,
  bgListReceiptArg,
  bgListReceiptRenderers,
  bgStartReceiptArg,
  bgStartReceiptRenderers,
  bgStatusReceiptArg,
  bgStatusReceiptRenderers,
  installBgProcessReceipts,
} from "../internal/presentation/bg-process-receipt.ts";

const theme = {
  fg: (_key: string, text: string) => text,
  bg: (_key: string, text: string) => text,
  inverse: (text: string) => text,
};

function context(args: any, overrides: Record<string, unknown> = {}): any {
  return {
    args,
    state: {},
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    invalidate() {},
    ...overrides,
  };
}

function withApexUi<T>(value: string, run: () => T): T {
  const previous = process.env.PI_APEX_UI;
  process.env.PI_APEX_UI = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.PI_APEX_UI;
    else process.env.PI_APEX_UI = previous;
  }
}

function stubUi() {
  return { requestRender() {} };
}

// install still registers the settlement message renderer.
function fakePi() {
  return { registerMessageRenderer() {} } as any;
}

describe("apex bg-process receipts", () => {
  it("formats compact header arguments", () => {
    assert.equal(
      bgStartReceiptArg({ command: "npm run dev", title: "dev" }, 80),
      "dev (npm run dev)",
    );
    assert.equal(bgStartReceiptArg({ command: "npm run dev" }, 80), "npm run dev");
    assert.equal(
      bgStartReceiptArg({ command: "npm run dev", title: "npm run dev" }, 80),
      "npm run dev",
    );
    assert.equal(bgStartReceiptArg({}, 80), "start");

    assert.equal(bgStatusReceiptArg({ id: "bg_3" }, 80), "bg_3");
    assert.equal(bgStatusReceiptArg({}, 80), "status");

    assert.equal(bgListReceiptArg({ include_settled: false }, 80), "running only");
    assert.equal(bgListReceiptArg({ include_settled: true }, 80), "all");
    assert.equal(bgListReceiptArg({}, 80), "all");
    assert.equal(bgListReceiptArg(undefined, 80), "list");

    assert.equal(bgKillReceiptArg({ id: "bg_7" }, 80), "bg_7");
    assert.equal(bgKillReceiptArg({}, 80), "kill");
  });

  it("renders bg_start as an Apex receipt instead of boxed JSON args", () => {
    const args = { command: "npm run dev", title: "dev" };
    const ctx = context(args);
    const call = bgStartReceiptRenderers
      .renderCall(args, theme, ctx)
      .render(80)
      .join("\n");
    assert.match(call, /bg_start/);
    assert.match(call, /dev \(npm run dev\)/);
    assert.doesNotMatch(call, /┌|┐|└|┘/);
    assert.doesNotMatch(call, /"command"/);

    const rendered = bgStartReceiptRenderers
      .renderResult(
        {
          content: [
            { type: "text", text: "Started bg_1: dev\nnpm run dev (pid 4321)" },
          ],
          details: {
            bg: { job: { id: "bg_1", status: "running", pid: 4321 } },
          },
        },
        { expanded: false, isPartial: false },
        theme,
        ctx,
      )
      .render(80);
    const text = rendered.join("\n");
    assert.match(text, /bg_start/);
    assert.match(text, /running/);
    assert.match(text, /pid 4321/);
    assert.match(text, /Started bg_1/);
    assert.doesNotMatch(text, /┌|┐|└|┘/);
    assert.ok(rendered.every((line: string) => safeVisibleWidth(line) <= 80));
  });

  it("renders bg_list counts as receipt stats", () => {
    const args = { include_settled: false };
    const ctx = context(args);
    const call = bgListReceiptRenderers
      .renderCall(args, theme, ctx)
      .render(80)
      .join("\n");
    assert.match(call, /bg_list/);
    assert.match(call, /running only/);
    assert.doesNotMatch(call, /┌|┐|└|┘/);
    assert.doesNotMatch(call, /"include_settled"/);

    const rendered = bgListReceiptRenderers
      .renderResult(
        {
          content: [{ type: "text", text: "bg_1 running dev\nbg_2 completed build" }],
          details: {
            bg: { jobs: [], running: 1, total: 3, includeSettled: false },
          },
        },
        { expanded: false, isPartial: false },
        theme,
        ctx,
      )
      .render(80);
    const text = rendered.join("\n");
    assert.match(text, /1 running/);
    assert.match(text, /3 total/);
    assert.match(text, /bg_1 running dev/);
    assert.doesNotMatch(text, /┌|┐|└|┘/);
    assert.ok(rendered.every((line: string) => safeVisibleWidth(line) <= 80));
  });

  it("reports settled exit codes in bg_status stats", () => {
    const args = { id: "bg_2" };
    const text = bgStatusReceiptRenderers
      .renderResult(
        {
          content: [{ type: "text", text: "bg_2 failed" }],
          details: {
            bg: { job: { id: "bg_2", status: "failed", exitCode: 1 } },
          },
        },
        { expanded: false, isPartial: false },
        theme,
        context(args),
      )
      .render(80)
      .join("\n");
    assert.match(text, /failed/);
    assert.match(text, /exit 1/);
  });

  it("wraps bg_status ToolExecutionComponent getters", () => {
    withApexUi("1", () => installBgProcessReceipts(fakePi()));
    const proto = ToolExecutionComponent.prototype as any;
    const status = {
      toolName: "bg_status",
      toolDefinition: { name: "bg_status" },
    };
    assert.equal(
      proto.getCallRenderer.call(status),
      bgStatusReceiptRenderers.renderCall,
    );
    assert.equal(
      proto.getResultRenderer.call(status),
      bgStatusReceiptRenderers.renderResult,
    );
    assert.equal(proto.getRenderShell.call(status), "self");
    assert.equal(proto.hasRendererDefinition.call(status), true);

    const owned = {
      toolName: "bg_status",
      toolDefinition: {
        name: "bg_status",
        renderCall: () => ({ render: () => ["OWN"], invalidate() {} }),
      },
    };
    assert.notEqual(
      proto.getCallRenderer.call(owned),
      bgStatusReceiptRenderers.renderCall,
    );
    assert.equal(proto.getRenderShell.call(owned), "default");
  });

  it("renders a real bg_list ToolExecutionComponent as an Apex receipt", () => {
    initTheme("dark");
    withApexUi("1", () => installBgProcessReceipts(fakePi()));

    const args = { include_settled: true };
    const component = new ToolExecutionComponent(
      "bg_list",
      "call-1",
      args,
      { showImages: false },
      { name: "bg_list" } as any,
      stubUi() as any,
      process.cwd(),
    );
    component.markExecutionStarted();
    component.updateResult({
      content: [
        {
          type: "text",
          text: "bg_1 running dev — npm run dev\nbg_2 completed build — npm run build",
        },
      ],
      details: {
        bg: { jobs: [], running: 1, total: 2, includeSettled: true },
      },
      isError: false,
    });

    const lines = component.render(80);
    const text = lines.join("\n");
    assert.match(text, /bg_list/);
    assert.match(text, /all/);
    assert.match(text, /1 running/);
    assert.match(text, /bg_1 running dev/);
    assert.doesNotMatch(text, /┌|┐|└|┘/);
    assert.ok(lines.every((line) => safeVisibleWidth(line) <= 80));
  });

  it("keeps the receipt registry live across Apex module reloads", async () => {
    withApexUi("1", () => installBgProcessReceipts(fakePi()));
    const moduleUrl = new URL(
      "../internal/presentation/headless-receipts.ts",
      import.meta.url,
    );
    moduleUrl.search = "bg-reload-regression";
    const reloaded = await import(moduleUrl.href);
    const renderCall = () => ({
      render: () => ["RELOADED CALL"],
      invalidate() {},
    });
    const renderResult = () => ({
      render: () => ["RELOADED RESULT"],
      invalidate() {},
    });
    reloaded.registerHeadlessReceipt("bg_reload_probe", {
      renderCall,
      renderResult,
    });

    const proto = ToolExecutionComponent.prototype as any;
    const probe = {
      toolName: "bg_reload_probe",
      toolDefinition: { name: "bg_reload_probe" },
    };
    assert.equal(proto.getCallRenderer.call(probe), renderCall);
    assert.equal(proto.getResultRenderer.call(probe), renderResult);
    assert.equal(proto.getRenderShell.call(probe), "self");
  });

  it("skips the wrap when PI_APEX_UI=0", () => {
    const previous = process.env.PI_APEX_UI;
    const proto = ToolExecutionComponent.prototype as any;
    const before = proto.getCallRenderer;
    process.env.PI_APEX_UI = "0";
    try {
      installBgProcessReceipts(fakePi());
      assert.equal(proto.getCallRenderer, before);
    } finally {
      if (previous === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = previous;
    }
  });
});

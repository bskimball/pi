import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { safeVisibleWidth } from "../internal/presentation/safe-text-layout.ts";

const {
  POWERSHELL_RECEIPT_TOOL,
  installPowerShellReceipts,
  powershellExecutableName,
  powershellOwnsPresentation,
  powershellReceiptArg,
  powershellReceiptRenderers,
} = await import("../internal/presentation/powershell-receipt.ts");

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

describe("apex powershell receipts", () => {
  it("formats a compact header argument", () => {
    assert.equal(
      powershellReceiptArg({ command: "Get-Service wuauserv" }, 80),
      "Get-Service wuauserv",
    );
    assert.equal(
      powershellReceiptArg(
        {
          command: "Get-ChildItem\nWhere-Object Name -eq 'foo'\nSelect-Object FullName",
        },
        80,
      ),
      "Get-ChildItem +2 lines",
    );
    assert.equal(
      powershellReceiptArg({ command: "Get-Item HKLM:\\SOFTWARE", timeout: 15 }, 80),
      "Get-Item HKLM:\\SOFTWARE 15s",
    );
    assert.equal(powershellReceiptArg({}, 80), "powershell");
    assert.equal(
      powershellExecutableName(
        "C:\\Program Files\\PowerShell\\7\\very-long-custom-pwsh-host.exe",
      ),
      "very-long-custom-pwsh-host.exe",
    );
  });

  it("renders an Apex receipt instead of boxed JSON args", () => {
    const args = { command: "Get-Date" };
    const ctx = context(args);
    const call = powershellReceiptRenderers
      .renderCall(args, theme, ctx)
      .render(80)
      .join("\n");
    assert.match(call, /powershell/);
    assert.match(call, /Get-Date/);
    assert.doesNotMatch(call, /┌|┐|└|┘/);
    assert.doesNotMatch(call, /"command"/);

    const rendered = powershellReceiptRenderers
      .renderResult(
        {
          content: [{ type: "text", text: "Monday, August 17, 2026 9:41:00 AM" }],
          details: {
            exitCode: 0,
            truncated: false,
            timedOut: false,
            aborted: false,
            executable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
          },
        },
        { expanded: false, isPartial: false },
        theme,
        ctx,
      )
      .render(80);
    const text = rendered.join("\n");
    assert.match(text, /powershell/);
    assert.match(text, /exit 0/);
    assert.match(text, /pwsh\.exe/);
    assert.match(text, /Monday, August 17/);
    assert.doesNotMatch(text, /┌|┐|└|┘/);
    assert.ok(rendered.every((line: string) => safeVisibleWidth(line) <= 80));
  });

  it("blanks the call row once the result receipt exists", () => {
    const args = { command: "Write-Output hi" };
    const ctx = context(args);
    const callComponent = powershellReceiptRenderers.renderCall(args, theme, ctx);
    assert.match(callComponent.render(80).join("\n"), /Write-Output hi/);

    powershellReceiptRenderers.renderResult(
      {
        content: [{ type: "text", text: "hi" }],
        details: { exitCode: 0 },
      },
      { expanded: false, isPartial: false },
      theme,
      ctx,
    );
    assert.deepEqual(callComponent.render(80), []);
  });

  it("wraps powershell ToolExecutionComponent getters and leaves others alone", () => {
    withApexUi("1", () => {
      installPowerShellReceipts();
      const proto = ToolExecutionComponent.prototype as any;

      const tool = {
        toolName: POWERSHELL_RECEIPT_TOOL,
        toolDefinition: { name: "powershell" },
      };
      assert.equal(powershellOwnsPresentation(tool), false);
      assert.equal(
        proto.getCallRenderer.call(tool),
        powershellReceiptRenderers.renderCall,
      );
      assert.equal(
        proto.getResultRenderer.call(tool),
        powershellReceiptRenderers.renderResult,
      );
      assert.equal(proto.getRenderShell.call(tool), "self");
      assert.equal(proto.hasRendererDefinition.call(tool), true);

      const ownCall = () => ({ render: () => ["OWN-CALL"], invalidate() {} });
      const ownResult = () => ({ render: () => ["OWN-RESULT"], invalidate() {} });
      const ownedBoth = {
        toolName: POWERSHELL_RECEIPT_TOOL,
        toolDefinition: {
          name: "powershell",
          renderCall: ownCall,
          renderResult: ownResult,
        },
      };
      assert.equal(proto.getCallRenderer.call(ownedBoth), ownCall);
      assert.equal(proto.getResultRenderer.call(ownedBoth), ownResult);
      assert.equal(proto.getRenderShell.call(ownedBoth), "default");

      const ownedCallOnly = {
        toolName: POWERSHELL_RECEIPT_TOOL,
        toolDefinition: { name: "powershell", renderCall: ownCall },
      };
      assert.equal(proto.getCallRenderer.call(ownedCallOnly), ownCall);
      assert.equal(proto.getResultRenderer.call(ownedCallOnly), undefined);
      assert.equal(proto.getRenderShell.call(ownedCallOnly), "default");

      const ownedShell = {
        toolName: POWERSHELL_RECEIPT_TOOL,
        toolDefinition: { name: "powershell", renderShell: "default" },
      };
      assert.equal(powershellOwnsPresentation(ownedShell), false);
      assert.equal(proto.getRenderShell.call(ownedShell), "self");

      const other = {
        toolName: "bash",
        toolDefinition: { name: "bash" },
      };
      assert.equal(proto.getCallRenderer.call(other), undefined);
      assert.equal(proto.getResultRenderer.call(other), undefined);
      assert.equal(proto.getRenderShell.call(other), "default");
    });
  });

  it("renders a real ToolExecutionComponent as an Apex receipt", () => {
    initTheme("dark");
    withApexUi("1", () => {
      installPowerShellReceipts();

      const args = { command: "Get-Location" };
      const component = new ToolExecutionComponent(
        "powershell",
        "call-1",
        args,
        { showImages: false },
        { name: "powershell" } as any,
        stubUi() as any,
        process.cwd(),
      );
      component.markExecutionStarted();
      component.updateResult({
        content: [{ type: "text", text: "C:\\Users\\bskim\\.pi" }],
        details: {
          exitCode: 0,
          truncated: false,
          timedOut: false,
          aborted: false,
          executable: "pwsh.exe",
        },
        isError: false,
      });

      const lines = component.render(80);
      const text = lines.join("\n");
      assert.match(text, /powershell/);
      assert.match(text, /Get-Location/);
      assert.match(text, /C:\\Users\\bskim\\.pi/);
      assert.doesNotMatch(text, /┌|┐|└|┘/);
      assert.equal((text.match(/powershell/g) ?? []).length, 1);
      assert.ok(lines.every((line) => safeVisibleWidth(line) <= 80));
    });
  });

  it("skips the wrap when PI_APEX_UI=0", () => {
    const previous = process.env.PI_APEX_UI;
    const proto = ToolExecutionComponent.prototype as any;
    const before = proto.getCallRenderer;
    process.env.PI_APEX_UI = "0";
    try {
      installPowerShellReceipts();
      assert.equal(proto.getCallRenderer, before);
    } finally {
      if (previous === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = previous;
    }
  });
});

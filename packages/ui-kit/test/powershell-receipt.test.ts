import { resolveReceiptFor, ReceiptToolExecutionComponent } from "./receipt-test-host.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { safeVisibleWidth } from "@pi/ui-kit/internal/presentation/safe-text-layout.ts";

import {
  POWERSHELL_RECEIPT_TOOL,
  installPowerShellReceipts,
  powershellExecutableName,
  powershellOwnsPresentation,
  powershellReceiptArg,
  powershellReceiptRenderers,
} from "../internal/presentation/powershell-receipt.ts";

import {
} from "../internal/presentation/headless-receipts.ts";

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
  const previousApex = process.env.PI_APEX_UI;
  const previousChrome = process.env.PI_UI_CHROME;
  process.env.PI_APEX_UI = value;
  process.env.PI_UI_CHROME = value;
  try {
    return run();
  } finally {
    if (previousApex === undefined) delete process.env.PI_APEX_UI;
    else process.env.PI_APEX_UI = previousApex;
    if (previousChrome === undefined) delete process.env.PI_UI_CHROME;
    else process.env.PI_UI_CHROME = previousChrome;
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

  it("resolves powershell tool renderers through the public API and leaves others alone", () => {
    withApexUi("1", () => {
      installPowerShellReceipts();

      const tool = {
        toolName: POWERSHELL_RECEIPT_TOOL,
        toolDefinition: { name: "powershell" },
      };
      assert.equal(powershellOwnsPresentation(tool), false);
      assert.equal(
        resolveReceiptFor(tool)?.renderCall,
        powershellReceiptRenderers.renderCall,
      );
      assert.equal(
        resolveReceiptFor(tool)?.renderResult,
        powershellReceiptRenderers.renderResult,
      );
      assert.equal(resolveReceiptFor(tool)?.renderShell ?? "default", "self");
      assert.equal(Boolean(resolveReceiptFor(tool)), true);

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
      assert.equal(
        resolveReceiptFor(ownedBoth)?.renderCall,
        powershellReceiptRenderers.renderCall,
      );
      assert.equal(
        resolveReceiptFor(ownedBoth)?.renderResult,
        powershellReceiptRenderers.renderResult,
      );
      assert.equal(resolveReceiptFor(ownedBoth)?.renderShell ?? "default", "self");

      const ownedCallOnly = {
        toolName: POWERSHELL_RECEIPT_TOOL,
        toolDefinition: { name: "powershell", renderCall: ownCall },
      };
      assert.equal(
        resolveReceiptFor(ownedCallOnly)?.renderCall,
        powershellReceiptRenderers.renderCall,
      );
      assert.equal(
        resolveReceiptFor(ownedCallOnly)?.renderResult,
        powershellReceiptRenderers.renderResult,
      );
      assert.equal(resolveReceiptFor(ownedCallOnly)?.renderShell ?? "default", "self");

      const ownedShell = {
        toolName: POWERSHELL_RECEIPT_TOOL,
        toolDefinition: { name: "powershell", renderShell: "default" },
      };
      assert.equal(powershellOwnsPresentation(ownedShell), false);
      assert.equal(resolveReceiptFor(ownedShell)?.renderShell ?? "default", "self");

      const other = {
        toolName: "bash",
        toolDefinition: { name: "bash" },
      };
      assert.equal(resolveReceiptFor(other)?.renderCall, undefined);
      assert.equal(resolveReceiptFor(other)?.renderResult, undefined);
      assert.equal(resolveReceiptFor(other)?.renderShell ?? "default", "default");
    });
  });

  it("renders a real ToolExecutionComponent as an Apex receipt", () => {
    initTheme("dark");
    withApexUi("1", () => {
      installPowerShellReceipts();

      const args = { command: "Get-Location" };
      const component = new ReceiptToolExecutionComponent(
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

  it("renders a real ToolExecutionComponent even when a stale renderer owns the tool", () => {
    initTheme("dark");
    withApexUi("1", () => {
      installPowerShellReceipts();

      const args = { command: "Get-Date" };
      const staleCall = () => ({
        render: () => ["PS> Get-Date (timeout 30s)"],
        invalidate() {},
      });
      const staleResult = () => ({
        render: () => ["Took 1.4s"],
        invalidate() {},
      });
      const component = new ReceiptToolExecutionComponent(
        "powershell",
        "call-stale-1",
        args,
        { showImages: false },
        {
          name: "powershell",
          renderCall: staleCall,
          renderResult: staleResult,
          renderShell: "self",
        } as any,
        stubUi() as any,
        process.cwd(),
      );
      component.markExecutionStarted();
      component.updateResult({
        content: [{ type: "text", text: "Monday, August 17, 2026 9:41:00 AM" }],
        details: {
          exitCode: 0,
          truncated: false,
          timedOut: false,
          aborted: false,
          executable: "pwsh.exe",
        },
        isError: false,
      });

      const text = component.render(80).join("\n");
      assert.match(text, /powershell/);
      assert.match(text, /Get-Date/);
      assert.match(text, /Monday, August 17/);
      assert.doesNotMatch(text, /PS>/);
      assert.doesNotMatch(text, /Took 1\.4s/);
      assert.doesNotMatch(text, /┌|┐|└|┘/);
    });
  });

  it("suppresses stale powershell renderers when Apex is toggled off", () => {
    withApexUi("1", () => {
      installPowerShellReceipts();
      const staleCall = () => ({ render: () => ["STALE-CALL"], invalidate() {} });
      const staleResult = () => ({
        render: () => ["STALE-RESULT"],
        invalidate() {},
      });
      const tool = {
        toolName: POWERSHELL_RECEIPT_TOOL,
        toolDefinition: {
          name: "powershell",
          renderCall: staleCall,
          renderResult: staleResult,
          renderShell: "self",
        },
      };

      assert.equal(
        resolveReceiptFor(tool)?.renderCall,
        powershellReceiptRenderers.renderCall,
      );
      assert.equal(
        resolveReceiptFor(tool)?.renderResult,
        powershellReceiptRenderers.renderResult,
      );
      assert.equal(resolveReceiptFor(tool)?.renderShell ?? "default", "self");

      process.env.PI_APEX_UI = "0";
      process.env.PI_UI_CHROME = "0";
      assert.equal(resolveReceiptFor(tool)?.renderCall, undefined);
      assert.equal(resolveReceiptFor(tool)?.renderResult, undefined);
      assert.equal(resolveReceiptFor(tool)?.renderShell ?? "default", "default");
      assert.equal(Boolean(resolveReceiptFor(tool)), true);

      process.env.PI_APEX_UI = "1";
      process.env.PI_UI_CHROME = "1";
      assert.equal(
        resolveReceiptFor(tool)?.renderCall,
        powershellReceiptRenderers.renderCall,
      );
      assert.equal(
        resolveReceiptFor(tool)?.renderResult,
        powershellReceiptRenderers.renderResult,
      );
      assert.equal(resolveReceiptFor(tool)?.renderShell ?? "default", "self");
    });
  });

  it("renders stock Pi chrome when the public receipt resolver is disabled", () => {
    initTheme("dark");
    withApexUi("1", () => installPowerShellReceipts());

    withApexUi("0", () => {
      const component = new ReceiptToolExecutionComponent(
        "powershell",
        "call-disabled-1",
        { command: "Get-Date" },
        { showImages: false },
        {
          name: "powershell",
          renderCall: () => ({
            render: () => ["PS> Get-Date"],
            invalidate() {},
          }),
          renderResult: () => ({
            render: () => ["Took 1.4s"],
            invalidate() {},
          }),
          renderShell: "self",
        } as any,
        stubUi() as any,
        process.cwd(),
      );
      component.markExecutionStarted();
      component.updateResult({
        content: [{ type: "text", text: "Monday, August 17, 2026" }],
        details: { exitCode: 0 },
        isError: false,
      });

      const text = component.render(80).join("\n");
      assert.doesNotMatch(text, /PS>/);
      assert.doesNotMatch(text, /Took 1\.4s/);
      assert.doesNotMatch(text, /Apex/i);
      assert.match(text, /powershell|Get-Date|Monday, August 17/i);
    });
  });

  it("skips the wrap when PI_APEX_UI=0", () => {
    const previousApex = process.env.PI_APEX_UI;
    const previousChrome = process.env.PI_UI_CHROME;
    const proto = ToolExecutionComponent.prototype as any;
    const before = proto.getCallRenderer;
    process.env.PI_APEX_UI = "0";
    process.env.PI_UI_CHROME = "0";
    try {
      installPowerShellReceipts();
      assert.equal(proto.getCallRenderer, before);
    } finally {
      if (previousApex === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = previousApex;
      if (previousChrome === undefined) delete process.env.PI_UI_CHROME;
      else process.env.PI_UI_CHROME = previousChrome;
    }
  });
});

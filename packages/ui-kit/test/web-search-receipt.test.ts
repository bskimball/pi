import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { safeVisibleWidth } from "@pi/ui-kit/internal/presentation/safe-text-layout.ts";
import {
  installJevReceipts,
  JEV_TOOL,
  jevReceiptArg,
  jevReceiptRenderers,
} from "@pi/ui-kit/internal/presentation/jev-receipt.ts";
import {
  fetchContentReceiptRenderers,
  installWebSearchReceipts,
  webSearchReceiptRenderers,
} from "@pi/ui-kit/internal/presentation/web-search-receipt.ts";

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

describe("apex web-search receipts", () => {
  it("renders an Apex receipt instead of boxed JSON args", () => {
    const args = { query: "pi coding agent" };
    const ctx = context(args);
    const call = webSearchReceiptRenderers
      .renderCall(args, theme, ctx)
      .render(80)
      .join("\n");
    assert.match(call, /web_search/);
    assert.match(call, /pi coding agent/);
    assert.doesNotMatch(call, /┌|┐|└|┘/);
    assert.doesNotMatch(call, /"query"/);

    const rendered = webSearchReceiptRenderers
      .renderResult(
        {
          content: [{ type: "text", text: "1. Result title\nhttps://example.com" }],
          details: { resultCount: 1, queryCount: 1 },
        },
        { expanded: false, isPartial: false },
        theme,
        ctx,
      )
      .render(80);
    const text = rendered.join("\n");
    assert.match(text, /web_search/);
    assert.match(text, /1 result/);
    assert.match(text, /Result title/);
    assert.doesNotMatch(text, /┌|┐|└|┘/);
    assert.ok(rendered.every((line: string) => safeVisibleWidth(line) <= 80));
  });

  it("wraps fetch_content ToolExecutionComponent getters", () => {
    withApexUi("1", () => {
      installWebSearchReceipts();
    const proto = ToolExecutionComponent.prototype as any;
    const fetch = {
      toolName: "fetch_content",
      toolDefinition: { name: "fetch_content" },
    };
    assert.equal(
      proto.getCallRenderer.call(fetch),
      fetchContentReceiptRenderers.renderCall,
    );
    assert.equal(
      proto.getResultRenderer.call(fetch),
      fetchContentReceiptRenderers.renderResult,
    );
    assert.equal(proto.getRenderShell.call(fetch), "self");
    assert.equal(proto.hasRendererDefinition.call(fetch), true);

    const owned = {
      toolName: "fetch_content",
      toolDefinition: {
        name: "fetch_content",
        renderCall: () => ({ render: () => ["OWN"], invalidate() {} }),
      },
    };
    assert.notEqual(
      proto.getCallRenderer.call(owned),
      fetchContentReceiptRenderers.renderCall,
    );
    assert.equal(proto.getRenderShell.call(owned), "default");
    });
  });

  it("renders a real fetch_content ToolExecutionComponent as an Apex receipt", () => {
    initTheme("dark");
    withApexUi("1", () => {
      installWebSearchReceipts();

    const args = { url: "https://example.com/docs" };
    const component = new ToolExecutionComponent(
      "fetch_content",
      "call-1",
      args,
      { showImages: false },
      { name: "fetch_content" } as any,
      stubUi() as any,
      process.cwd(),
    );
    component.markExecutionStarted();
    component.updateResult({
      content: [
        {
          type: "text",
          text: "# Docs\nSource: https://example.com/docs\n\nHello world.",
        },
      ],
      details: { host: "example.com", urlCount: 1, contentLength: 12 },
      isError: false,
    });

    const lines = component.render(80);
    const text = lines.join("\n");
    assert.match(text, /fetch_content/);
    assert.match(text, /example.com\/docs/);
    assert.match(text, /Hello world/);
    assert.doesNotMatch(text, /┌|┐|└|┘/);
    assert.ok(lines.every((line) => safeVisibleWidth(line) <= 80));
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
      installWebSearchReceipts();
      assert.equal(proto.getCallRenderer, before);
    } finally {
      if (previousApex === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = previousApex;
      if (previousChrome === undefined) delete process.env.PI_UI_CHROME;
      else process.env.PI_UI_CHROME = previousChrome;
    }
  });
});

describe("kit jev receipts", () => {
  const jevArgs = {
    state: "The customer was charged twice and requests a refund.",
    questions: {
      department: { type: "choice", instructions: "Which team handles this?", criteria: { billing: "Charges", shipping: "Delivery" } },
      refund_requested: { type: "noul", instructions: "Does the customer request a refund?" },
      billing_relevance: { type: "score", instructions: "How relevant?", criteria: ["unrelated", "partly related", "directly related"] },
    },
  };
  const jevResult = {
    content: [{ type: "text", text: "compact" }],
    details: {
      model: "jev-1.13.0",
      answers: {
        department: { type: "choice", choice: "billing", confidence: 1, probabilities: { billing: 1, shipping: 0 } },
        refund_requested: { type: "noul", noul: 0.99 },
        billing_relevance: { type: "score", score: 2, confidence: 1, legend: { 0: "unrelated", 1: "partly related", 2: "directly related" }, probabilities: { 0: 0, 1: 0, 2: 1 } },
      },
      usage: { input_tokens: 387, output_tokens: 65 },
    },
    isError: false,
  };

  it("renders a header with question count, not the state", () => {
    assert.equal(
      jevReceiptArg(jevArgs, 120),
      "3 questions: department (choice), refund_requested (noul) +1 more",
    );
    const ctx = context(jevArgs);
    const call = jevReceiptRenderers.renderCall(jevArgs, theme, ctx).render(80).join("\n");
    assert.match(call, /jev/);
    assert.match(call, /3 questions/);
    assert.doesNotMatch(call, /charged twice/);
    assert.doesNotMatch(call, /┌|┐|└|┘/);
  });

  it("renders compact Choice, Noul, and Score lines plus usage", () => {
    const ctx = context(jevArgs);
    const text = jevReceiptRenderers.renderResult(jevResult, { expanded: false, isPartial: false }, theme, ctx).render(80).join("\n");
    assert.match(text, /jev/);
    assert.match(text, /department: billing \(conf 1\)/);
    assert.match(text, /refund_requested: 0\.99/);
    assert.doesNotMatch(text, /refund_requested: yes/i);
    assert.match(text, /billing_relevance: 2 \(conf 1\)/);
    assert.doesNotMatch(text, /\/2|of 3|denominator/);
    assert.match(text, /in 387/);
    assert.match(text, /out 65/);
    assert.doesNotMatch(text, /probabilities/);
    assert.doesNotMatch(text, /┌|┐|└|┘/);
  });

  it("keeps Noul, confidence, and probabilities exact", () => {
    const ctx = context(jevArgs);
    const details = {
      answers: {
        almost: { type: "noul", noul: 0.4999 },
        nearOne: { type: "noul", noul: 0.9999 },
        picked: { type: "choice", choice: "b", confidence: 0.4999, probabilities: { a: 0.4999, b: 0.5001 } },
      },
      usage: { input_tokens: 3, output_tokens: 1 },
    };
    const text = jevReceiptRenderers.renderResult(
      { content: [{ type: "text", text: "x" }], details, isError: false },
      { expanded: false, isPartial: false }, theme, ctx,
    ).render(120).join("\n");
    assert.match(text, /almost: 0\.4999/);
    assert.match(text, /nearOne: 0\.9999/);
    assert.match(text, /picked: b \(conf 0\.4999\)/);
    assert.doesNotMatch(text, /conf 0\.50\b/);
    const expanded = jevReceiptRenderers.renderResult(
      { content: [{ type: "text", text: "x" }], details, isError: false },
      { expanded: true, isPartial: false }, theme, ctx,
    ).render(120).join("\n");
    assert.match(expanded, /a=0\.4999, b=0\.5001/);
  });

  it("bounds long values and many questions", () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 16; i++) many[`q${i}`] = { type: "noul", instructions: `Question number ${i} with a very long instruction tail that should be trimmed` };
    const longResult = {
      content: [{ type: "text", text: "compact" }],
      details: {
        answers: Object.fromEntries(Object.entries(many).map(([id]) => [id, { type: "noul", noul: 0.5 }])),
        usage: { input_tokens: 10, output_tokens: 2 },
      },
      isError: false,
    };
    const ctx = context({ state: "s", questions: many });
    const lines = jevReceiptRenderers.renderResult(longResult, { expanded: false, isPartial: false }, theme, ctx).render(40);
    assert.ok(lines.every((line: string) => safeVisibleWidth(line) <= 40));
    const text = lines.join("\n");
    assert.match(text, /more answer/);
    assert.match(text, /in 10/);
    assert.match(text, /out 2/);
    assert.doesNotMatch(text, /more lines|truncated/);
    const longValue = `x${"y".repeat(600)}`;
    const wide = jevReceiptRenderers.renderResult(
      { content: [{ type: "text", text: "compact" }], details: { answers: { big: { type: "choice", choice: longValue, confidence: 0.9, probabilities: { [longValue]: 1 } } }, usage: { input_tokens: 1, output_tokens: 1 } }, isError: false },
      { expanded: false, isPartial: false }, theme, ctx,
    ).render(80);
    assert.ok(wide.every((line: string) => safeVisibleWidth(line) <= 80));
    assert.match(wide.join("\n"), new RegExp(`big: x${"y".repeat(20)}`));
  });

  it("shows an honest fallback on partial or malformed answers", () => {
    const ctx = context(jevArgs);
    const partial = jevReceiptRenderers.renderResult(
      { content: [{ type: "text", text: "fallback body" }], details: {}, isError: false },
      { expanded: false, isPartial: false }, theme, ctx,
    ).render(80).join("\n");
    assert.match(partial, /fallback body/);
    const broken = jevReceiptRenderers.renderResult(
      { content: [{ type: "text", text: "x" }], details: { answers: { department: { type: "choice" } } }, isError: false },
      { expanded: false, isPartial: false }, theme, ctx,
    ).render(80);
    assert.ok(broken.join("\n").length > 0);
  });

  it("expands to model, legends, probabilities, and usage", () => {
    const ctx = context(jevArgs);
    const text = jevReceiptRenderers.renderResult(jevResult, { expanded: true, isPartial: false }, theme, ctx).render(120).join("\n");
    assert.match(text, /jev-1\.13\.0/);
    assert.match(text, /billing=1/);
    assert.match(text, /directly related/);
    assert.match(text, /in 387/);
    assert.ok(text.split("\n").every((line: string) => safeVisibleWidth(line) <= 120));
  });

  it("renders structured legend labels as bounded text", () => {
    const ctx = context(jevArgs);
    const details = {
      answers: {
        structured: { type: "score", score: 1.5, confidence: 0.6, legend: { 0: { label: "low", hint: "rare" }, 1: ["mid", "tier"], 2: "high" }, probabilities: { 0: 0.2, 1: 0.3, 2: 0.5 } },
      },
      usage: { input_tokens: 4, output_tokens: 2 },
    };
    const text = jevReceiptRenderers.renderResult(
      { content: [{ type: "text", text: "x" }], details, isError: false },
      { expanded: true, isPartial: false }, theme, ctx,
    ).render(120).join("\n");
    assert.match(text, /"label":"low"/);
    assert.match(text, /mid/);
    assert.doesNotMatch(text, /\[object Object\]/);
  });

  it("renders errors as bounded text without invented answers", () => {
    const ctx = context(jevArgs);
    const text = jevReceiptRenderers.renderResult(
      { content: [{ type: "text", text: "Jev request failed: HTTP 402: no balance" }], details: {}, isError: true },
      { expanded: false, isPartial: false }, theme, ctx,
    ).render(80).join("\n");
    assert.match(text, /HTTP 402/);
    assert.doesNotMatch(text, /billing|conf/);
  });

  it("renders a real jev ToolExecutionComponent receipt", () => {
    initTheme("dark");
    withApexUi("1", () => {
      installJevReceipts();
      const realContent = JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          department: { type: "choice", choice: "billing", confidence: 1 },
          refund_requested: { type: "noul", noul: 0.99 },
          billing_relevance: { type: "score", score: 2, confidence: 1, legend: { 0: "unrelated", 1: "partly related", 2: "directly related" } },
        },
        usage: { input_tokens: 387, output_tokens: 65 },
      });
      for (const skin of [undefined, "apex", "claude", "hal"] as const) {
        const previousSkin = process.env.PI_UI_SKIN;
        try {
          if (skin === undefined) delete process.env.PI_UI_SKIN;
          else process.env.PI_UI_SKIN = skin;
          const component = new ToolExecutionComponent(
            JEV_TOOL,
            `call-${skin ?? "unset"}`,
            jevArgs,
            { showImages: false },
            { name: JEV_TOOL } as any,
            stubUi() as any,
            process.cwd(),
          );
          component.markExecutionStarted();
          component.updateResult({
            content: [{ type: "text", text: realContent }],
            details: (jevResult as any).details,
            isError: false,
          });
          for (const width of [40, 120]) {
            const lines = component.render(width);
            const text = lines.join("\n");
            assert.match(text, /jev/);
            assert.match(text, /department: billing/);
            assert.match(text, /refund_requested: 0\.99/);
            assert.match(text, /billing_relevance: 2/);
            assert.match(text, /in 387/);
            assert.doesNotMatch(text, /charged twice/);
            assert.ok(lines.every((line: string) => safeVisibleWidth(line) <= width), `${skin ?? "unset"}@${width}`);
          }
          const collapsed = component.render(80).join("\n");
          assert.doesNotMatch(collapsed, /┌|┐|└|┘/);
        } finally {
          if (previousSkin === undefined) delete process.env.PI_UI_SKIN;
          else process.env.PI_UI_SKIN = previousSkin;
        }
      }
    });
  });

  it("rerenders an existing receipt for skin and theme changes", () => {
    const previousSkin = process.env.PI_UI_SKIN;
    const previousApex = process.env.PI_APEX_UI;
    const previousChrome = process.env.PI_UI_CHROME;
    try {
      process.env.PI_UI_CHROME = "1";
      process.env.PI_APEX_UI = "0";
      process.env.PI_UI_SKIN = "apex";
      initTheme("apex-dark");
      installJevReceipts();
      const switchContent = JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          department: { type: "choice", choice: "billing", confidence: 1 },
          refund_requested: { type: "noul", noul: 0.99 },
          billing_relevance: { type: "score", score: 2, confidence: 1, legend: { 0: "unrelated", 1: "partly related", 2: "directly related" } },
        },
        usage: { input_tokens: 387, output_tokens: 65 },
      });
      const component = new ToolExecutionComponent(
        JEV_TOOL, "call-switch", jevArgs, { showImages: false }, { name: JEV_TOOL } as any, stubUi() as any, process.cwd(),
      );
      component.markExecutionStarted();
      component.updateResult({ content: [{ type: "text", text: switchContent }], details: jevResult.details, isError: false });
      for (const [themeName, skin, glyph] of [
        ["apex-dark", "apex", "●"],
        ["claude-dark", "claude", "●"],
        ["hal-dark", "hal", "■"],
        ["apex-dark", "apex", "●"],
      ] as const) {
        initTheme(themeName);
        process.env.PI_UI_SKIN = skin;
        component.invalidate();
        for (const width of [40, 120]) {
          const lines = component.render(width);
          const text = lines.join("\n");
          assert.match(text, new RegExp(glyph));
          assert.match(text, /department: billing/);
          assert.match(text, /refund_requested: 0\.99/);
          assert.doesNotMatch(text, /charged twice/);
          assert.ok(lines.every((line: string) => safeVisibleWidth(line) <= width), `${skin}@${width}`);
        }
      }
    } finally {
      if (previousChrome === undefined) delete process.env.PI_UI_CHROME;
      else process.env.PI_UI_CHROME = previousChrome;
      if (previousApex === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = previousApex;
      if (previousSkin === undefined) delete process.env.PI_UI_SKIN;
      else process.env.PI_UI_SKIN = previousSkin;
      initTheme("dark");
    }
  });

  it("renders stock JSON with chrome off, without judgment lines", () => {
    const chrome = process.env.PI_UI_CHROME;
    const apex = process.env.PI_APEX_UI;
    const realContent = JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        department: { type: "choice", choice: "billing", confidence: 1 },
        refund_requested: { type: "noul", noul: 0.99 },
      },
      usage: { input_tokens: 387, output_tokens: 65 },
    });
    try {
      process.env.PI_UI_CHROME = "0";
      process.env.PI_APEX_UI = "1";
      installJevReceipts();
      const plain = new ToolExecutionComponent(
        JEV_TOOL, "call-off", jevArgs, { showImages: false }, { name: JEV_TOOL } as any, stubUi() as any, process.cwd(),
      );
      plain.markExecutionStarted();
      plain.updateResult({ content: [{ type: "text", text: realContent }], details: (jevResult as any).details, isError: false });
      const offText = plain.render(80).join("\n");
      assert.match(offText, /jev-1\.13\.0/);
      assert.match(offText, /department/);
      assert.doesNotMatch(offText, /department: billing \(conf/);
      assert.doesNotMatch(offText, /refund_requested: 0\.99/);
      delete process.env.PI_UI_CHROME;
      process.env.PI_APEX_UI = "0";
      installJevReceipts();
      const legacy = new ToolExecutionComponent(
        JEV_TOOL, "call-legacy", jevArgs, { showImages: false }, { name: JEV_TOOL } as any, stubUi() as any, process.cwd(),
      );
      legacy.markExecutionStarted();
      legacy.updateResult({ content: [{ type: "text", text: realContent }], details: (jevResult as any).details, isError: false });
      const legacyText = legacy.render(80).join("\n");
      assert.match(legacyText, /jev-1\.13\.0/);
      assert.doesNotMatch(legacyText, /department: billing \(conf/);
    } finally {
      if (chrome === undefined) delete process.env.PI_UI_CHROME;
      else process.env.PI_UI_CHROME = chrome;
      if (apex === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = apex;
    }
  });
});

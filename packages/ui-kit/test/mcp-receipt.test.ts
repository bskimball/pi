import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { safeVisibleWidth } from "@pi/ui-kit/internal/presentation/safe-text-layout.ts";
import { installSharedPresentation, resetUiKitInstallForTests } from "../install.ts";
import {
  installCodemodeReceipts,
  codemodeReceiptArg,
  codemodeReceiptRenderers,
  toolSearchReceiptRenderers,
} from "@pi/ui-kit/internal/presentation/codemode-receipt.ts";
import {
  installMcpReceipts,
  listMcpResourcesRenderers,
  listMcpResourceTemplatesRenderers,
  mcpProxyRenderers,
  readMcpResourceRenderers,
} from "@pi/ui-kit/internal/presentation/mcp-receipt.ts";
import { shouldAttachApexReceipts } from "@pi/ui-kit/internal/presentation/headless-receipts.ts";

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

function withChrome<T>(value: string | undefined, run: () => T): T {
  const previousChrome = process.env.PI_UI_CHROME;
  const previousApex = process.env.PI_APEX_UI;
  if (value === undefined) {
    delete process.env.PI_UI_CHROME;
    delete process.env.PI_APEX_UI;
  } else {
    process.env.PI_UI_CHROME = value;
    process.env.PI_APEX_UI = value;
  }
  try {
    return run();
  } finally {
    if (previousChrome === undefined) delete process.env.PI_UI_CHROME;
    else process.env.PI_UI_CHROME = previousChrome;
    if (previousApex === undefined) delete process.env.PI_APEX_UI;
    else process.env.PI_APEX_UI = previousApex;
  }
}

function stubUi() {
  return { requestRender() {} };
}

const OWNER_DEF = {
  renderCall() {
    return { render: () => ["OWNER-CALL"], invalidate() {} };
  },
  renderResult() {
    return { render: () => ["OWNER-RESULT"], invalidate() {} };
  },
};

describe("native codemode/MCP/tool-search rendering", () => {
  it("attaches kit receipts, overriding owner renderers where registered", () => {
    withChrome("1", () => {
      resetUiKitInstallForTests();
      try {
        const pi = { registerMessageRenderer() {} } as any;
        installSharedPresentation(pi);
        // MCP proxies attach even when Pi's owner renderers are present.
        for (const toolName of [
          "mcp__chrome-devtools__list_pages",
          "mcp__context7__resolve-library-id",
        ]) {
          assert.ok(shouldAttachApexReceipts({ toolName }), toolName);
          assert.ok(
            shouldAttachApexReceipts({ toolName, toolDefinition: OWNER_DEF as any }),
            `${toolName} overrides its owner renderer`,
          );
        }
        // Codemode overrides its owner renderer too.
        assert.ok(shouldAttachApexReceipts({ toolName: "codemode" }));
        assert.ok(
          shouldAttachApexReceipts({ toolName: "codemode", toolDefinition: OWNER_DEF as any }),
          "codemode overrides its owner renderer",
        );
        // Owner-less native tools attach by exact name.
        for (const toolName of [
          "tool_search",
          "list_mcp_resources",
          "list_mcp_resource_templates",
          "read_mcp_resource",
        ]) {
          assert.ok(shouldAttachApexReceipts({ toolName }), toolName);
        }
        // Deleted adapter-era names stay untouched.
        assert.equal(shouldAttachApexReceipts({ toolName: "mcp" }), undefined);
        assert.equal(shouldAttachApexReceipts({ toolName: "mcpScript" }), undefined);
        // Unrelated kit receipts remain active.
        assert.ok(shouldAttachApexReceipts({ toolName: "web_search" }));
        assert.ok(shouldAttachApexReceipts({ toolName: "memory_list" }));
      } finally {
        resetUiKitInstallForTests();
      }
    });
  });

  it("attaches nothing for these tools with chrome off", () => {
    withChrome("0", () => {
      resetUiKitInstallForTests();
      try {
        const pi = { registerMessageRenderer() {} } as any;
        installSharedPresentation(pi);
        for (const toolName of [
          "mcp__chrome-devtools__list_pages",
          "codemode",
          "tool_search",
          "list_mcp_resources",
          "list_mcp_resource_templates",
          "read_mcp_resource",
        ]) {
          assert.equal(shouldAttachApexReceipts({ toolName }), undefined, toolName);
        }
      } finally {
        resetUiKitInstallForTests();
      }
    });
  });
});

const CODE = [
  '// @options: {"max_output_tokens": 1000}',
  "const pages = await tools.mcp__chrome_devtools__list_pages({});",
  'const docs = await tools["mcp__context7__query-docs"]({ libraryId: "/vercel/next.js" });',
  'await tools.bash({ command: "ls" });',
  "return pages;",
].join("\n");

const CALLS = [
  { id: "a/1", name: "mcp__chrome-devtools__list_pages", args: "{}", status: "ok", durationMs: 120 },
  {
    id: "a/2",
    name: "mcp__context7__query-docs",
    args: '{"libraryId":"/vercel/next.js"}',
    status: "error",
    durationMs: 300,
    error: "boom\nsecond line",
  },
  { id: "a/3", name: "bash", args: '{"command":"ls"}', status: "ok", durationMs: 50, cost: 0.004 },
];

const CODE_RESULT = {
  content: [
    { type: "text", text: "Script completed\nWall time 1.2 seconds\nOutput:\nhello world\nsecond line" },
  ],
  details: { calls: CALLS },
  isError: false,
};

describe("codemode receipt", () => {
  it("summarizes nested tool names in the call header, not the script", () => {
    assert.equal(
      codemodeReceiptArg({ code: CODE }, 120),
      "chrome_devtools/list_pages, context7/query-docs, bash · 4 lines",
    );
    const text = codemodeReceiptRenderers
      .renderCall({ code: CODE }, theme, context({ code: CODE }))
      .render(100)
      .join("\n");
    assert.match(text, /codemode/);
    assert.match(text, /chrome_devtools\/list_pages/);
    assert.match(text, /context7\/query-docs/);
    assert.doesNotMatch(text, /@options/);
  });

  it("stats calls, failures, and model cost", () => {
    const text = codemodeReceiptRenderers
      .renderResult(CODE_RESULT, { expanded: false, isPartial: false }, theme, context({ code: CODE }))
      .render(100)
      .join("\n");
    assert.match(text, /3 calls/);
    assert.match(text, /1 failed/);
    assert.match(text, /\$0\.004/);
    assert.match(text, /hello world/);
    assert.doesNotMatch(text, /Script completed/);
    assert.doesNotMatch(text, /Wall time/);
  });

  it("shows running calls while partial", () => {
    const running = {
      content: [{ type: "text", text: "" }],
      details: {
        calls: [
          { id: "a/1", name: "bash", args: '{"command":"sleep"}', status: "running" },
          { id: "a/2", name: "mcp__context7__query-docs", args: "{}", status: "ok" },
        ],
      },
      isError: false,
    };
    const text = codemodeReceiptRenderers
      .renderResult(running, { expanded: false, isPartial: true }, theme, context({ code: CODE }))
      .render(100)
      .join("\n");
    assert.match(text, /codemode/);
    assert.match(text, /\.\.\. bash/);
    assert.match(text, /ok context7\/query-docs/);
  });

  it("names the spill file and expands to script, calls, and output", () => {
    const spilled = {
      content: [{ type: "text", text: "Script completed\nWall time 9.9 seconds\nOutput:\nout" }],
      details: { calls: CALLS.slice(0, 1), fullOutputPath: "/tmp/pi-full.txt" },
      isError: false,
    };
    const collapsed = codemodeReceiptRenderers
      .renderResult(spilled, { expanded: false, isPartial: false }, theme, context({ code: CODE }))
      .render(100)
      .join("\n");
    assert.match(collapsed, /full output: \/tmp\/pi-full\.txt/);
    const expanded = codemodeReceiptRenderers
      .renderResult(CODE_RESULT, { expanded: true, isPartial: false }, theme, context({ code: CODE }))
      .render(100)
      .join("\n");
    assert.match(expanded, /const pages/);
    assert.match(expanded, /err context7\/query-docs libraryId=\/vercel\/next\.js/);
    assert.doesNotMatch(expanded, /\{"libraryId"/);
    assert.match(expanded, /boom/);
    assert.match(expanded, /hello world/);
  });
});

describe("tool_search receipt", () => {
  it("shows the query, load count, and loaded names", () => {
    const args = { query: "browser snapshot", limit: 5 };
    const result = {
      content: [{ type: "text", text: "Loaded 2 tools." }],
      details: { loaded: ["mcp__chrome-devtools__take_snapshot", "read"] },
      isError: false,
    };
    const call = toolSearchReceiptRenderers
      .renderCall(args, theme, context(args))
      .render(80)
      .join("\n");
    assert.match(call, /tool_search/);
    assert.match(call, /browser snapshot/);
    const text = toolSearchReceiptRenderers
      .renderResult(result, { expanded: false, isPartial: false }, theme, context(args))
      .render(80)
      .join("\n");
    assert.match(text, /2 loaded/);
    assert.match(text, /chrome-devtools\/take_snapshot/);
  });
});

describe("mcp proxy receipt", () => {
  it("titles server/tool and compacts args without JSON", () => {
    const renderers: any = mcpProxyRenderers("mcp__context7__query-docs");
    const args = { libraryId: "/vercel/next.js", query: "routing", extra: { nested: true, other: 1 } };
    const call = renderers.renderCall(args, theme, context(args)).render(100).join("\n");
    assert.match(call, /libraryId=\/vercel\/next\.js/);
    assert.match(call, /query=routing/);
    assert.match(call, /extra=\{2 keys\}/);
    assert.doesNotMatch(call, /\{"/);
    const result = {
      content: [{ type: "text", text: "docs here" }],
      details: { server: "context7", tool: "query-docs" },
      isError: false,
    };
    const text = renderers
      .renderResult(result, { expanded: false, isPartial: false }, theme, context(args))
      .render(100)
      .join("\n");
    assert.match(text, /context7\/query-docs/);
    assert.match(text, /docs here/);
  });

  it("falls back to the proxy name when details are absent", () => {
    const renderers: any = mcpProxyRenderers("mcp__chrome-devtools__take_snapshot");
    const text = renderers
      .renderResult(
        { content: [{ type: "text", text: "snap" }], details: {}, isError: false },
        { expanded: false, isPartial: false },
        theme,
        context({}),
      )
      .render(100)
      .join("\n");
    assert.match(text, /chrome-devtools\/take_snapshot/);
  });

  it("summarizes images when there is no text", () => {
    const renderers: any = mcpProxyRenderers("mcp__chrome-devtools__take_snapshot");
    const text = renderers
      .renderResult(
        { content: [{ type: "image", mimeType: "image/png", data: "x" }], details: {}, isError: false },
        { expanded: false, isPartial: false },
        theme,
        context({}),
      )
      .render(100)
      .join("\n");
    assert.match(text, /1 image/);
    assert.match(text, /\[image\/png\]/);
  });
});

const LIST_RESULT = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        resources: [
          { server: "context7", name: "docs", uri: "ctx7://docs" },
          { server: "context7", name: "api", uri: "ctx7://api" },
        ],
      }),
    },
  ],
  details: { server: "context7", tool: "list_mcp_resources" },
  isError: false,
};

describe("mcp resource receipts", () => {
  it("lists resources with counts and name/uri lines", () => {
    const args = { server: "context7" };
    const call = listMcpResourcesRenderers
      .renderCall(args, theme, context(args))
      .render(80)
      .join("\n");
    assert.match(call, /list_mcp_resources/);
    assert.match(call, /context7/);
    const text = listMcpResourcesRenderers
      .renderResult(LIST_RESULT, { expanded: false, isPartial: false }, theme, context(args))
      .render(100)
      .join("\n");
    assert.match(text, /2 resources/);
    assert.match(text, /docs ctx7:\/\/docs/);
    assert.match(text, /api ctx7:\/\/api/);
  });

  it("counts errors and lists templates by uriTemplate", () => {
    const result = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            resourceTemplates: [
              { server: "s", name: "t1", uriTemplate: "s://{id}" },
              { server: "s", name: "t2", uriTemplate: "s://{id}/x" },
              { server: "s", name: "t3", uriTemplate: "s://static" },
            ],
            errors: [{ server: "down", error: "timeout" }],
          }),
        },
      ],
      details: { server: "", tool: "list_mcp_resource_templates" },
      isError: false,
    };
    const text = listMcpResourceTemplatesRenderers
      .renderResult(result, { expanded: false, isPartial: false }, theme, context({}))
      .render(100)
      .join("\n");
    assert.match(text, /3 templates/);
    assert.match(text, /1 error/);
    assert.match(text, /t1 s:\/\/\{id\}/);
    const expanded = listMcpResourceTemplatesRenderers
      .renderResult(result, { expanded: true, isPartial: false }, theme, context({}))
      .render(100)
      .join("\n");
    assert.match(expanded, /down: timeout/);
  });

  it("renders read_mcp_resource with server and uri", () => {
    const args = { server: "context7", uri: "ctx7://docs/intro" };
    const call = readMcpResourceRenderers
      .renderCall(args, theme, context(args))
      .render(100)
      .join("\n");
    assert.match(call, /read_mcp_resource/);
    assert.match(call, /context7 ctx7:\/\/docs\/intro/);
    const text = readMcpResourceRenderers
      .renderResult(
        { content: [{ type: "text", text: "intro text" }], details: { server: "context7" }, isError: false },
        { expanded: false, isPartial: false },
        theme,
        context(args),
      )
      .render(100)
      .join("\n");
    assert.match(text, /intro text/);
  });
});

describe("wrapped native components", () => {
  it("renders an mcp proxy through the kit even with owner renderers", () => {
    initTheme("dark");
    withChrome("1", () => {
      installMcpReceipts();
      installCodemodeReceipts();
      const component = new ToolExecutionComponent(
        "mcp__context7__query-docs",
        "call-mcp-1",
        { libraryId: "/vercel/next.js", query: "routing" },
        { showImages: false },
        { name: "mcp__context7__query-docs", ...OWNER_DEF } as any,
        stubUi() as any,
        process.cwd(),
      );
      component.markExecutionStarted();
      component.updateResult({
        content: [{ type: "text", text: "routing docs" }],
        details: { server: "context7", tool: "query-docs" },
        isError: false,
      });
      const lines = component.render(100);
      const text = lines.join("\n");
      assert.match(text, /context7\/query-docs/);
      assert.match(text, /libraryId=\/vercel\/next\.js/);
      assert.match(text, /routing docs/);
      assert.doesNotMatch(text, /OWNER-CALL/);
      assert.doesNotMatch(text, /OWNER-RESULT/);
      assert.ok(lines.every((line: string) => safeVisibleWidth(line) <= 100));
    });
  });

  it("renders codemode through the kit even with owner renderers", () => {
    initTheme("dark");
    withChrome("1", () => {
      installCodemodeReceipts();
      const component = new ToolExecutionComponent(
        "codemode",
        "call-code-1",
        { code: CODE },
        { showImages: false },
        { name: "codemode", ...OWNER_DEF } as any,
        stubUi() as any,
        process.cwd(),
      );
      component.markExecutionStarted();
      component.updateResult(CODE_RESULT as any);
      const lines = component.render(100);
      const text = lines.join("\n");
      assert.match(text, /codemode/);
      assert.match(text, /3 calls/);
      assert.match(text, /1 failed/);
      assert.match(text, /hello world/);
      assert.doesNotMatch(text, /OWNER-/);
      assert.ok(lines.every((line: string) => safeVisibleWidth(line) <= 100));
    });
  });

  it("falls back to owner renderers with chrome off", () => {
    initTheme("dark");
    withChrome("0", () => {
      installMcpReceipts();
      const component = new ToolExecutionComponent(
        "mcp__context7__query-docs",
        "call-off-1",
        { libraryId: "/vercel/next.js" },
        { showImages: false },
        { name: "mcp__context7__query-docs", ...OWNER_DEF } as any,
        stubUi() as any,
        process.cwd(),
      );
      component.markExecutionStarted();
      component.updateResult({
        content: [{ type: "text", text: "x" }],
        details: {},
        isError: false,
      });
      const text = component.render(100).join("\n");
      assert.match(text, /OWNER-/);
    });
  });
});

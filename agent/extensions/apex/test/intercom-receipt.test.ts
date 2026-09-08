import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { safeVisibleWidth } from "../internal/presentation/safe-text-layout.ts";
import {
  CONTACT_SUPERVISOR_TOOL,
  INTERCOM_MESSAGE_TYPE,
  INTERCOM_TOOL,
  contactSupervisorReceiptArg,
  contactSupervisorReceiptRenderers,
  installIntercomReceipts,
  intercomMessageLines,
  intercomReceiptArg,
  intercomReceiptRenderers,
  parseIntercomMessage,
} from "../internal/presentation/intercom-receipt.ts";

const theme = {
  fg: (_key: string, text: string) => text,
  bg: (_key: string, text: string) => text,
  inverse: (text: string) => text,
};

function context(args: any): any {
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

function fakePi(seen?: string[]) {
  return {
    registerMessageRenderer: (type: string) => {
      seen?.push(type);
    },
  } as any;
}

describe("apex intercom receipts", () => {
  it("formats compact headers per action without dumping the message", () => {
    assert.equal(intercomReceiptArg({ action: "list" }, 80), "list");
    assert.equal(
      intercomReceiptArg({ action: "ask", to: "worker", message: "  hello   there " }, 80),
      "ask -> worker hello there",
    );
    assert.equal(
      intercomReceiptArg(
        { action: "send", to: "worker", attachments: [{}, {}], message: "hi" },
        80,
      ),
      "send -> worker +2 files hi",
    );
    assert.equal(
      intercomReceiptArg({ action: "list-cwd", cwd: "/repo" }, 80),
      "list-cwd @ /repo",
    );
    assert.equal(
      intercomReceiptArg({ action: "cancel", messageId: "a1b2c3d4-e5" }, 80),
      "cancel a1b2c3d4",
    );
    assert.doesNotMatch(
      intercomReceiptArg({ action: "send", to: "w", message: "a\nb\nc" }, 80),
      /\n/,
    );
  });

  it("formats contact_supervisor headers with reason and title", () => {
    assert.equal(
      contactSupervisorReceiptArg({ reason: "need_decision", message: "use v2?" }, 80),
      "need_decision use v2?",
    );
    assert.equal(
      contactSupervisorReceiptArg(
        { reason: "interview_request", interview: { title: "API choice" } },
        80,
      ),
      "interview_request API choice",
    );
  });

  it("renders an Apex receipt instead of boxed args", () => {
    const args = { action: "ask", to: "worker", message: "use JWT or cookies?" };
    const ctx = context(args);
    const call = intercomReceiptRenderers
      .renderCall(args, theme, ctx)
      .render(80)
      .join("\n");
    assert.match(call, /intercom/);
    assert.match(call, /ask/);
    assert.match(call, /worker/);
    assert.doesNotMatch(call, /┌|┐|└|┘/);
    assert.doesNotMatch(call, /"action"/);

    const rendered = intercomReceiptRenderers
      .renderResult(
        {
          content: [{ type: "text", text: "Reply from worker: use JWT." }],
          details: { messageId: "a1b2c3d4-e5f6" },
        },
        { expanded: false, isPartial: false },
        theme,
        ctx,
      )
      .render(80);
    const text = rendered.join("\n");
    assert.match(text, /intercom/);
    assert.match(text, /use JWT/);
    assert.match(text, /a1b2c3d4/);
    assert.doesNotMatch(text, /┌|┐|└|┘/);
    assert.ok(rendered.every((line: string) => safeVisibleWidth(line) <= 80));
  });

  it("keeps the supervisor structured-reply parse warning visible", () => {
    const args = { reason: "interview_request" };
    const result = {
      content: [{ type: "text", text: "answers: ..." }],
      details: { structuredReplyParseError: "question q1 missing" },
    };
    const collapsed = contactSupervisorReceiptRenderers
      .renderResult(
        result,
        { expanded: false, isPartial: false },
        theme,
        context(args),
      )
      .render(80)
      .join("\n");
    assert.match(collapsed, /Parse issue: question q1 missing/);
    const expanded = contactSupervisorReceiptRenderers
      .renderResult(
        result,
        { expanded: true, isPartial: false },
        theme,
        context(args),
      )
      .render(80)
      .join("\n");
    assert.match(expanded, /Parse issue: question q1 missing/);
  });

  it("keeps the warning when output exceeds the preview and body budgets", () => {
    const args = { reason: "interview_request" };
    const longCollapsed = {
      content: [{ type: "text", text: "l1\nl2\nl3\nl4\nl5" }],
      details: { structuredReplyParseError: "question q1 missing" },
    };
    const collapsed = contactSupervisorReceiptRenderers
      .renderResult(
        longCollapsed,
        { expanded: false, isPartial: false },
        theme,
        context(args),
      )
      .render(80)
      .join("\n");
    assert.match(collapsed, /Parse issue: question q1 missing/);

    const manyLines = Array.from({ length: 81 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    const expanded = contactSupervisorReceiptRenderers
      .renderResult(
        {
          content: [{ type: "text", text: manyLines }],
          details: { structuredReplyParseError: "question q1 missing" },
        },
        { expanded: true, isPartial: false },
        theme,
        context(args),
      )
      .render(80)
      .join("\n");
    assert.match(expanded, /Parse issue: question q1 missing/);
  });

  it("overrides intercom-owned presentation when Apex is on", () => {
    withApexUi("1", () => {
      installIntercomReceipts(fakePi());
      const proto = ToolExecutionComponent.prototype as any;
      for (const [name, renderers] of [
        [INTERCOM_TOOL, intercomReceiptRenderers],
        [CONTACT_SUPERVISOR_TOOL, contactSupervisorReceiptRenderers],
      ] as const) {
        const owned = {
          toolName: name,
          toolDefinition: {
            name,
            renderCall: () => ({ render: () => ["OWN"], invalidate() {} }),
            renderResult: () => ({ render: () => ["OWN"], invalidate() {} }),
            renderShell: "self",
          },
        };
        assert.equal(proto.getCallRenderer.call(owned), renderers.renderCall);
        assert.equal(
          proto.getResultRenderer.call(owned),
          renderers.renderResult,
        );
        assert.equal(proto.getRenderShell.call(owned), "self");
      }
    });
  });

  it("renders a real intercom ToolExecutionComponent as an Apex receipt", () => {
    initTheme("dark");
    withApexUi("1", () => {
      installIntercomReceipts(fakePi());

      const args = { action: "send", to: "worker", message: "starting task-3" };
      const component = new ToolExecutionComponent(
        INTERCOM_TOOL,
        "call-1",
        args,
        { showImages: false },
        {
          name: INTERCOM_TOOL,
          renderCall: () => ({ render: () => ["OWN"], invalidate() {} }),
          renderResult: () => ({ render: () => ["OWN"], invalidate() {} }),
        } as any,
        stubUi() as any,
        process.cwd(),
      );
      component.markExecutionStarted();
      component.updateResult({
        content: [{ type: "text", text: "Message sent to worker" }],
        details: { messageId: "a1b2c3d4-e5f6", delivered: true },
        isError: false,
      });

      const lines = component.render(80);
      const text = lines.join("\n");
      assert.match(text, /intercom/);
      assert.match(text, /worker/);
      assert.match(text, /Message sent to worker/);
      assert.doesNotMatch(text, /┌|┐|└|┘/);
      assert.doesNotMatch(text, /^OWN$/m);
      assert.ok(lines.every((line) => safeVisibleWidth(line) <= 80));
    });
  });

  it("skips the wrap when PI_APEX_UI=0", () => {
    const previous = process.env.PI_APEX_UI;
    const proto = ToolExecutionComponent.prototype as any;
    const before = proto.getCallRenderer;
    const seen: string[] = [];
    process.env.PI_APEX_UI = "0";
    try {
      installIntercomReceipts(fakePi(seen));
      assert.equal(proto.getCallRenderer, before);
      assert.deepEqual(seen, []);
    } finally {
      if (previous === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = previous;
    }
  });

  it("registers the intercom_message renderer when Apex is on", () => {
    withApexUi("1", () => {
      const seen: string[] = [];
      installIntercomReceipts(fakePi(seen));
      assert.ok(seen.includes(INTERCOM_MESSAGE_TYPE));
    });
  });
});

describe("apex intercom inbound notice", () => {
  const fullDetails = {
    from: {
      id: "a1b2c3d4-e5f6-7890",
      name: "worker",
      cwd: "/repo",
      model: "gpt-5",
      status: "idle",
    },
    message: {
      id: "m1",
      content: { text: "Task-3 complete. Ready for task-4?" },
      expectsReply: true,
    },
    replyCommand: 'intercom({ action: "reply", message: "..." })',
    bodyText: "Task-3 complete. Ready for task-4?",
  };

  it("parses structured details and rejects empty payloads", () => {
    const view = parseIntercomMessage(fullDetails);
    assert.equal(view?.senderName, "worker");
    assert.equal(view?.expectsReply, true);
    assert.equal(view?.replyCommand, fullDetails.replyCommand);
    assert.equal(parseIntercomMessage(undefined), undefined);
    assert.equal(parseIntercomMessage({}), undefined);
    assert.equal(
      parseIntercomMessage({ from: {}, message: { content: {} } }),
      undefined,
    );
  });

  it("renders sender, body, and reply hint as an Apex notice", () => {
    const view = parseIntercomMessage(fullDetails)!;
    const lines = intercomMessageLines(theme, 80, view, { expanded: false });
    const text = lines.join("\n");
    assert.match(text, /message/);
    assert.match(text, /intercom/);
    assert.match(text, /from worker/);
    assert.match(text, /expects reply/);
    assert.match(text, /inbound/);
    assert.match(text, /worker/);
    assert.match(text, /a1b2c3d4/);
    assert.match(text, /Task-3 complete/);
    assert.match(text, /To reply:/);
    assert.doesNotMatch(text, /\u256d|\u256e/);
    assert.ok(lines.every((line) => safeVisibleWidth(line) <= 80));
  });

  it("renders FYI messages without a reply hint", () => {
    const view = parseIntercomMessage({
      from: { id: "abc123", name: "planner" },
      message: { content: { text: "noted" } },
      bodyText: "noted",
    })!;
    const text = intercomMessageLines(theme, 80, view, { expanded: false }).join(
      "\n",
    );
    assert.match(text, /from planner/);
    assert.doesNotMatch(text, /expects reply/);
    assert.doesNotMatch(text, /To reply:/);
  });

  it("keeps reply threading and attachment metadata visible", () => {
    const view = parseIntercomMessage({
      from: { id: "abc123", name: "worker" },
      message: {
        content: {
          text: "see attached",
          attachments: [{ name: "auth.ts", content: "x" }],
        },
        replyTo: "deadbeef-1234",
      },
      bodyText: "see attached",
    })!;
    const text = intercomMessageLines(theme, 80, view, { expanded: false }).join(
      "\n",
    );
    assert.match(text, /reply to deadbeef/);
    assert.match(text, /1 attachment/);
  });

  it("flags silent truncation inside a single long paragraph", () => {
    const body = `${"alpha ".repeat(1080)}DECISION: stop.`;
    const view = parseIntercomMessage({
      from: { id: "abc123", name: "worker" },
      message: { content: { text: body } },
      bodyText: body,
    })!;
    const expanded = intercomMessageLines(theme, 80, view, {
      expanded: true,
    }).join("\n");
    assert.match(expanded, /more not shown/);
    assert.doesNotMatch(expanded, /DECISION: stop\./);
  });

  it("keeps every metadata part visible beside a long cwd", () => {
    const view = parseIntercomMessage({
      from: {
        id: "a1b2c3d4-e5f6",
        name: "worker",
        cwd: "C:/Users/bskim/workspaces/the-project-name",
        model: "gpt-5",
        status: "idle",
      },
      message: {
        content: {
          text: "see attached",
          attachments: [
            { name: "a.ts", content: "x" },
            { name: "b.ts", content: "y" },
          ],
        },
        replyTo: "deadbeef-1234",
        provenance: { type: "extension_outbox", extensionName: "helper" },
      },
      bodyText: "see attached",
    })!;
    const text = intercomMessageLines(theme, 80, view, {
      expanded: true,
    }).join("\n");
    assert.match(text, /reply to deadbeef/);
    assert.match(text, /2 attachments/);
    assert.match(text, /via helper/);
  });

  it("never synthesizes a reply command the owner withheld", () => {
    const view = parseIntercomMessage({
      from: { id: "abc123", name: "worker" },
      message: { content: { text: "decide this" }, expectsReply: true },
      bodyText: "decide this",
    })!;
    const text = intercomMessageLines(theme, 80, view, {
      expanded: false,
    }).join("\n");
    assert.match(text, /expects reply/);
    assert.doesNotMatch(text, /To reply:/);
  });

  it("bounds long bodies and preserves paragraph breaks", () => {
    const body = ["para one", "", "para two", ...Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)].join("\n");
    const view = parseIntercomMessage({
      from: { id: "abc123", name: "worker" },
      message: { content: { text: body } },
      bodyText: body,
    })!;
    const collapsed = intercomMessageLines(theme, 80, view, { expanded: false });
    assert.ok(collapsed.length <= 8);
    const collapsedText = collapsed.join("\n");
    assert.match(collapsedText, /para one/);
    assert.match(collapsedText, /more not shown/);
    const expanded = intercomMessageLines(theme, 80, view, { expanded: true });
    assert.match(expanded.join("\n"), /line 20/);
    assert.doesNotMatch(expanded.join("\n"), /more not shown/);
    assert.ok(expanded.every((line) => safeVisibleWidth(line) <= 80));
  });
});

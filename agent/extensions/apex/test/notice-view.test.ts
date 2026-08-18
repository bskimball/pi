import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { safeVisibleWidth } from "../internal/presentation/safe-text-layout.ts";
import {
  noticeLines,
  type NoticeRow,
} from "../internal/presentation/notice-view.ts";
import {
  BG_PROCESS_SETTLED_TYPE,
  BG_SETTLED_HINT,
  bgProcessNoticeRows,
  bgStatusKind,
  installBgProcessReceipts,
} from "../internal/presentation/bg-process-receipt.ts";

const theme = {
  fg: (_key: string, text: string) => text,
};

function rows(overrides: Partial<NoticeRow> = {}): NoticeRow[] {
  return [
    {
      kind: "succeeded",
      id: "bg_1",
      subject: "npm run dev",
      detail: "exit 0",
      preview: "vite ready",
      ...overrides,
    },
  ];
}

describe("apex notice view", () => {
  it("renders a bounded background receipt, not a raw custom-type block", () => {
    const lines = noticeLines(theme, 80, {
      channel: "bg process",
      rows: rows(),
      hint: BG_SETTLED_HINT,
      expanded: false,
      pad: 1,
    });
    const text = lines.join("\n");
    assert.match(text, /notice/);
    assert.match(text, /bg process/);
    assert.match(text, /1 settled/);
    assert.match(text, /background/);
    assert.match(text, /bg_1/);
    assert.match(text, /npm run dev/);
    assert.match(text, /bg_status/);
    assert.doesNotMatch(text, /bg-process-settled/);
    assert.ok(lines.every((line) => safeVisibleWidth(line) <= 80));
  });

  it("drops the channel and background tag before the counts on a narrow terminal", () => {
    const narrow = noticeLines(theme, 40, {
      channel: "bg process",
      rows: rows(),
      hint: BG_SETTLED_HINT,
      expanded: false,
    });
    const header = narrow[0] ?? "";
    assert.match(header, /notice/);
    assert.match(header, /1 settled/);
    assert.doesNotMatch(header, /bg process/);
    assert.doesNotMatch(header, /background/);
    assert.ok(narrow.every((line) => safeVisibleWidth(line) <= 40));
  });

  it("counts killed rows as failures", () => {
    const lines = noticeLines(theme, 80, {
      channel: "bg process",
      rows: [
        { kind: "killed", id: "bg_2", subject: "watcher", detail: "SIGTERM" },
      ],
      expanded: false,
    });
    assert.match(lines.join("\n"), /1 failed/);
  });
});

describe("bg-process settlement notice", () => {
  it("maps job statuses onto the notice vocabulary", () => {
    assert.equal(bgStatusKind("completed"), "succeeded");
    assert.equal(bgStatusKind("failed"), "failed");
    assert.equal(bgStatusKind("killed"), "killed");
    assert.equal(bgStatusKind("running"), "running");
    assert.equal(bgStatusKind("nope"), "unknown");
  });

  it("builds rows from structured details and ignores a missing id", () => {
    const built = bgProcessNoticeRows({
      jobs: [
        {
          id: "bg_1",
          status: "completed",
          exitCode: 0,
          signal: null,
          title: "dev",
          command: "npm run dev",
        },
        { status: "failed", title: "orphan" },
      ],
    });
    assert.equal(built.length, 1);
    assert.equal(built[0]?.id, "bg_1");
    assert.equal(built[0]?.kind, "succeeded");
    assert.equal(built[0]?.subject, "dev");
    assert.match(built[0]?.detail ?? "", /exit 0/);
    assert.equal(built[0]?.preview, "npm run dev");
  });

  it("registers the message renderer only when Apex presentation is on", () => {
    const types: string[] = [];
    const pi = {
      registerMessageRenderer(customType: string) {
        types.push(customType);
      },
    };

    const previous = process.env.PI_APEX_UI;
    process.env.PI_APEX_UI = "0";
    try {
      installBgProcessReceipts(pi as any);
      assert.deepEqual(types, []);
    } finally {
      if (previous === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = previous;
    }

    process.env.PI_APEX_UI = "1";
    try {
      installBgProcessReceipts(pi as any);
      assert.deepEqual(types, [BG_PROCESS_SETTLED_TYPE]);
    } finally {
      if (previous === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = previous;
    }
  });
});

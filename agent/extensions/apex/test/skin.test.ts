import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { installBuiltinReceipts } from "../internal/presentation/builtin-receipts.ts";
import {
  intercomMessageLines,
  parseIntercomMessage,
} from "../internal/presentation/intercom-receipt.ts";
import { noticeLines } from "../internal/presentation/notice-view.ts";
import { safeVisibleWidth } from "../internal/presentation/safe-text-layout.ts";
import {
  buildTodoList,
  renderTodoList,
} from "../internal/todo/todo-view.ts";
import {
  SKIN_ENV_VAR,
  activeSkinName,
  composerPromptGlyph,
  skinGlyphs,
} from "../internal/presentation/skin.ts";
import { TREE } from "../internal/presentation/ui-common.ts";

// Pre-change apex literals, pinned so any visual regression fails loudly.
const APEX_GLYPHS = {
  header: "●",
  branch: "├─",
  last: "╰─",
  rail: "│",
  receipt: "○",
  hang: "   ",
  prompt: "❯",
  statusIdle: "○",
  statusActive: "●",
};

const statusTheme = {
  fg: (_key: string, text: string) => text,
  bg: (_key: string, text: string) => text,
};

function todoText(): string {
  const view = buildTodoList([
    { content: "Draft the plan", status: "pending" },
    { content: "Wire the skins", status: "in_progress" },
    { content: "Ship it", status: "completed" },
  ]);
  return renderTodoList(statusTheme as any, 80, view).join("\n");
}

function noticeText(): string {
  return noticeLines(statusTheme as any, 80, {
    channel: "bg process",
    expanded: false,
    rows: [
      { kind: "succeeded", id: "bg_1", subject: "npm run dev", detail: "exit 0" },
      { kind: "failed", id: "bg_2", subject: "npm test", detail: "exit 1" },
    ],
  }).join("\n");
}

function intercomText(): string {
  const view = parseIntercomMessage({
    from: { id: "a1b2c3d4-e5f6", name: "worker" },
    message: { content: { text: "Task done" }, expectsReply: true },
    bodyText: "Task done",
  })!;
  return intercomMessageLines(statusTheme as any, 80, view, { expanded: false }).join("\n");
}

function stubUi() {
  return { requestRender() {} };
}

function withSkin<T>(value: string | undefined, run: () => T): T {
  const previous = process.env[SKIN_ENV_VAR];
  if (value === undefined) delete process.env[SKIN_ENV_VAR];
  else process.env[SKIN_ENV_VAR] = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env[SKIN_ENV_VAR];
    else process.env[SKIN_ENV_VAR] = previous;
  }
}

describe("apex presentation skins", () => {
  it("defaults to the apex skin when PI_UI_SKIN is unset", () => {
    withSkin(undefined, () => {
      assert.equal(activeSkinName(), "apex");
      assert.deepEqual({ ...skinGlyphs() }, APEX_GLYPHS);
      assert.equal(composerPromptGlyph(), "❯");
    });
  });

  it("renders byte-identical apex glyphs through TREE", () => {
    withSkin(undefined, () => {
      assert.deepEqual(Object.keys(TREE).sort(), ["branch", "hang", "header", "last", "rail", "receipt"]);
      assert.equal(TREE.header, APEX_GLYPHS.header);
      assert.equal(TREE.branch, APEX_GLYPHS.branch);
      assert.equal(TREE.last, APEX_GLYPHS.last);
      assert.equal(TREE.rail, APEX_GLYPHS.rail);
      assert.equal(TREE.receipt, APEX_GLYPHS.receipt);
      assert.equal(TREE.hang, APEX_GLYPHS.hang);
    });
  });

  it("swaps receipt and composer glyphs for the claude skin", () => {
    withSkin("claude", () => {
      assert.equal(activeSkinName(), "claude");
      assert.equal(skinGlyphs().header, "●");
      assert.equal(skinGlyphs().receipt, "●");
      assert.equal(skinGlyphs().rail, "⎿");
      assert.equal(composerPromptGlyph(), ">");
      assert.equal(TREE.header, "●");
      assert.equal(TREE.receipt, "●");
      assert.equal(TREE.rail, "⎿");
      // Unspecified tree edges keep their apex geometry.
      assert.equal(TREE.branch, APEX_GLYPHS.branch);
      assert.equal(TREE.last, APEX_GLYPHS.last);
      assert.equal(TREE.hang, APEX_GLYPHS.hang);
    });
  });

  it("falls back to apex for unrecognized skin values", () => {
    for (const value of ["banana", "", "CLAUDE", "Claude"]) {
      withSkin(value, () => {
        assert.equal(activeSkinName(), "apex");
        assert.equal(TREE.header, APEX_GLYPHS.header);
        assert.equal(composerPromptGlyph(), "❯");
      });
    }
  });

  it("keeps every skin glyph code point narrow", () => {
    // Receipt/tree glyphs flow through safeVisibleWidth budgets, so each
    // code point must be width 1. Multi-char edges total one per code point.
    for (const glyph of ["●", "○", "■", "□", "⎿", "│", "├", "─", "╰", ">"]) {
      assert.equal(safeVisibleWidth(glyph), 1, glyph);
    }
    // Load-bearing rendering-safety assertions for the skin glyphs.
    assert.equal(safeVisibleWidth("●"), 1);
    assert.equal(safeVisibleWidth("⎿"), 1);
    assert.equal(safeVisibleWidth("● test ⎿"), 8);
    for (const skin of [undefined, "claude"]) {
      withSkin(skin, () => {
        assert.equal(safeVisibleWidth(TREE.branch), 2);
        assert.equal(safeVisibleWidth(TREE.last), 2);
        assert.equal(safeVisibleWidth(TREE.hang), 3);
      });
    }
    // The apex composer prompt ❯ predates skins and measures 2 in the
    // fallback table; it never flows through width budgets (Pi owns editor
    // layout), so skins preserve it unchanged.
    assert.equal(safeVisibleWidth("❯"), 2);
  });

  it("renders receipts end to end with the active skin", () => {
    initTheme("dark");
    const previousApex = process.env.PI_APEX_UI;
    const previousSkin = process.env[SKIN_ENV_VAR];
    const renderGrep = () => {
      installBuiltinReceipts();
      const component = new ToolExecutionComponent(
        "grep",
        "call-skin-e2e",
        { pattern: "skin" },
        { showImages: false },
        { name: "grep", renderCall: () => {}, renderResult: () => {} } as any,
        stubUi() as any,
        process.cwd(),
      );
      // The call row carries the idle receipt root; the settled result row
      // carries the active header root (● in both skins).
      const call = component.render(80).join("\n");
      component.markExecutionStarted();
      component.updateResult({
        content: [{ type: "text", text: "src/skin.ts:1:skin" }],
        isError: false,
      });
      return { call, result: component.render(80).join("\n") };
    };
    try {
      process.env.PI_APEX_UI = "1";
      process.env[SKIN_ENV_VAR] = "claude";
      const claude = renderGrep();
      assert.match(claude.call, /●/);
      assert.doesNotMatch(claude.call, /○/);
      assert.match(claude.result, /●/);
      delete process.env[SKIN_ENV_VAR];
      const apex = renderGrep();
      assert.match(apex.call, /○/);
      assert.doesNotMatch(apex.call, /●/);
      assert.match(apex.result, /●/);
    } finally {
      if (previousApex === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = previousApex;
      if (previousSkin === undefined) delete process.env[SKIN_ENV_VAR];
      else process.env[SKIN_ENV_VAR] = previousSkin;
    }
  });

  it("resolves status glyphs per skin with apex fallback", () => {
    withSkin(undefined, () => {
      assert.equal(skinGlyphs().statusIdle, "○");
      assert.equal(skinGlyphs().statusActive, "●");
    });
    withSkin("claude", () => {
      assert.equal(skinGlyphs().statusIdle, "□");
      assert.equal(skinGlyphs().statusActive, "■");
    });
    for (const value of ["banana", "", "CLAUDE"]) {
      withSkin(value, () => {
        assert.equal(skinGlyphs().statusIdle, "○");
        assert.equal(skinGlyphs().statusActive, "●");
      });
    }
  });

  it("renders todo, notice, and intercom surfaces with the active skin", () => {
    withSkin("claude", () => {
      const todo = todoText();
      assert.match(todo, /□/);
      assert.match(todo, /■/);
      assert.doesNotMatch(todo, /●/);
      assert.doesNotMatch(todo, /○/);
      const notice = noticeText();
      assert.match(notice, /■/);
      assert.doesNotMatch(notice, /●/);
      assert.doesNotMatch(notice, /○/);
      const intercom = intercomText();
      assert.match(intercom, /■/);
      assert.doesNotMatch(intercom, /●/);
      assert.doesNotMatch(intercom, /○/);
    });
    withSkin(undefined, () => {
      const todo = todoText();
      assert.match(todo, /●/);
      assert.match(todo, /○/);
      assert.doesNotMatch(todo, /■/);
      assert.doesNotMatch(todo, /□/);
      const notice = noticeText();
      assert.match(notice, /●/);
      assert.doesNotMatch(notice, /■/);
      assert.doesNotMatch(notice, /□/);
      const intercom = intercomText();
      assert.match(intercom, /●/);
      assert.doesNotMatch(intercom, /■/);
      assert.doesNotMatch(intercom, /□/);
    });
  });

  it("re-reads status glyphs dynamically without re-import", () => {
    const previous = process.env[SKIN_ENV_VAR];
    try {
      process.env[SKIN_ENV_VAR] = "claude";
      assert.match(todoText(), /■/);
      assert.doesNotMatch(todoText(), /●/);
      delete process.env[SKIN_ENV_VAR];
      assert.match(todoText(), /●/);
      assert.doesNotMatch(todoText(), /■/);
      assert.match(noticeText(), /●/);
    } finally {
      if (previous === undefined) delete process.env[SKIN_ENV_VAR];
      else process.env[SKIN_ENV_VAR] = previous;
    }
  });

  it("keeps every skin glyph free of Extended_Pictographic codepoints", () => {
    // Emoji-font codepoints ignore theme color and misreport width, so no
    // skin glyph may carry the Extended_Pictographic property.
    for (const skin of [undefined, "claude"]) {
      withSkin(skin, () => {
        for (const [key, value] of Object.entries(skinGlyphs())) {
          assert.doesNotMatch(
            value,
            /\p{Extended_Pictographic}/u,
            `${skin ?? "apex"}.${key}`,
          );
        }
      });
    }
  });

  it("re-reads the skin dynamically without re-import", () => {
    const previous = process.env[SKIN_ENV_VAR];
    try {
      process.env[SKIN_ENV_VAR] = "claude";
      assert.equal(TREE.header, "●");
      assert.equal(TREE.receipt, "●");
      assert.equal(composerPromptGlyph(), ">");
      process.env[SKIN_ENV_VAR] = "apex";
      assert.equal(TREE.header, "●");
      assert.equal(composerPromptGlyph(), "❯");
      delete process.env[SKIN_ENV_VAR];
      assert.equal(TREE.header, "●");
    } finally {
      if (previous === undefined) delete process.env[SKIN_ENV_VAR];
      else process.env[SKIN_ENV_VAR] = previous;
    }
  });
});

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import readGuard, { isWildcardOnlyGrepPattern } from "../read-guard.ts";

const BLOCKED = [
  ".*",
  ".+",
  "^.*$",
  "^.+$",
  "(?s).*",
  "[\\s\\S]*",
  "[\\S\\s]+",
];

const ALLOWED = [
  "foo.*bar",
  ".*foo",
  "foo.*",
  ".{1,}",
  "a+",
  "\\w+",
  ".",
  "",
  "  ",
  "  .*  ",
  "(?:.*)",
  "[.]*",
];

describe("isWildcardOnlyGrepPattern", () => {
  for (const pattern of BLOCKED) {
    it(`blocks ${JSON.stringify(pattern)}`, () => {
      assert.equal(isWildcardOnlyGrepPattern(pattern), true);
    });
  }

  for (const pattern of ALLOWED) {
    it(`allows ${JSON.stringify(pattern)}`, () => {
      assert.equal(isWildcardOnlyGrepPattern(pattern), false);
    });
  }
});

function collectToolCall(register: typeof readGuard) {
  const hooks: Array<(event: unknown, ctx: { cwd: string }) => unknown> = [];
  register({
    on(name: string, fn: (event: unknown, ctx: { cwd: string }) => unknown) {
      if (name === "tool_call") hooks.push(fn);
    },
  } as never);
  assert.ok(hooks.length >= 1);
  return (event: unknown) => hooks[0](event, { cwd: process.cwd() });
}

describe("tool_call grep wildcard guard", () => {
  const call = collectToolCall(readGuard);

  it("blocks non-literal wildcard-only grep", () => {
    const result = call({
      type: "tool_call",
      toolName: "grep",
      input: { pattern: ".*" },
    });
    assert.equal((result as { block?: boolean })?.block, true);
    assert.match(
      String((result as { reason?: string })?.reason),
      /read with offset\/limit/i,
    );
    assert.match(String((result as { reason?: string })?.reason), /discriminat/i);
  });

  it("allows literal search for .*", () => {
    const result = call({
      type: "tool_call",
      toolName: "grep",
      input: { pattern: ".*", literal: true },
    });
    assert.equal(result, undefined);
  });

  it("allows discriminating regex", () => {
    assert.equal(
      call({
        type: "tool_call",
        toolName: "grep",
        input: { pattern: "foo.*bar" },
      }),
      undefined,
    );
    assert.equal(
      call({
        type: "tool_call",
        toolName: "grep",
        input: { pattern: ".*foo" },
      }),
      undefined,
    );
    assert.equal(
      call({
        type: "tool_call",
        toolName: "grep",
        input: { pattern: "  .*  " },
      }),
      undefined,
    );
  });

  it("ignores unrelated tools", () => {
    assert.equal(
      call({
        type: "tool_call",
        toolName: "find",
        input: { pattern: ".*" },
      }),
      undefined,
    );
  });

  it("does not block read without a prior image record", () => {
    assert.equal(
      call({
        type: "tool_call",
        toolName: "read",
        input: { path: "no-such-file-for-read-guard.png" },
      }),
      undefined,
    );
  });
});

describe("text re-read guard", () => {
  it("blocks the third unchanged read of the same region and allows a different region or an edit", async () => {
    const prior = process.env.PI_BEHAVIOR_MODE;
    delete process.env.PI_BEHAVIOR_MODE;
    const dir = mkdtempSync(path.join(tmpdir(), "read-guard-"));
    const file = path.join(dir, "notes.txt");
    writeFileSync(file, "unchanged\n");
    const calls: Array<(event: unknown, ctx: { cwd: string }) => unknown> = [];
    const results: Array<(event: unknown, ctx: { cwd: string }) => unknown> = [];
    const compacts: Array<() => void> = [];
    readGuard({
      on(name: string, fn: (...args: unknown[]) => unknown) {
        if (name === "tool_call") calls.push(fn as (event: unknown, ctx: { cwd: string }) => unknown);
        if (name === "tool_result") results.push(fn as (event: unknown, ctx: { cwd: string }) => unknown);
        if (name === "session_compact") compacts.push(fn as () => void);
      },
    } as never);
    const ctx = { cwd: dir };
    const readCall = (offset?: number) => calls[0]({
      type: "tool_call",
      toolName: "read",
      input: offset === undefined ? { path: file } : { path: file, offset },
    }, ctx);
    const readResult = () => results[0]({
      type: "tool_result",
      toolName: "read",
      isError: false,
      input: { path: file },
      content: [{ type: "text", text: "unchanged" }],
    }, ctx);
    try {
      assert.equal(readCall(), undefined, "first read");
      await readResult();
      assert.equal(readCall(), undefined, "confirmation re-read stays allowed");
      await readResult();
      const blocked = readCall() as { block?: boolean; reason?: string } | undefined;
      assert.equal(blocked?.block, true);
      assert.match(String(blocked?.reason), /already in context/);
      assert.equal(readCall(40), undefined, "a different region is a different read");
      calls[0]({ type: "tool_call", toolName: "edit", input: { path: file, edits: [] } }, ctx);
      assert.equal(readCall(), undefined, "an edit clears the region");
      await readResult();
      await readResult();
      assert.equal((readCall() as { block?: boolean } | undefined)?.block, true, "blocks again after two post-edit reads");
      compacts[0]();
      assert.equal(readCall(), undefined, "compaction drops the copy, so the next read is allowed");
    } finally {
      if (prior === undefined) delete process.env.PI_BEHAVIOR_MODE;
      else process.env.PI_BEHAVIOR_MODE = prior;
    }
  });
});

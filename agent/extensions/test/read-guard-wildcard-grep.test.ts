import assert from "node:assert/strict";
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

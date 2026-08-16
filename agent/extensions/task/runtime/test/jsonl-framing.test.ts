import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import {
  attachJsonlReader,
  encodeJsonl,
  parseJsonlLine,
} from "../jsonl-framing.ts";

function collect(stream: Readable, maxLine?: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    const reader = attachJsonlReader(
      stream,
      (line) => lines.push(line),
      maxLine,
    );
    stream.on("error", reject);
    stream.on("close", () => {
      reader.dispose();
      resolve(lines);
    });
  });
}

describe("jsonl framing bounds", () => {
  it("emits ordinary LF records", async () => {
    const stream = Readable.from(["{\"a\":1}\n{\"b\":2}\n"]);
    assert.deepEqual(await collect(stream), ['{"a":1}', '{"b":2}']);
  });

  it("emits a type stub for an oversized record instead of parsing it", async () => {
    const stream = Readable.from([
      encodeJsonl({ ok: true }),
      `{"type":"tool_execution_end","toolCallId":"call-1","result":"${"x".repeat(80)}"}\n`,
      encodeJsonl({ after: true }),
    ]);
    assert.deepEqual(await collect(stream, 40), [
      '{"ok":true}',
      '{"type":"tool_execution_end","toolCallId":"call-1","truncated":true}',
      '{"after":true}',
    ]);
  });

  it("stubs an oversized record that arrives without a newline yet", async () => {
    const stream = new Readable({ read() {} });
    const pending = collect(stream, 40);
    stream.push('{"type":"tool_execution_end","toolCallId":"c1","dump":"');
    stream.push(`${"x".repeat(80)}"}\n`);
    stream.push(encodeJsonl({ kept: true }));
    stream.push(null);
    assert.deepEqual(await pending, [
      '{"type":"tool_execution_end","toolCallId":"c1","truncated":true}',
      '{"kept":true}',
    ]);
  });

  it("recovers isError from the tail of an oversized tool-end record", async () => {
    const stream = Readable.from([
      `{"type":"tool_execution_end","toolCallId":"call-9","result":"${"x".repeat(80)}","isError":true}\n`,
    ]);
    assert.deepEqual(await collect(stream, 40), [
      '{"type":"tool_execution_end","toolCallId":"call-9","isError":true,"truncated":true}',
    ]);
  });

  it("stubs a single giant chunk without a newline until the record ends", async () => {
    const stream = new Readable({ read() {} });
    const pending = collect(stream, 40);
    stream.push(
      `{"type":"tool_execution_end","toolCallId":"call-g","result":"${"x".repeat(200)}","isError":true}\n{"ok":true}\n`,
    );
    stream.push(null);
    assert.deepEqual(await pending, [
      '{"type":"tool_execution_end","toolCallId":"call-g","isError":true,"truncated":true}',
      '{"ok":true}',
    ]);
  });

  it("refuses to parse an oversized line", () => {
    assert.equal(parseJsonlLine(`{"x":"${"y".repeat(300_000)}"}`), undefined);
    assert.deepEqual(parseJsonlLine('{"ok":true}'), { ok: true });
  });
});

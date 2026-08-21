import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluateSettledReport,
  extractLastReportFence,
  validateReportJson,
} from "../report-schema.ts";

const schema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    count: { type: "number" },
    ok: { type: "boolean" },
    kind: { type: "string", enum: ["a", "b"] },
  },
  required: ["summary", "count"],
};

describe("report-schema", () => {
  it("extracts the last report fence", () => {
    const text = "```report\n{\"a\":1}\n```\nmore\n```report\n{\"b\":2}\n```";
    assert.equal(extractLastReportFence(text)?.trim(), '{"b":2}');
  });

  it("validates a conforming object", () => {
    const result = validateReportJson(
      schema,
      JSON.stringify({ summary: "done", count: 3, ok: true, kind: "a" }),
    );
    assert.equal(result.status, "ok");
    assert.equal(result.parsed?.count, 3);
  });

  it("fails missing required keys", () => {
    const result = validateReportJson(schema, JSON.stringify({ summary: "x" }));
    assert.equal(result.status, "invalid");
    assert.match(result.error ?? "", /missing required key: count/);
  });

  it("fails type mismatches", () => {
    const result = validateReportJson(
      schema,
      JSON.stringify({ summary: "x", count: "nope" }),
    );
    assert.equal(result.status, "invalid");
    assert.match(result.error ?? "", /expected number/);
  });

  it("fails enum membership", () => {
    const result = validateReportJson(
      schema,
      JSON.stringify({ summary: "x", count: 1, kind: "z" }),
    );
    assert.equal(result.status, "invalid");
    assert.match(result.error ?? "", /enum/);
  });

  it("reports missing when no fence and schema requested", () => {
    const result = evaluateSettledReport("plain assistant text", JSON.stringify(schema));
    assert.equal(result.status, "missing");
    assert.equal(result.parsed, null);
  });

  it("returns none-requested without a schema", () => {
    const result = evaluateSettledReport("```report\n{}\n```");
    assert.equal(result.status, "none-requested");
  });
});

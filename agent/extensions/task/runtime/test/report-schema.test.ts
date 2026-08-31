import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_INSPECTION_REPORT_SCHEMA,
  DEFAULT_IMPLEMENTATION_REPORT_SCHEMA,
  DEFAULT_REVIEW_REPORT_SCHEMA,
  defaultReportSchemaForAgent,
  evaluateSettledReport,
  extractLastReportFence,
  parseReportSchema,
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

  it("does not treat prototype names as present required keys", () => {
    const result = validateReportJson(
      { type: "object", required: ["toString"] },
      JSON.stringify({}),
    );
    assert.equal(result.status, "invalid");
    assert.match(result.error ?? "", /missing required key: toString/);
  });

  it("rejects unknown top-level schema keys", () => {
    const parsed = parseReportSchema(JSON.stringify({ type: "object", additionalProperties: false }));
    assert.match(parsed.error ?? "", /unknown key: additionalProperties/);
  });

  it("rejects non-object root schemas", () => {
    const parsed = parseReportSchema(JSON.stringify(["string"]));
    assert.match(parsed.error ?? "", /must be a JSON object/);
  });

  it("rejects property specs that are not string|number|boolean", () => {
    const parsed = parseReportSchema(
      JSON.stringify({ type: "object", properties: { nested: { type: "object" } } }),
    );
    assert.match(parsed.error ?? "", /nested\.type must be string\|number\|boolean/);
  });

  it("rejects non-string enum members", () => {
    const parsed = parseReportSchema(
      JSON.stringify({
        type: "object",
        properties: { kind: { type: "string", enum: [1, 2] } },
      }),
    );
    assert.match(parsed.error ?? "", /enum must be an array of strings/);
  });

  it("selects structured defaults for writers and reviewers", () => {
    assert.equal(
      defaultReportSchemaForAgent("machinist"),
      DEFAULT_IMPLEMENTATION_REPORT_SCHEMA,
    );
    assert.equal(defaultReportSchemaForAgent("artisan"), DEFAULT_IMPLEMENTATION_REPORT_SCHEMA);
    assert.equal(defaultReportSchemaForAgent("scribe"), DEFAULT_IMPLEMENTATION_REPORT_SCHEMA);
    assert.equal(defaultReportSchemaForAgent("oracle"), DEFAULT_REVIEW_REPORT_SCHEMA);
    assert.equal(defaultReportSchemaForAgent("inspector"), DEFAULT_INSPECTION_REPORT_SCHEMA);
    assert.equal(defaultReportSchemaForAgent("scout"), undefined);
  });

  it("validates the default implementation report contract", () => {
    const result = evaluateSettledReport(
      '```report\n{"outcome":"completed","acceptanceMet":true,"filesChanged":"a.ts","validation":"focused test passed","blockers":"none","recommendedNextStep":"review"}\n```',
      DEFAULT_IMPLEMENTATION_REPORT_SCHEMA,
    );
    assert.equal(result.status, "ok");
    assert.equal(result.parsed?.acceptanceMet, true);
  });

  it("validates the default review verdict contract", () => {
    const result = evaluateSettledReport(
      '```report\n{"verdict":"ADVISORY","materialFindingCount":0,"findings":"optional simplification","requiredCorrection":"none"}\n```',
      DEFAULT_REVIEW_REPORT_SCHEMA,
    );
    assert.equal(result.status, "ok");
    assert.equal(result.parsed?.verdict, "ADVISORY");
  });

  it("rejects an unclassified review verdict", () => {
    const result = evaluateSettledReport(
      '```report\n{"verdict":"FAIL","materialFindingCount":1,"findings":"broken","requiredCorrection":"fix"}\n```',
      DEFAULT_REVIEW_REPORT_SCHEMA,
    );
    assert.equal(result.status, "invalid");
    assert.match(result.error ?? "", /enum/);
  });

  it("accepts Inspector failure and blocked verdicts", () => {
    for (const verdict of ["FAIL", "BLOCKED"]) {
      const result = evaluateSettledReport(
        `\`\`\`report\n{"verdict":"${verdict}","findings":"changed path did not pass","evidence":"browser observation","blocker":"CDP unavailable or UI regression"}\n\`\`\``,
        DEFAULT_INSPECTION_REPORT_SCHEMA,
      );
      assert.equal(result.status, "ok");
      assert.equal(result.parsed?.verdict, verdict);
    }
  });
});

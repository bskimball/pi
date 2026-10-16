// footer: rendered-text coverage for the three UI footers (apex, claude,
// hal) against the kit FooterSnapshot contract.
//
// Uses an identity paint (fg/bold return text unchanged) so assertions read
// plain text with no ANSI to strip. Tone paths (>=70 warning, >=90 error)
// are not asserted here beyond Claude's key rule: a high context percent
// tones the readout but never replaces the model cluster.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatTokens } from "../../../packages/ui-kit/internal/presentation/ui-common.ts";
import { safeVisibleWidth } from "../../../packages/ui-kit/internal/presentation/safe-text-layout.ts";
import type {
  FooterPaint,
  FooterSnapshot,
} from "../../../packages/ui-kit/internal/presentation/footer.ts";
import { buildFooter as buildApexFooter } from "../apex/footer.ts";
import { buildFooter as buildClaudeFooter } from "../claude/footer.ts";
import { buildFooter as buildHalFooter } from "../hal/footer.ts";

const paint: FooterPaint = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function snapshot(overrides: Partial<FooterSnapshot> = {}): FooterSnapshot {
  return {
    cwd: "~/proj",
    branch: "main",
    sessionName: "test",
    model: { id: "opus-4-5", provider: "anthropic", reasoning: true },
    thinking: "high",
    multiProvider: true,
    subscription: true,
    usage: { input: 12000, output: 3400, cacheRead: 0, cacheWrite: 0, cost: 1.234 },
    context: { percent: 48, window: 200000, tokens: 96000 },
    mode: "Fusion",
    statuses: [{ key: "a", text: "ext-status" }],
    ...overrides,
  };
}

function joined(lines: string[]): string {
  return lines.join("\n");
}

describe("footer renderers", () => {
  it("formats token counts as the footers print them", () => {
    assert.equal(formatTokens(96000), "96k");
    assert.equal(formatTokens(200000), "200k");
    assert.equal(formatTokens(12000), "12k");
    assert.equal(formatTokens(3400), "3.4k");
  });

  it("apex shows model, thinking, context tokens, place, and usage at width 120", () => {
    const lines = buildApexFooter(snapshot(), 120, paint);
    assert.ok(lines.length <= 3 && lines.length >= 1);
    for (const line of lines) assert.ok(safeVisibleWidth(line) <= 120);
    const text = joined(lines);
    const line1 = lines[0] ?? "";
    const line2 = lines[1] ?? "";
    assert.match(line1, /opus-4-5/);
    assert.match(line1, /high/);
    assert.match(line1, /48%/);
    assert.match(line1, /96k\/200k/);
    assert.match(line2, /~\/proj/);
    assert.match(line2, /main/);
    assert.match(text, /12k/);
    assert.match(text, /3\.4k/);
    assert.match(text, /\$1\.234/);
    assert.match(text, /sub/);
  });

  it("claude shows model, thinking, context tokens, place, and usage at width 120", () => {
    const lines = buildClaudeFooter(snapshot(), 120, paint);
    assert.ok(lines.length <= 3 && lines.length >= 1);
    for (const line of lines) assert.ok(safeVisibleWidth(line) <= 120);
    const text = joined(lines);
    const line1 = lines[0] ?? "";
    const line2 = lines[1] ?? "";
    assert.match(line1, /opus-4-5/);
    assert.match(line1, /high/);
    assert.match(line1, /anthropic/);
    assert.match(line1, /48%/);
    assert.match(line1, /96k\/200k/);
    assert.match(line2, /~\/proj/);
    assert.match(line2, /main/);
    assert.match(text, /12k in/);
    assert.match(text, /3\.4k out/);
    assert.match(text, /\$1\.234 sub/);
  });

  it("hal shows model, thinking, context tokens, place, and usage at width 120", () => {
    const lines = buildHalFooter(snapshot(), 120, paint);
    assert.ok(lines.length <= 3 && lines.length >= 1);
    for (const line of lines) assert.ok(safeVisibleWidth(line) <= 120);
    const text = joined(lines);
    const line1 = lines[0] ?? "";
    const line2 = lines[1] ?? "";
    assert.match(line1, /OPUS-4-5/);
    assert.match(line1, /HIGH/);
    assert.match(line1, /48%/);
    assert.match(line1, /96K\/200K/);
    assert.match(line2, /~\/proj/);
    assert.match(line2, /main/);
    assert.match(text, /12K\/3\.4K/);
    assert.match(text, /COST \$1\.234 SUB/);
  });

  it("claude keeps the model on line 1 at 85% context (tone, not replacement)", () => {
    const s = snapshot({ context: { percent: 85, window: 200000, tokens: 170000 } });
    const lines = buildClaudeFooter(s, 120, paint);
    const line1 = lines[0] ?? "";
    assert.match(line1, /opus-4-5/);
    assert.match(line1, /85%/);
    assert.doesNotMatch(line1, /auto-compact/);
  });

  it("never fabricates a used count when context tokens are unknown", () => {
    const s = snapshot({ context: { percent: 48, window: 200000, tokens: null } });
    for (const build of [buildApexFooter, buildClaudeFooter, buildHalFooter]) {
      const text = joined(build(s, 120, paint));
      assert.match(text, /48%/);
      assert.match(text, /200k/i);
      assert.doesNotMatch(text, /96k/i);
    }
    assert.match(joined(buildApexFooter(s, 120, paint)), /of 200k/);
  });

  it("renders unknown context without crashing", () => {
    const s = snapshot({ context: { percent: null, window: 200000, tokens: null } });
    for (const build of [buildApexFooter, buildClaudeFooter, buildHalFooter]) {
      const lines = build(s, 120, paint);
      assert.ok(lines.length >= 1);
      assert.match(joined(lines), /\?/);
      for (const line of lines) assert.ok(safeVisibleWidth(line) <= 120);
    }
  });

  it("narrow width keeps model and percent, drops usage and cost", () => {
    for (const build of [buildApexFooter, buildClaudeFooter, buildHalFooter]) {
      const lines = build(snapshot(), 40, paint);
      assert.ok(lines.length >= 1);
      for (const line of lines) assert.ok(safeVisibleWidth(line) <= 40);
      const text = joined(lines);
      assert.match(text, /opus-4-5/i);
      assert.match(text, /48%|\?/);
      assert.match(text, /~\/proj/);
      assert.doesNotMatch(text, /\$1\.234/);
    }
  });

  it("stays within width and line budget at width 80", () => {
    for (const build of [buildApexFooter, buildClaudeFooter, buildHalFooter]) {
      const lines = build(snapshot(), 80, paint);
      assert.ok(lines.length <= 3 && lines.length >= 1);
      for (const line of lines) assert.ok(safeVisibleWidth(line) <= 80);
      assert.match(joined(lines), /opus-4-5/i);
    }
  });
});

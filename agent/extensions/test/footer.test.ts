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
import { formatModeStatus } from "../prompt-commands/modes.ts";

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
    assert.match(line1, /MODE: FUSION/);
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
    assert.match(line1, /MODE: FUSION/);
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

  it("formats descriptive mode statuses with posture and sidekick model (Option C)", () => {
    assert.equal(formatModeStatus({ mode: "pi" }), "Pi \u00B7 Direct");
    assert.equal(formatModeStatus({ mode: "apex" }), "Apex \u00B7 Inline");
    assert.equal(formatModeStatus({ mode: "apex-orchestrate" }), "Apex Orchestrate \u00B7 Pipeline");
    assert.equal(formatModeStatus({ mode: "utopia" }), "Utopia \u00B7 +Sidekick");
    assert.equal(formatModeStatus({ mode: "work" }), "Work \u00B7 Crew");
    assert.equal(formatModeStatus({ mode: "fusion" }), "Fusion \u00B7 Sidekick");
    assert.equal(
      formatModeStatus({
        mode: "fusion",
        fusion: {
          lead: { provider: "anthropic", modelId: "opus-4-5", thinking: "high" },
          sidekick: { provider: "openai", modelId: "gpt-5.4-mini", thinking: "low" },
        },
      }),
      "Fusion \u00B7 +gpt-5.4-mini",
    );
  });

  it("combines explicit MODE badge, posture, and inline hydra modifier on line 1 without duplicating hydra on line 2", () => {
    const s = snapshot({
      mode: formatModeStatus({ mode: "utopia" }),
      statuses: [
        { key: "cua", text: "cua:on" },
        { key: "hydra", text: "hydra:high\u00B7jippity" },
      ],
    });
    const apexLines = buildApexFooter(s, 140, paint);
    assert.match(apexLines[0] ?? "", /MODE: UTOPIA \u00B7 \+SIDEKICK \(HYDRA:HIGH\u00B7JIPPITY\)/);
    assert.doesNotMatch(apexLines[1] ?? "", /hydra/i);
    assert.match(apexLines[1] ?? "", /cua:on/);

    const claudeLines = buildClaudeFooter(s, 140, paint);
    assert.match(claudeLines[0] ?? "", /\u25B8\u25B8 utopia mode \u00B7 \+sidekick \(hydra:high\u00B7jippity\)/);
    assert.doesNotMatch(claudeLines[1] ?? "", /hydra/i);
    assert.match(claudeLines[1] ?? "", /cua:on/);

    const halLines = buildHalFooter(s, 140, paint);
    assert.match(halLines[0] ?? "", /MODE: UTOPIA \u00B7 \+SIDEKICK \(HYDRA:HIGH\u00B7JIPPITY\)/);
    assert.doesNotMatch(halLines[1] ?? "", /hydra/i);
    assert.match(halLines[1] ?? "", /CUA:ON/);
  });

  it("keeps Apex and Apex Orchestrate distinct at medium width (55) when posture detail drops", () => {
    const inlineSnap = snapshot({ mode: formatModeStatus({ mode: "apex" }) });
    const orchSnap = snapshot({ mode: formatModeStatus({ mode: "apex-orchestrate" }) });
    for (const build of [buildApexFooter, buildClaudeFooter, buildHalFooter]) {
      const inlineLine1 = build(inlineSnap, 55, paint)[0] ?? "";
      const orchLine1 = build(orchSnap, 55, paint)[0] ?? "";
      assert.notEqual(inlineLine1, orchLine1);
      assert.match(orchLine1, /orchestrate/i);
    }
  });

  it("retains hydra status on line 2 when line 1 sheds mode detail at width 80", () => {
    const s = snapshot({
      mode: formatModeStatus({ mode: "utopia" }),
      statuses: [{ key: "hydra", text: "hydra:high\u00B7jippity" }],
    });
    for (const build of [buildApexFooter, buildClaudeFooter, buildHalFooter]) {
      const lines = build(s, 80, paint);
      assert.match(joined(lines), /hydra:high\u00B7jippity/i);
    }
  });

  it("hal drops system phrase before cost at width 60", () => {
    const s = snapshot({ statuses: [] });
    const lines = buildHalFooter(s, 60, paint);
    const line2 = lines[1] ?? "";
    assert.match(line2, /COST \$1\.234 SUB/);
    assert.doesNotMatch(line2, /ALL SYSTEMS NOMINAL/);
  });

  it("sheds verbose jev telemetry on line 2 before dropping cua:on", () => {
    const s = snapshot({
      mode: formatModeStatus({ mode: "apex" }),
      statuses: [
        { key: "cua", text: "cua:on" },
        { key: "jev", text: "jev route \u00B7 12 calls, 48,920 tok (advisory)" },
      ],
    });
    // Width 65 fits place + usage + cost + cua:on (~50 cols), but not the 43-col jev telemetry.
    const apexLines = buildApexFooter(s, 65, paint);
    assert.match(apexLines[1] ?? "", /cua:on/);
    assert.doesNotMatch(apexLines[1] ?? "", /jev route/);

    const claudeLines = buildClaudeFooter(s, 65, paint);
    assert.match(claudeLines[1] ?? "", /cua:on/);
    assert.doesNotMatch(claudeLines[1] ?? "", /jev route/);

    // HAL includes the right-aligned system phrase ("ALL SYSTEMS NOMINAL", 19 cols), so test at width 85.
    const halLines = buildHalFooter(s, 85, paint);
    assert.match(halLines[1] ?? "", /CUA:ON/);
    assert.doesNotMatch(halLines[1] ?? "", /JEV ROUTE/);
  });
});

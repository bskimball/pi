import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  installOrchestrateFooterPatch,
  ORCHESTRATE_STATUS_KEY,
  relocateOrchestrateStatus,
  resolveRuntimeFooterPath,
} from "../apex/lib/orchestrate-footer-patch.ts";
import { safeVisibleWidth } from "../apex/lib/safe-text-layout.ts";

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const warning = (text: string) => `\x1b[33m${text}\x1b[0m`;

describe("relocateOrchestrateStatus", () => {
  it("returns stock output unchanged when orchestrate is absent", () => {
    const stock = [dim("cwd (main)"), dim("stock stats"), "other"];
    const result = relocateOrchestrateStatus(
      stock,
      new Map([["other", "other"]]),
      80,
    );
    assert.equal(result, stock);
  });

  it("moves only orchestrate onto row 1 and preserves stock row 2 exactly", () => {
    const row2 = dim("↑10 ↓20 R30 $0.123 21.0%/200k        model • high");
    const stock = [dim("~/project (main)"), row2, warning("orchestrator")];
    const result = relocateOrchestrateStatus(
      stock,
      new Map([[ORCHESTRATE_STATUS_KEY, warning("orchestrator")]]),
      80,
    );
    assert.equal(result.length, 2);
    assert.equal(result[1], row2);
    assert.equal(safeVisibleWidth(result[0]), 80);
    assert.match(result[0], /orchestrator/);
  });

  it("preserves other statuses on a sorted third row", () => {
    const statuses = new Map([
      ["zeta", "z status"],
      [ORCHESTRATE_STATUS_KEY, "orchestrator"],
      ["alpha", "a\nstatus"],
    ]);
    const result = relocateOrchestrateStatus(
      ["cwd", "stats", "a status orchestrator z status"],
      statuses,
      80,
    );
    assert.deepEqual(result, [
      `${"cwd"}${" ".repeat(65)}orchestrator`,
      "stats",
      "a status z status",
    ]);
  });

  it("handles narrow and zero widths without adding rows", () => {
    const statuses = new Map([[ORCHESTRATE_STATUS_KEY, "orchestrator"]]);
    assert.deepEqual(
      relocateOrchestrateStatus(["cwd", "stats", "orchestrator"], statuses, 0),
      ["", "stats"],
    );
    const narrow = relocateOrchestrateStatus(
      ["cwd", "stats", "orchestrator"],
      statuses,
      5,
    );
    assert.equal(narrow.length, 2);
    assert.ok(safeVisibleWidth(narrow[0]) <= 5);
  });
});

describe("installOrchestrateFooterPatch", () => {
  it("patches once and updates the delegate on reinstall", () => {
    let originalCalls = 0;
    class FakeFooter {
      footerData = {
        getExtensionStatuses: () =>
          new Map([[ORCHESTRATE_STATUS_KEY, "orchestrator"]]),
      };
      render(_width: number): string[] {
        originalCalls++;
        return ["cwd", "stats", "orchestrator"];
      }
    }

    assert.equal(installOrchestrateFooterPatch(FakeFooter as any), true);
    const wrapper = FakeFooter.prototype.render;
    const first = new FakeFooter().render(30);
    assert.equal(first.length, 2);

    const replacement = (lines: string[]) => [lines[0]!, "replacement"];
    assert.equal(
      installOrchestrateFooterPatch(FakeFooter as any, replacement),
      true,
    );
    assert.equal(FakeFooter.prototype.render, wrapper);
    assert.deepEqual(new FakeFooter().render(30), ["cwd", "replacement"]);
    assert.equal(originalCalls, 2);
  });

  it("falls back to stock output for malformed footer data", () => {
    class FakeFooter {
      footerData = { getExtensionStatuses: () => { throw new Error("bad"); } };
      render(_width?: number): string[] {
        return ["cwd", "stats"];
      }
    }
    installOrchestrateFooterPatch(FakeFooter as any);
    assert.deepEqual(new FakeFooter().render(80), ["cwd", "stats"]);
  });
});

describe("resolveRuntimeFooterPath", () => {
  it("resolves beside the running dist/cli.js", () => {
    const resolved = resolveRuntimeFooterPath("C:/pi-package/dist/cli.js");
    assert.ok(resolved?.replace(/\\/g, "/").endsWith(
      "/dist/modes/interactive/components/footer.js",
    ));
  });

  it("returns undefined without a CLI path", () => {
    assert.equal(resolveRuntimeFooterPath(undefined), undefined);
  });
});

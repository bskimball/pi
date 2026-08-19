import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attachTaskHostPainter,
  paintTaskPinnedSurface,
  requestTaskHostRender,
} from "./render-safety.ts";

describe("Task pinned-surface repaint", () => {
  it("falls back to receipt invalidation when no host painter is mounted", () => {
    let remounts = 0;
    assert.equal(requestTaskHostRender(), false);
    assert.equal(
      paintTaskPinnedSurface(() => {
        remounts += 1;
      }),
      false,
    );
    assert.equal(remounts, 1);
  });

  it("requests a host frame without remounting the transcript receipt", () => {
    let paints = 0;
    let remounts = 0;
    const detach = attachTaskHostPainter({
      requestRender() {
        paints += 1;
      },
    });
    try {
      assert.equal(
        paintTaskPinnedSurface(() => {
          remounts += 1;
        }),
        true,
      );
      assert.equal(paints, 1);
      assert.equal(remounts, 0);
    } finally {
      detach();
    }
  });
});

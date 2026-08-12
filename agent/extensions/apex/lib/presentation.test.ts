import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  apexPresentationEnabled,
  withApexPresentation,
} from "./presentation.ts";

describe("presentation gate", () => {
  it("defaults to enabled and disables on PI_APEX_UI=0", () => {
    const prev = process.env.PI_APEX_UI;
    try {
      delete process.env.PI_APEX_UI;
      assert.equal(apexPresentationEnabled(), true);
      process.env.PI_APEX_UI = "0";
      assert.equal(apexPresentationEnabled(), false);
      process.env.PI_APEX_UI = "1";
      assert.equal(apexPresentationEnabled(), true);
    } finally {
      if (prev === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = prev;
    }
  });

  it("strips only renderer slots and always preserves tool execution", () => {
    const prev = process.env.PI_APEX_UI;
    const execute = () => "ok";
    try {
      process.env.PI_APEX_UI = "0";
      const disabled = withApexPresentation({
        renderShell: "self",
        renderCall: () => undefined,
        renderResult: () => undefined,
        execute,
        custom: 42,
      });
      assert.equal(disabled.renderShell, undefined);
      assert.equal(disabled.renderCall, undefined);
      assert.equal(disabled.renderResult, undefined);
      assert.equal(disabled.execute, execute);
      assert.equal(disabled.execute(), "ok");
      assert.equal(disabled.custom, 42);

      process.env.PI_APEX_UI = "1";
      const enabled = withApexPresentation({ renderShell: "self", execute });
      assert.equal(enabled.renderShell, "self");
      assert.equal(enabled.execute, execute);
    } finally {
      if (prev === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = prev;
    }
  });
});

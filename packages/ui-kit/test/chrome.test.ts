import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  UI_CHROME_ENV_VAR,
  UI_CHROME_LEGACY_ENV_VAR,
  uiChromeEnabled,
} from "@pi/ui-kit";

function withEnv(vars: Record<string, string | undefined>, run: () => void): void {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("uiChromeEnabled", () => {
  it("treats unset env as enabled", () => {
    withEnv({ [UI_CHROME_ENV_VAR]: undefined, [UI_CHROME_LEGACY_ENV_VAR]: undefined }, () => {
      assert.equal(uiChromeEnabled(), true);
    });
  });

  it("honors the deprecated PI_APEX_UI alias", () => {
    withEnv({ [UI_CHROME_ENV_VAR]: undefined, [UI_CHROME_LEGACY_ENV_VAR]: "0" }, () => {
      assert.equal(uiChromeEnabled(), false);
    });
  });

  it("lets PI_UI_CHROME win when both are set", () => {
    withEnv({ [UI_CHROME_ENV_VAR]: "1", [UI_CHROME_LEGACY_ENV_VAR]: "0" }, () => {
      assert.equal(uiChromeEnabled(), true);
    });
    withEnv({ [UI_CHROME_ENV_VAR]: "0", [UI_CHROME_LEGACY_ENV_VAR]: "1" }, () => {
      assert.equal(uiChromeEnabled(), false);
    });
  });
});

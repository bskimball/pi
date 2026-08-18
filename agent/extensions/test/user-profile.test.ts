import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyUserProfileToSystemPrompt,
  loadUserProfile,
  MAX_USER_PROFILE_CHARS,
  USER_PROFILE_FILE,
} from "../user-profile.ts";

function withAgentDir(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "pi-user-profile-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("loads and trims a private user profile", () => {
  withAgentDir((directory) => {
    writeFileSync(join(directory, USER_PROFILE_FILE), "\n# Brian\n\nContext.\n");
    assert.equal(loadUserProfile(directory), "# Brian\n\nContext.");
  });
});

test("returns undefined when the private profile is absent or empty", () => {
  withAgentDir((directory) => {
    assert.equal(loadUserProfile(directory), undefined);
    writeFileSync(join(directory, USER_PROFILE_FILE), "  \n");
    assert.equal(loadUserProfile(directory), undefined);
  });
});

test("bounds injected private context", () => {
  withAgentDir((directory) => {
    writeFileSync(
      join(directory, USER_PROFILE_FILE),
      "x".repeat(MAX_USER_PROFILE_CHARS + 10),
    );
    assert.equal(loadUserProfile(directory)?.length, MAX_USER_PROFILE_CHARS);
  });
});

test("applyUserProfileToSystemPrompt injects when profile present and not subagent", () => {
  const next = applyUserProfileToSystemPrompt("base", "Hello", false);
  assert.equal(next, "base\n\n# Private user context\n\nHello");
});

test("applyUserProfileToSystemPrompt skips subagents even when profile present", () => {
  assert.equal(applyUserProfileToSystemPrompt("base", "Hello", true), undefined);
});

test("applyUserProfileToSystemPrompt skips missing profile", () => {
  assert.equal(applyUserProfileToSystemPrompt("base", undefined, false), undefined);
});

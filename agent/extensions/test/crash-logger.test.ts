import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MAX_LOG_BYTES, rotateIfNeeded } from "../crash-logger.ts";

describe("crash log rotation", () => {
  it("renames the complete active log instead of rewriting it in place", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-crash-"));
    const logPath = join(directory, "pi-crash.log");
    const original = `=== first event ===\n${"x".repeat(MAX_LOG_BYTES)}\n`;
    writeFileSync(logPath, original, "utf8");

    rotateIfNeeded(logPath);

    assert.throws(() => statSync(logPath));
    const archives = readdirSync(directory).filter((name) =>
      name.startsWith("pi-crash.rotated."),
    );
    assert.equal(archives.length, 1);
    assert.equal(readFileSync(join(directory, archives[0]), "utf8"), original);
  });

  it("rotates different log names into independent archive namespaces", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-crash-"));
    const crashPath = join(directory, "pi-crash.log");
    const lifecyclePath = join(directory, "pi-lifecycle.log");

    writeFileSync(crashPath, "c".repeat(MAX_LOG_BYTES), "utf8");
    writeFileSync(lifecyclePath, "l".repeat(MAX_LOG_BYTES), "utf8");
    rotateIfNeeded(crashPath);
    rotateIfNeeded(lifecyclePath);

    const archives = readdirSync(directory);
    assert.equal(
      archives.filter((name) => name.startsWith("pi-crash.rotated.")).length,
      1,
    );
    assert.equal(
      archives.filter((name) => name.startsWith("pi-lifecycle.rotated.")).length,
      1,
    );
  });

  it("retains only the newest complete rotated generation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-crash-"));
    const logPath = join(directory, "pi-crash.log");

    writeFileSync(logPath, "a".repeat(MAX_LOG_BYTES), "utf8");
    rotateIfNeeded(logPath);
    await new Promise((resolve) => setTimeout(resolve, 5));
    writeFileSync(logPath, "b".repeat(MAX_LOG_BYTES), "utf8");
    rotateIfNeeded(logPath);

    const archives = readdirSync(directory).filter((name) =>
      name.startsWith("pi-crash.rotated."),
    );
    assert.equal(archives.length, 1);
    assert.equal(readFileSync(join(directory, archives[0]), "utf8"), "b".repeat(MAX_LOG_BYTES));
  });
});

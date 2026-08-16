import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import {
  lastPhasePath,
  readLastPhase,
  writeLastPhase,
} from "../crash-logger/internal/last-phase.ts";

describe("last-phase", () => {
  it("writes and reads a roundtrip for this pid", () => {
    writeLastPhase("startup");
    const line = readLastPhase(process.pid);
    assert.ok(line);
    assert.match(line, / pid=\d+ startup$/);
    assert.equal(fs.readFileSync(lastPhasePath(process.pid), "utf8").trim(), line);
  });

  it("strips newlines and caps phase length", () => {
    writeLastPhase("a\r\nb" + "x".repeat(300));
    const line = readLastPhase(process.pid);
    assert.ok(line);
    assert.doesNotMatch(line, /[\r\n]/);
    assert.match(line, / a bxx/);
    const phase = line.replace(/^\S+ pid=\d+ /, "");
    assert.equal(phase.length, 240);
  });

  it("returns undefined for a missing pid", () => {
    assert.equal(readLastPhase(2_147_483_647), undefined);
  });
});

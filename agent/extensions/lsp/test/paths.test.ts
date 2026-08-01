import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { detectRoot, languageForPath, pathToUri, uriToPath } from "../paths.ts";

describe("paths", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-lsp-root-"));
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("maps extensions to languages", () => {
    assert.equal(languageForPath("a.ts")?.key, "typescript");
    assert.equal(languageForPath("a.tsx")?.languageId, "typescriptreact");
    assert.equal(languageForPath("a.py")?.key, "python");
    assert.equal(languageForPath("a.go")?.key, "go");
    assert.equal(languageForPath("a.php")?.key, "php");
    assert.equal(languageForPath("a.md"), undefined);
  });

  it("detects nearest go.mod without walking above cwd", () => {
    const cwd = join(root, "workspace");
    const nested = join(cwd, "services", "api");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(cwd, "go.mod"), "module example\n");
    writeFileSync(join(nested, "main.go"), "package main\n");
    // Outer marker above cwd must be ignored
    writeFileSync(join(root, "go.mod"), "module outer\n");

    const detected = detectRoot(join(nested, "main.go"), cwd, "go");
    assert.equal(detected, cwd);
  });

  it("prefers package.json over only walking to git for typescript", () => {
    const cwd = join(root, "ts-monorepo");
    const pkg = join(cwd, "packages", "app");
    mkdirSync(join(pkg, "src"), { recursive: true });
    mkdirSync(join(cwd, ".git")); // file or dir
    writeFileSync(join(cwd, "package.json"), "{}");
    writeFileSync(join(pkg, "package.json"), "{}");
    writeFileSync(join(pkg, "src", "index.ts"), "export {}\n");

    const detected = detectRoot(join(pkg, "src", "index.ts"), cwd, "typescript");
    assert.equal(detected, pkg);
  });

  it("falls back to cwd when no markers", () => {
    const cwd = join(root, "empty");
    mkdirSync(cwd, { recursive: true });
    const file = join(cwd, "x.go");
    writeFileSync(file, "package x\n");
    assert.equal(detectRoot(file, cwd, "go"), cwd);
  });

  it("honors custom rootMarkers override", () => {
    const cwd = join(root, "custom-markers");
    const nested = join(cwd, "pkg", "sub");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(cwd, "go.mod"), "module example\n");
    writeFileSync(join(cwd, "pkg", ".my-root"), "");
    writeFileSync(join(nested, "main.go"), "package main\n");

    // Default markers would stop at go.mod (cwd).
    assert.equal(detectRoot(join(nested, "main.go"), cwd, "go"), cwd);
    // Custom markers prefer nearest .my-root under pkg/.
    assert.equal(
      detectRoot(join(nested, "main.go"), cwd, "go", [".my-root", "go.mod"]),
      join(cwd, "pkg"),
    );
  });

  it("round-trips file URIs and normalizes drive case", () => {
    if (process.platform === "win32") {
      const uri = pathToUri("C:\\Users\\test\\file.go");
      assert.match(uri, /^file:\/\/\/C:\//);
      const back = uriToPath(uri);
      assert.match(back.toLowerCase(), /users\\test\\file\.go$/i);
    } else {
      const uri = pathToUri("/tmp/file.go");
      assert.equal(uri, "file:///tmp/file.go");
      assert.equal(uriToPath(uri), "/tmp/file.go");
    }
  });
});

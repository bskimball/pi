import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

function isExtensionFile(name: string): boolean {
  return name.endsWith(".ts") || name.endsWith(".js");
}

function declaredEntries(dir: string): string[] | undefined {
  const manifestPath = join(dir, "package.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const entries = manifest?.pi?.extensions;
    if (Array.isArray(entries) && entries.length > 0) {
      return entries
        .map((entry: unknown) => resolve(dir, String(entry)))
        .filter(existsSync);
    }
  }
  for (const name of ["index.ts", "index.js"]) {
    const entry = join(dir, name);
    if (existsSync(entry)) return [entry];
  }
  return undefined;
}

function localImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/(?:from\s+|import\s*)["'](\.{1,2}\/[^"']+)["']/g)]
    .map((match) => resolve(dirname(file), match[1]));
}

function sourceClosure(entry: string): string[] {
  const pending = [entry];
  const seen = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file) || !existsSync(file) || !isExtensionFile(file)) continue;
    seen.add(file);
    pending.push(...localImports(file));
  }
  return [...seen];
}

function discoverExtensions(dir: string): string[] {
  const discovered: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);
    if (entry.isFile() && isExtensionFile(entry.name)) {
      discovered.push(resolve(entryPath));
      continue;
    }
    if (entry.isDirectory()) {
      discovered.push(...(declaredEntries(entryPath) ?? []));
    }
  }
  return discovered;
}

describe("extension discovery layout", () => {
  it("loads package entry points once and excludes support directories", () => {
    const extensionsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const relative = discoverExtensions(extensionsDir)
      .map((entry) => entry.slice(extensionsDir.length + 1).replaceAll("\\", "/"))
      .sort();

    for (const required of [
      "apex/apex-ui.ts",
      "lsp/index.ts",
      "task/amp-task.ts",
      "task/async-task.ts",
    ]) {
      assert.equal(relative.filter((entry) => entry === required).length, 1, required);
    }

    assert.equal(existsSync(join(extensionsDir, "shared")), false);
    assert.equal(relative.some((entry) => entry.includes("/test/")), false);
    assert.equal(relative.some((entry) => entry.includes("observatory/")), false);
    assert.equal(relative.some((entry) => entry.includes("runtime/")), false);
    assert.equal(relative.some((entry) => entry.includes("internal/")), false);
    // The `edit` and todo tools are Apex-owned; no standalone entry may
    // register them a second time.
    assert.equal(relative.includes("todo-list.ts"), false);
    assert.equal(relative.some((entry) => entry.startsWith("unified-edit/")), false);
  });

  it("keeps every extension entry source-independent", () => {
    const extensionsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    for (const entry of discoverExtensions(extensionsDir)) {
      const entryRelative = relative(extensionsDir, entry).replaceAll("\\", "/");
      const owner = entryRelative.includes("/")
        ? entryRelative.split("/")[0]
        : entryRelative.replace(/\.[^.]+$/, "");
      for (const file of sourceClosure(entry)) {
        for (const target of localImports(file)) {
          const targetRelative = relative(extensionsDir, target).replaceAll("\\", "/");
          assert.ok(
            targetRelative === owner || targetRelative.startsWith(`${owner}/`),
            `${relative(extensionsDir, file)} imports another extension source: ${targetRelative}`,
          );
        }
      }
    }
  });
});

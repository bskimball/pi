import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type {
  AutocompleteItem,
  AutocompleteProvider,
} from "@earendil-works/pi-tui";
import atPathComplete, {
  createAtPathProvider,
  extractAtPrefix,
  isScopedAtQuery,
  listScopedAtItems,
  parseAtPrefix,
} from "../at-path-complete.ts";

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "at-path-complete-"));
  mkdirSync(join(root, "files"));
  mkdirSync(join(root, "skills"));
  writeFileSync(join(root, "files", "secret.env"), "TOKEN=x\n");
  writeFileSync(join(root, "files", "notes.md"), "# notes\n");
  writeFileSync(join(root, "skills", "browser.md"), "# skill\n");
  return root;
}

function skillHitProvider(): AutocompleteProvider {
  return {
    async getSuggestions() {
      return {
        items: [
          {
            value: "@skills/browser.md",
            label: "browser.md",
            description: "skills/browser.md",
          },
        ],
        prefix: "@files/",
      };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const current = lines[cursorLine] ?? "";
      const next = `${current.slice(0, cursorCol - prefix.length)}${item.value}${current.slice(cursorCol)}`;
      const nextLines = [...lines];
      nextLines[cursorLine] = next;
      return { lines: nextLines, cursorLine, cursorCol: cursorCol - prefix.length + item.value.length };
    },
  };
}

describe("at-path-complete parsing", () => {
  it("extracts scoped @ prefixes including quoted paths", () => {
    assert.equal(extractAtPrefix("@files/"), "@files/");
    assert.equal(extractAtPrefix("see @files/sec"), "@files/sec");
    assert.equal(extractAtPrefix('@"files/my file'), '@"files/my file');
    assert.equal(extractAtPrefix("email@files/"), null);
  });

  it("treats a slash as the scoped-listing trigger", () => {
    assert.equal(isScopedAtQuery("files/"), true);
    assert.equal(isScopedAtQuery("files\\secret"), true);
    assert.equal(isScopedAtQuery("files"), false);
    assert.equal(parseAtPrefix("@files/").raw, "files/");
    assert.equal(parseAtPrefix('@"files/').quoted, true);
  });
});

describe("at-path-complete listing", () => {
  it("lists on-disk children of a gitignored-style folder", () => {
    const cwd = makeWorkspace();
    const listed = listScopedAtItems("files/", cwd, false);
    assert.equal(listed.directoryExists, true);
    const names = listed.items.map((item) => item.label).sort();
    assert.deepEqual(names, ["notes.md", "secret.env"]);
    assert.ok(listed.items.every((item) => item.value.startsWith("@files/")));
    assert.equal(
      listed.items.some((item) => item.description?.includes("skills")),
      false,
    );
  });

  it("filters the last path segment and ranks prefix matches first", () => {
    const cwd = makeWorkspace();
    const listed = listScopedAtItems("files/sec", cwd, false);
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0]?.label, "secret.env");
    assert.equal(listed.items[0]?.value, "@files/secret.env");
  });

  it("quotes completions that contain spaces", () => {
    const cwd = makeWorkspace();
    writeFileSync(join(cwd, "files", "my notes.txt"), "x");
    const listed = listScopedAtItems("files/my", cwd, false);
    assert.equal(listed.items[0]?.value, '@"files/my notes.txt"');
  });

  it("reports a missing directory so the inner provider can run", () => {
    const cwd = makeWorkspace();
    const listed = listScopedAtItems("nope/", cwd, false);
    assert.equal(listed.directoryExists, false);
    assert.equal(listed.items.length, 0);
  });
});

describe("at-path-complete provider wrap", () => {
  it("replaces FFF skill hits when @files/ exists on disk", async () => {
    const cwd = makeWorkspace();
    const provider = createAtPathProvider(skillHitProvider(), () => cwd);
    const result = await provider.getSuggestions(["@files/"], 0, 7, {
      signal: new AbortController().signal,
    });
    assert.ok(result);
    const labels = result.items.map((item: AutocompleteItem) => item.label);
    assert.ok(labels.includes("secret.env"));
    assert.equal(labels.includes("browser.md"), false);
    assert.equal(result.prefix, "@files/");
  });

  it("delegates unscoped @ queries to the inner provider", async () => {
    const cwd = makeWorkspace();
    const provider = createAtPathProvider(skillHitProvider(), () => cwd);
    const result = await provider.getSuggestions(["@files"], 0, 6, {
      signal: new AbortController().signal,
    });
    assert.equal(result?.items[0]?.label, "browser.md");
  });

  it("delegates scoped @ queries when the directory does not exist", async () => {
    const cwd = makeWorkspace();
    const provider = createAtPathProvider(skillHitProvider(), () => cwd);
    const result = await provider.getSuggestions(["@missing/"], 0, 9, {
      signal: new AbortController().signal,
    });
    assert.equal(result?.items[0]?.label, "browser.md");
  });

  it("returns null for an empty existing directory instead of leaking fuzzy hits", async () => {
    const cwd = makeWorkspace();
    mkdirSync(join(cwd, "empty"));
    const provider = createAtPathProvider(skillHitProvider(), () => cwd);
    const result = await provider.getSuggestions(["@empty/"], 0, 7, {
      signal: new AbortController().signal,
    });
    assert.equal(result, null);
  });

  it("returns null when the directory exists but the last segment matches nothing", async () => {
    const cwd = makeWorkspace();
    const provider = createAtPathProvider(skillHitProvider(), () => cwd);
    const result = await provider.getSuggestions(["@files/zzz"], 0, 10, {
      signal: new AbortController().signal,
    });
    assert.equal(result, null);
  });
});

function withPiSubagent<T>(value: string | undefined, run: () => T): T {
  const prev = process.env.PI_SUBAGENT;
  if (value === undefined) delete process.env.PI_SUBAGENT;
  else process.env.PI_SUBAGENT = value;
  try {
    return run();
  } finally {
    if (prev === undefined) delete process.env.PI_SUBAGENT;
    else process.env.PI_SUBAGENT = prev;
  }
}

describe("at-path-complete extension wiring", () => {
  it("skips subagents", () => {
    withPiSubagent("1", () => {
      const events: string[] = [];
      atPathComplete({
        on(name: string) {
          events.push(name);
        },
      } as never);
      assert.deepEqual(events, []);
    });
  });

  it("registers the overlay on resources_discover after session_start", () => {
    withPiSubagent(undefined, () => {
      const handlers: Record<string, (...args: never[]) => unknown> = {};
      atPathComplete({
        on(name: string, fn: (...args: never[]) => unknown) {
          handlers[name] = fn;
        },
      } as never);
      assert.ok(handlers.session_start);
      assert.ok(handlers.resources_discover);

      const factories: Array<(current: AutocompleteProvider) => AutocompleteProvider> = [];
      const ctx = {
        cwd: "/tmp",
        ui: {
          addAutocompleteProvider(factory: (current: AutocompleteProvider) => AutocompleteProvider) {
            factories.push(factory);
          },
        },
      };
      handlers.session_start?.({ type: "session_start", reason: "startup" } as never, ctx as never);
      assert.equal(factories.length, 0);
      handlers.resources_discover?.(
        { type: "resources_discover", cwd: "/tmp", reason: "startup" } as never,
        ctx as never,
      );
      assert.equal(factories.length, 1);
    });
  });
});

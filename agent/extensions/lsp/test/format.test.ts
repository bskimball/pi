import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatDiagnostics,
  formatHover,
  formatLocations,
  normalizeDocumentSymbols,
  normalizeLocations,
  normalizeWorkspaceSymbols,
  pickBestSymbol,
} from "../format.ts";

describe("format", () => {
  it("normalizes Location and LocationLink", () => {
    const locs = normalizeLocations([
      { uri: "file:///a.ts", range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } } },
      {
        targetUri: "file:///b.ts",
        targetRange: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
        targetSelectionRange: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } },
      },
    ]);
    assert.equal(locs.length, 2);
    assert.equal(locs[0].uri, "file:///a.ts");
    assert.equal(locs[1].targetSelection?.start.line, 2);
    const text = formatLocations(locs);
    assert.match(text, /a\.ts:2:3/);
    assert.match(text, /b\.ts:1:1/);
  });

  it("formats MarkupContent and MarkedString hover", () => {
    assert.match(
      formatHover({ contents: { kind: "markdown", value: "**Hi**" } }),
      /\*\*Hi\*\*/,
    );
    assert.match(
      formatHover({ contents: [{ language: "ts", value: "const x = 1" }, "note"] }),
      /const x = 1/,
    );
    assert.equal(formatHover(null), "No hover information.");
  });

  it("flattens hierarchical DocumentSymbol and SymbolInformation", () => {
    const hierarchical = normalizeDocumentSymbols(
      [
        {
          name: "Foo",
          kind: 5,
          range: { start: { line: 0, character: 0 }, end: { line: 10, character: 1 } },
          selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
          children: [
            {
              name: "bar",
              kind: 6,
              range: { start: { line: 2, character: 2 }, end: { line: 4, character: 3 } },
              selectionRange: { start: { line: 2, character: 2 }, end: { line: 2, character: 5 } },
            },
          ],
        },
      ],
      "file:///proj/a.ts",
    );
    assert.equal(hierarchical.length, 2);
    assert.equal(hierarchical[1].name, "bar");
    assert.equal(hierarchical[1].containerName, "Foo");

    const flat = normalizeDocumentSymbols(
      [
        {
          name: "baz",
          kind: 12,
          location: {
            uri: "file:///proj/a.ts",
            range: { start: { line: 5, character: 0 }, end: { line: 5, character: 3 } },
          },
        },
      ],
      "file:///proj/a.ts",
    );
    assert.equal(flat[0].name, "baz");
  });

  it("normalizes workspace symbols", () => {
    const symbols = normalizeWorkspaceSymbols([
      {
        name: "Serve",
        kind: 12,
        location: {
          uri: "file:///app/main.go",
          range: { start: { line: 3, character: 5 }, end: { line: 3, character: 10 } },
        },
      },
    ]);
    assert.equal(symbols[0].path.includes("main.go"), true);
  });

  it("pickBestSymbol prefers exact and reports ambiguity", () => {
    const symbols = [
      { name: "Foo", kind: 5, path: "/a.ts" },
      { name: "Foo", kind: 12, path: "/b.ts" },
      { name: "foobar", kind: 12, path: "/c.ts" },
    ];
    const amb = pickBestSymbol(symbols, "Foo");
    assert.equal(amb.ambiguous?.length, 2);
    const one = pickBestSymbol(symbols, "foobar");
    assert.equal(one.match?.name, "foobar");
  });

  it("diagnostics unknown vs clean", () => {
    assert.match(
      formatDiagnostics([], "/a.ts", { status: "unknown" }),
      /status: unknown/i,
    );
    assert.match(
      formatDiagnostics([], "/a.ts", { status: "received" }),
      /No diagnostics/,
    );
    assert.match(
      formatDiagnostics(
        [{ severity: 1, message: "oops", range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } } }],
        "/a.ts",
        { status: "pull" },
      ),
      /error.*a\.ts:1:2/,
    );
  });
});

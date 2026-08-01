import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * Document versioning logic mirrored from LspClient.ensureDocument for unit testing
 * without spawning a server.
 */
interface Doc {
  uri: string;
  version: number;
  text: string;
}

function ensureDocument(
  docs: Map<string, Doc>,
  uri: string,
  text: string,
  notifications: Array<{ method: string; version: number; full: boolean }>,
): Doc {
  const existing = docs.get(uri);
  if (!existing) {
    const doc = { uri, version: 1, text };
    docs.set(uri, doc);
    notifications.push({ method: "didOpen", version: 1, full: true });
    return doc;
  }
  if (existing.text === text) return existing;
  existing.version += 1;
  existing.text = text;
  notifications.push({ method: "didChange", version: existing.version, full: true });
  return existing;
}

describe("document versioning", () => {
  it("opens at version 1 and full-sync changes bump versions", () => {
    const docs = new Map<string, Doc>();
    const notes: Array<{ method: string; version: number; full: boolean }> = [];
    const uri = "file:///a.ts";

    const d1 = ensureDocument(docs, uri, "one", notes);
    assert.equal(d1.version, 1);
    assert.equal(notes[0].method, "didOpen");

    const d2 = ensureDocument(docs, uri, "one", notes);
    assert.equal(d2.version, 1);
    assert.equal(notes.length, 1); // no change

    const d3 = ensureDocument(docs, uri, "two", notes);
    assert.equal(d3.version, 2);
    assert.equal(notes[1].method, "didChange");
    assert.equal(notes[1].full, true);

    const d4 = ensureDocument(docs, uri, "three", notes);
    assert.equal(d4.version, 3);
  });
});

import { createReadStream, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const COMPONENTS = ["input", "output", "cacheRead", "cacheWrite"];
export async function readEntries(path, visit) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let line = 0;
  for await (const text of lines) {
    line++;
    if (text.trim()) visit(JSON.parse(text), line); // Fail closed on damaged evidence.
  }
}
const at = (e) => Date.parse(e.timestamp ?? e.message?.timestamp ?? "");
function blank() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, catalogEstimateUsd: 0,
    priced: 0, unpriced: 0, missing: 0, missingComponents: 0, models: {}, modes: {} };
}
function add(out, message, mode, model, freeModels) {
  const u = message.usage;
  out.models[model ?? "unknown"] = (out.models[model ?? "unknown"] ?? 0) + 1;
  out.modes[mode ?? "unknown"] = (out.modes[mode ?? "unknown"] ?? 0) + 1;
  if (!u) { out.missing++; return; }
  let tokens = 0;
  for (const key of COMPONENTS) {
    if (typeof u[key] !== "number" || !Number.isFinite(u[key]) || u[key] < 0) { out.missingComponents++; continue; }
    out[key] += u[key]; tokens += u[key];
  }
  out.tokens += tokens;
  const cost = typeof u.cost === "number" ? u.cost : u.cost?.total;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) out.missing++;
  else if (cost === 0 && tokens > 0 && !freeModels.includes(model)) out.unpriced++;
  else { out.priced++; out.catalogEstimateUsd += cost; }
}
function links(value, files) {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (["sessionFile", "session_file"].includes(key) && typeof item === "string") files.add(resolve(item));
    else if (key === "sessionFiles" && Array.isArray(item)) item.filter(x => typeof x === "string").forEach(x => files.add(resolve(x)));
    else links(item, files);
  }
}
async function load(path) {
  const entries = [];
  await readEntries(path, (entry, line) => entries.push({ ...entry, line }));
  return entries;
}
// ranges are explicit inclusive physical line boundaries in the lead log, not inferred tasks.
export async function scoreSession(path, { taskId, ranges, workerRanges = {}, freeModels = [] } = {}) {
  if (!taskId || !Array.isArray(ranges) || !ranges.length) throw new Error("taskId and explicit ranges are required");
  if (!workerRanges || typeof workerRanges !== "object" || Array.isArray(workerRanges)) {
    throw new Error("workerRanges must be keyed by absolute child file path");
  }
  for (const file of Object.keys(workerRanges)) {
    if (resolve(file) !== file) throw new Error("workerRanges keys must be absolute paths");
  }
  const es = await load(path);
  let previous = 0;
  const windows = ranges.map(([a, b]) => {
    if (!Number.isInteger(a) || !Number.isInteger(b) || a <= previous || b < a || b > es.at(-1)?.line) throw new Error("ranges must be ordered, disjoint, valid line boundaries");
    previous = b;
    const start = es.find(e => e.line === a), end = es.find(e => e.line === b);
    if (!start || !end || !Number.isFinite(at(start)) || !Number.isFinite(at(end)) || at(end) < at(start)) throw new Error("range timestamps missing or reversed");
    return [at(start), at(end)];
  });
  const selected = e => ranges.some(([a,b]) => e.line >= a && e.line <= b);
  const lead = blank(), worker = blank(), combined = blank();
  const files = new Set(), seen = new Set(es.filter(e => e.id).map(e => e.id));
  const warnings = [];
  const intervals = [];
  let mode = null, model = null, request = null, final = null, specialistCalls = 0;
  const events = [];
  for (const e of es) {
    if (e.customType === "behavior-mode") mode = e.data?.mode ?? null;
    if (e.type === "model_change") model = e.provider && e.modelId ? `${e.provider}/${e.modelId}` : null;
    // Persistent sidekick links may precede this task and remain valid for later generations.
    if (e.customType === "fusion-sidekick-session") links(e.data, files);
    if (e.message?.role === "toolResult") links(e.message.details, files);
    if (!selected(e)) continue;
    const m = e.message;
    if (m?.role === "user") {
      if (request !== null) {
        if (final !== null) intervals.push([request, final]); else warnings.push("request without final before next user message");
      }
      request = at(e); final = null;
    }
    if (m?.role === "assistant") {
      const eventModel = m.provider && m.model ? `${m.provider}/${m.model}` : model;
      add(lead, m, mode, eventModel, freeModels); add(combined, m, mode, eventModel, freeModels);
      events.push({ line: e.line, mode, model: eventModel });
      final = !m.content?.some?.(p => p.type === "toolCall") && !["error", "aborted"].includes(m.stopReason)
        ? at(e)
        : null;
    }
    if (m?.role === "toolResult") {
      final = null;
      if (["task", "task_start", "task_chain"].includes(m.toolName)) {
        specialistCalls++;
        const receiptFiles = new Set();
        links(m.details, receiptFiles);
        if (!receiptFiles.size) {
          warnings.push("delegation receipt lacks child session evidence; worker coverage may be missing");
        }
      }
    }
    if (m?.details?.childUsage) warnings.push("inline childUsage excluded: no independently deduplicated generation boundary");
  }
  if (request !== null && final !== null) intervals.push([request, final]);
  else if (request !== null) warnings.push("open request: active duration unknown");
  // Intersect with explicit slices, avoiding both idle and retained-worker lifetime.
  const active = intervals.flatMap(([a,b]) => windows.map(([c,d]) => [Math.max(a,c), Math.min(b,d)]).filter(([a,b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a));
  let excludedDuplicates = 0, excludedPreHeader = 0, unreadableWorkers = 0, unattributedWorkerEvents = 0;
  files.delete(resolve(path));
  for (const file of Object.keys(workerRanges)) {
    if (!files.has(file)) throw new Error("workerRanges refers to a child without a persisted session link");
  }
  const provisionalWorkerFiles = [];
  for (const file of files) {
    let ws;
    try { ws = await load(file); } catch { unreadableWorkers++; continue; }
    const childRanges = workerRanges[file];
    if (childRanges !== undefined) {
      if (!Array.isArray(childRanges) || !childRanges.length) {
        throw new Error("workerRanges values must be nonempty inclusive line ranges");
      }
      let last = 0;
      for (const range of childRanges) {
        const [a, b] = range;
        if (!Number.isInteger(a) || !Number.isInteger(b) || a <= last || b < a || b > ws.at(-1)?.line) {
          throw new Error("workerRanges must be ordered, disjoint, valid child line boundaries");
        }
        last = b;
      }
    } else {
      provisionalWorkerFiles.push(file);
    }
    const born = at(ws.find(e => e.type === "session") ?? {});
    let workerMode = null, workerModel = null;
    for (const e of ws) {
      if (e.customType === "behavior-mode") workerMode = e.data?.mode ?? null;
      if (e.type === "model_change") workerModel = e.provider && e.modelId ? `${e.provider}/${e.modelId}` : null;
      const m = e.message;
      if (m?.role !== "assistant") continue;
      if (e.id && seen.has(e.id)) { excludedDuplicates++; continue; }
      if (Number.isFinite(born) && at(e) < born) { excludedPreHeader++; continue; }
      const included = childRanges
        ? childRanges.some(([a, b]) => e.line >= a && e.line <= b)
        : windows.some(([a, b]) => at(e) >= a && at(e) <= b);
      if (!included) continue;
      // No stable ID or creation time: cannot safely distinguish copied fork history.
      if (!e.id || !Number.isFinite(born)) { unattributedWorkerEvents++; continue; }
      seen.add(e.id);
      const em = m.provider && m.model ? `${m.provider}/${m.model}` : workerModel;
      add(worker, m, workerMode, em, freeModels); add(combined, m, workerMode, em, freeModels);
    }
  }
  const complete = combined.priced > 0 && !combined.missing && !combined.unpriced && !combined.missingComponents
    && !unreadableWorkers && !unattributedWorkerEvents && !warnings.length
    && !provisionalWorkerFiles.length;
  return { taskId, sessionId: es.find(e => e.type === "session")?.id ?? null, ranges, events,
    lead, worker, combined, costBasis: "catalog estimate, not invoice", costUsd: complete ? combined.catalogEstimateUsd : null,
    activeMs: warnings.some(w => /request/.test(w)) ? null : active.length ? active.reduce((n,[a,b]) => n+b-a,0) : null,
    activeIntervals: active, specialistCalls, candidateWorkerSessions: files.size, excludedDuplicates, excludedPreHeader,
    unreadableWorkers, unattributedWorkerEvents, warnings: [...new Set(warnings)],
    workerRanges, provisionalWorkerFiles, estimatesProvisional: provisionalWorkerFiles.length > 0,
    attribution: "Explicit child line ranges are caller-supplied task/generation ownership evidence, not automatically verified causality. Without them child estimates use temporal overlap only and are provisional.",
    humanAcceptance: null, verification: null, processCompletion: null };
}
async function selfTest() {
  const root = mkdtempSync(join(tmpdir(), "trial-score-"));
  try {
    const parent = join(root,"p.jsonl"), child = join(root,"w.jsonl");
    const e = (id, sec, role, more = {}) => ({ id, type:"message", timestamp:`2026-01-01T00:00:${String(sec).padStart(2,"0")}.000Z`, message:{role,...more} });
    const usage = { input:10, output:2, cacheRead:3, cacheWrite:0, cost:0 };
    const first = e("a",2,"assistant",{provider:"p",model:"m",usage,content:[]});
    const rows = [{type:"session",id:"s"},{type:"custom",customType:"behavior-mode",data:{mode:"apex"}},e("u",1,"user"),first,
      {type:"custom",customType:"fusion-sidekick-session",data:{sessionFile:child}},
      {type:"custom",customType:"behavior-mode",data:{mode:"apex-orchestrate"}},e("v",20,"user"),e("b",22,"assistant",{usage:{...usage,cost:1},content:[]})];
    writeFileSync(parent,rows.map(JSON.stringify).join("\n"));
    writeFileSync(child,[{type:"session",timestamp:"2026-01-01T00:00:01.000Z"},first,e("w",2,"assistant",{usage:{...usage,cost:2}}),e("late",40,"assistant",{usage})].map(JSON.stringify).join("\n"));
    const s = await scoreSession(parent,{taskId:"test",ranges:[[3,4],[7,8]]});
    assert.equal(s.lead.tokens,30); assert.equal(s.worker.tokens,15); assert.equal(s.combined.tokens,45);
    assert.equal(s.excludedDuplicates,1); assert.equal(s.combined.unpriced,1); assert.equal(s.costUsd,null);
    assert.equal(s.activeMs,3000); assert.equal(s.events[0].mode,"apex"); assert.equal(s.events[1].mode,"apex-orchestrate");
    assert.equal(s.estimatesProvisional, true);
    const boundaries = { taskId: "test", ranges: [[3,4],[7,8]], freeModels: ["p/m"] };
    const provisional = await scoreSession(parent, boundaries);
    assert.equal(provisional.combined.unpriced, 0);
    assert.equal(provisional.costUsd, null); // Temporal overlap alone cannot certify cost.
    const owned = await scoreSession(parent, { ...boundaries, workerRanges: { [child]: [[2,3]] } });
    assert.equal(owned.estimatesProvisional, false);
    assert.equal(owned.worker.tokens, 15);
    assert.equal(owned.costUsd, 3);
    await assert.rejects(scoreSession(parent, { ...boundaries, workerRanges: { [child]: [[3,99]] } }), /workerRanges/);
    await assert.rejects(scoreSession(parent),/explicit ranges/);

    const failedRows = [
      { type: "session", id: "failed-delegation" },
      e("request", 1, "user"),
      e("failure", 2, "toolResult", { toolName: "task_chain", isError: true }),
      e("answer", 3, "assistant", { usage: { ...usage, cost: 1 }, content: [] }),
    ];
    writeFileSync(parent, failedRows.map(JSON.stringify).join("\n"));
    const failed = await scoreSession(parent, { taskId: "failed-delegation", ranges: [[2, 4]] });
    assert.equal(failed.specialistCalls, 1);
    assert.equal(failed.costUsd, null);
    assert.ok(failed.warnings.some(warning => warning.includes("worker coverage may be missing")));
    console.log("self-test passed");
  } finally { rmSync(root,{recursive:true,force:true}); }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv[2] === "--self-test") await selfTest();
  else if (!process.argv[2] || !process.argv[3]) { console.error("usage: node score-session.mjs <session.jsonl> <boundary.json> | --self-test\nboundary: { taskId, ranges: [[firstLine,lastLine]], workerRanges?: { absoluteChildPath: [[firstLine,lastLine]] }, freeModels?: [provider/model] }"); process.exitCode=1; }
  else console.log(JSON.stringify(await scoreSession(process.argv[2],JSON.parse(readFileSync(process.argv[3],"utf8"))),null,2));
}

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createApexMirror } from "../bg-process/internal/apex-mirror.ts";
import { OUTPUT_LOG, OutputLogTail, readJob, startPersistentJob } from "../bg-process/internal/persistent-store.ts";
import { emptyStream, type JobState } from "../bg-process/internal/job-state.ts";
import { PersistentMirror } from "../bg-process/internal/persistent-mirror.ts";
import type { ApexMirror } from "../bg-process/internal/apex-mirror.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Recorded { authorization?: string; contentType?: string; origin?: string; body: { method: string; params: { events: Array<Record<string, unknown>> } } }

/** Loopback stand-in for Apex's BackgroundJobBridge. */
function fakeApex() {
  const requests: Recorded[] = [];
  let status = 200;
  let stop: string[] = [];
  const server: Server = createServer((request: IncomingMessage, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      requests.push({
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
        origin: request.headers.origin,
        body: JSON.parse(raw),
      });
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(status === 200 ? { ok: true, result: { stop } } : { ok: false, error: "x" }));
      stop = [];
    });
  });
  return {
    requests,
    events: () => requests.flatMap((request) => request.body.params.events),
    setStatus: (value: number) => { status = value; },
    stopNext: (ids: string[]) => { stop = ids; },
    listen: () => new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/call`))),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const job = { id: "bg_1", title: "dev", command: "npm run dev", cwd: "/project", persistent: false, startedAt: 1 };

/** Heartbeats skip a tick if the last send was <900 ms ago, so one may take up to ~2 s. */
const HEARTBEAT_WINDOW_MS = 2_200;

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(25);
  }
}

describe("bg-process Apex mirror", () => {
  const apex = fakeApex();
  const mirrors: ApexMirror[] = [];
  let url = "";
  const open = (onStop: (ids: string[]) => void = () => {}, token = "secret") => {
    const mirror = createApexMirror(onStop, { APEX_BACKGROUND_JOBS_URL: url, APEX_BACKGROUND_JOBS_TOKEN: token })!;
    mirrors.push(mirror);
    return mirror;
  };
  before(async () => { url = await apex.listen(); });
  beforeEach(() => { apex.requests.length = 0; apex.setStatus(200); });
  afterEach(() => { for (const mirror of mirrors.splice(0)) mirror.dispose(); });
  after(() => apex.close());

  it("is disabled without the Apex environment", () => {
    assert.equal(createApexMirror(() => {}, {}), undefined);
    assert.equal(createApexMirror(() => {}, { APEX_BACKGROUND_JOBS_URL: url }), undefined);
  });

  it("batches events, heartbeats while running, delivers stops, and goes quiet after settle", async () => {
    const stops: string[][] = [];
    const mirror = open((ids) => stops.push(ids));
    mirror.started(job);
    mirror.output("bg_1", "hello ");
    mirror.output("bg_1", "world\n");
    await sleep(300);
    assert.equal(apex.requests.length, 1);
    const [first] = apex.requests;
    assert.equal(first.authorization, "Bearer secret");
    assert.equal(first.contentType, "application/json");
    assert.equal(first.origin, undefined);
    assert.equal(first.body.method, "sync");
    assert.deepEqual(first.body.params.events, [
      { type: "started", job },
      { type: "output", id: "bg_1", data: "hello world\n" },
    ]);

    apex.stopNext(["bg_1"]);
    await waitFor(() => stops.length > 0);
    assert.ok(apex.requests.length >= 2, "heartbeat sync while a job runs");
    assert.deepEqual(stops, [["bg_1"]]);

    mirror.settled("bg_1", "killed", null, "SIGTERM");
    await sleep(300);
    assert.deepEqual(apex.events().at(-1), { type: "settled", id: "bg_1", status: "killed", exitCode: null, signal: "SIGTERM" });
    const quiet = apex.requests.length;
    await sleep(HEARTBEAT_WINDOW_MS);
    assert.equal(apex.requests.length, quiet, "no heartbeat once nothing runs");
  });

  it("sends detached for jobs it stops following and stops heartbeating", async () => {
    const mirror = open();
    mirror.started({ ...job, id: "bg_p", persistent: true }, "replay\n");
    mirror.detached(["bg_p"]);
    await sleep(300);
    assert.deepEqual(apex.events().map((event) => event.type), ["started", "detached"]);
    assert.equal(apex.events()[0].output, "replay\n");
    const quiet = apex.requests.length;
    await sleep(HEARTBEAT_WINDOW_MS);
    assert.equal(apex.requests.length, quiet);
  });

  it("truncates oversized pending output to its tail", async () => {
    const mirror = open();
    mirror.output("bg_big", "a".repeat(200 * 1024));
    mirror.output("bg_big", "b".repeat(200 * 1024));
    await sleep(300);
    const [event] = apex.events();
    const data = String(event.data);
    assert.ok(data.startsWith("\n[… output truncated …]\n"));
    assert.ok(data.endsWith("b".repeat(1024)));
    assert.ok(Buffer.byteLength(data) <= 256 * 1024 + 64);
  });

  it("disables itself after a 401", async () => {
    apex.setStatus(401);
    const mirror = open(() => {}, "revoked");
    mirror.started(job);
    await waitFor(() => apex.requests.length === 1);
    apex.setStatus(200);
    mirror.output("bg_1", "after");
    await sleep(HEARTBEAT_WINDOW_MS);
    assert.equal(apex.requests.length, 1);
  });
});

describe("persistent job mirroring", () => {
  it("replays once, re-announces the pid, follows log resets, settles, and detaches", () => {
    const directory = mkdtempSync(join(tmpdir(), "bg-pmirror-"));
    try {
      const calls: unknown[][] = [];
      const fake: ApexMirror = {
        started: (job, output) => calls.push(["started", job.id, job.pid, output]),
        output: (id, data) => { if (data) calls.push(["output", id, data]); },
        settled: (id, status) => calls.push(["settled", id, status]),
        detached: (ids) => calls.push(["detached", ...ids]),
        dispose: () => {},
      };
      const tracker = new PersistentMirror(fake);
      const log = join(directory, OUTPUT_LOG);
      writeFileSync(log, "booting\n");
      const state = (patch: Partial<JobState>): JobState => ({
        id: "bg_p", title: "srv", command: "srv", cwd: directory, status: "running", startedAt: 1, exitCode: null, signal: null,
        stdout: emptyStream(), stderr: emptyStream(), killRequested: false, persistent: true, ...patch,
      });
      tracker.sync(state({ status: "completed" }), directory);
      assert.deepEqual(calls, [], "settled on first sight is not mirrored");

      tracker.sync(state({}), directory);
      appendFileSync(log, "listening\n");
      tracker.sync(state({ pid: 42 }), directory);
      tracker.sync(state({ pid: 42 }), directory);
      truncateSync(log, 0);
      appendFileSync(log, "after reset, longer than before\n");
      tracker.sync(state({ pid: 42, outputLogResets: 1 }), directory);
      appendFileSync(log, "bye\n");
      tracker.sync(state({ pid: 42, outputLogResets: 1, status: "completed", exitCode: 0 }), directory);
      assert.deepEqual(calls, [
        ["started", "bg_p", undefined, "booting\n"],
        ["started", "bg_p", 42, undefined],
        ["output", "bg_p", "listening\n"],
        ["output", "bg_p", "after reset, longer than before\n"],
        ["output", "bg_p", "bye\n"],
        ["settled", "bg_p", "completed"],
      ]);

      calls.length = 0;
      tracker.sync(state({ id: "bg_q", pid: 7 }), directory);
      tracker.detachAll();
      tracker.detachAll();
      assert.deepEqual(calls.at(-1), ["detached", "bg_q"]);
      assert.equal(calls.filter((call) => call[0] === "detached").length, 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("persistent output log", () => {
  it("tails appended text, keeps split UTF-8 intact, and restarts after a runner reset", () => {
    const directory = mkdtempSync(join(tmpdir(), "bg-tail-"));
    try {
      const log = join(directory, OUTPUT_LOG);
      writeFileSync(log, "old line\nlast line\n");
      const tail = new OutputLogTail(directory);
      assert.equal(tail.start(10), "last line\n");
      const euro = Buffer.from("€", "utf8");
      appendFileSync(log, Buffer.concat([Buffer.from("a"), euro.subarray(0, 1)]));
      assert.equal(tail.read(), "a");
      appendFileSync(log, euro.subarray(1));
      assert.equal(tail.read(), "€");
      // The runner truncated and the log regrew past our offset between reads.
      truncateSync(log, 0);
      appendFileSync(log, "fresh output that is longer than before\n");
      assert.equal(tail.read(1), "fresh output that is longer than before\n");
      appendFileSync(log, "done\n");
      assert.equal(tail.finish(1), "done\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("the detached runner writes command output to output.log", async () => {
    const root = mkdtempSync(join(tmpdir(), "bg-runner-"));
    try {
      const id = `bg_${randomUUID()}`;
      const directory = join(root, id);
      const state: JobState = {
        id, title: "echo", command: "echo persistent-ok", cwd: root, status: "running", startedAt: Date.now(),
        exitCode: null, signal: null, stdout: emptyStream(), stderr: emptyStream(), killRequested: false, persistent: true,
      };
      await startPersistentJob(directory, state);
      for (let attempt = 0; attempt < 100 && readJob(directory).status === "running"; attempt += 1) await sleep(100);
      assert.equal(readJob(directory).status, "completed");
      assert.match(new OutputLogTail(directory).start(65_536), /persistent-ok/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

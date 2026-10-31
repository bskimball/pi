import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDoc, defineExtension, defineTask, Harness, type TaskId } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { shipping, type Exec } from "./shipping.ts";
import { branch, clean, digest, head, loadTask, locked, repositoryRoot, stateDir, type Task } from "./shipping-state.ts";

type Request = { id: string; task: string; root: string; head: string; contract: string; owner: string };
type Receipt = { id: string; task: string; head: string; state: "queued" | "verifying" | "landing" | "landed" | "pending-merge" | "blocked"; error?: string };
export const queueDir = (root: string) => join(stateDir(root), "queue");
const requestsDir = (root: string) => join(queueDir(root), "requests");
function atomic(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  renameSync(temp, file);
}
function fingerprint(t: Task): string {
  return digest(JSON.stringify({ root: t.root, branch: t.branch, base: t.base, paths: t.paths, delivery: t.delivery, route: t.route, remote: t.remote, remoteHash: t.remoteHash, repo: t.repo, target: t.target, checks: t.checks, mergeMethod: t.mergeMethod, review: t.review, pr: t.pr }));
}
function guard(r: Request): Task {
  const t = loadTask(r.root, r.task);
  if (t.cleaned || t.delivery !== "ship" || !t.remote || !t.remoteHash || !t.checks.length) throw new Error("Queue requires an open ship-authorized task with a remote and canonical checks.");
  if (branch(t.root) !== t.branch || head(t.root) !== r.head) throw new Error("Queued candidate HEAD or branch changed; inspect and authorize a new candidate.");
  clean(t.root);
  if (t.review?.head !== r.head || t.review.verdict === "block") throw new Error("Queue requires the applicable review for the exact candidate.");
  if (fingerprint(t) !== r.contract) throw new Error("Approved shipping contract changed; enqueue again only after inspection and authorization.");
  return t;
}
function request(value: unknown): Request {
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" || !/^[a-f0-9-]{36}$/.test(value.id)
    || !("task" in value) || typeof value.task !== "string" || !("root" in value) || typeof value.root !== "string"
    || !("head" in value) || typeof value.head !== "string" || !/^[a-f0-9]{40,64}$/.test(value.head)
    || !("contract" in value) || typeof value.contract !== "string" || !("owner" in value) || typeof value.owner !== "string") throw new Error("Invalid queue request.");
  return { id: value.id, task: value.task, root: value.root, head: value.head, contract: value.contract, owner: value.owner };
}
function requests(root: string): Request[] {
  const dir = requestsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => /^[a-f0-9-]{36}\.json$/.test(f)).map(f => {
    const r = request(JSON.parse(readFileSync(join(dir, f), "utf8")));
    if (stateDir(r.root) !== stateDir(root) || f !== `${r.id}.json`) throw new Error("Queue request belongs to another repository or id.");
    return r;
  });
}
const receiptFile = (root: string, id: string) => join(queueDir(root), "receipts", `${id}.json`);
function receipt(root: string, r: Request, state: Receipt["state"], error?: string): Receipt {
  const value: Receipt = { id: r.id, task: r.task, head: r.head, state, ...(error ? { error: error.slice(-4000) } : {}) };
  atomic(receiptFile(root, r.id), value);
  return value;
}
export function queueStatus(cwd: string, task?: string): object {
  const root = repositoryRoot(cwd);
  return { jobs: requests(root).filter(r => !task || r.task === task).slice(-40).map(r => existsSync(receiptFile(root, r.id)) ? JSON.parse(readFileSync(receiptFile(root, r.id), "utf8")) : { id: r.id, task: r.task, head: r.head, state: "queued" }), log: join(queueDir(root), "runner.log") };
}
export async function enqueue(cwd: string, owner: string, task: string, expectedHead: string, confirm: boolean): Promise<Request> {
  if (!confirm) throw new Error("Enqueue requires confirm:true and explicit user permission to verify and land this exact task/candidate.");
  const root = repositoryRoot(cwd);
  return locked(root, async () => {
    const t = loadTask(root, task);
    const r: Request = { id: randomUUID(), task, root: t.root, head: expectedHead, contract: fingerprint(t), owner };
    guard(r);
    if (t.landed) throw new Error("Task already landed; no new queue job needed.");
    const previous = requests(root).find(old => old.task === task && old.head === expectedHead && old.contract === r.contract && (!existsSync(receiptFile(root, old.id)) || !["blocked", "pending-merge"].includes(JSON.parse(readFileSync(receiptFile(root, old.id), "utf8")).state)));
    if (previous) return previous;
    atomic(join(requestsDir(root), `${r.id}.json`), r);
    return r;
  });
}

const Jobs = defineDoc<{ jobs: Record<string, TaskId<null>> }>({ kind: "shipping.queue", version: 1, scope: "session", initial: () => ({ jobs: {} }), checkpointWhen: () => true });

function recordedStop(root: string, r: Request): boolean {
  const file = receiptFile(root, r.id);
  if (!existsSync(file)) return false;
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  return Boolean(value && typeof value === "object" && "state" in value && ["blocked", "pending-merge", "landed"].includes(String(value.state)));
}

// The caller must own the repository queue's process lock before opening storage.
export async function runQueue(root: string, exec: Exec): Promise<void> {
  const Job = defineTask<Request, { phase: "verify" } | { phase: "land" }, null>({
    name: "shipping.land", version: 1, initial: () => ({ phase: "verify" }),
    phases: {
      verify: async (task, runtime, context) => {
        const r = task.input;
        if (recordedStop(root, r)) {
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
          return;
        }
        try {
          guard(r); receipt(root, r, "verifying");
          await shipping(r.root, r.owner, { operation: "verify", task: r.task, expectedHead: r.head }, exec, runtime.signal);
          await runtime.commit(() => ({ status: "running", checkpoint: { phase: "land" } }), context);
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          receipt(root, r, "blocked", error instanceof Error ? error.message : String(error));
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
        }
      },
      land: async (task, runtime, context) => {
        const r = task.input;
        if (recordedStop(root, r)) {
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
          return;
        }
        try {
          guard(r); receipt(root, r, "landing");
          await shipping(r.root, r.owner, { operation: "land", task: r.task, expectedHead: r.head, confirm: true }, exec, runtime.signal);
          receipt(root, r, loadTask(r.root, r.task).landed ? "landed" : "pending-merge");
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          receipt(root, r, "blocked", error instanceof Error ? error.message : String(error));
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
        }
      },
    },
    abort: (task, runtime, context) => {
      receipt(root, task.input, "blocked", "Queue job aborted; explicit authorization is required to enqueue again.");
      return runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "shipping-queue", tasks: [Job] }));
  const harness = await Harness.open(await openNodeJsonlStorage(join(queueDir(root), "durable"), BACKGROUND_CONTEXT), { models: createModels(), registry }, BACKGROUND_CONTEXT);
  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT);
    // Run serially: two candidates must never check/land in one checkout together.
    for (const r of requests(root)) {
      const id = await conversation.commit(async tx => {
        const jobs = await tx.doc(Jobs);
        if (jobs.jobs[r.id]) return jobs.jobs[r.id];
        const id = await tx.createTask(Job, r, { ownership: { kind: "conversation" } });
        jobs.jobs[r.id] = id;
        return id;
      }, BACKGROUND_CONTEXT);
      const prior = await harness.getTask(id, BACKGROUND_CONTEXT);
      if (prior?.state.status === "terminal") continue;
      const inspection = await harness.inspect(BACKGROUND_CONTEXT);
      if (inspection.tasks.some(t => t.record.id === id && t.state.kind === "blocked")) {
        receipt(root, r, "blocked", "Durable task is parked; inspect runner.log before retrying.");
        continue;
      }
      await harness.waitForTask(id, BACKGROUND_CONTEXT);
    }
  } finally { await harness.close(BACKGROUND_CONTEXT); }
}

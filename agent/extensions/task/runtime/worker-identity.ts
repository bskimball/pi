// worker-identity: durable internal identity with short user-facing handles.

import { randomUUID } from "node:crypto";

export interface WorkerIdentity {
  /** Immutable registry/render key. Never shown as the normal task handle. */
  instanceId: string;
  /** Short process-local handle accepted by task_* tools. */
  id: string;
}

export function createWorkerIdentity(
  sequence: number,
  uuid: () => string = randomUUID,
): WorkerIdentity {
  return {
    instanceId: uuid(),
    id: `task_${sequence}`,
  };
}

export function findWorkerByHandle<T extends { id: string }>(
  workers: Iterable<T>,
  id: string,
): T | undefined {
  for (const worker of workers) {
    if (worker.id === id) return worker;
  }
  return undefined;
}

export function findWorkerByInstance<T>(
  workers: { get(instanceId: string): T | undefined },
  instanceId: string | undefined,
): T | undefined {
  return instanceId ? workers.get(instanceId) : undefined;
}

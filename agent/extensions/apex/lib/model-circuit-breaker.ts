// Persisted provider/model circuit breakers for async worker model selection.
// Lives under the Pi agent runtime dir (never the project repo). Failures only
// count when the caller already proved a clean provider/model availability
// failure (no tools, no meaningful output, no user abort).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { isModelFallbackError, splitQualifiedModel } from "./worker-runtime.ts";

const require = createRequire(import.meta.url);

/** Open the circuit after this many qualifying failures inside the window. */
export const CIRCUIT_FAILURE_THRESHOLD = 2;
/** Only failures inside this sliding window contribute to the threshold. */
export const CIRCUIT_FAILURE_WINDOW_MS = 15 * 60_000;
/** How long an open circuit stays skipped before one half-open probe. */
export const CIRCUIT_OPEN_COOLDOWN_MS = 10 * 60_000;
/** Exclusive half-open trial reservation TTL (stale after crash). */
export const CIRCUIT_HALF_OPEN_TRIAL_MS = 2 * 60_000;
/** Bound persisted entries so a noisy provider set cannot grow forever. */
export const CIRCUIT_MAX_ENTRIES = 128;
/** Cap stored failure timestamps per entry. */
export const CIRCUIT_MAX_FAILURE_TIMESTAMPS = 8;

const SCHEMA = 1 as const;

export type CircuitClock = () => number;

export interface CircuitBreakerOptions {
  /** Absolute path to the JSON store. Defaults under getAgentDir()/harness. */
  path?: string;
  now?: CircuitClock;
}

export interface CircuitEntry {
  /** Qualified provider/model key. */
  key: string;
  /** Recent qualifying failure timestamps (ms), newest last. */
  failures: number[];
  /** When set and in the future, the circuit is open. */
  openUntil?: number;
  /** Exclusive half-open probe reservation. */
  halfOpen?: {
    token: string;
    reservedAt: number;
    expiresAt: number;
  };
  updatedAt: number;
}

interface CircuitStoreFile {
  schema: typeof SCHEMA;
  entries: CircuitEntry[];
}

export interface AttemptDecision {
  /** Index into the original attempts array. */
  index: number;
  model: string | undefined;
  /** True when every candidate was open/reserved and we forced one through. */
  failSafe: boolean;
  /** Models skipped because their circuit was open or reserved. */
  skipped: string[];
  /** Half-open reservation token when this attempt is a recovery probe. */
  halfOpenToken?: string;
}

function defaultStorePath(): string {
  // Lazy require keeps unit tests free of the full coding-agent package graph
  // when callers inject `path` (all tests do).
  const { getAgentDir } = require("@earendil-works/pi-coding-agent") as {
    getAgentDir: () => string;
  };
  return join(getAgentDir(), "harness", "model-circuits.json");
}

function emptyStore(): CircuitStoreFile {
  return { schema: SCHEMA, entries: [] };
}

function isFiniteTs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function normalizeEntry(raw: unknown, now: number): CircuitEntry | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.key !== "string" || !rec.key.includes("/")) return undefined;
  if (!splitQualifiedModel(rec.key)) return undefined;

  const failures = Array.isArray(rec.failures)
    ? rec.failures
        .filter(isFiniteTs)
        .filter((ts) => ts <= now + 60_000)
        .slice(-CIRCUIT_MAX_FAILURE_TIMESTAMPS)
    : [];

  let openUntil: number | undefined;
  if (isFiniteTs(rec.openUntil)) openUntil = rec.openUntil;

  let halfOpen: CircuitEntry["halfOpen"];
  if (rec.halfOpen && typeof rec.halfOpen === "object" && !Array.isArray(rec.halfOpen)) {
    const ho = rec.halfOpen as Record<string, unknown>;
    if (
      typeof ho.token === "string" &&
      ho.token.length > 0 &&
      ho.token.length <= 80 &&
      isFiniteTs(ho.reservedAt) &&
      isFiniteTs(ho.expiresAt)
    ) {
      halfOpen = {
        token: ho.token,
        reservedAt: ho.reservedAt,
        expiresAt: ho.expiresAt,
      };
    }
  }

  const updatedAt = isFiniteTs(rec.updatedAt) ? rec.updatedAt : now;
  return {
    key: rec.key,
    failures,
    openUntil,
    halfOpen,
    updatedAt,
  };
}

function normalizeStore(raw: unknown, now: number): CircuitStoreFile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyStore();
  const rec = raw as Record<string, unknown>;
  const list = Array.isArray(rec.entries) ? rec.entries : [];
  const seen = new Set<string>();
  const entries: CircuitEntry[] = [];
  for (const item of list) {
    const entry = normalizeEntry(item, now);
    if (!entry || seen.has(entry.key)) continue;
    seen.add(entry.key);
    entries.push(entry);
    if (entries.length >= CIRCUIT_MAX_ENTRIES) break;
  }
  return { schema: SCHEMA, entries };
}

function pruneEntry(entry: CircuitEntry, now: number): CircuitEntry {
  const windowStart = now - CIRCUIT_FAILURE_WINDOW_MS;
  const failures = entry.failures
    .filter((ts) => ts >= windowStart)
    .slice(-CIRCUIT_MAX_FAILURE_TIMESTAMPS);
  let halfOpen = entry.halfOpen;
  if (halfOpen && halfOpen.expiresAt <= now) halfOpen = undefined;
  let openUntil = entry.openUntil;
  if (openUntil != null && openUntil <= now && !halfOpen) {
    // Cooldown elapsed with no active probe: keep openUntil as the
    // half-open eligibility marker until success or a new failure reopens.
  }
  return {
    ...entry,
    failures,
    halfOpen,
    openUntil,
  };
}

function isEffectivelyOpen(entry: CircuitEntry | undefined, now: number): boolean {
  return !!entry?.openUntil && entry.openUntil > now;
}

function needsHalfOpenProbe(entry: CircuitEntry | undefined, now: number): boolean {
  if (!entry?.openUntil) return false;
  return entry.openUntil <= now;
}

function loadStore(path: string, now: number): CircuitStoreFile {
  try {
    if (!existsSync(path)) return emptyStore();
    const raw = readFileSync(path, "utf8");
    if (!raw.trim()) return emptyStore();
    return normalizeStore(JSON.parse(raw), now);
  } catch {
    // Missing/corrupt/unreadable store must not break task lifecycle.
    return emptyStore();
  }
}

function atomicWriteJson(path: string, data: CircuitStoreFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore cleanup races
    }
    // Swallow write failures: circuit state is advisory.
  }
}

function touchEvict(
  store: CircuitStoreFile,
  entry: CircuitEntry,
  now: number,
): void {
  entry.updatedAt = now;
  const others = store.entries.filter((e) => e.key !== entry.key);
  others.push(entry);
  others.sort((a, b) => b.updatedAt - a.updatedAt);
  store.entries = others.slice(0, CIRCUIT_MAX_ENTRIES);
}

function findEntry(
  store: CircuitStoreFile,
  key: string,
  now: number,
): CircuitEntry | undefined {
  const found = store.entries.find((e) => e.key === key);
  return found ? pruneEntry(found, now) : undefined;
}

function circuitKey(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return splitQualifiedModel(model) ? model : undefined;
}

/**
 * True when a clean attempt failure should count against the circuit.
 * Callers must still enforce no-tools / no-output / no-abort invariants.
 */
export function isQualifyingCircuitFailure(
  message: string | undefined,
): boolean {
  return isModelFallbackError(message);
}

export interface ModelCircuitBreaker {
  readonly path: string;
  /**
   * Choose the next model attempt from a configured chain.
   * Skips open circuits; claims at most one half-open trial per key;
   * if every candidate is blocked, returns the first candidate as fail-safe
   * without clearing circuit state.
   */
  selectAttempt(
    attempts: Array<string | undefined>,
    fromIndex?: number,
  ): AttemptDecision;
  /** Record a clean qualifying provider/model failure for a model. */
  recordFailure(model: string | undefined, message?: string): void;
  /** Close/reset the circuit after a successful settled generation. */
  recordSuccess(model: string | undefined): void;
  /** Test helper: read a normalized entry. */
  peek(model: string | undefined): CircuitEntry | undefined;
}

/**
 * Create a circuit breaker backed by JSON under the Pi agent runtime dir.
 * All public methods are exception-safe for task lifecycle use.
 */
export function createModelCircuitBreaker(
  options: CircuitBreakerOptions = {},
): ModelCircuitBreaker {
  const path = options.path ?? defaultStorePath();
  const now: CircuitClock = options.now ?? Date.now;

  const mutate = (fn: (store: CircuitStoreFile, t: number) => void): void => {
    try {
      const t = now();
      const store = loadStore(path, t);
      fn(store, t);
      atomicWriteJson(path, store);
    } catch {
      // Advisory only.
    }
  };

  const selectAttempt = (
    attempts: Array<string | undefined>,
    fromIndex = 0,
  ): AttemptDecision => {
    const start = Math.max(0, fromIndex);
    const skipped: string[] = [];
    if (!attempts.length || start >= attempts.length) {
      return { index: start, model: undefined, failSafe: false, skipped };
    }

    try {
      const t = now();
      const store = loadStore(path, t);
      let dirty = false;

      const tryIndex = (
        index: number,
        allowFailSafe: boolean,
      ): AttemptDecision | undefined => {
        const model = attempts[index];
        const key = circuitKey(model);
        if (!key) {
          // Unqualified / default model: never circuit-break (cannot key it).
          return { index, model, failSafe: allowFailSafe, skipped: [...skipped] };
        }

        let entry = findEntry(store, key, t);
        if (entry) {
          // Persist prune of expired half-open.
          const prev = store.entries.find((e) => e.key === key);
          if (
            prev &&
            (prev.halfOpen?.expiresAt !== entry.halfOpen?.expiresAt ||
              prev.failures.length !== entry.failures.length)
          ) {
            touchEvict(store, entry, t);
            dirty = true;
          }
        }

        if (isEffectivelyOpen(entry, t)) {
          skipped.push(key);
          return undefined;
        }

        if (needsHalfOpenProbe(entry, t)) {
          const reserved = entry?.halfOpen;
          if (reserved && reserved.expiresAt > t) {
            // Another worker holds the exclusive recovery trial.
            skipped.push(key);
            return undefined;
          }
          const token = randomUUID();
          const next: CircuitEntry = {
            key,
            failures: entry?.failures ?? [],
            openUntil: entry?.openUntil,
            halfOpen: {
              token,
              reservedAt: t,
              expiresAt: t + CIRCUIT_HALF_OPEN_TRIAL_MS,
            },
            updatedAt: t,
          };
          touchEvict(store, next, t);
          dirty = true;
          return {
            index,
            model,
            failSafe: false,
            skipped: [...skipped],
            halfOpenToken: token,
          };
        }

        // Closed / healthy (or never tracked).
        return { index, model, failSafe: allowFailSafe, skipped: [...skipped] };
      };

      for (let i = start; i < attempts.length; i++) {
        const decision = tryIndex(i, false);
        if (decision) {
          if (dirty) atomicWriteJson(path, store);
          return decision;
        }
      }

      // Fail-safe: force the first remaining candidate without erasing state.
      const failSafeIndex = start;
      const decision: AttemptDecision = {
        index: failSafeIndex,
        model: attempts[failSafeIndex],
        failSafe: true,
        skipped,
      };
      if (dirty) atomicWriteJson(path, store);
      return decision;
    } catch {
      return {
        index: start,
        model: attempts[start],
        failSafe: true,
        skipped,
      };
    }
  };

  const recordFailure = (model: string | undefined, message?: string): void => {
    const key = circuitKey(model);
    if (!key) return;
    if (message !== undefined && !isQualifyingCircuitFailure(message)) return;

    mutate((store, t) => {
      const prev = findEntry(store, key, t) ?? {
        key,
        failures: [],
        updatedAt: t,
      };
      const failures = [...prev.failures, t]
        .filter((ts) => ts >= t - CIRCUIT_FAILURE_WINDOW_MS)
        .slice(-CIRCUIT_MAX_FAILURE_TIMESTAMPS);
      const shouldOpen = failures.length >= CIRCUIT_FAILURE_THRESHOLD;
      const entry: CircuitEntry = {
        key,
        failures,
        openUntil: shouldOpen ? t + CIRCUIT_OPEN_COOLDOWN_MS : prev.openUntil,
        // Consume half-open reservation on outcome.
        halfOpen: undefined,
        updatedAt: t,
      };
      // Half-open failure always re-opens even if window count dipped.
      if (prev.halfOpen || (prev.openUntil != null && prev.openUntil <= t)) {
        entry.openUntil = t + CIRCUIT_OPEN_COOLDOWN_MS;
      }
      touchEvict(store, entry, t);
    });
  };

  const recordSuccess = (model: string | undefined): void => {
    const key = circuitKey(model);
    if (!key) return;

    mutate((store, t) => {
      // Success closes the circuit entirely for this key.
      store.entries = store.entries.filter((e) => e.key !== key);
      void t;
    });
  };

  const peek = (model: string | undefined): CircuitEntry | undefined => {
    const key = circuitKey(model);
    if (!key) return undefined;
    try {
      const t = now();
      return findEntry(loadStore(path, t), key, t);
    } catch {
      return undefined;
    }
  };

  return { path, selectAttempt, recordFailure, recordSuccess, peek };
}

/** Shared process-local breaker for async workers (lazy path resolution). */
let shared: ModelCircuitBreaker | undefined;

export function getSharedModelCircuitBreaker(): ModelCircuitBreaker {
  if (!shared) shared = createModelCircuitBreaker();
  return shared;
}

/** Test-only: replace or clear the process-local shared instance. */
export function setSharedModelCircuitBreaker(
  breaker: ModelCircuitBreaker | undefined,
): void {
  shared = breaker;
}

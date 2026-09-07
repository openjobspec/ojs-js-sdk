/**
 * OJS Testing Module — fake mode, assertions, and test utilities.
 *
 * Implements the OJS Testing Specification (ojs-testing.md).
 *
 * Usage:
 *   import { testing } from '@openjobspec/client';
 *
 *   beforeEach(() => testing.fake());
 *   afterEach(() => testing.restore());
 *
 *   test('enqueues welcome email', async () => {
 *     await myApp.signup('user@example.com');
 *     testing.assertEnqueued('email.send', { args: [{ to: 'user@example.com' }] });
 *   });
 */

import {
  createEnqueueEnvelope,
  cloneJsonArray,
  cloneJsonRecord,
  type Job,
  type JsonValue,
  type EnqueueOptions,
  type JobState,
  type RetryPolicy,
  type UniquePolicy,
} from './job.js';

// In-memory store for fake mode
interface FakeStore {
  enqueued: FakeJob[];
  performed: FakeJob[];
}

/** A fake job record stored by the testing module. */
export interface FakeJob {
  id: string;
  type: string;
  queue: string;
  args: JsonValue[];
  meta: Record<string, JsonValue>;
  state: JobState;
  attempt: number;
  options: EnqueueOptions;
  created_at: string;
  priority?: number;
  timeout?: number;
  scheduled_at?: string;
  expires_at?: string;
  retry?: RetryPolicy;
  unique?: UniquePolicy;
  schema?: string;
  visibility_timeout?: number;
  tags?: string[];
  /**
   * The message of the error thrown by the registered handler, if this job's
   * state is 'discarded' because its handler threw. Populated instead of
   * silently discarding the failure, so `testing.assertFailed()` callers can
   * diagnose *why* a job failed rather than only that it did.
   */
  error?: string;
}

/** Options for matching jobs in assertion helpers. */
export interface MatchOptions {
  args?: JsonValue[];
  queue?: string;
  meta?: Record<string, JsonValue>;
  count?: number;
}

let store: FakeStore | null = null;
let mode: 'real' | 'fake' | 'inline' = 'real';
const handlers = new Map<string, (job: FakeJob) => Promise<void> | void>();

function generateId(): string {
  // Simple UUIDv7-like ID for testing
  const now = Date.now();
  const hex = now.toString(16).padStart(12, '0');
  const rand = Math.random().toString(16).substring(2, 14);
  return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-7${rand.substring(0, 3)}-${rand.substring(3, 7)}-${rand.substring(7)}000`;
}

/** Activate fake mode. Jobs are stored in memory, not sent to a backend. */
export function fake(): void {
  mode = 'fake';
  store = { enqueued: [], performed: [] };
}

/** Activate inline mode. Jobs execute synchronously when enqueued. */
export function inline(): void {
  mode = 'inline';
  store = { enqueued: [], performed: [] };
}

/** Restore real mode and clear all test state. */
export function restore(): void {
  mode = 'real';
  store = null;
  handlers.clear();
}

/** Returns true if testing mode (fake or inline) is active. */
export function isTestMode(): boolean {
  return mode !== 'real';
}

/** Returns the current mode. */
export function getMode(): string {
  return mode;
}

/** Register a handler for inline mode execution. */
export function registerHandler(type: string, handler: (job: FakeJob) => Promise<void> | void): void {
  handlers.set(type, handler);
}

/**
 * Record a job enqueue (called by OJSClient when in fake/inline mode).
 * @internal
 */
export async function _recordEnqueue(
  type: string,
  args: JsonValue[],
  options: EnqueueOptions = {},
): Promise<FakeJob> {
  return _recordEnqueueEnvelope(createEnqueueEnvelope(type, args, options));
}

/**
 * Record an already-prepared enqueue envelope. This is the client path used
 * after enqueue middleware has mutated, replaced, or encrypted a job.
 *
 * @internal
 */
export async function _recordEnqueueEnvelope(envelope: Job): Promise<FakeJob> {
  if (!store) throw new Error('OJS testing: not in test mode. Call testing.fake() or testing.inline() first.');

  const job: FakeJob = {
    id: generateId(),
    type: envelope.type,
    queue: envelope.queue,
    // Deep-clone (not a shallow `[...]`/`{...}` copy) using the same
    // JSON-semantic normalization the real enqueue path applies via
    // `createEnqueueEnvelope()`. This is deliberately defensive rather
    // than relying on the caller having already deep-cloned upstream:
    // `_recordEnqueueEnvelope` is itself exported and can receive any
    // `Job`-shaped envelope, and enqueue middleware running before
    // `next()` can replace `args`/`meta` with objects it built by hand.
    // Without this, a caller mutating a nested value inside its own
    // `args`/`meta` object *after* enqueuing (or a later middleware/test
    // mutating the value returned by `_toJob()` below) would silently
    // corrupt this stored fake-mode record, since a shallow copy only
    // protects the outer array/object, not values nested within it.
    args: cloneJsonArray(envelope.args),
    meta: envelope.meta !== undefined ? cloneJsonRecord(envelope.meta) : {},
    state: 'available',
    attempt: 0,
    options: envelopeToOptions(envelope),
    created_at: new Date().toISOString(),
  };
  if (envelope.priority !== undefined) job.priority = envelope.priority;
  if (envelope.timeout !== undefined) job.timeout = envelope.timeout;
  if (envelope.scheduled_at !== undefined) {
    job.scheduled_at = envelope.scheduled_at;
  }
  if (envelope.expires_at !== undefined) job.expires_at = envelope.expires_at;
  if (envelope.retry !== undefined) job.retry = copyRetry(envelope.retry);
  if (envelope.unique !== undefined) job.unique = copyUnique(envelope.unique);
  if (envelope.schema !== undefined) job.schema = envelope.schema;
  if (envelope.visibility_timeout !== undefined) {
    job.visibility_timeout = envelope.visibility_timeout;
  }
  if (envelope.tags !== undefined) job.tags = [...envelope.tags];

  store.enqueued.push(job);

  if (mode === 'inline') {
    const handler = handlers.get(envelope.type);
    if (handler) {
      job.state = 'active';
      job.attempt = 1;
      try {
        await handler(job);
        job.state = 'completed';
      } catch (err) {
        job.state = 'discarded';
        job.error = err instanceof Error ? err.message : String(err);
      }
      store.performed.push(job);
    }
  }

  return job;
}

/**
 * Convert a FakeJob to a Job envelope for OJSClient return values.
 * @internal
 */
export function _toJob(fakeJob: FakeJob): Job {
  const job: Job = {
    specversion: '1.0',
    id: fakeJob.id,
    type: fakeJob.type,
    queue: fakeJob.queue,
    // Deep-cloned, never the same `args`/`meta` array/object references
    // stored on `fakeJob`: this `Job` is handed back through the enqueue
    // middleware onion (and ultimately to the caller), where a later
    // middleware or the caller itself may read or mutate it after
    // `next()` returns. Without this clone, such a post-`next()`
    // mutation would alias and silently corrupt the recorded fake-mode
    // store, so a later `testing.assertEnqueued()`/`allEnqueued()` would
    // observe the mutated (wrong) value instead of what was actually
    // recorded at enqueue time.
    args: cloneJsonArray(fakeJob.args),
    meta: cloneJsonRecord(fakeJob.meta),
    state: fakeJob.state,
    attempt: fakeJob.attempt,
    created_at: fakeJob.created_at,
  };
  if (fakeJob.priority !== undefined) job.priority = fakeJob.priority;
  if (fakeJob.timeout !== undefined) job.timeout = fakeJob.timeout;
  if (fakeJob.scheduled_at !== undefined) {
    job.scheduled_at = fakeJob.scheduled_at;
  }
  if (fakeJob.expires_at !== undefined) job.expires_at = fakeJob.expires_at;
  if (fakeJob.retry !== undefined) job.retry = copyRetry(fakeJob.retry);
  if (fakeJob.unique !== undefined) job.unique = copyUnique(fakeJob.unique);
  if (fakeJob.schema !== undefined) job.schema = fakeJob.schema;
  if (fakeJob.visibility_timeout !== undefined) {
    job.visibility_timeout = fakeJob.visibility_timeout;
  }
  if (fakeJob.tags !== undefined) job.tags = [...fakeJob.tags];
  return job;
}

function envelopeToOptions(job: Job): EnqueueOptions {
  const options: EnqueueOptions = { queue: job.queue };
  if (job.priority !== undefined) options.priority = job.priority;
  if (job.timeout !== undefined) options.timeout = job.timeout;
  if (job.scheduled_at !== undefined) options.delay = job.scheduled_at;
  if (job.expires_at !== undefined) options.expiresAt = job.expires_at;
  if (job.retry !== undefined) {
    options.retry = {
      ...(job.retry.max_attempts !== undefined
        ? { maxAttempts: job.retry.max_attempts }
        : {}),
      ...(job.retry.initial_interval !== undefined
        ? { initialInterval: job.retry.initial_interval }
        : {}),
      ...(job.retry.backoff_coefficient !== undefined
        ? { backoffCoefficient: job.retry.backoff_coefficient }
        : {}),
      ...(job.retry.max_interval !== undefined
        ? { maxInterval: job.retry.max_interval }
        : {}),
      ...(job.retry.jitter !== undefined ? { jitter: job.retry.jitter } : {}),
      ...(job.retry.non_retryable_errors !== undefined
        ? { nonRetryableErrors: [...job.retry.non_retryable_errors] }
        : {}),
      ...(job.retry.on_exhaustion !== undefined
        ? { onExhaustion: job.retry.on_exhaustion }
        : {}),
    };
  }
  if (job.unique !== undefined) {
    options.unique = {
      ...(job.unique.keys !== undefined ? { keys: [...job.unique.keys] } : {}),
      ...(job.unique.args_keys !== undefined
        ? { argsKeys: [...job.unique.args_keys] }
        : {}),
      ...(job.unique.meta_keys !== undefined
        ? { metaKeys: [...job.unique.meta_keys] }
        : {}),
      ...(job.unique.period !== undefined ? { period: job.unique.period } : {}),
      ...(job.unique.on_conflict !== undefined
        ? { onConflict: job.unique.on_conflict }
        : {}),
      ...(job.unique.states !== undefined
        ? { states: [...job.unique.states] }
        : {}),
    };
  }
  if (job.tags !== undefined) options.tags = [...job.tags];
  if (job.meta !== undefined) options.meta = cloneJsonRecord(job.meta);
  if (job.schema !== undefined) options.schema = job.schema;
  if (job.visibility_timeout !== undefined) {
    options.visibilityTimeout = job.visibility_timeout;
  }
  return options;
}

function copyRetry(policy: RetryPolicy): RetryPolicy {
  return {
    ...policy,
    ...(policy.non_retryable_errors !== undefined
      ? { non_retryable_errors: [...policy.non_retryable_errors] }
      : {}),
  };
}

function copyUnique(policy: UniquePolicy): UniquePolicy {
  const copy: UniquePolicy = {};
  if (policy.keys !== undefined) copy.keys = [...policy.keys];
  if (policy.args_keys !== undefined) copy.args_keys = [...policy.args_keys];
  if (policy.meta_keys !== undefined) copy.meta_keys = [...policy.meta_keys];
  if (policy.period !== undefined) copy.period = policy.period;
  if (policy.on_conflict !== undefined) copy.on_conflict = policy.on_conflict;
  if (policy.states !== undefined) copy.states = [...policy.states];
  return copy;
}

/**
 * Deep-clones an `EnqueueOptions` object (the developer-facing, camelCase
 * shape stored on `FakeJob.options`), independently re-cloning its own
 * nested `meta`/`tags`/`retry`/`unique` rather than sharing any array/
 * object reference with the source. Used whenever a `FakeJob` is exposed
 * outside the store (see `cloneFakeJob`) so mutating the exposed copy's
 * options can never alter the recorded one.
 */
function cloneEnqueueOptions(options: EnqueueOptions): EnqueueOptions {
  const cloned: EnqueueOptions = { ...options };
  if (options.tags !== undefined) cloned.tags = [...options.tags];
  if (options.meta !== undefined) cloned.meta = cloneJsonRecord(options.meta);
  if (options.retry !== undefined) {
    cloned.retry = {
      ...options.retry,
      ...(options.retry.nonRetryableErrors !== undefined
        ? { nonRetryableErrors: [...options.retry.nonRetryableErrors] }
        : {}),
    };
  }
  if (options.unique !== undefined) {
    // `envelopeToOptions()` (this record's only producer) never sets the
    // deprecated `UniqueOptions.key`, only the canonical `keys`/
    // `argsKeys`/`metaKeys` -- so it is deliberately not handled here.
    cloned.unique = {
      ...options.unique,
      ...(options.unique.keys !== undefined
        ? { keys: [...options.unique.keys] }
        : {}),
      ...(options.unique.argsKeys !== undefined
        ? { argsKeys: [...options.unique.argsKeys] }
        : {}),
      ...(options.unique.metaKeys !== undefined
        ? { metaKeys: [...options.unique.metaKeys] }
        : {}),
      ...(options.unique.states !== undefined
        ? { states: [...options.unique.states] }
        : {}),
    };
  }
  return cloned;
}

/**
 * Deep-clones a `FakeJob` record for safe external exposure (e.g. via
 * `allEnqueued()`): every JSON/array/object-valued field is independently
 * re-cloned, never shared by reference with the stored record. A caller
 * that mutates the returned job (its `args`, `meta`, `options`, `tags`,
 * `retry`, or `unique`) cannot alter what `testing.ts`'s own store holds,
 * so a later `assertEnqueued()`/`allEnqueued()` call still observes
 * exactly what was originally recorded.
 */
function cloneFakeJob(job: FakeJob): FakeJob {
  const cloned: FakeJob = {
    ...job,
    args: cloneJsonArray(job.args),
    meta: cloneJsonRecord(job.meta),
    options: cloneEnqueueOptions(job.options),
  };
  if (job.retry !== undefined) cloned.retry = copyRetry(job.retry);
  if (job.unique !== undefined) cloned.unique = copyUnique(job.unique);
  if (job.tags !== undefined) cloned.tags = [...job.tags];
  return cloned;
}

/** Assert that at least one job of the given type was enqueued. */
export function assertEnqueued(type: string, options?: MatchOptions): void {
  if (!store) throw new Error('OJS testing: not in test mode.');

  const matches = findMatching(store.enqueued, type, options);
  const expectedCount = options?.count;

  if (expectedCount !== undefined) {
    if (matches.length !== expectedCount) {
      throw new Error(
        `Expected ${expectedCount} enqueued job(s) of type '${type}', found ${matches.length}.` +
        describeEnqueued(store.enqueued, type),
      );
    }
  } else if (matches.length === 0) {
    throw new Error(
      `Expected at least one enqueued job of type '${type}', found none.` +
      describeEnqueued(store.enqueued, type),
    );
  }
}

/** Assert that NO job of the given type was enqueued. */
export function refuteEnqueued(type: string, options?: MatchOptions): void {
  if (!store) throw new Error('OJS testing: not in test mode.');

  const matches = findMatching(store.enqueued, type, options);
  if (matches.length > 0) {
    throw new Error(
      `Expected no enqueued jobs of type '${type}', but found ${matches.length}.`,
    );
  }
}

/** Assert that at least one job of the given type was performed (inline mode). */
export function assertPerformed(type: string, options?: MatchOptions): void {
  if (!store) throw new Error('OJS testing: not in test mode.');

  const matches = findMatching(store.performed, type, options);
  if (matches.length === 0) {
    throw new Error(`Expected at least one performed job of type '${type}', found none.`);
  }
}

/** Assert that at least one job completed successfully. */
export function assertCompleted(type: string): void {
  if (!store) throw new Error('OJS testing: not in test mode.');
  const match = store.performed.find((j) => j.type === type && j.state === 'completed');
  if (!match) throw new Error(`Expected a completed job of type '${type}', found none.`);
}

/** Assert that at least one job failed. */
export function assertFailed(type: string): void {
  if (!store) throw new Error('OJS testing: not in test mode.');
  const match = store.performed.find((j) => j.type === type && j.state === 'discarded');
  if (!match) throw new Error(`Expected a failed job of type '${type}', found none.`);
}

/** Return all enqueued jobs, optionally filtered. */
export function allEnqueued(filter?: { type?: string; queue?: string }): FakeJob[] {
  if (!store) throw new Error('OJS testing: not in test mode.');
  let jobs = store.enqueued;
  if (filter?.type) jobs = jobs.filter((j) => j.type === filter.type);
  if (filter?.queue) jobs = jobs.filter((j) => j.queue === filter.queue);
  // Deep-clone every exposed job (Finding 7): the caller receives its own
  // independent copies, so mutating a returned job's args/meta/options/
  // tags/retry/unique can never corrupt this module's internal store.
  return jobs.map(cloneFakeJob);
}

/**
 * Returns every job that has finished executing (inline mode, or after
 * `drain()`), optionally filtered — the read-only counterpart of
 * `allEnqueued()` for the `performed` half of the store. Each returned
 * job is an independent deep clone (see `cloneFakeJob`), so mutating it
 * cannot alter the recorded store `assertPerformed()`/`assertCompleted()`/
 * `assertFailed()` consult.
 */
export function performed(filter?: { type?: string; queue?: string }): FakeJob[] {
  if (!store) throw new Error('OJS testing: not in test mode.');
  let jobs = store.performed;
  if (filter?.type) jobs = jobs.filter((j) => j.type === filter.type);
  if (filter?.queue) jobs = jobs.filter((j) => j.queue === filter.queue);
  return jobs.map(cloneFakeJob);
}

/** Clear all enqueued and performed jobs. */
export function clearAll(): void {
  if (!store) throw new Error('OJS testing: not in test mode.');
  store.enqueued = [];
  store.performed = [];
}

/** Process all enqueued jobs in fake mode using registered handlers. */
export async function drain(options?: { maxJobs?: number }): Promise<void> {
  if (!store) throw new Error('OJS testing: not in test mode.');

  const max = options?.maxJobs ?? Infinity;
  let processed = 0;

  while (processed < max) {
    const job = store.enqueued.find((j) => j.state === 'available');
    if (!job) break;

    const handler = handlers.get(job.type);
    job.state = 'active';
    job.attempt = (job.attempt || 0) + 1;

    if (handler) {
      try {
        await handler(job);
        job.state = 'completed';
      } catch (err) {
        job.state = 'discarded';
        job.error = err instanceof Error ? err.message : String(err);
      }
    } else {
      job.state = 'completed';
    }

    store.performed.push(job);
    processed++;
  }
}

// --- Internal helpers ---

function findMatching(jobs: FakeJob[], type: string, options?: MatchOptions): FakeJob[] {
  return jobs.filter((j) => {
    if (j.type !== type) return false;
    if (options?.queue && j.queue !== options.queue) return false;
    if (options?.args && JSON.stringify(j.args) !== JSON.stringify(options.args)) return false;
    if (options?.meta) {
      for (const [k, v] of Object.entries(options.meta)) {
        if (JSON.stringify(j.meta[k]) !== JSON.stringify(v)) return false;
      }
    }
    return true;
  });
}

function describeEnqueued(jobs: FakeJob[], type: string): string {
  const ofType = jobs.filter((j) => j.type === type);
  if (jobs.length === 0) return '\n  No jobs were enqueued at all.';
  if (ofType.length === 0) {
    const types = [...new Set(jobs.map((j) => j.type))];
    return `\n  Enqueued types: ${types.join(', ')}`;
  }
  return '';
}

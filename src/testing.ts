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

import type { JsonValue, EnqueueOptions, JobState } from './job.js';

// In-memory store for fake mode
interface FakeStore {
  enqueued: FakeJob[];
  performed: FakeJob[];
}

interface FakeJob {
  id: string;
  type: string;
  queue: string;
  args: JsonValue[];
  meta: Record<string, JsonValue>;
  state: JobState;
  attempt: number;
  options: EnqueueOptions;
  created_at: string;
}

interface MatchOptions {
  args?: JsonValue[];
  queue?: string;
  meta?: Record<string, JsonValue>;
  count?: number;
}

let store: FakeStore | null = null;
let mode: 'real' | 'fake' | 'inline' = 'real';
let handlers: Map<string, (job: FakeJob) => Promise<void> | void> = new Map();

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
export function _recordEnqueue(
  type: string,
  args: JsonValue[],
  options: EnqueueOptions = {},
): FakeJob {
  if (!store) throw new Error('OJS testing: not in test mode. Call testing.fake() or testing.inline() first.');

  const job: FakeJob = {
    id: generateId(),
    type,
    queue: options.queue ?? 'default',
    args,
    meta: (options.meta ?? {}) as Record<string, JsonValue>,
    state: 'available',
    attempt: 0,
    options,
    created_at: new Date().toISOString(),
  };

  store.enqueued.push(job);

  if (mode === 'inline') {
    const handler = handlers.get(type);
    if (handler) {
      job.state = 'active';
      job.attempt = 1;
      try {
        const result = handler(job);
        if (result instanceof Promise) {
          // For inline mode, we execute synchronously so we note it's async
          // Users should await the enqueue call
        }
        job.state = 'completed';
      } catch {
        job.state = 'discarded';
      }
      store.performed.push(job);
    }
  }

  return job;
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
  return jobs;
}

/** Clear all enqueued and performed jobs. */
export function clearAll(): void {
  if (!store) throw new Error('OJS testing: not in test mode.');
  store.enqueued = [];
  store.performed = [];
}

/** Process all enqueued jobs in fake mode using registered handlers. */
export function drain(options?: { maxJobs?: number }): void {
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
        handler(job);
        job.state = 'completed';
      } catch {
        job.state = 'discarded';
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

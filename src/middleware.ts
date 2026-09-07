/**
 * Middleware chain implementation following the OJS Middleware Chains Specification.
 *
 * Supports both enqueue middleware (linear pass-through) and
 * execution middleware (nested onion model with next()).
 */

import type { Job, JsonValue } from './job.js';

// ---- Execution Middleware (Worker-side) ----

/** The context provided to execution middleware and job handlers. */
export interface JobContext {
  /** The full job envelope. */
  job: Job;
  /** Current attempt number (1-indexed). */
  attempt: number;
  /** The queue the job was fetched from. */
  queue: string;
  /** The worker ID that claimed this job. */
  workerId: string;
  /** The workflow ID, if this job is part of a workflow. */
  workflowId?: string;
  /** Parent results from upstream workflow steps. */
  parentResults?: Record<string, JsonValue>;
  /** Mutable metadata store scoped to this execution. */
  metadata: Map<string, unknown>;
  /** Signal for cooperative cancellation. */
  signal: AbortSignal;
}

/** The next function in the middleware chain. */
export type NextFunction = () => Promise<unknown>;

/** An execution middleware function. */
export type ExecutionMiddleware = (
  ctx: JobContext,
  next: NextFunction,
) => Promise<unknown>;

// ---- Enqueue Middleware (Client-side) ----

/** An enqueue middleware function. Returns the job to continue, or null to drop. */
export type EnqueueMiddleware = (
  job: Job,
  next: (job: Job) => Promise<Job | null>,
) => Promise<Job | null>;

// ---- Middleware Chain ----

/**
 * A composable middleware chain.
 * Supports add, prepend, insertBefore, insertAfter, and remove operations
 * as required by the OJS Middleware Specification.
 */
export class MiddlewareChain<T> {
  private chain: { name: string; fn: T }[] = [];

  /** Append middleware to the end of the chain. */
  add(name: string, fn: T): this {
    this.chain.push({ name, fn });
    return this;
  }

  /** Insert middleware at the beginning of the chain. */
  prepend(name: string, fn: T): this {
    this.chain.unshift({ name, fn });
    return this;
  }

  /** Insert middleware immediately before an existing middleware. */
  insertBefore(existingName: string, name: string, fn: T): this {
    const index = this.indexOf(existingName);
    if (index === -1) {
      throw new Error(`Middleware '${existingName}' not found in chain.`);
    }
    this.chain.splice(index, 0, { name, fn });
    return this;
  }

  /** Insert middleware immediately after an existing middleware. */
  insertAfter(existingName: string, name: string, fn: T): this {
    const index = this.indexOf(existingName);
    if (index === -1) {
      throw new Error(`Middleware '${existingName}' not found in chain.`);
    }
    this.chain.splice(index + 1, 0, { name, fn });
    return this;
  }

  /** Remove a middleware by name. */
  remove(name: string): this {
    const index = this.indexOf(name);
    if (index !== -1) {
      this.chain.splice(index, 1);
    }
    return this;
  }

  /** Check if a middleware exists by name. */
  has(name: string): boolean {
    return this.indexOf(name) !== -1;
  }

  /** Get the ordered list of middleware functions. */
  entries(): readonly { name: string; fn: T }[] {
    return this.chain;
  }

  /** Get the number of middleware in the chain. */
  get length(): number {
    return this.chain.length;
  }

  /** Clear all middleware. */
  clear(): void {
    this.chain = [];
  }

  private indexOf(name: string): number {
    return this.chain.findIndex((m) => m.name === name);
  }
}

/**
 * The re-entrancy guard state for one *specific* `next()` closure instance,
 * shared by both {@link composeExecution} and {@link composeEnqueue}.
 *
 * Each time a chain position is entered — whether that is the very first
 * dispatch or a fresh retry-driven re-invocation — it is given a **new**
 * `next` closure with its own private state, not a shared slot keyed by
 * array index. This matters for middleware like the built-in
 * `retry`/`timeout` pair: a retried attempt re-enters upstream positions
 * with an entirely new downstream call chain, which must get fresh guard
 * state rather than colliding with a *previous* attempt's now-stale state
 * for the same nominal position.
 *
 * Within a single closure's lifetime:
 * - `undefined` (never called): calling `next()` is allowed.
 * - `'pending'`: `next()` has started and not yet settled. A second call
 *   while pending is a *concurrent* re-entrancy bug (it would run the
 *   remaining chain twice against shared context/state) and is always
 *   rejected.
 * - `'succeeded'`: `next()` already resolved successfully through this
 *   closure. That downstream invocation already ran to completion, so
 *   calling `next()` again through the *same* closure is rejected — there
 *   is nothing left to legitimately retry via it.
 * - `'failed'`: `next()` rejected through this closure. This is the only
 *   state from which calling `next()` again is allowed, since it is what
 *   lets a retry-style middleware (see `middleware/retry.ts`) catch a
 *   failure and re-run the downstream chain — that re-run reuses the same
 *   closure and legitimately expects to be allowed to call it again.
 */
type DispatchState = 'pending' | 'succeeded' | 'failed';

/** Thrown when `next()` is called again after it already resolved. */
const NEXT_AFTER_SUCCESS_MESSAGE =
  'next() called again after it already resolved successfully; a chain ' +
  'position may only be re-invoked after a rejection (e.g. for a retry), ' +
  'not after it has already succeeded';

/** Thrown when `next()` is called concurrently while still pending. */
const NEXT_CONCURRENT_MESSAGE = 'next() called multiple times';

/**
 * Compose execution middleware into a single handler function.
 * Implements the nested "onion model" where each middleware wraps the next.
 *
 * A given `next()` closure may only have one *in-flight* invocation at a
 * time: calling it again while the previous call is still pending (e.g.
 * firing it twice without awaiting) is rejected, since that would run the
 * remaining chain concurrently against shared context/state. Calling the
 * *same* closure again sequentially *after* it already resolved
 * successfully is also rejected — that downstream invocation already ran to
 * completion. The only sequential re-invocation this allows is *after a
 * rejection*, which is what lets a retry-style middleware (see
 * middleware/retry.ts) re-run the downstream chain on failure. Each retry
 * attempt re-enters the chain with fresh `next()` closures for every
 * downstream position, so a later attempt succeeding never collides with an
 * earlier attempt's state.
 */
export function composeExecution(
  middlewares: readonly { name: string; fn: ExecutionMiddleware }[],
  handler: (ctx: JobContext) => Promise<unknown>,
): (ctx: JobContext) => Promise<unknown> {
  function dispatch(ctx: JobContext, i: number): Promise<unknown> {
    const middleware = middlewares[i];
    if (!middleware) {
      return Promise.resolve().then(() => handler(ctx));
    }

    let state: DispatchState | undefined;
    const next: NextFunction = () => {
      if (state === 'pending') {
        return Promise.reject(new Error(NEXT_CONCURRENT_MESSAGE));
      }
      if (state === 'succeeded') {
        return Promise.reject(new Error(NEXT_AFTER_SUCCESS_MESSAGE));
      }
      state = 'pending';
      return dispatch(ctx, i + 1).then(
        (result) => {
          state = 'succeeded';
          return result;
        },
        (error: unknown) => {
          state = 'failed';
          throw error;
        },
      );
    };

    return Promise.resolve().then(() => middleware.fn(ctx, next));
  }

  return (ctx: JobContext) => dispatch(ctx, 0);
}

/**
 * Compose enqueue middleware into a single function.
 * Linear chain: each middleware can pass, drop, or throw.
 *
 * Uses the same "no concurrent re-entrancy, retry-only-after-rejection,
 * per-invocation-closure" guard as {@link composeExecution} — see its
 * documentation for the rationale and the exact state transitions.
 */
export function composeEnqueue(
  middlewares: readonly { name: string; fn: EnqueueMiddleware }[],
  finalEnqueue: (job: Job) => Promise<Job | null>,
): (job: Job) => Promise<Job | null> {
  function dispatch(i: number, currentJob: Job): Promise<Job | null> {
    const middleware = middlewares[i];
    if (!middleware) {
      return Promise.resolve().then(() => finalEnqueue(currentJob));
    }

    let state: DispatchState | undefined;
    const next = (nextJob: Job): Promise<Job | null> => {
      if (state === 'pending') {
        return Promise.reject(new Error(NEXT_CONCURRENT_MESSAGE));
      }
      if (state === 'succeeded') {
        return Promise.reject(new Error(NEXT_AFTER_SUCCESS_MESSAGE));
      }
      state = 'pending';
      return dispatch(i + 1, nextJob).then(
        (result) => {
          state = 'succeeded';
          return result;
        },
        (error: unknown) => {
          state = 'failed';
          throw error;
        },
      );
    };

    return Promise.resolve().then(() => middleware.fn(currentJob, next));
  }

  return (job: Job) => dispatch(0, job);
}

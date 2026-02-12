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
 * Compose execution middleware into a single handler function.
 * Implements the nested "onion model" where each middleware wraps the next.
 */
export function composeExecution(
  middlewares: readonly { name: string; fn: ExecutionMiddleware }[],
  handler: (ctx: JobContext) => Promise<unknown>,
): (ctx: JobContext) => Promise<unknown> {
  return (ctx: JobContext) => {
    let index = -1;

    function dispatch(i: number): Promise<unknown> {
      if (i <= index) {
        return Promise.reject(new Error('next() called multiple times'));
      }
      index = i;

      const middleware = middlewares[i];
      if (!middleware) {
        return handler(ctx);
      }

      return middleware.fn(ctx, () => dispatch(i + 1));
    }

    return dispatch(0);
  };
}

/**
 * Compose enqueue middleware into a single function.
 * Linear chain: each middleware can pass, drop, or throw.
 */
export function composeEnqueue(
  middlewares: readonly { name: string; fn: EnqueueMiddleware }[],
  finalEnqueue: (job: Job) => Promise<Job | null>,
): (job: Job) => Promise<Job | null> {
  return (job: Job) => {
    let index = -1;

    function dispatch(i: number, currentJob: Job): Promise<Job | null> {
      if (i <= index) {
        return Promise.reject(new Error('next() called multiple times'));
      }
      index = i;

      const middleware = middlewares[i];
      if (!middleware) {
        return finalEnqueue(currentJob);
      }

      return middleware.fn(currentJob, (nextJob) => dispatch(i + 1, nextJob));
    }

    return dispatch(0, job);
  };
}

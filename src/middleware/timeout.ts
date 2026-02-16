/**
 * Execution timeout middleware for OJS job processing.
 *
 * Aborts job execution if it exceeds the configured timeout duration.
 *
 * @example
 * ```typescript
 * import { OJSWorker } from '@openjobspec/sdk';
 * import { timeout } from '@openjobspec/sdk/middleware';
 *
 * const worker = new OJSWorker({ url: 'http://localhost:8080', queues: ['default'] });
 * worker.use(timeout({ timeoutMs: 30_000 })); // 30 seconds
 * ```
 *
 * @module
 */

import type { ExecutionMiddleware, JobContext, NextFunction } from '../middleware.js';

/** Error thrown when a job exceeds its execution timeout. */
export class TimeoutError extends Error {
  /** The timeout duration in milliseconds. */
  readonly timeoutMs: number;
  /** The job ID that timed out. */
  readonly jobId: string;

  constructor(timeoutMs: number, jobId: string) {
    super(`Job ${jobId} timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
    this.jobId = jobId;
  }
}

/** Options for the timeout middleware. */
export interface TimeoutOptions {
  /** Maximum execution time in milliseconds. */
  timeoutMs: number;
}

/**
 * Creates execution middleware that aborts job processing after a timeout.
 *
 * Uses `AbortController` and `setTimeout` to enforce the time limit.
 * Rejects with a {@link TimeoutError} if the job exceeds the configured duration.
 *
 * @param options - timeout configuration
 * @returns execution middleware function
 */
export function timeout(options: TimeoutOptions): ExecutionMiddleware {
  const { timeoutMs } = options;

  return async (ctx: JobContext, next: NextFunction): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const result = await Promise.race([
        next(),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => {
            reject(new TimeoutError(timeoutMs, ctx.job.id ?? 'unknown'));
          });
        }),
      ]);
      return result;
    } finally {
      clearTimeout(timer);
    }
  };
}

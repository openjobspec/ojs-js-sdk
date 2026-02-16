/**
 * Client-side retry middleware for OJS job processing.
 *
 * Retries failed job executions with configurable exponential backoff and jitter.
 *
 * @example
 * ```typescript
 * import { OJSWorker } from '@openjobspec/sdk';
 * import { retry } from '@openjobspec/sdk/middleware';
 *
 * const worker = new OJSWorker({ url: 'http://localhost:8080', queues: ['default'] });
 * worker.use(retry({ maxRetries: 3, baseDelayMs: 100 }));
 * ```
 *
 * @module
 */

import type { ExecutionMiddleware, JobContext, NextFunction } from '../middleware.js';

/** Options for the retry middleware. */
export interface RetryOptions {
  /** Maximum number of retry attempts. Defaults to `3`. */
  maxRetries?: number;
  /** Base delay in milliseconds for exponential backoff. Defaults to `100`. */
  baseDelayMs?: number;
  /** Maximum delay in milliseconds. Defaults to `30000`. */
  maxDelayMs?: number;
  /** Whether to add random jitter to the delay. Defaults to `true`. */
  jitter?: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Creates execution middleware that retries failed job executions
 * with exponential backoff.
 *
 * @param options - retry configuration
 * @returns execution middleware function
 */
export function retry(options?: RetryOptions): ExecutionMiddleware {
  const maxRetries = options?.maxRetries ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 100;
  const maxDelayMs = options?.maxDelayMs ?? 30_000;
  const useJitter = options?.jitter ?? true;

  return async (_ctx: JobContext, next: NextFunction): Promise<unknown> => {
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await next();
      } catch (error) {
        lastError = error;

        if (attempt >= maxRetries) {
          break;
        }

        const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
        const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
        const finalDelay = useJitter
          ? cappedDelay * (0.5 + Math.random() * 0.5)
          : cappedDelay;

        await delay(finalDelay);
      }
    }

    throw lastError;
  };
}

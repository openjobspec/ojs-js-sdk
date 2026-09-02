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
import { getTimeoutSettlement } from './timeout-settlement.js';

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

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new Error('The operation was aborted', { cause: reason });
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      signal.removeEventListener('abort', onAbort);
    };

    const onAbort = (): void => {
      cleanup();
      reject(abortReason(signal));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
  });
}

async function settlesWithin(
  settlement: Promise<void>,
  graceMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      settlement.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), graceMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
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

  return async (ctx: JobContext, next: NextFunction): Promise<unknown> => {
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await next();
      } catch (error) {
        lastError = error;

        if (attempt >= maxRetries) {
          break;
        }

        const timeoutLifecycle = getTimeoutSettlement(error);
        if (
          timeoutLifecycle &&
          !(await settlesWithin(
            timeoutLifecycle.settlement,
            timeoutLifecycle.settlementGraceMs,
          ))
        ) {
          throw error;
        }

        const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
        const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
        const finalDelay = useJitter
          ? cappedDelay * (0.5 + Math.random() * 0.5)
          : cappedDelay;

        await delay(finalDelay, ctx.signal);
      }
    }

    throw lastError;
  };
}

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
import { registerTimeoutSettlement } from './timeout-settlement.js';

interface TimeoutFrame {
  signal: AbortSignal;
  settled: boolean;
}

interface TimeoutFrameStack {
  originalSignal: AbortSignal;
  frames: TimeoutFrame[];
}

const timeoutFrameStacks = new WeakMap<JobContext, TimeoutFrameStack>();

function pushTimeoutFrame(
  ctx: JobContext,
  signal: AbortSignal,
): TimeoutFrame {
  let stack = timeoutFrameStacks.get(ctx);
  if (!stack) {
    stack = { originalSignal: ctx.signal, frames: [] };
    timeoutFrameStacks.set(ctx, stack);
  }

  const frame = { signal, settled: false };
  stack.frames.push(frame);
  ctx.signal = signal;
  return frame;
}

function settleTimeoutFrame(ctx: JobContext, frame: TimeoutFrame): void {
  const stack = timeoutFrameStacks.get(ctx);
  if (!stack) {
    return;
  }

  frame.settled = true;
  while (stack.frames.at(-1)?.settled) {
    stack.frames.pop();
  }

  const activeFrame = stack.frames.at(-1);
  ctx.signal = activeFrame?.signal ?? stack.originalSignal;
  if (stack.frames.length === 0) {
    timeoutFrameStacks.delete(ctx);
  }
}

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
  /**
   * Maximum time retry middleware may wait for timed-out work to settle
   * cooperatively before retrying is considered unsafe. Defaults to `100`.
   */
  settlementGraceMs?: number;
}

function abortReasonAsError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error('The operation was aborted', { cause: reason });
}

/**
 * Creates execution middleware that aborts job processing after a timeout.
 *
 * Uses `AbortController` and `setTimeout` to enforce the time limit.
 * Rejects with a {@link TimeoutError} immediately when the deadline expires.
 *
 * The middleware's own timeout is combined into `ctx.signal` (replacing it
 * for the remainder of the chain) rather than kept on a private,
 * disconnected `AbortController`. Downstream middleware/handlers that
 * cooperatively check `ctx.signal` (e.g. to abort an outgoing `fetch`) will
 * therefore actually observe this timeout firing — previously the private
 * controller's `abort()` only made this middleware's own race settle early;
 * it never propagated to anything the handler itself could see.
 *
 * Downstream settlement and signal restoration are tracked separately from
 * the outward timeout rejection. The retry middleware uses that private
 * lifecycle to prevent a second invocation from overlapping timed-out work.
 *
 * @param options - timeout configuration
 * @returns execution middleware function
 */
export function timeout(options: TimeoutOptions): ExecutionMiddleware {
  const { timeoutMs } = options;
  const settlementGraceMs = options.settlementGraceMs ?? 100;

  return async (ctx: JobContext, next: NextFunction): Promise<unknown> => {
    const outerSignal = ctx.signal;
    const combined = new AbortController();
    const timeoutError = new TimeoutError(timeoutMs, ctx.job.id ?? 'unknown');
    let outerListenerAttached = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectCancellation: (reason: Error) => void = () => undefined;

    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const frame = pushTimeoutFrame(ctx, combined.signal);

    const removeOuterAbortListener = (): void => {
      if (!outerListenerAttached) {
        return;
      }
      outerSignal.removeEventListener('abort', propagateOuterAbort);
      outerListenerAttached = false;
    };

    function propagateOuterAbort(): void {
      removeOuterAbortListener();
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      rejectCancellation(abortReasonAsError(outerSignal.reason));
      combined.abort(outerSignal.reason);
    }

    if (outerSignal.aborted) {
      propagateOuterAbort();
    } else {
      outerSignal.addEventListener('abort', propagateOuterAbort, { once: true });
      outerListenerAttached = true;
    }

    if (!combined.signal.aborted) {
      timer = setTimeout(() => {
        timer = undefined;
        removeOuterAbortListener();
        rejectCancellation(timeoutError);
        combined.abort(timeoutError);
      }, timeoutMs);
    }

    let downstream: Promise<unknown>;
    try {
      downstream = Promise.resolve(next());
    } catch (error) {
      downstream = Promise.reject(
        error instanceof Error
          ? error
          : new Error('Downstream middleware failed', { cause: error }),
      );
    }

    const settlement = downstream.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      removeOuterAbortListener();
      settleTimeoutFrame(ctx, frame);
    });
    registerTimeoutSettlement(timeoutError, settlement, settlementGraceMs);

    return Promise.race([cancellation, downstream]);
  };
}

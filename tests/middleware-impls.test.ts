import { describe, it, expect, vi } from 'vitest';
import { logging } from '../src/middleware/logging.js';
import { timeout, TimeoutError } from '../src/middleware/timeout.js';
import { retry } from '../src/middleware/retry.js';
import { metrics, type MetricsRecorder } from '../src/middleware/metrics.js';
import {
  composeExecution,
  type JobContext,
} from '../src/middleware.js';

function createTestContext(overrides: Partial<JobContext> = {}): JobContext {
  return {
    job: {
      specversion: '1.0',
      id: 'test-id',
      type: 'test.job',
      queue: 'default',
      args: [],
    },
    attempt: 1,
    queue: 'default',
    workerId: 'test-worker',
    metadata: new Map(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('logging middleware', () => {
  it('should log completion on success', async () => {
    const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const mw = logging({ logger });
    const ctx = createTestContext();

    await mw(ctx, async () => 'ok');

    expect(logger.log).toHaveBeenCalledOnce();
    expect(logger.log.mock.calls[0][0]).toContain('Job completed');
  });

  it('should log error on failure', async () => {
    const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const mw = logging({ logger });
    const ctx = createTestContext();

    await expect(
      mw(ctx, async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');

    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0][0]).toContain('Job failed');
  });

  it('should log debug messages when level is debug', async () => {
    const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const mw = logging({ logger, level: 'debug' });
    const ctx = createTestContext();

    await mw(ctx, async () => 'ok');

    expect(logger.debug).toHaveBeenCalledOnce();
    expect(logger.debug.mock.calls[0][0]).toContain('Job started');
  });
});

describe('timeout middleware', () => {
  it('should pass through if job completes within timeout', async () => {
    const mw = timeout({ timeoutMs: 1000 });
    const ctx = createTestContext();

    const result = await mw(ctx, async () => 'ok');
    expect(result).toBe('ok');
  });

  it('should reject at the deadline even when downstream never settles', async () => {
    vi.useFakeTimers();
    try {
      const mw = timeout({ timeoutMs: 10 });
      const ctx = createTestContext();
      let observedSignal: AbortSignal | undefined;

      const promise = mw(ctx, () => new Promise(() => {
        observedSignal = ctx.signal;
        ctx.signal.addEventListener('abort', () => {
          // Deliberately observe cancellation without settling.
        });
      }));
      const assertion = expect(promise).rejects.toThrow(TimeoutError);

      await vi.advanceTimersByTimeAsync(10);
      await assertion;

      expect(observedSignal?.aborted).toBe(true);
      expect(observedSignal?.reason).toBeInstanceOf(TimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should propagate the timeout into ctx.signal so downstream handlers observe it', async () => {
    vi.useFakeTimers();
    try {
      const mw = timeout({ timeoutMs: 10 });
      const ctx = createTestContext();

      let observedAbort = false;
      const handlerPromise = mw(ctx, () => {
        return new Promise((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => {
            observedAbort = true;
            reject(ctx.signal.reason);
          }, { once: true });
        });
      });

      const assertion = expect(handlerPromise).rejects.toThrow(TimeoutError);
      await vi.advanceTimersByTimeAsync(10);
      await assertion;

      expect(observedAbort).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should restore the outer signal only after timed-out downstream settles', async () => {
    vi.useFakeTimers();
    try {
      const outerController = new AbortController();
      const mw = timeout({ timeoutMs: 10 });
      const ctx = createTestContext({ signal: outerController.signal });
      let settleDownstream: (() => void) | undefined;
      let timeoutSignal: AbortSignal | undefined;

      const handlerPromise = mw(ctx, () => new Promise<void>((resolve) => {
        timeoutSignal = ctx.signal;
        settleDownstream = resolve;
      }));

      const assertion = expect(handlerPromise).rejects.toThrow(TimeoutError);
      await vi.advanceTimersByTimeAsync(10);
      await assertion;

      expect(ctx.signal).toBe(timeoutSignal);
      expect(ctx.signal.aborted).toBe(true);

      settleDownstream?.();
      await Promise.resolve();
      await Promise.resolve();

      expect(ctx.signal).toBe(outerController.signal);
      expect(ctx.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should remove the outer abort listener when a non-cooperative handler times out', async () => {
    vi.useFakeTimers();
    try {
      const outerController = new AbortController();
      const addSpy = vi.spyOn(outerController.signal, 'addEventListener');
      const removeSpy = vi.spyOn(outerController.signal, 'removeEventListener');
      const mw = timeout({ timeoutMs: 10 });
      const ctx = createTestContext({ signal: outerController.signal });

      void mw(ctx, () => new Promise(() => {
        // Deliberately ignores cancellation and never settles.
      })).catch(() => undefined);

      await vi.advanceTimersByTimeAsync(10);

      expect(addSpy).toHaveBeenCalledTimes(1);
      expect(removeSpy).toHaveBeenCalledTimes(1);
      expect(removeSpy.mock.calls[0]?.[1]).toBe(addSpy.mock.calls[0]?.[1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should restore the outer signal after normal completion', async () => {
    vi.useFakeTimers();
    try {
      const outerController = new AbortController();
      const mw = timeout({ timeoutMs: 10 });
      const ctx = createTestContext({ signal: outerController.signal });

      await expect(mw(ctx, async () => 'ok')).resolves.toBe('ok');

      expect(ctx.signal).toBe(outerController.signal);
      await vi.advanceTimersByTimeAsync(10);
      expect(ctx.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should immediately propagate an already-aborted outer signal into the combined signal', async () => {
    const outerController = new AbortController();
    const reason = new Error('worker shutting down');
    outerController.abort(reason);

    const mw = timeout({ timeoutMs: 10_000 });
    const ctx = createTestContext({ signal: outerController.signal });

    let sawAbortedSignalInHandler = false;
    await expect(
      mw(ctx, () => {
        sawAbortedSignalInHandler = ctx.signal.aborted;
        return Promise.reject(ctx.signal.reason);
      }),
    ).rejects.toBe(reason);

    expect(sawAbortedSignalInHandler).toBe(true);
    expect(ctx.signal).toBe(outerController.signal);
  });

  it('should propagate a later outer-signal abort (e.g. worker shutdown) into the handler', async () => {
    const outerController = new AbortController();
    const mw = timeout({ timeoutMs: 10_000 });
    const ctx = createTestContext({ signal: outerController.signal });

    const handlerPromise = mw(ctx, () => new Promise((_resolve, reject) => {
      ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
    }));

    const shutdownReason = new Error('shutdown');
    outerController.abort(shutdownReason);

    await expect(handlerPromise).rejects.toBe(shutdownReason);
    expect(ctx.signal).toBe(outerController.signal);
  });

  it('should not leak an abort listener on the outer signal once the call settles normally', async () => {
    const outerController = new AbortController();
    const addSpy = vi.spyOn(outerController.signal, 'addEventListener');
    const removeSpy = vi.spyOn(outerController.signal, 'removeEventListener');

    const mw = timeout({ timeoutMs: 1000 });
    const ctx = createTestContext({ signal: outerController.signal });

    await mw(ctx, async () => 'ok');

    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy.mock.calls[0]?.[1]).toBe(addSpy.mock.calls[0]?.[1]);
  });

  it('should restore the worker signal after an outer frame settles before a late inner frame', async () => {
    vi.useFakeTimers();
    try {
      const workerController = new AbortController();
      const outer = timeout({ timeoutMs: 100 });
      const inner = timeout({ timeoutMs: 10 });
      const ctx = createTestContext({ signal: workerController.signal });
      let innerSignal: AbortSignal | undefined;
      let settleHandler: (() => void) | undefined;

      const execution = outer(ctx, () =>
        inner(ctx, () => new Promise<void>((resolve) => {
          innerSignal = ctx.signal;
          settleHandler = resolve;
        })),
      );
      const assertion = expect(execution).rejects.toThrow(TimeoutError);

      await vi.advanceTimersByTimeAsync(10);
      await assertion;

      expect(ctx.signal).toBe(innerSignal);
      expect(ctx.signal).not.toBe(workerController.signal);
      expect(ctx.signal.aborted).toBe(true);

      settleHandler?.();
      await Promise.resolve();
      await Promise.resolve();

      expect(ctx.signal).toBe(workerController.signal);
      expect(ctx.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should keep the inner frame active when the outer timeout fires first', async () => {
    vi.useFakeTimers();
    try {
      const workerController = new AbortController();
      const outer = timeout({ timeoutMs: 10 });
      const inner = timeout({ timeoutMs: 100 });
      const ctx = createTestContext({ signal: workerController.signal });
      let innerSignal: AbortSignal | undefined;
      let settleHandler: (() => void) | undefined;

      const execution = outer(ctx, () =>
        inner(ctx, () => new Promise<void>((resolve) => {
          innerSignal = ctx.signal;
          settleHandler = resolve;
        })),
      );
      const assertion = expect(execution).rejects.toThrow(TimeoutError);

      await vi.advanceTimersByTimeAsync(10);
      await assertion;

      expect(innerSignal?.aborted).toBe(true);
      expect(ctx.signal).toBe(innerSignal);

      settleHandler?.();
      await Promise.resolve();
      await Promise.resolve();

      expect(ctx.signal).toBe(workerController.signal);
      expect(ctx.signal.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should propagate worker cancellation through every nested timeout frame', async () => {
    const workerController = new AbortController();
    const outer = timeout({ timeoutMs: 10_000 });
    const inner = timeout({ timeoutMs: 10_000 });
    const ctx = createTestContext({ signal: workerController.signal });
    let innerSignal: AbortSignal | undefined;

    const execution = outer(ctx, () =>
      inner(ctx, () => new Promise((_resolve, reject) => {
        innerSignal = ctx.signal;
        ctx.signal.addEventListener(
          'abort',
          () => reject(ctx.signal.reason),
          { once: true },
        );
      })),
    );

    const reason = new Error('worker shutdown');
    workerController.abort(reason);

    await expect(execution).rejects.toBe(reason);
    expect(innerSignal?.aborted).toBe(true);
    expect(innerSignal?.reason).toBe(reason);
    expect(ctx.signal).toBe(workerController.signal);
  });
});

describe('retry and timeout middleware', () => {
  it('should retry only after a cooperative timed-out invocation settles', async () => {
    vi.useFakeTimers();
    try {
      const retryMw = retry({ maxRetries: 1, baseDelayMs: 1, jitter: false });
      const timeoutMw = timeout({ timeoutMs: 10, settlementGraceMs: 50 });
      const ctx = createTestContext();
      let attempts = 0;
      let inFlight = 0;
      let maxInFlight = 0;

      const composed = composeExecution([
        { name: 'retry', fn: retryMw },
        { name: 'timeout', fn: timeoutMw },
      ], async () => {
        attempts++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);

        if (attempts === 1) {
          try {
            await new Promise((_resolve, reject) => {
              ctx.signal.addEventListener('abort', () => {
                reject(ctx.signal.reason);
              }, { once: true });
            });
          } finally {
            inFlight--;
          }
        }

        inFlight--;
        return 'ok';
      });
      const resultPromise = composed(ctx);

      await vi.runAllTimersAsync();

      await expect(resultPromise).resolves.toBe('ok');
      expect(attempts).toBe(2);
      expect(maxInFlight).toBe(1);
      expect(inFlight).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should not retry or overlap a non-cooperative timed-out invocation', async () => {
    vi.useFakeTimers();
    try {
      const retryMw = retry({ maxRetries: 1, baseDelayMs: 1, jitter: false });
      const timeoutMw = timeout({ timeoutMs: 10, settlementGraceMs: 25 });
      const ctx = createTestContext();
      let attempts = 0;

      const composed = composeExecution([
        { name: 'retry', fn: retryMw },
        { name: 'timeout', fn: timeoutMw },
      ], () => {
        attempts++;
        return new Promise(() => {
          // Deliberately ignores cancellation and never settles.
        });
      });

      const resultPromise = composed(ctx);
      const assertion = expect(resultPromise).rejects.toThrow(TimeoutError);

      await vi.advanceTimersByTimeAsync(10);
      expect(attempts).toBe(1);

      await vi.advanceTimersByTimeAsync(24);
      expect(attempts).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      await assertion;

      expect(attempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should retry when timed-out work settles within the configured grace', async () => {
    vi.useFakeTimers();
    try {
      const retryMw = retry({ maxRetries: 1, baseDelayMs: 1, jitter: false });
      const timeoutMw = timeout({ timeoutMs: 10, settlementGraceMs: 30 });
      const ctx = createTestContext();
      let attempts = 0;
      let settleFirst: (() => void) | undefined;

      const composed = composeExecution([
        { name: 'retry', fn: retryMw },
        { name: 'timeout', fn: timeoutMw },
      ], async () => {
        attempts++;
        if (attempts === 1) {
          await new Promise<void>((resolve) => {
            settleFirst = resolve;
          });
        }
        return 'ok';
      });
      const resultPromise = composed(ctx);

      await vi.advanceTimersByTimeAsync(10);
      expect(attempts).toBe(1);

      await vi.advanceTimersByTimeAsync(20);
      settleFirst?.();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);

      await expect(resultPromise).resolves.toBe('ok');
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('retry middleware', () => {
  it('should pass through on success', async () => {
    const mw = retry({ maxRetries: 3, baseDelayMs: 1 });
    const ctx = createTestContext();

    const result = await mw(ctx, async () => 'ok');
    expect(result).toBe('ok');
  });

  it('should retry on failure and succeed', async () => {
    const mw = retry({ maxRetries: 3, baseDelayMs: 1, jitter: false });
    const ctx = createTestContext();

    let calls = 0;
    const result = await mw(ctx, async () => {
      calls++;
      if (calls < 3) throw new Error('fail');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('should throw after exhausting retries', async () => {
    const mw = retry({ maxRetries: 2, baseDelayMs: 1, jitter: false });
    const ctx = createTestContext();

    await expect(
      mw(ctx, async () => { throw new Error('always fails'); }),
    ).rejects.toThrow('always fails');
  });

  it('should cancel a retry delay using the context signal', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const reason = new Error('worker stopping');
      const mw = retry({ maxRetries: 1, baseDelayMs: 100, jitter: false });
      const ctx = createTestContext({ signal: controller.signal });
      let calls = 0;

      const promise = mw(ctx, async () => {
        calls++;
        throw new Error('retryable');
      });
      await Promise.resolve();

      controller.abort(reason);

      await expect(promise).rejects.toBe(reason);
      expect(calls).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('metrics middleware', () => {
  it('should record completion on success', async () => {
    const recorder: MetricsRecorder = {
      jobStarted: vi.fn(),
      jobCompleted: vi.fn(),
      jobFailed: vi.fn(),
    };
    const mw = metrics({ recorder });
    const ctx = createTestContext();

    await mw(ctx, async () => 'ok');

    expect(recorder.jobStarted).toHaveBeenCalledWith('test.job', 'default');
    expect(recorder.jobCompleted).toHaveBeenCalledOnce();
    expect(recorder.jobFailed).not.toHaveBeenCalled();
  });

  it('should record failure on error', async () => {
    const recorder: MetricsRecorder = {
      jobStarted: vi.fn(),
      jobCompleted: vi.fn(),
      jobFailed: vi.fn(),
    };
    const mw = metrics({ recorder });
    const ctx = createTestContext();

    await expect(
      mw(ctx, async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');

    expect(recorder.jobStarted).toHaveBeenCalledOnce();
    expect(recorder.jobFailed).toHaveBeenCalledOnce();
    expect(recorder.jobCompleted).not.toHaveBeenCalled();
  });
});

describe('retry middleware — maxRetries=0', () => {
  it('should not retry at all when maxRetries is 0', async () => {
    const mw = retry({ maxRetries: 0, baseDelayMs: 1 });
    const ctx = createTestContext();
    let calls = 0;

    await expect(
      mw(ctx, async () => { calls++; throw new Error('fail'); }),
    ).rejects.toThrow('fail');

    expect(calls).toBe(1);
  });

  it('should succeed on first try with maxRetries=0', async () => {
    const mw = retry({ maxRetries: 0, baseDelayMs: 1 });
    const ctx = createTestContext();

    const result = await mw(ctx, async () => 'ok');
    expect(result).toBe('ok');
  });
});

describe('retry + timeout — exhausted final attempt rethrows immediately', () => {
  it('rethrows TimeoutError on final attempt without awaiting settlement', async () => {
    vi.useFakeTimers();
    try {
      const retryMw = retry({ maxRetries: 0, baseDelayMs: 1, jitter: false });
      const timeoutMw = timeout({ timeoutMs: 10 });
      const ctx = createTestContext();
      let attempts = 0;

      const next = () => timeoutMw(ctx, () => {
        attempts++;
        return new Promise(() => {
          // Deliberately ignores cancellation and never settles.
        });
      });

      const resultPromise = retryMw(ctx, next);
      const assertion = expect(resultPromise).rejects.toThrow(TimeoutError);
      await vi.advanceTimersByTimeAsync(10);

      await assertion;
      expect(attempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rethrows TimeoutError on exhausted final attempt (maxRetries=1, both fail)', async () => {
    vi.useFakeTimers();
    try {
      const retryMw = retry({ maxRetries: 1, baseDelayMs: 1, jitter: false });
      const timeoutMw = timeout({ timeoutMs: 10 });
      const ctx = createTestContext();
      let attempts = 0;

      const next = () => timeoutMw(ctx, () => {
        attempts++;
        if (attempts === 2) {
          return new Promise(() => {
            // The final invocation is deliberately non-cooperative.
          });
        }
        return new Promise((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
        });
      });

      const resultPromise = retryMw(ctx, next);
      // Attach assertion BEFORE advancing timers to ensure the rejection
      // handler is registered before the promise actually rejects.
      const assertion = expect(resultPromise).rejects.toThrow(TimeoutError);

      // First timeout fires at 10ms
      await vi.advanceTimersByTimeAsync(10);
      // Retry delay (1ms)
      await vi.advanceTimersByTimeAsync(1);
      // Second timeout fires at 10ms — should reject immediately (final attempt)
      await vi.advanceTimersByTimeAsync(10);

      await assertion;
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

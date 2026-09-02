import { describe, it, expect } from 'vitest';
import {
  MiddlewareChain,
  composeExecution,
  composeEnqueue,
  type ExecutionMiddleware,
  type EnqueueMiddleware,
  type JobContext,
} from '../src/middleware.js';
import type { Job } from '../src/job.js';
import { retry } from '../src/middleware/retry.js';

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

describe('MiddlewareChain', () => {
  describe('add/remove operations', () => {
    it('should add middleware', () => {
      const chain = new MiddlewareChain<ExecutionMiddleware>();
      chain.add('logging', async (_ctx, next) => next());
      expect(chain.length).toBe(1);
      expect(chain.has('logging')).toBe(true);
    });

    it('should prepend middleware', () => {
      const chain = new MiddlewareChain<ExecutionMiddleware>();
      chain.add('second', async (_ctx, next) => next());
      chain.prepend('first', async (_ctx, next) => next());

      const entries = chain.entries();
      expect(entries[0].name).toBe('first');
      expect(entries[1].name).toBe('second');
    });

    it('should insert before', () => {
      const chain = new MiddlewareChain<ExecutionMiddleware>();
      chain.add('first', async (_ctx, next) => next());
      chain.add('third', async (_ctx, next) => next());
      chain.insertBefore('third', 'second', async (_ctx, next) => next());

      const entries = chain.entries();
      expect(entries.map((e) => e.name)).toEqual(['first', 'second', 'third']);
    });

    it('should insert after', () => {
      const chain = new MiddlewareChain<ExecutionMiddleware>();
      chain.add('first', async (_ctx, next) => next());
      chain.add('third', async (_ctx, next) => next());
      chain.insertAfter('first', 'second', async (_ctx, next) => next());

      const entries = chain.entries();
      expect(entries.map((e) => e.name)).toEqual(['first', 'second', 'third']);
    });

    it('should remove middleware', () => {
      const chain = new MiddlewareChain<ExecutionMiddleware>();
      chain.add('logging', async (_ctx, next) => next());
      chain.add('metrics', async (_ctx, next) => next());
      chain.remove('logging');

      expect(chain.length).toBe(1);
      expect(chain.has('logging')).toBe(false);
      expect(chain.has('metrics')).toBe(true);
    });

    it('should throw on insertBefore with missing target', () => {
      const chain = new MiddlewareChain<ExecutionMiddleware>();
      expect(() =>
        chain.insertBefore('nonexistent', 'new', async (_ctx, next) => next()),
      ).toThrow("Middleware 'nonexistent' not found");
    });

    it('should clear all middleware', () => {
      const chain = new MiddlewareChain<ExecutionMiddleware>();
      chain.add('a', async (_ctx, next) => next());
      chain.add('b', async (_ctx, next) => next());
      chain.clear();
      expect(chain.length).toBe(0);
    });
  });
});

describe('composeExecution', () => {
  it('should compose middleware in onion order', async () => {
    const order: string[] = [];

    const middlewares = [
      {
        name: 'outer',
        fn: async (_ctx: JobContext, next: () => Promise<unknown>) => {
          order.push('outer-before');
          const result = await next();
          order.push('outer-after');
          return result;
        },
      },
      {
        name: 'inner',
        fn: async (_ctx: JobContext, next: () => Promise<unknown>) => {
          order.push('inner-before');
          const result = await next();
          order.push('inner-after');
          return result;
        },
      },
    ];

    const handler = async () => {
      order.push('handler');
      return 'result';
    };

    const composed = composeExecution(middlewares, handler);
    const result = await composed(createTestContext());

    expect(result).toBe('result');
    expect(order).toEqual([
      'outer-before',
      'inner-before',
      'handler',
      'inner-after',
      'outer-after',
    ]);
  });

  it('should allow middleware to short-circuit by not calling next', async () => {
    const middlewares = [
      {
        name: 'circuit-breaker',
        fn: async (_ctx: JobContext, _next: () => Promise<unknown>) => {
          return 'short-circuited';
        },
      },
    ];

    const handler = async () => 'should-not-reach';

    const composed = composeExecution(middlewares, handler);
    const result = await composed(createTestContext());

    expect(result).toBe('short-circuited');
  });

  it('should propagate errors through middleware', async () => {
    const caughtErrors: string[] = [];

    const middlewares = [
      {
        name: 'error-handler',
        fn: async (_ctx: JobContext, next: () => Promise<unknown>) => {
          try {
            return await next();
          } catch (error) {
            caughtErrors.push((error as Error).message);
            throw error;
          }
        },
      },
    ];

    const handler = async () => {
      throw new Error('handler failed');
    };

    const composed = composeExecution(middlewares, handler);
    await expect(composed(createTestContext())).rejects.toThrow('handler failed');
    expect(caughtErrors).toEqual(['handler failed']);
  });

  it('should reject when next() is called concurrently before the first call settles', async () => {
    const middlewares = [
      {
        name: 'bad',
        fn: async (_ctx: JobContext, next: () => Promise<unknown>) => {
          // Fires next() twice without awaiting the first — this would run
          // the remaining chain (and the handler) concurrently against the
          // same shared context, which is the actual bug class the guard
          // exists to catch.
          const first = next();
          const second = next();
          await first;
          return second;
        },
      },
    ];

    const handler = async () => 'ok';

    const composed = composeExecution(middlewares, handler);
    await expect(composed(createTestContext())).rejects.toThrow(
      'next() called multiple times',
    );
  });

  it('should allow next() to be called again sequentially after the previous call settles', async () => {
    // This is the pattern the built-in retry middleware (middleware/retry.ts)
    // relies on: catch a failure from next() and call next() again to re-run
    // the downstream chain. It must not be confused with the concurrent
    // reentrancy case above.
    let calls = 0;
    const middlewares = [
      {
        name: 'retry-once',
        fn: async (_ctx: JobContext, next: () => Promise<unknown>) => {
          try {
            return await next();
          } catch {
            return next();
          }
        },
      },
    ];

    const handler = async () => {
      calls++;
      if (calls === 1) throw new Error('first attempt fails');
      return 'ok-on-retry';
    };

    const composed = composeExecution(middlewares, handler);
    const result = await composed(createTestContext());

    expect(result).toBe('ok-on-retry');
    expect(calls).toBe(2);
  });

  it('should clear downstream guards so a synchronous middleware throw can be retried', async () => {
    let attempts = 0;
    const throwingMiddleware = ((
      _ctx: JobContext,
      next: () => Promise<unknown>,
    ) => {
      attempts++;
      if (attempts === 1) {
        throw new Error('synchronous middleware failure');
      }
      return next();
    }) as ExecutionMiddleware;
    const middlewares = [
      {
        name: 'retry-once',
        fn: async (_ctx: JobContext, next: () => Promise<unknown>) => {
          try {
            return await next();
          } catch {
            return next();
          }
        },
      },
      { name: 'throws-once', fn: throwingMiddleware },
    ];

    const composed = composeExecution(middlewares, async () => 'recovered');

    await expect(composed(createTestContext())).resolves.toBe('recovered');
    expect(attempts).toBe(2);
  });

  it('should convert a direct synchronous handler throw into a rejection', async () => {
    const handler = (() => {
      throw new Error('synchronous handler failure');
    }) as (ctx: JobContext) => Promise<unknown>;
    const composed = composeExecution([], handler);

    let result: Promise<unknown> | undefined;
    expect(() => {
      result = composed(createTestContext());
    }).not.toThrow();
    await expect(result).rejects.toThrow('synchronous handler failure');
  });

  it('should reject a sequential next() call after the previous call already resolved successfully (async middleware)', async () => {
    // A chain position represents exactly one downstream invocation. Once
    // that invocation has *succeeded*, there is nothing left to legitimately
    // retry (unlike the rejection case below), so a second sequential call
    // must be rejected rather than silently re-running the handler.
    let handlerCalls = 0;
    const handler = async () => {
      handlerCalls++;
      return 'ok';
    };

    const middlewares = [
      {
        name: 'double-success-call',
        fn: async (_ctx: JobContext, next: () => Promise<unknown>) => {
          const first = await next();
          // The prior call already resolved successfully; calling next()
          // again for this same position must reject, not re-run the
          // handler a second time.
          await expect(next()).rejects.toThrow(
            'next() called again after it already resolved successfully',
          );
          return first;
        },
      },
    ];

    const composed = composeExecution(middlewares, handler);
    await expect(composed(createTestContext())).resolves.toBe('ok');
    expect(handlerCalls).toBe(1);
  });

  it('should reject a sequential next() call after the previous call already resolved successfully (sync-returning middleware)', async () => {
    // Same guarantee, but exercised through a middleware written as a plain
    // (non-async) function that returns a promise chain synchronously,
    // rather than using async/await internally.
    let handlerCalls = 0;
    const handler = async () => {
      handlerCalls++;
      return 'sync-ok';
    };

    const doubleCallMiddleware = ((
      _ctx: JobContext,
      next: () => Promise<unknown>,
    ) =>
      next().then((first) =>
        next().then(
          () => {
            throw new Error('expected the second next() call to reject');
          },
          (error: unknown) => {
            expect((error as Error).message).toContain(
              'already resolved successfully',
            );
            return first;
          },
        ),
      )) as ExecutionMiddleware;

    const composed = composeExecution(
      [{ name: 'sync-double-call', fn: doubleCallMiddleware }],
      handler,
    );

    await expect(composed(createTestContext())).resolves.toBe('sync-ok');
    expect(handlerCalls).toBe(1);
  });

  it('should allow a retry after rejection but never after success, across mixed sync/async attempts', async () => {
    // Explicit rejection-then-retry coverage distinct from the
    // success-then-reject case above: the same position may be re-invoked
    // any number of times as long as every prior call ended in a rejection,
    // but the moment one succeeds, the position is consumed.
    let attempts = 0;
    const handler = (() => {
      attempts++;
      if (attempts === 1) {
        // Synchronous throw on the first attempt.
        throw new Error('sync failure on attempt 1');
      }
      if (attempts === 2) {
        // Asynchronous rejection on the second attempt.
        return Promise.reject(new Error('async failure on attempt 2'));
      }
      return Promise.resolve('third-time-lucky');
    }) as (ctx: JobContext) => Promise<unknown>;

    const middlewares = [
      {
        name: 'retry-until-success-then-stop',
        fn: async (_ctx: JobContext, next: () => Promise<unknown>) => {
          let result: unknown;
          for (;;) {
            try {
              result = await next();
              break;
            } catch {
              continue;
            }
          }
          // The handler has now succeeded; a further retry must reject.
          await expect(next()).rejects.toThrow(
            'already resolved successfully',
          );
          return result;
        },
      },
    ];

    const composed = composeExecution(middlewares, handler);
    await expect(composed(createTestContext())).resolves.toBe(
      'third-time-lucky',
    );
    expect(attempts).toBe(3);
  });


  it('should actually retry the downstream chain when the shipped retry() middleware is composed via a real MiddlewareChain', async () => {
    // Regression test: retry() (middleware/retry.ts) is only ever exercised
    // in isolation elsewhere (called directly with a raw `next` closure),
    // which does not catch bugs in its interaction with the real dispatch
    // guard above. Wire it through the actual chain/compose machinery.
    const chain = new MiddlewareChain<ExecutionMiddleware>();
    chain.add('retry', retry({ maxRetries: 2, baseDelayMs: 1, jitter: false }));

    let attempts = 0;
    const handler = async () => {
      attempts++;
      if (attempts < 3) throw new Error(`fails on attempt ${attempts}`);
      return 'succeeded';
    };

    const composed = composeExecution(chain.entries(), handler);
    const result = await composed(createTestContext());

    expect(result).toBe('succeeded');
    expect(attempts).toBe(3);
  });

  it('should propagate the final error once retry() exhausts all attempts through a real chain', async () => {
    const chain = new MiddlewareChain<ExecutionMiddleware>();
    chain.add('retry', retry({ maxRetries: 2, baseDelayMs: 1, jitter: false }));

    let attempts = 0;
    const handler = async () => {
      attempts++;
      throw new Error('always fails');
    };

    const composed = composeExecution(chain.entries(), handler);
    await expect(composed(createTestContext())).rejects.toThrow('always fails');
    expect(attempts).toBe(3); // 1 initial + 2 retries
  });

  it('should work with no middleware', async () => {
    const handler = async () => 'direct';
    const composed = composeExecution([], handler);
    const result = await composed(createTestContext());
    expect(result).toBe('direct');
  });
});

describe('composeEnqueue', () => {
  function createTestJob(): Job {
    return {
      specversion: '1.0',
      id: 'test-id',
      type: 'email.send',
      queue: 'default',
      args: [{ to: 'user@example.com' }],
    };
  }

  it('should pass job through middleware chain', async () => {
    const middlewares = [
      {
        name: 'trace',
        fn: async (job: Job, next: (j: Job) => Promise<Job | null>) => {
          job.meta = { ...job.meta, trace_id: 'abc' };
          return next(job);
        },
      },
    ];

    const finalEnqueue = async (job: Job) => job;

    const composed = composeEnqueue(middlewares, finalEnqueue);
    const result = await composed(createTestJob());

    expect(result).not.toBeNull();
    expect(result!.meta?.trace_id).toBe('abc');
  });

  it('should allow middleware to drop a job', async () => {
    const middlewares = [
      {
        name: 'dedup',
        fn: async (_job: Job, _next: (j: Job) => Promise<Job | null>) => {
          return null; // Drop
        },
      },
    ];

    const finalEnqueue = async (job: Job) => job;
    const composed = composeEnqueue(middlewares, finalEnqueue);
    const result = await composed(createTestJob());

    expect(result).toBeNull();
  });

  it('should compose multiple middleware in order', async () => {
    const order: string[] = [];

    const middlewares = [
      {
        name: 'first',
        fn: async (job: Job, next: (j: Job) => Promise<Job | null>) => {
          order.push('first');
          return next(job);
        },
      },
      {
        name: 'second',
        fn: async (job: Job, next: (j: Job) => Promise<Job | null>) => {
          order.push('second');
          return next(job);
        },
      },
    ];

    const finalEnqueue = async (job: Job) => {
      order.push('enqueue');
      return job;
    };

    const composed = composeEnqueue(middlewares, finalEnqueue);
    await composed(createTestJob());

    expect(order).toEqual(['first', 'second', 'enqueue']);
  });

  it('should clear downstream guards so a synchronous enqueue throw can be retried and dropped', async () => {
    let attempts = 0;
    const finalEnqueue = ((job: Job) => {
      attempts++;
      if (attempts === 1) {
        throw new Error('synchronous enqueue failure');
      }
      return Promise.resolve(null);
    }) as (job: Job) => Promise<Job | null>;
    const middlewares = [
      {
        name: 'retry-once',
        fn: async (job: Job, next: (j: Job) => Promise<Job | null>) => {
          try {
            return await next(job);
          } catch {
            return next(job);
          }
        },
      },
    ];
    const composed = composeEnqueue(middlewares, finalEnqueue);

    await expect(composed(createTestJob())).resolves.toBeNull();
    expect(attempts).toBe(2);
  });

  it('should convert a direct synchronous final enqueue throw into a rejection', async () => {
    const finalEnqueue = (() => {
      throw new Error('synchronous final enqueue failure');
    }) as (job: Job) => Promise<Job | null>;
    const composed = composeEnqueue([], finalEnqueue);

    let result: Promise<Job | null> | undefined;
    expect(() => {
      result = composed(createTestJob());
    }).not.toThrow();
    await expect(result).rejects.toThrow('synchronous final enqueue failure');
  });

  it('should still reject concurrent enqueue next() calls', async () => {
    const middlewares = [
      {
        name: 'bad',
        fn: async (job: Job, next: (j: Job) => Promise<Job | null>) => {
          const first = next(job);
          const second = next(job);
          await first;
          return second;
        },
      },
    ];
    const composed = composeEnqueue(middlewares, async (job) => job);

    await expect(composed(createTestJob())).rejects.toThrow(
      'next() called multiple times',
    );
  });

  it('should reject a sequential enqueue next() call after the previous call already resolved successfully', async () => {
    let enqueueCalls = 0;
    const finalEnqueue = async (job: Job) => {
      enqueueCalls++;
      return job;
    };

    const middlewares = [
      {
        name: 'double-success-call',
        fn: async (job: Job, next: (j: Job) => Promise<Job | null>) => {
          const first = await next(job);
          await expect(next(job)).rejects.toThrow(
            'next() called again after it already resolved successfully',
          );
          return first;
        },
      },
    ];

    const composed = composeEnqueue(middlewares, finalEnqueue);
    const result = await composed(createTestJob());

    expect(result).not.toBeNull();
    expect(enqueueCalls).toBe(1);
  });

  it('should allow an enqueue retry after rejection but never after success', async () => {
    let attempts = 0;
    const finalEnqueue = ((job: Job) => {
      attempts++;
      if (attempts === 1) {
        // Synchronous throw on the first attempt.
        throw new Error('sync enqueue failure on attempt 1');
      }
      return Promise.resolve(job);
    }) as (job: Job) => Promise<Job | null>;

    const middlewares = [
      {
        name: 'retry-until-success-then-stop',
        fn: async (job: Job, next: (j: Job) => Promise<Job | null>) => {
          let result: Job | null;
          try {
            result = await next(job);
          } catch {
            result = await next(job);
          }
          await expect(next(job)).rejects.toThrow(
            'already resolved successfully',
          );
          return result;
        },
      },
    ];

    const composed = composeEnqueue(middlewares, finalEnqueue);
    const result = await composed(createTestJob());

    expect(result).not.toBeNull();
    expect(attempts).toBe(2);
  });
});

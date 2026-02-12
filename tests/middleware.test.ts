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

  it('should reject when next() is called multiple times', async () => {
    const middlewares = [
      {
        name: 'bad',
        fn: async (_ctx: JobContext, next: () => Promise<unknown>) => {
          await next();
          return next(); // Second call should throw
        },
      },
    ];

    const handler = async () => 'ok';

    const composed = composeExecution(middlewares, handler);
    await expect(composed(createTestContext())).rejects.toThrow(
      'next() called multiple times',
    );
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
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OJSWorker } from '../src/worker.js';
import {
  OJSConnectionError,
  OJSError,
  OJSServerError,
  OJSNotFoundError,
  OJSValidationError,
} from '../src/errors.js';
import type { Transport, TransportRequestOptions, TransportResponse } from '../src/transport/types.js';
import type { Job } from '../src/job.js';

function createMockTransport() {
  const requests: TransportRequestOptions[] = [];
  let fetchHandler: ((options: TransportRequestOptions) => TransportResponse) | null = null;

  const transport: Transport = {
    async request<T>(options: TransportRequestOptions): Promise<TransportResponse<T>> {
      requests.push(options);
      if (fetchHandler) {
        return fetchHandler(options) as TransportResponse<T>;
      }
      // Default responses
      if (options.path === '/workers/fetch') {
        return { status: 200, headers: {}, body: { jobs: [] } as T };
      }
      if (options.path === '/workers/ack') {
        return { status: 200, headers: {}, body: { acknowledged: true } as T };
      }
      if (options.path === '/workers/nack') {
        return { status: 200, headers: {}, body: {} as T };
      }
      if (options.path === '/workers/heartbeat') {
        return { status: 200, headers: {}, body: { state: 'running' } as T };
      }
      return { status: 200, headers: {}, body: {} as T };
    },
  };

  return {
    transport,
    requests,
    setFetchHandler(handler: (options: TransportRequestOptions) => TransportResponse) {
      fetchHandler = handler;
    },
  };
}

function createTestJob(overrides: Partial<Job> = {}): Job {
  return {
    specversion: '1.0',
    id: `job_${Math.random().toString(36).slice(2)}`,
    type: 'test.job',
    queue: 'default',
    args: [{ key: 'value' }],
    state: 'active',
    attempt: 1,
    ...overrides,
  };
}

describe('OJSWorker', () => {
  let mock: ReturnType<typeof createMockTransport>;
  let worker: OJSWorker;

  beforeEach(() => {
    mock = createMockTransport();
    worker = new OJSWorker({
      url: 'http://localhost:8080',
      queues: ['default'],
      concurrency: 5,
      pollInterval: 50,
      heartbeatInterval: 60000, // Don't interfere with tests
      transport: mock.transport,
    });
  });

  afterEach(async () => {
    if (worker.currentState !== 'terminated') {
      await worker.stop();
    }
  });

  describe('register', () => {
    it('should register a handler', () => {
      worker.register('test.job', async () => 'done');
      // No public way to check, but it shouldn't throw
    });

    it('should allow chaining', () => {
      const result = worker
        .register('test.a', async () => {})
        .register('test.b', async () => {});
      expect(result).toBe(worker);
    });
  });

  describe('use (middleware)', () => {
    it('should add middleware with auto-generated name', () => {
      worker.use(async (_ctx, next) => next());
      expect(worker.middleware.length).toBe(1);
    });

    it('should add named middleware', () => {
      worker.use('logging', async (_ctx, next) => next());
      expect(worker.middleware.has('logging')).toBe(true);
    });
  });

  describe('lifecycle', () => {
    it('should start in terminated state', () => {
      expect(worker.currentState).toBe('terminated');
    });

    it('should transition to running on start', async () => {
      await worker.start();
      expect(worker.currentState).toBe('running');
    });

    it('should transition to terminated on stop', async () => {
      await worker.start();
      await worker.stop();
      expect(worker.currentState).toBe('terminated');
    });

    it('should throw if started twice', async () => {
      await worker.start();
      await expect(worker.start()).rejects.toThrow('already running');
    });
  });

  describe('job processing', () => {
    it('should fetch and process a job', async () => {
      vi.useFakeTimers();
      try {
        const testJob = createTestJob({ type: 'email.send' });
        let fetchCallCount = 0;

        mock.setFetchHandler((options) => {
          if (options.path === '/workers/fetch') {
            fetchCallCount++;
            if (fetchCallCount === 1) {
              return { status: 200, headers: {}, body: { jobs: [testJob] } };
            }
            return { status: 200, headers: {}, body: { jobs: [] } };
          }
          if (options.path === '/workers/ack') {
            return { status: 200, headers: {}, body: { acknowledged: true } };
          }
          if (options.path === '/workers/heartbeat') {
            return { status: 200, headers: {}, body: { state: 'running' } };
          }
          return { status: 200, headers: {}, body: {} };
        });

        const processed = vi.fn();
        worker.register('email.send', async (ctx) => {
          processed(ctx.job.type);
          return { sent: true };
        });

        await worker.start();

        // Wait for the job to be processed
        await vi.advanceTimersByTimeAsync(200);

        await worker.stop();

        expect(processed).toHaveBeenCalledWith('email.send');

        // Should have sent an ACK
        const ackRequest = mock.requests.find((r) => r.path === '/workers/ack');
        expect(ackRequest).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should nack a job when handler throws', async () => {
      vi.useFakeTimers();
      try {
        const testJob = createTestJob({ type: 'failing.job' });
        let fetchCallCount = 0;

        mock.setFetchHandler((options) => {
          if (options.path === '/workers/fetch') {
            fetchCallCount++;
            if (fetchCallCount === 1) {
              return { status: 200, headers: {}, body: { jobs: [testJob] } };
            }
            return { status: 200, headers: {}, body: { jobs: [] } };
          }
          return { status: 200, headers: {}, body: {} };
        });

        worker.register('failing.job', async () => {
          throw new Error('Something went wrong');
        });

        await worker.start();
        await vi.advanceTimersByTimeAsync(200);
        await worker.stop();

        const nackRequest = mock.requests.find((r) => r.path === '/workers/nack');
        expect(nackRequest).toBeDefined();
        const body = nackRequest!.body as { error: { message: string } };
        expect(body.error.message).toBe('Something went wrong');
      } finally {
        vi.useRealTimers();
      }
    });

    it('should nack when no handler is registered', async () => {
      vi.useFakeTimers();
      try {
        const testJob = createTestJob({ type: 'unknown.job' });
        let fetchCallCount = 0;

        mock.setFetchHandler((options) => {
          if (options.path === '/workers/fetch') {
            fetchCallCount++;
            if (fetchCallCount === 1) {
              return { status: 200, headers: {}, body: { jobs: [testJob] } };
            }
            return { status: 200, headers: {}, body: { jobs: [] } };
          }
          return { status: 200, headers: {}, body: {} };
        });

        await worker.start();
        await vi.advanceTimersByTimeAsync(200);
        await worker.stop();

        const nackRequest = mock.requests.find((r) => r.path === '/workers/nack');
        expect(nackRequest).toBeDefined();
        const body = nackRequest!.body as { error: { code: string } };
        expect(body.error.code).toBe('handler_not_found');
      } finally {
        vi.useRealTimers();
      }
    });

    it('should invoke the durable handler and ack normally on a true first run (404 checkpoint)', async () => {
      vi.useFakeTimers();
      try {
        const testJob = createTestJob({ type: 'durable.first-run' });
        let fetchCallCount = 0;

        mock.setFetchHandler((options) => {
          if (options.path === '/workers/fetch') {
            fetchCallCount++;
            if (fetchCallCount === 1) {
              return { status: 200, headers: {}, body: { jobs: [testJob] } };
            }
            return { status: 200, headers: {}, body: { jobs: [] } };
          }
          if (options.method === 'GET' && /^\/jobs\/.+\/checkpoint$/.test(options.path)) {
            throw new OJSNotFoundError('checkpoint', testJob.id);
          }
          if (options.method === 'GET' && /^\/checkpoints\/.+\/resume$/.test(options.path)) {
            throw new OJSNotFoundError('checkpoint', testJob.id);
          }
          return { status: 200, headers: {}, body: {} };
        });

        const handlerCalled = vi.fn();
        worker.registerDurable('durable.first-run', async (ctx, dc) => {
          handlerCalled(ctx.job.type, dc.isReplaying());
          return { done: true };
        });

        await worker.start();
        await vi.advanceTimersByTimeAsync(200);
        await worker.stop();

        expect(handlerCalled).toHaveBeenCalledWith('durable.first-run', false);

        const ackRequest = mock.requests.find((r) => r.path === '/workers/ack');
        expect(ackRequest).toBeDefined();
        const nackRequest = mock.requests.find((r) => r.path === '/workers/nack');
        expect(nackRequest).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should nack without invoking the durable handler when checkpoint loading fails with a connection error', async () => {
      vi.useFakeTimers();
      try {
        const testJob = createTestJob({ type: 'durable.conn-fail' });
        let fetchCallCount = 0;

        mock.setFetchHandler((options) => {
          if (options.path === '/workers/fetch') {
            fetchCallCount++;
            if (fetchCallCount === 1) {
              return { status: 200, headers: {}, body: { jobs: [testJob] } };
            }
            return { status: 200, headers: {}, body: { jobs: [] } };
          }
          if (options.method === 'GET' && /^\/jobs\/.+\/checkpoint$/.test(options.path)) {
            throw new OJSConnectionError('connection refused');
          }
          return { status: 200, headers: {}, body: {} };
        });

        const handlerCalled = vi.fn();
        const sideEffectCalled = vi.fn();
        worker.registerDurable('durable.conn-fail', async (ctx, dc) => {
          handlerCalled();
          await dc.sideEffect('must-not-run', async () => sideEffectCalled());
          return {};
        });

        await worker.start();
        await vi.advanceTimersByTimeAsync(200);
        await worker.stop();

        // The handler (and any of its side effects) must never run.
        expect(handlerCalled).not.toHaveBeenCalled();
        expect(sideEffectCalled).not.toHaveBeenCalled();

        const ackRequest = mock.requests.find((r) => r.path === '/workers/ack');
        expect(ackRequest).toBeUndefined();

        const nackRequest = mock.requests.find((r) => r.path === '/workers/nack');
        expect(nackRequest).toBeDefined();
        const body = nackRequest!.body as { error: { code: string; message: string; retryable: boolean } };
        expect(body.error.code).toBe('handler_error');
        expect(body.error.message).toContain(testJob.id);
        expect(body.error.message).toContain('checkpoint');
        expect(body.error.retryable).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should nack as non-retryable without invoking the durable handler on checkpoint auth failure', async () => {
      vi.useFakeTimers();
      try {
        const testJob = createTestJob({ type: 'durable.auth-fail' });
        let fetchCallCount = 0;

        mock.setFetchHandler((options) => {
          if (options.path === '/workers/fetch') {
            fetchCallCount++;
            if (fetchCallCount === 1) {
              return { status: 200, headers: {}, body: { jobs: [testJob] } };
            }
            return { status: 200, headers: {}, body: { jobs: [] } };
          }
          if (options.method === 'GET' && /^\/jobs\/.+\/checkpoint$/.test(options.path)) {
            throw new OJSError('Unauthorized', 'unauthorized', { retryable: false });
          }
          return { status: 200, headers: {}, body: {} };
        });

        const handlerCalled = vi.fn();
        const sideEffectCalled = vi.fn();
        worker.registerDurable('durable.auth-fail', async (ctx, dc) => {
          handlerCalled();
          await dc.sideEffect('must-not-run', async () => sideEffectCalled());
          return {};
        });

        await worker.start();
        await vi.advanceTimersByTimeAsync(200);
        await worker.stop();

        expect(handlerCalled).not.toHaveBeenCalled();
        expect(sideEffectCalled).not.toHaveBeenCalled();
        expect(mock.requests.find((r) => r.path === '/workers/ack')).toBeUndefined();

        const nackRequest = mock.requests.find((r) => r.path === '/workers/nack');
        expect(nackRequest).toBeDefined();
        const body = nackRequest!.body as {
          error: { code: string; message: string; retryable: boolean };
        };
        expect(body.error.code).toBe('handler_error');
        expect(body.error.message).toContain(testJob.id);
        expect(body.error.retryable).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should nack without invoking the durable handler when checkpoint loading fails with an HTTP 500', async () => {
      vi.useFakeTimers();
      try {
        const testJob = createTestJob({ type: 'durable.server-error' });
        let fetchCallCount = 0;

        mock.setFetchHandler((options) => {
          if (options.path === '/workers/fetch') {
            fetchCallCount++;
            if (fetchCallCount === 1) {
              return { status: 200, headers: {}, body: { jobs: [testJob] } };
            }
            return { status: 200, headers: {}, body: { jobs: [] } };
          }
          if (options.method === 'GET' && /^\/jobs\/.+\/checkpoint$/.test(options.path)) {
            throw new OJSServerError('Internal Server Error', 500);
          }
          return { status: 200, headers: {}, body: {} };
        });

        const handlerCalled = vi.fn();
        const sideEffectCalled = vi.fn();
        worker.registerDurable('durable.server-error', async (ctx, dc) => {
          handlerCalled();
          await dc.sideEffect('must-not-run', async () => sideEffectCalled());
          return {};
        });

        await worker.start();
        await vi.advanceTimersByTimeAsync(200);
        await worker.stop();

        expect(handlerCalled).not.toHaveBeenCalled();
        expect(sideEffectCalled).not.toHaveBeenCalled();

        const ackRequest = mock.requests.find((r) => r.path === '/workers/ack');
        expect(ackRequest).toBeUndefined();

        const nackRequest = mock.requests.find((r) => r.path === '/workers/nack');
        expect(nackRequest).toBeDefined();
        const body = nackRequest!.body as {
          error: { code: string; message: string; retryable: boolean };
        };
        expect(body.error.code).toBe('handler_error');
        expect(body.error.message).toContain(testJob.id);
        expect(body.error.retryable).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should nack without invoking the durable handler when canonical state is foreign', async () => {
      vi.useFakeTimers();
      try {
        const testJob = createTestJob({ type: 'durable.decode-fail' });
        let fetchCallCount = 0;

        mock.setFetchHandler((options) => {
          if (options.path === '/workers/fetch') {
            fetchCallCount++;
            if (fetchCallCount === 1) {
              return { status: 200, headers: {}, body: { jobs: [testJob] } };
            }
            return { status: 200, headers: {}, body: { jobs: [] } };
          }
          if (options.method === 'GET' && /^\/jobs\/.+\/checkpoint$/.test(options.path)) {
            return {
              status: 200,
              headers: {},
              body: {
                job_id: testJob.id,
                state: { foreign: true },
                sequence: 1,
                created_at: null,
              },
            };
          }
          return { status: 200, headers: {}, body: {} };
        });

        const handlerCalled = vi.fn();
        const sideEffectCalled = vi.fn();
        worker.registerDurable('durable.decode-fail', async (ctx, dc) => {
          handlerCalled();
          await dc.sideEffect('must-not-run', async () => sideEffectCalled());
          return {};
        });

        await worker.start();
        await vi.advanceTimersByTimeAsync(200);
        await worker.stop();

        expect(handlerCalled).not.toHaveBeenCalled();
        expect(sideEffectCalled).not.toHaveBeenCalled();

        const nackRequest = mock.requests.find((r) => r.path === '/workers/nack');
        expect(nackRequest).toBeDefined();
        const body = nackRequest!.body as {
          error: { code: string; message: string; retryable: boolean };
        };
        expect(body.error.code).toBe('handler_error');
        expect(body.error.message).toContain('missing _ojsReplayLog');
        expect(body.error.retryable).toBe(true);

        const ackRequest = mock.requests.find((r) => r.path === '/workers/ack');
        expect(ackRequest).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should not produce an unhandled rejection if nack() itself fails for an unregistered handler', async () => {
      // Regression test: processJob() previously left the "no handler
      // registered" nack() call as a floating promise (only `.finally()`,
      // no `.catch()`), so if nack() itself exhausted its own retries and
      // rejected, that rejection would surface as an unhandled promise
      // rejection rather than being safely logged.
      vi.useFakeTimers();
      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown): void => {
        unhandledRejections.push(reason);
      };
      process.on('unhandledRejection', onUnhandledRejection);

      try {
        const testJob = createTestJob({ type: 'unknown.job' });
        let fetchCallCount = 0;

        mock.setFetchHandler((options) => {
          if (options.path === '/workers/fetch') {
            fetchCallCount++;
            if (fetchCallCount === 1) {
              return { status: 200, headers: {}, body: { jobs: [testJob] } };
            }
            return { status: 200, headers: {}, body: { jobs: [] } };
          }
          if (options.path === '/workers/nack') {
            throw new Error('server unavailable');
          }
          return { status: 200, headers: {}, body: {} };
        });

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await worker.start();
        // Let the poll fetch the job, all 3 nack retries fail (with their
        // own backoff delays), and the resulting rejection propagate.
        await vi.advanceTimersByTimeAsync(5000);
        await worker.stop();

        expect(unhandledRejections).toHaveLength(0);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('failed to nack job'),
          expect.any(String),
        );
        warnSpy.mockRestore();
      } finally {
        process.removeListener('unhandledRejection', onUnhandledRejection);
        vi.useRealTimers();
      }
    });

    it('should not nack a successfully completed job even if ack() itself exhausts its retries and fails (no unhandled rejection)', async () => {
      // Regression test: processJob() previously chained
      // `execute(ctx).then(onSuccess).catch(onFailure)`. Because ack() was
      // awaited *inside* onSuccess, an ack() failure (after exhausting its
      // own retries) threw inside the `.then()` callback — which made the
      // whole chain reject and fall into the following `.catch()`,
      // incorrectly nacking a job whose handler had already succeeded.
      vi.useFakeTimers();
      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown): void => {
        unhandledRejections.push(reason);
      };
      process.on('unhandledRejection', onUnhandledRejection);

      try {
        const testJob = createTestJob({ type: 'ack-fails.test' });
        let fetchCallCount = 0;

        mock.setFetchHandler((options) => {
          if (options.path === '/workers/fetch') {
            fetchCallCount++;
            if (fetchCallCount === 1) {
              return { status: 200, headers: {}, body: { jobs: [testJob] } };
            }
            return { status: 200, headers: {}, body: { jobs: [] } };
          }
          if (options.path === '/workers/ack') {
            throw new Error('server unavailable');
          }
          return { status: 200, headers: {}, body: {} };
        });

        worker.register('ack-fails.test', async () => ({ ok: true }));

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await worker.start();
        // Let the poll fetch the job, the handler run to completion, and
        // all 3 ack retries fail (with their own backoff delays).
        await vi.advanceTimersByTimeAsync(5000);
        await worker.stop();

        expect(unhandledRejections).toHaveLength(0);

        const ackRequests = mock.requests.filter((r) => r.path === '/workers/ack');
        const nackRequests = mock.requests.filter((r) => r.path === '/workers/nack');
        // All 3 ack attempts (OJSWorker.ACK_NACK_MAX_RETRIES), and — this is
        // the critical assertion — the successfully-handled job must NEVER
        // be nacked just because its ack delivery failed.
        expect(ackRequests).toHaveLength(3);
        expect(nackRequests).toHaveLength(0);

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('failed to ack job'),
          expect.any(String),
        );

        // Cleanup/shutdown must still complete rather than hang: stop()
        // above already resolved, and the worker no longer considers the
        // job active.
        expect(worker.activeJobCount).toBe(0);
        expect(worker.currentState).toBe('terminated');

        warnSpy.mockRestore();
      } finally {
        process.removeListener('unhandledRejection', onUnhandledRejection);
        vi.useRealTimers();
      }
    });

    it('should not ack a job when nack() itself exhausts its retries and fails after a handler error (no unhandled rejection)', async () => {
      // Regression test: processJob()'s failure branch previously awaited
      // `this.nack(...)` with no surrounding try/catch. Since the whole
      // `execute(ctx).then().catch().finally()` chain is fire-and-forget
      // (processJob() itself is not awaited by its caller), a nack()
      // failure propagated as an unhandled promise rejection instead of
      // being safely logged.
      vi.useFakeTimers();
      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown): void => {
        unhandledRejections.push(reason);
      };
      process.on('unhandledRejection', onUnhandledRejection);

      try {
        const testJob = createTestJob({ type: 'nack-fails.test' });
        let fetchCallCount = 0;

        mock.setFetchHandler((options) => {
          if (options.path === '/workers/fetch') {
            fetchCallCount++;
            if (fetchCallCount === 1) {
              return { status: 200, headers: {}, body: { jobs: [testJob] } };
            }
            return { status: 200, headers: {}, body: { jobs: [] } };
          }
          if (options.path === '/workers/nack') {
            throw new Error('server unavailable');
          }
          return { status: 200, headers: {}, body: {} };
        });

        worker.register('nack-fails.test', async () => {
          throw new Error('handler blew up');
        });

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await worker.start();
        await vi.advanceTimersByTimeAsync(5000);
        await worker.stop();

        expect(unhandledRejections).toHaveLength(0);

        const ackRequests = mock.requests.filter((r) => r.path === '/workers/ack');
        const nackRequests = mock.requests.filter((r) => r.path === '/workers/nack');
        // The failed job must NEVER be ack'd just because its nack
        // delivery failed; all 3 nack attempts should still have been made.
        expect(ackRequests).toHaveLength(0);
        expect(nackRequests).toHaveLength(3);

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('failed to nack job'),
          expect.any(String),
        );

        expect(worker.activeJobCount).toBe(0);
        expect(worker.currentState).toBe('terminated');

        warnSpy.mockRestore();
      } finally {
        process.removeListener('unhandledRejection', onUnhandledRejection);
        vi.useRealTimers();
      }
    });

    it('should complete graceful shutdown promptly once ack() retries are exhausted, without waiting out the full grace period', async () => {
      // Verifies concurrency bookkeeping/cleanup: finishJob() must still
      // release the job's concurrency slot and unblock a pending
      // stop()-in-progress once the ack retry loop finally gives up, so
      // shutdown does not idle out the full (much longer) grace-period
      // timeout for a job that has, in fact, already finished executing.
      vi.useFakeTimers();
      let shutdownWorker: OJSWorker | undefined;
      try {
        const testJob = createTestJob({ type: 'shutdown-ack-fails.test' });
        let fetchCallCount = 0;

        mock.setFetchHandler((options) => {
          if (options.path === '/workers/fetch') {
            fetchCallCount++;
            if (fetchCallCount === 1) {
              return { status: 200, headers: {}, body: { jobs: [testJob] } };
            }
            return { status: 200, headers: {}, body: { jobs: [] } };
          }
          if (options.path === '/workers/ack') {
            throw new Error('server unavailable');
          }
          return { status: 200, headers: {}, body: {} };
        });

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        shutdownWorker = new OJSWorker({
          url: 'http://localhost:8080',
          queues: ['default'],
          pollInterval: 50,
          heartbeatInterval: 60000,
          shutdownTimeout: 20000, // much longer than the ack-retry backoff below
          transport: mock.transport,
        });
        shutdownWorker.register('shutdown-ack-fails.test', async () => ({ ok: true }));

        await shutdownWorker.start();
        await vi.advanceTimersByTimeAsync(60); // fetch + dispatch the job to the handler
        expect(shutdownWorker.activeJobCount).toBe(1);

        const stopPromise = shutdownWorker.stop();
        // 3 ack attempts with ~1500ms of combined backoff (500ms + 1000ms)
        // should resolve well before the 20s grace period would otherwise
        // force stop() to wait it out.
        await vi.advanceTimersByTimeAsync(2000);
        await stopPromise;

        expect(shutdownWorker.currentState).toBe('terminated');
        expect(mock.requests.filter((r) => r.path === '/workers/ack')).toHaveLength(3);

        warnSpy.mockRestore();
      } finally {
        if (shutdownWorker && shutdownWorker.currentState !== 'terminated') {
          await shutdownWorker.stop();
        }
        vi.useRealTimers();
      }
    });
  });

  describe('handler result validation (Finding: worker handler result validation)', () => {
    /**
     * Runs a single job through a real `OJSWorker` with the given handler
     * and returns the resulting ack/nack/event counts, so each case below
     * only needs to assert the outcome, not repeat the fetch/advance/stop
     * choreography every other test in this file already establishes.
     */
    async function runJobWithHandler(
      jobType: string,
      handler: () => unknown,
    ): Promise<{
      ackRequests: TransportRequestOptions[];
      nackRequests: TransportRequestOptions[];
      completedEvents: unknown[];
      failedEvents: unknown[];
    }> {
      const testJob = createTestJob({ type: jobType });
      let fetchCallCount = 0;
      mock.setFetchHandler((options) => {
        if (options.path === '/workers/fetch') {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return { status: 200, headers: {}, body: { jobs: [testJob] } };
          }
          return { status: 200, headers: {}, body: { jobs: [] } };
        }
        if (options.path === '/workers/ack') {
          return { status: 200, headers: {}, body: { acknowledged: true } };
        }
        if (options.path === '/workers/nack') {
          return { status: 200, headers: {}, body: {} };
        }
        return { status: 200, headers: {}, body: {} };
      });

      const completedEvents: unknown[] = [];
      const failedEvents: unknown[] = [];
      worker.events.on('job.completed', (event) => completedEvents.push(event));
      worker.events.on('job.failed', (event) => failedEvents.push(event));
      worker.register(jobType, async () => handler());

      await worker.start();
      await vi.advanceTimersByTimeAsync(200);
      await worker.stop();

      return {
        ackRequests: mock.requests.filter((r) => r.path === '/workers/ack'),
        nackRequests: mock.requests.filter((r) => r.path === '/workers/nack'),
        completedEvents,
        failedEvents,
      };
    }

    it('nacks exactly once with the non-retryable invalid_result code for a circular-reference result, never acking', async () => {
      vi.useFakeTimers();
      try {
        const cyclic: Record<string, unknown> = { a: 1 };
        cyclic.self = cyclic;

        const { ackRequests, nackRequests, completedEvents, failedEvents } =
          await runJobWithHandler('result.circular', () => cyclic);

        expect(ackRequests).toHaveLength(0);
        expect(nackRequests).toHaveLength(1);
        const body = nackRequests[0]!.body as { error: { code: string; message: string; retryable: boolean } };
        expect(body.error.code).toBe('invalid_result');
        expect(body.error.retryable).toBe(false);
        expect(body.error.message).toMatch(/circular/i);

        expect(completedEvents).toHaveLength(0);
        expect(failedEvents).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('nacks exactly once with the non-retryable invalid_result code for a BigInt result, never acking', async () => {
      vi.useFakeTimers();
      try {
        const { ackRequests, nackRequests, completedEvents, failedEvents } =
          await runJobWithHandler('result.bigint', () => ({ count: 1n }));

        expect(ackRequests).toHaveLength(0);
        expect(nackRequests).toHaveLength(1);
        const body = nackRequests[0]!.body as { error: { code: string; retryable: boolean; message: string } };
        expect(body.error.code).toBe('invalid_result');
        expect(body.error.retryable).toBe(false);
        expect(body.error.message).toMatch(/bigint/i);

        expect(completedEvents).toHaveLength(0);
        expect(failedEvents).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('nacks exactly once with the non-retryable invalid_result code for a non-finite (NaN/Infinity) result, never acking', async () => {
      vi.useFakeTimers();
      try {
        const { ackRequests, nackRequests, completedEvents, failedEvents } =
          await runJobWithHandler('result.nonfinite', () => ({ value: Number.POSITIVE_INFINITY }));

        expect(ackRequests).toHaveLength(0);
        expect(nackRequests).toHaveLength(1);
        const body = nackRequests[0]!.body as { error: { code: string; retryable: boolean; message: string } };
        expect(body.error.code).toBe('invalid_result');
        expect(body.error.retryable).toBe(false);
        expect(body.error.message).toMatch(/non-finite/i);

        expect(completedEvents).toHaveLength(0);
        expect(failedEvents).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('acks a Date result as its ISO string via toJSON(), emitting job.completed exactly once', async () => {
      vi.useFakeTimers();
      try {
        const when = new Date('2030-01-01T00:00:00.000Z');
        const { ackRequests, nackRequests, completedEvents, failedEvents } =
          await runJobWithHandler('result.date', () => when);

        expect(nackRequests).toHaveLength(0);
        expect(ackRequests).toHaveLength(1);
        const body = ackRequests[0]!.body as { result: string };
        expect(body.result).toBe('2030-01-01T00:00:00.000Z');

        expect(failedEvents).toHaveLength(0);
        expect(completedEvents).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('acks a custom toJSON() class result using its serialized value, emitting job.completed exactly once', async () => {
      vi.useFakeTimers();
      try {
        class Money {
          constructor(private readonly cents: number) {}
          toJSON(): Record<string, unknown> {
            return { amount: this.cents / 100, currency: 'USD' };
          }
        }

        const { ackRequests, nackRequests, completedEvents, failedEvents } =
          await runJobWithHandler('result.tojson', () => new Money(1999));

        expect(nackRequests).toHaveLength(0);
        expect(ackRequests).toHaveLength(1);
        const body = ackRequests[0]!.body as { result: { amount: number; currency: string } };
        expect(body.result).toEqual({ amount: 19.99, currency: 'USD' });

        expect(failedEvents).toHaveLength(0);
        expect(completedEvents).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('acks a handler that resolves with undefined and omits the result field entirely (not a literal null)', async () => {
      vi.useFakeTimers();
      try {
        const { ackRequests, nackRequests, completedEvents } =
          await runJobWithHandler('result.undefined', () => undefined);

        expect(nackRequests).toHaveLength(0);
        expect(ackRequests).toHaveLength(1);
        const body = ackRequests[0]!.body as Record<string, unknown>;
        expect('result' in body).toBe(false);
        expect(completedEvents).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('never emits job.completed or increments the completion metric when ack itself fails after a valid result', async () => {
      // Distinguishes "invalid result" (this describe block's main focus)
      // from "ack delivery failure after a *valid* result": both must
      // withhold job.completed, but only the former nacks.
      vi.useFakeTimers();
      try {
        const testJob = createTestJob({ type: 'result.ack-fails' });
        let fetchCallCount = 0;
        mock.setFetchHandler((options) => {
          if (options.path === '/workers/fetch') {
            fetchCallCount++;
            if (fetchCallCount === 1) {
              return { status: 200, headers: {}, body: { jobs: [testJob] } };
            }
            return { status: 200, headers: {}, body: { jobs: [] } };
          }
          if (options.path === '/workers/ack') {
            throw new Error('server unavailable');
          }
          return { status: 200, headers: {}, body: {} };
        });
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const completedEvents: unknown[] = [];
        worker.events.on('job.completed', (event) => completedEvents.push(event));
        worker.register('result.ack-fails', async () => ({ ok: true }));

        await worker.start();
        await vi.advanceTimersByTimeAsync(2000);
        await worker.stop();

        expect(mock.requests.filter((r) => r.path === '/workers/nack')).toHaveLength(0);
        expect(completedEvents).toHaveLength(0);
        warnSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('middleware execution', () => {
    it('should run middleware in onion order', async () => {
      vi.useFakeTimers();
      try {
        const testJob = createTestJob({ type: 'test.middleware' });
        let fetchCallCount = 0;

        mock.setFetchHandler((options) => {
          if (options.path === '/workers/fetch') {
            fetchCallCount++;
            if (fetchCallCount === 1) {
              return { status: 200, headers: {}, body: { jobs: [testJob] } };
            }
            return { status: 200, headers: {}, body: { jobs: [] } };
          }
          return { status: 200, headers: {}, body: {} };
        });

        const order: string[] = [];

        worker.use('outer', async (_ctx, next) => {
          order.push('outer-before');
          const result = await next();
          order.push('outer-after');
          return result;
        });

        worker.use('inner', async (_ctx, next) => {
          order.push('inner-before');
          const result = await next();
          order.push('inner-after');
          return result;
        });

        worker.register('test.middleware', async () => {
          order.push('handler');
          return 'done';
        });

        await worker.start();
        await vi.advanceTimersByTimeAsync(200);
        await worker.stop();

        expect(order).toEqual([
          'outer-before',
          'inner-before',
          'handler',
          'inner-after',
          'outer-after',
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should actually retry a failing handler when using the built-in retry() middleware', async () => {
      // Regression test: retry() previously could not retry anything once
      // wired through a real worker/MiddlewareChain, because composeExecution
      // rejected any *sequential* second call to next() as "called multiple
      // times". Verify the fix end-to-end through OJSWorker itself.
      const testJob = createTestJob({ type: 'test.retry' });
      let fetchCallCount = 0;

      mock.setFetchHandler((options) => {
        if (options.path === '/workers/fetch') {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return { status: 200, headers: {}, body: { jobs: [testJob] } };
          }
          return { status: 200, headers: {}, body: { jobs: [] } };
        }
        return { status: 200, headers: {}, body: {} };
      });

      const { retry } = await import('../src/middleware/retry.js');
      worker.use('retry', retry({ maxRetries: 2, baseDelayMs: 1, jitter: false }));

      let attempts = 0;
      worker.register('test.retry', async () => {
        attempts++;
        if (attempts < 3) throw new Error(`attempt ${attempts} fails`);
        return 'ok';
      });

      const completed = new Promise<void>((resolve) => {
        worker.events.on('job.completed', () => resolve());
      });

      await worker.start();
      await completed;
      await worker.stop();

      expect(attempts).toBe(3);
      // The job must be ack'd (not nack'd) once the retry middleware
      // eventually succeeds.
      const ackRequests = mock.requests.filter((r) => r.path === '/workers/ack');
      const nackRequests = mock.requests.filter((r) => r.path === '/workers/nack');
      expect(ackRequests).toHaveLength(1);
      expect(nackRequests).toHaveLength(0);
    });
  });

  describe('events', () => {
    it('should emit job.completed event', async () => {
      vi.useFakeTimers();
      try {
        const testJob = createTestJob({ type: 'event.test' });
        let fetchCallCount = 0;

        mock.setFetchHandler((options) => {
          if (options.path === '/workers/fetch') {
            fetchCallCount++;
            if (fetchCallCount === 1) {
              return { status: 200, headers: {}, body: { jobs: [testJob] } };
            }
            return { status: 200, headers: {}, body: { jobs: [] } };
          }
          return { status: 200, headers: {}, body: {} };
        });

        worker.register('event.test', async () => ({ result: 'ok' }));

        const completedEvents: unknown[] = [];
        worker.events.on('job.completed', (event) => {
          completedEvents.push(event);
        });

        await worker.start();
        await vi.advanceTimersByTimeAsync(200);
        await worker.stop();

        expect(completedEvents.length).toBeGreaterThanOrEqual(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should still ack (not nack) a successfully completed job even if a job.completed listener throws', async () => {
      // Regression test: OJSEventEmitter.emit() previously rejected as soon
      // as any listener threw. Since worker.ts emits 'job.completed' *after*
      // ack() has already succeeded, a broken user listener could make that
      // emit() call reject, which would route the job into the .catch()
      // handler and incorrectly nack an already-acked job.
      const testJob = createTestJob({ type: 'listener-throws.test' });
      let fetchCallCount = 0;

      mock.setFetchHandler((options) => {
        if (options.path === '/workers/fetch') {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return { status: 200, headers: {}, body: { jobs: [testJob] } };
          }
          return { status: 200, headers: {}, body: { jobs: [] } };
        }
        return { status: 200, headers: {}, body: {} };
      });

      worker.register('listener-throws.test', async () => ({ result: 'ok' }));
      worker.events.on('job.completed', () => {
        throw new Error('user listener bug');
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const idle = new Promise<void>((resolve) => {
        const check = (): void => {
          if (mock.requests.some((r) => r.path === '/workers/ack')) resolve();
        };
        worker.events.on('job.completed', check);
      });

      await worker.start();
      await idle;
      await worker.stop();

      const ackRequests = mock.requests.filter((r) => r.path === '/workers/ack');
      const nackRequests = mock.requests.filter((r) => r.path === '/workers/nack');
      expect(ackRequests).toHaveLength(1);
      expect(nackRequests).toHaveLength(0);

      warnSpy.mockRestore();
    });

    it('should still nack (not ack) a failed job even if a job.failed listener throws', async () => {
      // Symmetric regression test to the job.completed case above: events
      // must not alter the ack/nack decision on the *failure* path either.
      // A broken job.failed listener must not turn a legitimately-failed
      // job into an ack, and must not prevent the nack from being sent.
      const testJob = createTestJob({ type: 'failed-listener-throws.test' });
      let fetchCallCount = 0;

      mock.setFetchHandler((options) => {
        if (options.path === '/workers/fetch') {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return { status: 200, headers: {}, body: { jobs: [testJob] } };
          }
          return { status: 200, headers: {}, body: { jobs: [] } };
        }
        return { status: 200, headers: {}, body: {} };
      });

      worker.register('failed-listener-throws.test', async () => {
        throw new Error('handler blew up');
      });
      worker.events.on('job.failed', () => {
        throw new Error('user listener bug');
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const idle = new Promise<void>((resolve) => {
        const check = (): void => {
          if (mock.requests.some((r) => r.path === '/workers/nack')) resolve();
        };
        worker.events.on('job.failed', check);
      });

      await worker.start();
      await idle;
      await worker.stop();

      const ackRequests = mock.requests.filter((r) => r.path === '/workers/ack');
      const nackRequests = mock.requests.filter((r) => r.path === '/workers/nack');
      expect(nackRequests).toHaveLength(1);
      expect(ackRequests).toHaveLength(0);

      warnSpy.mockRestore();
    });

    it('should emit job.failed event on error', async () => {
      vi.useFakeTimers();
      try {
        const testJob = createTestJob({ type: 'fail.event' });
        let fetchCallCount = 0;

        mock.setFetchHandler((options) => {
          if (options.path === '/workers/fetch') {
            fetchCallCount++;
            if (fetchCallCount === 1) {
              return { status: 200, headers: {}, body: { jobs: [testJob] } };
            }
            return { status: 200, headers: {}, body: { jobs: [] } };
          }
          return { status: 200, headers: {}, body: {} };
        });

        worker.register('fail.event', async () => {
          throw new Error('handler error');
        });

        const failedEvents: unknown[] = [];
        worker.events.on('job.failed', (event) => {
          failedEvents.push(event);
        });

        await worker.start();
        await vi.advanceTimersByTimeAsync(200);
        await worker.stop();

        expect(failedEvents.length).toBeGreaterThanOrEqual(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should emit worker.started event', async () => {
      const startedEvents: unknown[] = [];
      worker.events.on('worker.started', (event) => {
        startedEvents.push(event);
      });

      await worker.start();
      expect(startedEvents).toHaveLength(1);
      await worker.stop();
    });

    it('should emit worker.stopped event', async () => {
      const stoppedEvents: unknown[] = [];
      worker.events.on('worker.stopped', (event) => {
        stoppedEvents.push(event);
      });

      await worker.start();
      await worker.stop();

      expect(stoppedEvents).toHaveLength(1);
    });
  });

  describe('job timeout', () => {
    it('should timeout a job that takes too long (deterministic fake timers)', async () => {
      vi.useFakeTimers();
      try {
        const testJob = createTestJob({
          type: 'slow.job',
          timeout: 50, // 50ms timeout
        });
        let fetchCallCount = 0;

        mock.setFetchHandler((options) => {
          if (options.path === '/workers/fetch') {
            fetchCallCount++;
            if (fetchCallCount === 1) {
              return { status: 200, headers: {}, body: { jobs: [testJob] } };
            }
            return { status: 200, headers: {}, body: { jobs: [] } };
          }
          return { status: 200, headers: {}, body: {} };
        });

        worker.register('slow.job', async (ctx) => {
          // Run longer than the timeout
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 500);
            ctx.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(ctx.signal.reason);
            });
          });
        });

        await worker.start();
        // Advance past the 50ms job timeout deterministically.
        await vi.advanceTimersByTimeAsync(50);

        const nackRequest = mock.requests.find((r) => r.path === '/workers/nack');
        expect(nackRequest).toBeDefined();
        const body = nackRequest!.body as { error: { code: string } };
        expect(body.error.code).toBe('timeout');
      } finally {
        // Real timers before stop() / the shared afterEach, since OJSWorker's
        // own shutdown grace-period logic is not part of what this test
        // exercises and should not depend on fake-timer advancement here.
        vi.useRealTimers();
      }
    });

    it.each([
      {
        name: 'validation error',
        downstreamError: () => new OJSValidationError('Late validation failure'),
      },
      {
        name: 'non-retryable OJSError',
        downstreamError: () => new OJSError(
          'Late non-retryable failure',
          'fatal_handler_error',
          { retryable: false },
        ),
      },
    ])('should keep timeout NACK policy when downstream later rejects with $name', async ({
      downstreamError,
    }) => {
      vi.useFakeTimers();
      try {
        const testJob = createTestJob({
          type: 'timeout-race.job',
          timeout: 50,
        });
        let fetchCallCount = 0;

        mock.setFetchHandler((options) => {
          if (options.path === '/workers/fetch') {
            fetchCallCount++;
            return {
              status: 200,
              headers: {},
              body: { jobs: fetchCallCount === 1 ? [testJob] : [] },
            };
          }
          return { status: 200, headers: {}, body: {} };
        });

        worker.register('timeout-race.job', async (ctx) => {
          await new Promise<never>((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => {
              setTimeout(() => reject(downstreamError()), 5);
            }, { once: true });
          });
        });

        await worker.start();
        await vi.advanceTimersByTimeAsync(55);

        const nackRequest = mock.requests.find((r) => r.path === '/workers/nack');
        expect(nackRequest).toBeDefined();
        const body = nackRequest!.body as {
          error: {
            code: string;
            message: string;
            retryable: boolean;
            details: Record<string, unknown>;
          };
        };
        expect(body.error).toEqual({
          code: 'timeout',
          message: `Job '${testJob.id}' exceeded 50ms timeout.`,
          retryable: true,
          details: {
            job_id: testJob.id,
            timeout_ms: 50,
          },
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('heartbeat', () => {
    it('should send heartbeats when configured', async () => {
      vi.useFakeTimers();
      try {
        // Create a worker with short heartbeat interval
        const heartbeatWorker = new OJSWorker({
          url: 'http://localhost:8080',
          queues: ['default'],
          concurrency: 5,
          pollInterval: 50,
          heartbeatInterval: 50,
          transport: mock.transport,
        });

        await heartbeatWorker.start();
        await vi.advanceTimersByTimeAsync(200);
        await heartbeatWorker.stop();

        const heartbeatRequests = mock.requests.filter((r) => r.path === '/workers/heartbeat');
        expect(heartbeatRequests.length).toBeGreaterThanOrEqual(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should transition to quiet when server directs', async () => {
      vi.useFakeTimers();
      try {
        let heartbeatCount = 0;
        mock.setFetchHandler((options) => {
          if (options.path === '/workers/heartbeat') {
            heartbeatCount++;
            if (heartbeatCount >= 2) {
              return { status: 200, headers: {}, body: { state: 'quiet' } };
            }
            return { status: 200, headers: {}, body: { state: 'running' } };
          }
          if (options.path === '/workers/fetch') {
            return { status: 200, headers: {}, body: { jobs: [] } };
          }
          return { status: 200, headers: {}, body: {} };
        });

        const heartbeatWorker = new OJSWorker({
          url: 'http://localhost:8080',
          queues: ['default'],
          concurrency: 5,
          pollInterval: 50,
          heartbeatInterval: 50,
          transport: mock.transport,
        });

        await heartbeatWorker.start();
        await vi.advanceTimersByTimeAsync(250);

        // Worker should have transitioned to quiet
        expect(heartbeatWorker.currentState).toBe('quiet');
        await heartbeatWorker.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should transition to terminate when server directs (deterministic fake timers)', async () => {
      vi.useFakeTimers();
      try {
        let heartbeatCount = 0;
        mock.setFetchHandler((options) => {
          if (options.path === '/workers/heartbeat') {
            heartbeatCount++;
            if (heartbeatCount >= 2) {
              return { status: 200, headers: {}, body: { state: 'terminate' } };
            }
            return { status: 200, headers: {}, body: { state: 'running' } };
          }
          if (options.path === '/workers/fetch') {
            return { status: 200, headers: {}, body: { jobs: [] } };
          }
          return { status: 200, headers: {}, body: {} };
        });

        const heartbeatWorker = new OJSWorker({
          url: 'http://localhost:8080',
          queues: ['default'],
          concurrency: 5,
          pollInterval: 50,
          heartbeatInterval: 50,
          transport: mock.transport,
        });

        await heartbeatWorker.start();
        await vi.advanceTimersByTimeAsync(50); // 1st heartbeat: running
        await vi.advanceTimersByTimeAsync(50); // 2nd heartbeat: terminate -> stop() (fire-and-forget)
        // Let the fire-and-forget stop() promise chain (event emission,
        // etc. — all microtask-based since there are no active jobs or
        // grace-period timers here) fully settle.
        await vi.advanceTimersByTimeAsync(0);

        // Worker should have terminated
        expect(heartbeatWorker.currentState).toBe('terminated');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('stop()', () => {
    it('should be idempotent when already terminated', async () => {
      // Worker starts in terminated state
      await worker.stop(); // Should not throw
      expect(worker.currentState).toBe('terminated');
    });
  });

  describe('concurrency', () => {
    it('should request only available slots in fetch', async () => {
      vi.useFakeTimers();
      try {
        mock.setFetchHandler((options) => {
          if (options.path === '/workers/fetch') {
            return { status: 200, headers: {}, body: { jobs: [] } };
          }
          return { status: 200, headers: {}, body: {} };
        });

        await worker.start();
        await vi.advanceTimersByTimeAsync(150);
        await worker.stop();

        const fetchRequests = mock.requests.filter((r) => r.path === '/workers/fetch');
        expect(fetchRequests.length).toBeGreaterThanOrEqual(1);
        const body = fetchRequests[0].body as { count: number };
        expect(body.count).toBeLessThanOrEqual(5); // concurrency is 5
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('activeJobCount', () => {
    it('should reflect active job count', async () => {
      expect(worker.activeJobCount).toBe(0);
    });
  });

  describe('worker labels', () => {
    it('should include labels in heartbeat', async () => {
      vi.useFakeTimers();
      try {
        const labeledWorker = new OJSWorker({
          url: 'http://localhost:8080',
          queues: ['default'],
          pollInterval: 50,
          heartbeatInterval: 50,
          labels: ['gpu', 'high-memory'],
          transport: mock.transport,
        });

        await labeledWorker.start();
        await vi.advanceTimersByTimeAsync(150);
        await labeledWorker.stop();

        const heartbeatRequest = mock.requests.find((r) => r.path === '/workers/heartbeat');
        if (heartbeatRequest) {
          const body = heartbeatRequest.body as { labels: string[] };
          expect(body.labels).toEqual(['gpu', 'high-memory']);
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('poll error backoff', () => {
    it('should use exponential backoff on consecutive poll errors (deterministic fake timers)', async () => {
      vi.useFakeTimers();
      let worker: OJSWorker | undefined;
      try {
        let errorCount = 0;

        mock.setFetchHandler((options) => {
          if (options.path === '/workers/fetch') {
            errorCount++;
            throw new Error('connection refused');
          }
          if (options.path === '/workers/heartbeat') {
            return { status: 200, headers: {}, body: { state: 'running' } };
          }
          return { status: 200, headers: {}, body: {} };
        });

        worker = new OJSWorker({
          url: 'http://localhost:8080',
          transport: mock.transport,
          pollInterval: 50,
          heartbeatInterval: 600_000,
        });

        await worker.start();
        await vi.advanceTimersByTimeAsync(500);

        // With a 50ms base and doubling backoff (50*2^n, capped at 30s),
        // polls happen at t=0, t=100 (50*2^1), and t=300 (50*2^2); the next
        // would be at t=700 (50*2^3), beyond this 500ms window — exactly 3.
        expect(errorCount).toBe(3);
      } finally {
        if (worker) await worker.stop();
        vi.useRealTimers();
      }
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OJSWorker } from '../src/worker.js';
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
      await new Promise((resolve) => setTimeout(resolve, 200));

      await worker.stop();

      expect(processed).toHaveBeenCalledWith('email.send');

      // Should have sent an ACK
      const ackRequest = mock.requests.find((r) => r.path === '/workers/ack');
      expect(ackRequest).toBeDefined();
    });

    it('should nack a job when handler throws', async () => {
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
      await new Promise((resolve) => setTimeout(resolve, 200));
      await worker.stop();

      const nackRequest = mock.requests.find((r) => r.path === '/workers/nack');
      expect(nackRequest).toBeDefined();
      const body = nackRequest!.body as { error: { message: string } };
      expect(body.error.message).toBe('Something went wrong');
    });

    it('should nack when no handler is registered', async () => {
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
      await new Promise((resolve) => setTimeout(resolve, 200));
      await worker.stop();

      const nackRequest = mock.requests.find((r) => r.path === '/workers/nack');
      expect(nackRequest).toBeDefined();
      const body = nackRequest!.body as { error: { code: string } };
      expect(body.error.code).toBe('handler_not_found');
    });
  });

  describe('middleware execution', () => {
    it('should run middleware in onion order', async () => {
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
      await new Promise((resolve) => setTimeout(resolve, 200));
      await worker.stop();

      expect(order).toEqual([
        'outer-before',
        'inner-before',
        'handler',
        'inner-after',
        'outer-after',
      ]);
    });
  });

  describe('events', () => {
    it('should emit job.completed event', async () => {
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
      await new Promise((resolve) => setTimeout(resolve, 200));
      await worker.stop();

      expect(completedEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('should emit job.failed event on error', async () => {
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
      await new Promise((resolve) => setTimeout(resolve, 200));
      await worker.stop();

      expect(failedEvents.length).toBeGreaterThanOrEqual(1);
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
    it('should timeout a job that takes too long', async () => {
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
      await new Promise((resolve) => setTimeout(resolve, 300));
      await worker.stop();

      const nackRequest = mock.requests.find((r) => r.path === '/workers/nack');
      expect(nackRequest).toBeDefined();
      const body = nackRequest!.body as { error: { code: string } };
      expect(body.error.code).toBe('timeout');
    });
  });

  describe('heartbeat', () => {
    it('should send heartbeats when configured', async () => {
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
      await new Promise((resolve) => setTimeout(resolve, 200));
      await heartbeatWorker.stop();

      const heartbeatRequests = mock.requests.filter((r) => r.path === '/workers/heartbeat');
      expect(heartbeatRequests.length).toBeGreaterThanOrEqual(1);
    });

    it('should transition to quiet when server directs', async () => {
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
      await new Promise((resolve) => setTimeout(resolve, 250));

      // Worker should have transitioned to quiet
      expect(heartbeatWorker.currentState).toBe('quiet');
      await heartbeatWorker.stop();
    });

    it('should transition to terminate when server directs', async () => {
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
      await new Promise((resolve) => setTimeout(resolve, 350));

      // Worker should have terminated
      expect(heartbeatWorker.currentState).toBe('terminated');
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
      mock.setFetchHandler((options) => {
        if (options.path === '/workers/fetch') {
          return { status: 200, headers: {}, body: { jobs: [] } };
        }
        return { status: 200, headers: {}, body: {} };
      });

      await worker.start();
      await new Promise((resolve) => setTimeout(resolve, 150));
      await worker.stop();

      const fetchRequests = mock.requests.filter((r) => r.path === '/workers/fetch');
      expect(fetchRequests.length).toBeGreaterThanOrEqual(1);
      const body = fetchRequests[0].body as { count: number };
      expect(body.count).toBeLessThanOrEqual(5); // concurrency is 5
    });
  });

  describe('activeJobCount', () => {
    it('should reflect active job count', async () => {
      expect(worker.activeJobCount).toBe(0);
    });
  });

  describe('worker labels', () => {
    it('should include labels in heartbeat', async () => {
      const labeledWorker = new OJSWorker({
        url: 'http://localhost:8080',
        queues: ['default'],
        pollInterval: 50,
        heartbeatInterval: 50,
        labels: ['gpu', 'high-memory'],
        transport: mock.transport,
      });

      await labeledWorker.start();
      await new Promise((resolve) => setTimeout(resolve, 150));
      await labeledWorker.stop();

      const heartbeatRequest = mock.requests.find((r) => r.path === '/workers/heartbeat');
      if (heartbeatRequest) {
        const body = heartbeatRequest.body as { labels: string[] };
        expect(body.labels).toEqual(['gpu', 'high-memory']);
      }
    });
  });

  describe('poll error backoff', () => {
    it('should use exponential backoff on consecutive poll errors', async () => {
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

      const worker = new OJSWorker({
        url: 'http://localhost:8080',
        transport: mock.transport,
        pollInterval: 50,
        heartbeatInterval: 600_000,
      });

      await worker.start();
      // Wait enough for a few poll errors
      await new Promise((r) => setTimeout(r, 500));
      await worker.stop();

      // Should have attempted multiple polls but with increasing delay
      // With 50ms base, errors should slow down (50*2=100, 50*4=200, etc.)
      // In 500ms we should see fewer errors than if it were a fixed interval
      expect(errorCount).toBeGreaterThan(1);
      expect(errorCount).toBeLessThan(10); // Without backoff at 100ms fixed, would be ~5; with 50ms base, even more
    });
  });
});

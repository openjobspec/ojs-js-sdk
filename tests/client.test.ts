import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OJSClient } from '../src/client.js';
import type { Transport, TransportRequestOptions, TransportResponse } from '../src/transport/types.js';
import type { Job } from '../src/job.js';
import { OJSError } from '../src/errors.js';
import * as testing from '../src/testing.js';

/** A mock transport for testing. */
function createMockTransport() {
  const requests: TransportRequestOptions[] = [];
  const responses = new Map<string, TransportResponse>();

  const transport: Transport = {
    async request<T>(options: TransportRequestOptions): Promise<TransportResponse<T>> {
      requests.push(options);
      const key = `${options.method} ${options.path}`;
      const response = responses.get(key);
      if (response) return response as TransportResponse<T>;
      return { status: 200, headers: {}, body: {} as T };
    },
  };

  return {
    transport,
    requests,
    mockResponse(method: string, path: string, body: unknown, status = 200) {
      responses.set(`${method} ${path}`, { status, headers: {}, body });
    },
  };
}

describe('OJSClient', () => {
  let mock: ReturnType<typeof createMockTransport>;
  let client: OJSClient;

  beforeEach(() => {
    mock = createMockTransport();
    client = new OJSClient({ url: 'http://localhost:8080', transport: mock.transport });
  });

  describe('enqueue', () => {
    it('should enqueue a simple job', async () => {
      const mockJob: Job = {
        specversion: '1.0',
        id: '019414d4-8b2e-7c3a-b5d1-f0e2a3b4c5d6',
        type: 'email.send',
        queue: 'default',
        args: [{ to: 'user@example.com' }],
        state: 'available',
      };

      mock.mockResponse('POST', '/jobs', { job: mockJob }, 201);

      const result = await client.enqueue('email.send', { to: 'user@example.com' });

      expect(result).not.toBeNull();
      if (result === null) throw new Error('Expected enqueue result');
      expect(result.type).toBe('email.send');
      expect(result.state).toBe('available');
      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0].method).toBe('POST');
      expect(mock.requests[0].path).toBe('/jobs');
    });

    it('should wrap non-array args in an array', async () => {
      mock.mockResponse('POST', '/jobs', { job: { id: 'test', type: 'test', queue: 'default', args: [{ key: 'value' }], specversion: '1.0' } }, 201);

      await client.enqueue('test.job', { key: 'value' });

      const body = mock.requests[0].body as Record<string, unknown>;
      expect(body.args).toEqual([{ key: 'value' }]);
    });

    it('should pass array args as-is', async () => {
      mock.mockResponse('POST', '/jobs', { job: { id: 'test', type: 'test', queue: 'default', args: ['a', 'b'], specversion: '1.0' } }, 201);

      await client.enqueue('test.job', ['a', 'b']);

      const body = mock.requests[0].body as Record<string, unknown>;
      expect(body.args).toEqual(['a', 'b']);
    });

    it('should include options in the wire format', async () => {
      mock.mockResponse('POST', '/jobs', { job: { id: 'test', type: 'test', queue: 'reports', args: [], specversion: '1.0' } }, 201);

      await client.enqueue('report.generate', { id: 42 }, {
        queue: 'reports',
        retry: { maxAttempts: 5, backoff: 'exponential' },
        tags: ['monthly'],
      });

      const body = mock.requests[0].body as Record<string, unknown>;
      const options = body.options as Record<string, unknown>;
      expect(options.queue).toBe('reports');
      expect(options.tags).toEqual(['monthly']);

      const retry = options.retry as Record<string, unknown>;
      expect(retry.max_attempts).toBe(5);
    });

    it.each(['queue--name', 'queue.', 'queue-'])(
      'accepts schema-valid queue name %s',
      async (queue) => {
        mock.mockResponse('POST', '/jobs', {
          job: { id: 'test', type: 'test.job', queue, args: [], specversion: '1.0' },
        }, 201);

        await client.enqueue('test.job', [], { queue });

        const body = mock.requests[0].body as {
          options: { queue: string };
        };
        expect(body.options.queue).toBe(queue);
      },
    );

    it('should build the complete enqueue envelope and preserve explicit zero values', async () => {
      mock.mockResponse('POST', '/jobs', {
        job: {
          id: 'test',
          type: 'report.generate',
          queue: 'reports',
          args: [],
          specversion: '1.0',
        },
      }, 201);

      await client.enqueue('report.generate', { id: 42 }, {
        queue: 'reports',
        priority: 0,
        timeout: 0,
        delay: '2026-08-09T10:00:00Z',
        expiresAt: '2026-08-10T10:00:00Z',
        retry: {
          maxAttempts: 0,
          initialInterval: 'PT1S',
          backoffCoefficient: 1,
          maxInterval: 'PT1M',
          jitter: false,
          nonRetryableErrors: ['ValidationError'],
          onExhaustion: 'dead_letter',
        },
        unique: {
          keys: ['type', 'args', 'meta'],
          argsKeys: ['id'],
          metaKeys: ['tenant'],
          period: 'PT1H',
          states: ['available'],
          onConflict: 'ignore',
        },
        tags: ['monthly'],
        visibilityTimeout: 5_000,
        meta: { tenant: 'acme' },
        schema: 'urn:ojs:schema:report.generate:v1',
      });

      expect(mock.requests[0].body).toEqual({
        type: 'report.generate',
        args: [{ id: 42 }],
        meta: { tenant: 'acme' },
        schema: 'urn:ojs:schema:report.generate:v1',
        options: {
          queue: 'reports',
          priority: 0,
          timeout_ms: 0,
          delay_until: '2026-08-09T10:00:00Z',
          expires_at: '2026-08-10T10:00:00Z',
          retry: {
            max_attempts: 0,
            initial_interval: 'PT1S',
            backoff_coefficient: 1,
            max_interval: 'PT1M',
            jitter: false,
            non_retryable_errors: ['ValidationError'],
            on_exhaustion: 'dead_letter',
          },
          unique: {
            keys: ['type', 'args', 'meta'],
            args_keys: ['id'],
            meta_keys: ['tenant'],
            period: 'PT1H',
            on_conflict: 'ignore',
            states: ['available'],
          },
          tags: ['monthly'],
          visibility_timeout_ms: 5_000,
        },
      });
    });

    it('should send only canonical unique-policy wire fields over HTTP', async () => {
      mock.mockResponse('POST', '/jobs', {
        job: {
          id: 'test',
          type: 'report.generate',
          queue: 'reports',
          args: [],
          specversion: '1.0',
        },
      }, 201);

      await client.enqueue('report.generate', { id: 42 }, {
        unique: {
          keys: ['type', 'args'],
          argsKeys: ['id'],
          period: 'PT1H',
          onConflict: 'reject',
          states: ['available', 'active'],
        },
      });

      const body = mock.requests[0].body as Record<string, unknown>;
      const options = body.options as Record<string, unknown>;
      expect(options.unique).toEqual({
        keys: ['type', 'args'],
        args_keys: ['id'],
        period: 'PT1H',
        on_conflict: 'reject',
        states: ['available', 'active'],
      });
      expect(options.unique).not.toHaveProperty('key');
    });

    it('should migrate every deprecated unique key entry as an args selector', async () => {
      mock.mockResponse('POST', '/jobs', {
        job: {
          id: 'test',
          type: 'report.generate',
          queue: 'reports',
          args: [],
          specversion: '1.0',
        },
      }, 201);

      await client.enqueue('report.generate', { type: 'monthly', id: 42 }, {
        unique: {
          keys: ['queue'],
          argsKeys: ['id'],
          key: ['type', 'id', 'queue'],
        },
      });

      const body = mock.requests[0].body as Record<string, unknown>;
      const options = body.options as Record<string, unknown>;
      expect(options.unique).toEqual({
        keys: ['queue', 'args'],
        args_keys: ['id', 'type', 'queue'],
      });
      expect(options.unique).not.toHaveProperty('key');
    });

    it('should validate job type format', async () => {
      await expect(
        client.enqueue('INVALID TYPE!', {}),
      ).rejects.toThrow();
    });

    it('should accept typed args via generic parameter', async () => {
      interface EmailPayload { to: string; subject: string }

      mock.mockResponse('POST', '/jobs', {
        job: { id: 'test', type: 'email.send', queue: 'default', args: [{ to: 'a@b.com', subject: 'Hi' }], specversion: '1.0' },
      }, 201);

      const job = await client.enqueue<EmailPayload>('email.send', { to: 'a@b.com', subject: 'Hi' });
      if (job === null) throw new Error('Expected enqueue result');
      expect(job.type).toBe('email.send');

      const body = mock.requests[0].body as Record<string, unknown>;
      expect(body.args).toEqual([{ to: 'a@b.com', subject: 'Hi' }]);
    });

    it('should accept typed array args via generic parameter', async () => {
      mock.mockResponse('POST', '/jobs', {
        job: { id: 'test', type: 'process.items', queue: 'default', args: ['item1', 'item2'], specversion: '1.0' },
      }, 201);

      const job = await client.enqueue<string>('process.items', ['item1', 'item2']);
      if (job === null) throw new Error('Expected enqueue result');
      expect(job.type).toBe('process.items');

      const body = mock.requests[0].body as Record<string, unknown>;
      expect(body.args).toEqual(['item1', 'item2']);
    });
  });

  describe('enqueueBatch', () => {
    it('should enqueue multiple jobs', async () => {
      const mockJobs = [
        { id: 'j1', type: 'email.send', queue: 'email', args: [{ to: 'a@example.com' }], specversion: '1.0', state: 'available' },
        { id: 'j2', type: 'email.send', queue: 'email', args: [{ to: 'b@example.com' }], specversion: '1.0', state: 'available' },
      ];

      mock.mockResponse('POST', '/jobs/batch', { jobs: mockJobs }, 201);

      const results = await client.enqueueBatch([
        { type: 'email.send', args: { to: 'a@example.com' } },
        { type: 'email.send', args: { to: 'b@example.com' } },
      ]);

      expect(results).toHaveLength(2);
      expect(mock.requests[0].path).toBe('/jobs/batch');

      const body = mock.requests[0].body as { jobs: Array<{ args: unknown[] }> };
      // Args should be wrapped in arrays
      expect(body.jobs[0].args).toEqual([{ to: 'a@example.com' }]);
    });

    it('accepts trailing and consecutive separators in batch queue names', async () => {
      mock.mockResponse('POST', '/jobs/batch', {
        jobs: [
          { id: 'j1', type: 'a.job', queue: 'queue--name', args: [], specversion: '1.0' },
          { id: 'j2', type: 'b.job', queue: 'queue.', args: [], specversion: '1.0' },
          { id: 'j3', type: 'c.job', queue: 'queue-', args: [], specversion: '1.0' },
        ],
      }, 201);

      await client.enqueueBatch([
        { type: 'a.job', options: { queue: 'queue--name' } },
        { type: 'b.job', options: { queue: 'queue.' } },
        { type: 'c.job', options: { queue: 'queue-' } },
      ]);

      const body = mock.requests[0].body as {
        jobs: Array<{ options: { queue: string } }>;
      };
      expect(body.jobs.map((job) => job.options.queue)).toEqual([
        'queue--name',
        'queue.',
        'queue-',
      ]);
    });

    it('should run every item through middleware, omit drops, and preserve order', async () => {
      mock.mockResponse('POST', '/jobs/batch', {
        jobs: [
          { id: 'j1', type: 'first.prepared', queue: 'first', args: [], specversion: '1.0' },
          { id: 'j3', type: 'third.prepared', queue: 'third', args: [], specversion: '1.0' },
        ],
      }, 201);
      const order: string[] = [];

      client.useEnqueue('prepare', async (job, next) => {
        order.push(job.type);
        if (job.type === 'second.job') return null;
        job.type = job.type.replace('.job', '.prepared');
        job.queue = job.type.split('.')[0]!;
        return next(job);
      });

      const result = await client.enqueueBatch([
        { type: 'first.job' },
        { type: 'second.job' },
        { type: 'third.job' },
      ]);

      expect(order).toEqual(['first.job', 'second.job', 'third.job']);
      expect(result.map((job) => job.id)).toEqual(['j1', 'j3']);
      expect(mock.requests).toHaveLength(1);
      const body = mock.requests[0].body as {
        jobs: Array<{ type: string; options: { queue: string } }>;
      };
      expect(body.jobs.map((job) => job.type)).toEqual([
        'first.prepared',
        'third.prepared',
      ]);
      expect(body.jobs.map((job) => job.options.queue)).toEqual([
        'first',
        'third',
      ]);
    });

    it('should return an empty batch without transport when middleware drops every item', async () => {
      client.useEnqueue('drop-all', async () => null);

      await expect(client.enqueueBatch([
        { type: 'first.job' },
        { type: 'second.job' },
      ])).resolves.toEqual([]);
      expect(mock.requests).toEqual([]);
    });

    it('should abort the whole batch before transport when middleware throws', async () => {
      client.useEnqueue('throw-on-second', async (job, next) => {
        if (job.type === 'second.job') throw new Error('batch rejected');
        return next(job);
      });

      await expect(client.enqueueBatch([
        { type: 'first.job' },
        { type: 'second.job' },
        { type: 'third.job' },
      ])).rejects.toThrow('batch rejected');
      expect(mock.requests).toEqual([]);
    });

    it('resolves each terminal with its corresponding response Job in order', async () => {
      // One atomic transport call; each per-job chain's next() resolves with
      // the matching response Job even though the chains are orchestrated
      // concurrently behind a barrier.
      mock.mockResponse('POST', '/jobs/batch', {
        jobs: [
          { id: 'a', type: 'a.job', queue: 'default', args: [], specversion: '1.0', state: 'available' },
          { id: 'b', type: 'b.job', queue: 'default', args: [], specversion: '1.0', state: 'available' },
        ],
      }, 201);

      const observedIds: (string | undefined)[] = [];
      client.useEnqueue('observe', async (job, next) => {
        const created = await next(job);
        observedIds.push(created?.id);
        return created;
      });

      const results = await client.enqueueBatch([
        { type: 'a.job' },
        { type: 'b.job' },
      ]);

      expect(mock.requests).toHaveLength(1);
      expect(results.map((j) => j.id)).toEqual(['a', 'b']);
      // Each chain observed its own response Job's id via next().
      expect(observedIds.sort()).toEqual(['a', 'b']);
    });

    it('reflects post-next batch mutations in the return without re-sending them', async () => {
      mock.mockResponse('POST', '/jobs/batch', {
        jobs: [
          { id: 'a', type: 'a.job', queue: 'server-queue', args: [], specversion: '1.0', state: 'available' },
        ],
      }, 201);

      client.useEnqueue('mutate', async (job, next) => {
        job.meta = { pre: true };
        const created = await next(job);
        if (created === null) return null;
        created.queue = 'post-next-only';
        return created;
      });

      const results = await client.enqueueBatch([{ type: 'a.job' }]);

      const body = mock.requests[0].body as { jobs: Array<{ meta?: unknown; options: { queue: string } }> };
      // pre-next mutation sent; post-next queue mutation not sent (original 'default').
      expect(body.jobs[0].meta).toEqual({ pre: true });
      expect(body.jobs[0].options.queue).toBe('default');
      // return reflects post-next mutation.
      expect(results[0].queue).toBe('post-next-only');
    });

    it('rejects the whole batch and every terminal when the transport fails', async () => {
      const failing = new OJSError('batch transport down', 'server_error', { retryable: true });
      const transport: Transport = {
        async request() {
          throw failing;
        },
      };
      const failClient = new OJSClient({ url: 'http://localhost:8080', transport });

      const caught: unknown[] = [];
      failClient.useEnqueue('observe-error', async (job, next) => {
        try {
          return await next(job);
        } catch (error) {
          caught.push(error);
          throw error;
        }
      });

      await expect(failClient.enqueueBatch([
        { type: 'a.job' },
        { type: 'b.job' },
      ])).rejects.toBe(failing);
      // Both terminals observed the transport error.
      expect(caught).toEqual([failing, failing]);
    });

    it('rejects every terminal when the batch response cardinality does not match', async () => {
      mock.mockResponse('POST', '/jobs/batch', {
        jobs: [
          { id: 'a', type: 'a.job', queue: 'default', args: [], specversion: '1.0', state: 'available' },
        ],
      }, 201);

      const caught: unknown[] = [];
      client.useEnqueue('observe-error', async (job, next) => {
        try {
          return await next(job);
        } catch (error) {
          caught.push(error);
          throw error;
        }
      });

      const batch = client.enqueueBatch([
        { type: 'a.job' },
        { type: 'b.job' },
      ]);

      await expect(batch).rejects.toMatchObject({
        name: 'OJSConnectionError',
        code: 'connection_error',
        message: 'Batch enqueue returned 1 jobs for 2 requests.',
      });
      expect(caught).toHaveLength(2);
      expect(caught[0]).toBe(caught[1]);
    });

    it('records each item in fake test mode as a single atomic batch', async () => {
      testing.fake();
      try {
        client.useEnqueue('pass', async (job, next) => next(job));
        const results = await client.enqueueBatch([
          { type: 'a.job', args: { n: 1 } },
          { type: 'b.job', args: { n: 2 } },
        ]);
        expect(results).toHaveLength(2);
        expect(results.every((j) => j.state === 'available')).toBe(true);
        testing.assertEnqueued('a.job', { args: [{ n: 1 }] });
        testing.assertEnqueued('b.job', { args: [{ n: 2 }] });
      } finally {
        testing.restore();
      }
    });
  });

  describe('enqueueBatch terminal retry semantics', () => {
    /**
     * A retry-style enqueue middleware: it calls `next()` up to
     * `maxAttempts` times, catching each rejection, and rethrows the final
     * error once its attempts are exhausted. This is the exact pattern that
     * would re-enter a per-job batch terminal after it has already been
     * reached. `onError` records every error each attempt observed.
     */
    function retryEnqueue(
      maxAttempts: number,
      onError: (error: unknown) => void,
      backoffMs = 0,
    ) {
      return async (
        job: import('../src/job.js').Job,
        next: (job: import('../src/job.js').Job) => Promise<import('../src/job.js').Job | null>,
      ): Promise<import('../src/job.js').Job | null> => {
        let lastError: unknown;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          try {
            return await next(job);
          } catch (error) {
            onError(error);
            lastError = error;
            if (backoffMs > 0 && attempt < maxAttempts - 1) {
              await new Promise((resolve) => setTimeout(resolve, backoffMs));
            }
          }
        }
        throw lastError;
      };
    }

    it('re-invoking next() after a transport failure rejects with the original error and issues exactly one transport call', async () => {
      const failing = new OJSError('batch transport down', 'server_error', { retryable: true });
      let transportCalls = 0;
      const transport: Transport = {
        async request() {
          transportCalls++;
          throw failing;
        },
      };
      const failClient = new OJSClient({ url: 'http://localhost:8080', transport });

      const seen: unknown[] = [];
      failClient.useEnqueue('retry', retryEnqueue(2, (error) => seen.push(error)));

      await expect(failClient.enqueueBatch([{ type: 'a.job' }])).rejects.toBe(failing);
      // The single atomic batch transport is attempted exactly once even
      // though the middleware retried next().
      expect(transportCalls).toBe(1);
      // Both the initial attempt and the retry observed the SAME original
      // terminal error (the second came from the invoke-once guard, not a
      // second transport cycle).
      expect(seen).toEqual([failing, failing]);
    });

    it('retries across multiple jobs while still issuing one atomic batch transport', async () => {
      const failing = new OJSError('batch transport down', 'server_error', { retryable: true });
      let transportCalls = 0;
      let batchSize = 0;
      const transport: Transport = {
        async request(options) {
          transportCalls++;
          const body = options.body as { jobs: unknown[] };
          batchSize = body.jobs.length;
          throw failing;
        },
      };
      const failClient = new OJSClient({ url: 'http://localhost:8080', transport });

      const seen: unknown[] = [];
      failClient.useEnqueue('retry', retryEnqueue(3, (error) => seen.push(error)));

      await expect(failClient.enqueueBatch([
        { type: 'a.job' },
        { type: 'b.job' },
        { type: 'c.job' },
      ])).rejects.toBe(failing);

      expect(transportCalls).toBe(1);
      expect(batchSize).toBe(3);
      // 3 jobs x 3 attempts each = 9 observed errors, all the original.
      expect(seen).toHaveLength(9);
      expect(seen.every((error) => error === failing)).toBe(true);
    });

    it('transport failure rejects every terminal once and never re-issues transport (no retry middleware)', async () => {
      const failing = new OJSError('down', 'server_error', { retryable: true });
      let transportCalls = 0;
      const transport: Transport = {
        async request() {
          transportCalls++;
          throw failing;
        },
      };
      const failClient = new OJSClient({ url: 'http://localhost:8080', transport });

      const caught: unknown[] = [];
      failClient.useEnqueue('observe', async (job, next) => {
        try {
          return await next(job);
        } catch (error) {
          caught.push(error);
          throw error;
        }
      });

      await expect(failClient.enqueueBatch([
        { type: 'a.job' },
        { type: 'b.job' },
      ])).rejects.toBe(failing);
      expect(transportCalls).toBe(1);
      expect(caught).toEqual([failing, failing]);
    });

    it('a retry middleware that backs off with a real timer still resolves promptly with one transport call', async () => {
      const failing = new OJSError('down', 'server_error', { retryable: true });
      let transportCalls = 0;
      const transport: Transport = {
        async request() {
          transportCalls++;
          throw failing;
        },
      };
      const failClient = new OJSClient({ url: 'http://localhost:8080', transport });

      const seen: unknown[] = [];
      // A backoff timer between attempts introduces an async gap between the
      // terminal rejection and its re-invocation; the invoke-once guard must
      // still reject promptly rather than hang waiting for a second cycle.
      failClient.useEnqueue('retry-backoff', retryEnqueue(3, (error) => seen.push(error), 5));

      await expect(failClient.enqueueBatch([{ type: 'a.job' }])).rejects.toBe(failing);
      expect(transportCalls).toBe(1);
      expect(seen).toEqual([failing, failing, failing]);
    }, 2000);

    it('a retry middleware re-invoking next() after a validation failure aborts before transport with the original error', async () => {
      let transportCalls = 0;
      const transport: Transport = {
        async request() {
          transportCalls++;
          return { status: 201, headers: {}, body: { jobs: [] } };
        },
      };
      const failClient = new OJSClient({ url: 'http://localhost:8080', transport });

      // This middleware corrupts the envelope so the terminal's
      // serialize/validate step throws synchronously, then retries.
      const seen: unknown[] = [];
      failClient.useEnqueue('corrupt-and-retry', async (job, next) => {
        job.queue = 'Invalid Queue Name!';
        let lastError: unknown;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            return await next(job);
          } catch (error) {
            seen.push(error);
            lastError = error;
          }
        }
        throw lastError;
      });

      const batch = failClient.enqueueBatch([{ type: 'a.job' }]);
      await expect(batch).rejects.toMatchObject({ name: 'OJSValidationError' });
      // Validation fails before any transport call and stays that way on retry.
      expect(transportCalls).toBe(0);
      expect(seen).toHaveLength(2);
      // Both attempts observed the identical original validation error object.
      expect(seen[0]).toBe(seen[1]);
      expect((seen[0] as Error).name).toBe('OJSValidationError');
    });
  });

  describe('getJob', () => {
    it('should fetch job details', async () => {
      const jobId = '019414d4-8b2e-7c3a-b5d1-f0e2a3b4c5d6';
      mock.mockResponse('GET', `/jobs/${jobId}`, {
        job: { id: jobId, type: 'email.send', state: 'completed', queue: 'default', args: [], specversion: '1.0' },
      });

      const job = await client.getJob(jobId);
      expect(job.id).toBe(jobId);
      expect(job.state).toBe('completed');
    });

    it('normalizes a legacy newline-delimited backtrace to canonical frames', async () => {
      const jobId = '019414d4-8b2e-7c3a-b5d1-f0e2a3b4c5d6';
      mock.mockResponse('GET', `/jobs/${jobId}`, {
        job: {
          id: jobId,
          type: 'email.send',
          state: 'discarded',
          queue: 'default',
          args: [],
          specversion: '1.0',
          error: {
            code: 'handler_error',
            message: 'failed',
            backtrace: 'Error: failed\n    at handler.ts:1:1',
          },
        },
      });

      const job = await client.getJob(jobId);
      expect(job.error?.backtrace).toEqual([
        'Error: failed',
        '    at handler.ts:1:1',
      ]);
    });
  });

  describe('cancelJob', () => {
    it('should cancel a job', async () => {
      const jobId = '019414d4-8b2e-7c3a-b5d1-f0e2a3b4c5d6';
      mock.mockResponse('DELETE', `/jobs/${jobId}`, {
        job: { id: jobId, type: 'email.send', state: 'cancelled', queue: 'default', args: [], specversion: '1.0' },
      });

      const job = await client.cancelJob(jobId);
      expect(job.state).toBe('cancelled');
    });
  });

  describe('enqueue middleware', () => {
    it('should run middleware before enqueue', async () => {
      mock.mockResponse('POST', '/jobs', {
        job: { id: 'test', type: 'email.send', queue: 'default', args: [], specversion: '1.0', meta: { trace_id: 'abc' } },
      }, 201);

      const order: string[] = [];

      client.useEnqueue('trace', async (job, next) => {
        order.push('trace-before');
        job.meta = { ...job.meta, trace_id: 'abc' };
        const result = await next(job);
        order.push('trace-after');
        return result;
      });

      client.useEnqueue('logging', async (job, next) => {
        order.push('logging-before');
        const result = await next(job);
        order.push('logging-after');
        return result;
      });

      await client.enqueue('email.send', {});

      expect(order).toEqual([
        'trace-before',
        'logging-before',
        'logging-after',
        'trace-after',
      ]);
    });

    it('should allow middleware to drop a job by returning null', async () => {
      client.useEnqueue('dedup', async (_job, _next) => {
        return null; // Drop the job (e.g., duplicate detected)
      });

      const result = await client.enqueue('email.send', {});
      expect(result).toBeNull();
    });

    it('should serialize only pre-next mutations and never re-send post-next mutations', async () => {
      // Onion semantics: the terminal transport enqueue happens when
      // `next()` is reached, so only mutations applied *before* next() are
      // serialized and sent. Mutations applied *after* next() affect the
      // Job the middleware returns to the caller but are never re-sent, and
      // response-only fields therefore cannot leak onto the wire.
      mock.mockResponse('POST', '/jobs', {
        job: {
          id: 'server-id',
          type: 'mutated.job',
          queue: 'original',
          args: ['encrypted'],
          state: 'available',
          specversion: '1.0',
        },
      }, 201);

      client.useEnqueue('mutate', async (job, next) => {
        // Applied before next(): these are what gets serialized/sent.
        job.type = 'mutated.job';
        job.args = ['encrypted'];
        job.meta = { tenant: 'acme' };
        job.schema = 'urn:ojs:schema:mutated.job:v1';

        const created = await next(job);
        if (created === null) return null;

        // Applied after next(): reflected in the return value only.
        created.queue = 'post-next-queue';
        created.priority = 0;
        created.tags = ['post-next'];
        created.result = { should_not: 'leak' };
        created.transport_extension = 'also not sent';
        return created;
      });

      const returned = await client.enqueue('original.job', { plaintext: true }, {
        queue: 'original',
        priority: 99,
        timeout: 99,
        retry: { maxAttempts: 9 },
        meta: { original: true },
      });

      // Wire body reflects the pre-next envelope: mutated type/args/meta/schema,
      // but the *original* options (queue/priority/timeout/retry), because
      // those were only mutated after next() (on the response Job).
      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0].body).toEqual({
        type: 'mutated.job',
        args: ['encrypted'],
        meta: { tenant: 'acme' },
        schema: 'urn:ojs:schema:mutated.job:v1',
        options: {
          queue: 'original',
          priority: 99,
          timeout_ms: 99,
          retry: { max_attempts: 9 },
        },
      });

      // The public return is the server-created Job (real id/state) with the
      // post-next mutations applied on top.
      expect(returned).not.toBeNull();
      expect(returned!.id).toBe('server-id');
      expect(returned!.state).toBe('available');
      expect(returned!.queue).toBe('post-next-queue');
      expect(returned!.priority).toBe(0);
      expect(returned!.tags).toEqual(['post-next']);
    });

    it('should expose the server-created id/state to post-next middleware code', async () => {
      const order: string[] = [];
      mock.mockResponse('POST', '/jobs', {
        job: {
          id: 'server-assigned-id',
          type: 'email.send',
          queue: 'default',
          args: [],
          state: 'available',
          specversion: '1.0',
        },
      }, 201);

      let observedId: string | undefined;
      let observedState: string | undefined;
      client.useEnqueue('observe', async (job, next) => {
        order.push('before-next');
        const created = await next(job);
        order.push('after-next');
        observedId = created?.id;
        observedState = created?.state;
        return created;
      });

      const result = await client.enqueue('email.send', {});
      expect(order).toEqual(['before-next', 'after-next']);
      expect(observedId).toBe('server-assigned-id');
      expect(observedState).toBe('available');
      expect(result!.id).toBe('server-assigned-id');
    });

    it('should surface a transport failure to post-next middleware code and reject', async () => {
      const failing = new OJSError('boom', 'server_error', { retryable: true });
      const transport: Transport = {
        async request() {
          throw failing;
        },
      };
      const failClient = new OJSClient({ url: 'http://localhost:8080', transport });

      let caught: unknown;
      failClient.useEnqueue('observe-error', async (job, next) => {
        try {
          return await next(job);
        } catch (error) {
          caught = error;
          throw error;
        }
      });

      await expect(failClient.enqueue('email.send', {})).rejects.toBe(failing);
      expect(caught).toBe(failing);
    });

    it('should send args encrypted before next() and return the response', async () => {
      let sentArgs: unknown;
      const transport: Transport = {
        async request(options) {
          sentArgs = (options.body as { args: unknown[] }).args;
          return {
            status: 201,
            headers: {},
            body: {
              job: {
                id: 'enc-id',
                type: 'secret.job',
                queue: 'default',
                args: (options.body as { args: unknown[] }).args,
                state: 'available',
                specversion: '1.0',
              },
            },
          };
        },
      };
      const encClient = new OJSClient({ url: 'http://localhost:8080', transport });
      encClient.useEnqueue('encrypt', async (job, next) => {
        job.args = job.args.map((a) => ({ cipher: `enc(${JSON.stringify(a)})` }));
        return next(job);
      });

      const result = await encClient.enqueue('secret.job', { pan: '4111' });
      expect(sentArgs).toEqual([{ cipher: 'enc({"pan":"4111"})' }]);
      expect(result!.id).toBe('enc-id');
    });

    it('should terminate the onion in fake test mode', async () => {
      testing.fake();
      try {
        const order: string[] = [];
        client.useEnqueue('fake-onion', async (job, next) => {
          order.push('before');
          const created = await next(job);
          order.push('after');
          // In fake mode next() returns the recorded fake job (real-looking id/state).
          expect(created?.id).toBeTruthy();
          expect(created?.state).toBe('available');
          return created;
        });

        const result = await client.enqueue('email.send', { to: 'a@b.com' });
        expect(order).toEqual(['before', 'after']);
        expect(result?.state).toBe('available');
        testing.assertEnqueued('email.send', { args: [{ to: 'a@b.com' }] });
      } finally {
        testing.restore();
      }
    });

    it('should terminate the onion in inline test mode', async () => {
      testing.inline();
      try {
        let handled = false;
        testing.registerHandler('inline.job', () => {
          handled = true;
        });
        client.useEnqueue('inline-onion', async (job, next) => next(job));
        const result = await client.enqueue('inline.job', {});
        expect(handled).toBe(true);
        expect(result?.state).toBe('completed');
        testing.assertPerformed('inline.job');
      } finally {
        testing.restore();
      }
    });

    it('should validate the post-middleware envelope before transport', async () => {
      client.useEnqueue('invalidate', async (job, next) => {
        job.queue = 'INVALID QUEUE';
        return next(job);
      });

      await expect(client.enqueue('valid.job', {})).rejects.toThrow(
        'Queue name must be lowercase',
      );
      expect(mock.requests).toEqual([]);
    });

    it('should allow middleware to repair invalid original options before validation', async () => {
      mock.mockResponse('POST', '/jobs', {
        job: {
          id: 'test',
          type: 'valid.job',
          queue: 'repaired',
          args: [],
          specversion: '1.0',
        },
      }, 201);
      client.useEnqueue('repair', async (job, next) => {
        job.queue = 'repaired';
        job.unique = { keys: ['type'], period: 'PT1H' };
        return next(job);
      });

      await expect(client.enqueue('valid.job', {}, {
        queue: 'INVALID QUEUE',
        unique: { period: 'not a duration' },
      })).resolves.not.toBeNull();

      const body = mock.requests[0].body as {
        options: { queue: string; unique: unknown };
      };
      expect(body.options).toEqual({
        queue: 'repaired',
        unique: { keys: ['type'], period: 'PT1H' },
      });
    });
  });

  describe('workflow', () => {
    it('should create a workflow', async () => {
      mock.mockResponse('POST', '/workflows', {
        id: 'wf_123',
        type: 'chain',
        state: 'pending',
        metadata: { job_count: 3, completed_count: 0, failed_count: 0, created_at: new Date().toISOString() },
      }, 201);

      const { chain } = await import('../src/workflow.js');
      const status = await client.workflow(
        chain(
          { type: 'data.fetch', args: { url: 'http://example.com' } },
          { type: 'data.transform', args: { format: 'csv' } },
        ),
      );

      expect(status.state).toBe('pending');
      expect(status.metadata.job_count).toBe(3);
    });

    it('unwraps a spec-shaped { workflow: {...} } response envelope', async () => {
      // ojs-http-binding.md §14.1 and GrpcTransport's grpcCreateWorkflow
      // both wrap the status in `{ workflow: {...} }` — the same envelope
      // shape used by every other create/get response. client.workflow()
      // must return the unwrapped WorkflowStatus, not the envelope itself.
      mock.mockResponse('POST', '/workflows', {
        workflow: {
          id: 'wf_456',
          type: 'chain',
          state: 'pending',
          metadata: { job_count: 2, completed_count: 0, failed_count: 0, created_at: new Date().toISOString() },
        },
      }, 201);

      const { chain } = await import('../src/workflow.js');
      const status = await client.workflow(
        chain(
          { type: 'data.fetch', args: { url: 'http://example.com' } },
          { type: 'data.transform', args: { format: 'csv' } },
        ),
      );

      expect(status.id).toBe('wf_456');
      expect(status.state).toBe('pending');
      expect(status.metadata.job_count).toBe(2);
      // The envelope wrapper itself must never leak through.
      expect((status as unknown as { workflow?: unknown }).workflow).toBeUndefined();
    });

    it.each(['step', 'callback'] as const)(
      'rejects expiresAt on a workflow %s before calling the transport',
      async (location) => {
        const { batch, chain } = await import('../src/workflow.js');
        const definition =
          location === 'step'
            ? chain({
                type: 'data.fetch',
                args: [],
                options: { expiresAt: '2030-01-01T00:00:00Z' },
              })
            : batch(
                [{ type: 'data.fetch', args: [] }],
                {
                  on_complete: {
                    type: 'data.finish',
                    args: [],
                    options: { expiresAt: '2030-01-01T00:00:00Z' },
                  },
                },
              );

        await expect(client.workflow(definition)).rejects.toMatchObject({
          code: 'invalid_request',
          retryable: false,
        });
        expect(mock.requests).toHaveLength(0);
      },
    );
  });

  describe('getWorkflow', () => {
    it('should fetch workflow status', async () => {
      const workflowId = 'wf_123';
      mock.mockResponse('GET', `/workflows/${workflowId}`, {
        id: workflowId,
        type: 'chain',
        state: 'running',
        metadata: { job_count: 3, completed_count: 1, failed_count: 0, created_at: new Date().toISOString() },
      });

      const status = await client.getWorkflow(workflowId);
      expect(status.state).toBe('running');
      expect(status.id).toBe(workflowId);
    });

    it('unwraps a spec-shaped { workflow: {...} } response envelope', async () => {
      const workflowId = 'wf_789';
      mock.mockResponse('GET', `/workflows/${workflowId}`, {
        workflow: {
          id: workflowId,
          type: 'chain',
          state: 'running',
          metadata: { job_count: 3, completed_count: 1, failed_count: 0, created_at: new Date().toISOString() },
        },
      });

      const status = await client.getWorkflow(workflowId);
      expect(status.id).toBe(workflowId);
      expect(status.state).toBe('running');
      expect((status as unknown as { workflow?: unknown }).workflow).toBeUndefined();
    });

    it('preserves and normalizes HTTP-only workflow step fields', async () => {
      const workflowId = 'wf_http_fields';
      mock.mockResponse('GET', `/workflows/${workflowId}`, {
        workflow: {
          id: workflowId,
          type: 'chain',
          state: 'running',
          metadata: {
            job_count: 2,
            completed_count: 1,
            failed_count: 0,
            created_at: '2026-08-08T00:00:00Z',
          },
          steps: [
            {
              index: 0,
              type: 'data.fetch',
              args: [{ page: 1 }],
              options: { queue: 'etl' },
              state: 'completed',
              job_id: 'job-1',
              result: { rows: 10 },
              started_at: '2026-08-08T00:00:01Z',
              completed_at: '2026-08-08T00:00:02Z',
            },
            {
              index: 1,
              type: 'data.load',
              state: 'available',
              job_id: null,
              depends_on: ['fetch'],
            },
          ],
        },
      });

      const status = await client.getWorkflow(workflowId);

      expect(status.steps).toEqual([
        {
          index: 0,
          type: 'data.fetch',
          args: [{ page: 1 }],
          options: { queue: 'etl' },
          state: 'completed',
          job_id: 'job-1',
          result: { rows: 10 },
          started_at: '2026-08-08T00:00:01Z',
          completed_at: '2026-08-08T00:00:02Z',
        },
        {
          index: 1,
          type: 'data.load',
          state: 'available',
          job_id: null,
          depends_on: ['fetch'],
        },
      ]);
      expect('depends_on' in status.steps![0]!).toBe(false);
    });
  });

  describe('cancelWorkflow', () => {
    it('should cancel a workflow', async () => {
      const workflowId = 'wf_123';
      mock.mockResponse('DELETE', `/workflows/${workflowId}`, {});

      await client.cancelWorkflow(workflowId);

      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0].method).toBe('DELETE');
      expect(mock.requests[0].path).toBe(`/workflows/${workflowId}`);
    });
  });

  describe('health', () => {
    it('should check server health', async () => {
      mock.mockResponse('GET', '/health', {
        status: 'ok',
        version: '1.0.0',
        backend: { type: 'redis', status: 'connected' },
      });

      const health = await client.health();
      expect(health.status).toBe('ok');
      expect(health.version).toBe('1.0.0');
      expect(health.backend?.type).toBe('redis');
    });
  });

  describe('manifest', () => {
    it('should fetch the conformance manifest', async () => {
      // manifest uses rawPath, so the mock key is based on the full path
      // We need a special mock for rawPath requests
      const mockTransport = {
        ...mock.transport,
        async request<T>(options: import('../src/transport/types.js').TransportRequestOptions): Promise<import('../src/transport/types.js').TransportResponse<T>> {
          mock.requests.push(options);
          if (options.path === '/ojs/manifest') {
            return { status: 200, headers: {}, body: { specversion: '1.0', layers: [1, 2, 3] } as T };
          }
          return { status: 200, headers: {}, body: {} as T };
        },
      };

      const manifestClient = new OJSClient({ url: 'http://localhost:8080', transport: mockTransport });
      const manifest = await manifestClient.manifest();
      expect(manifest.specversion).toBe('1.0');
    });
  });

  describe('middleware accessor', () => {
    it('should expose the enqueue middleware chain', () => {
      expect(client.middleware).toBeDefined();
      expect(client.middleware.length).toBe(0);

      client.useEnqueue('test', async (job, next) => next(job));
      expect(client.middleware.length).toBe(1);
      expect(client.middleware.has('test')).toBe(true);
    });
  });

  describe('enqueue with meta', () => {
    it('should include meta in the wire format', async () => {
      mock.mockResponse('POST', '/jobs', {
        job: { id: 'test', type: 'email.send', queue: 'default', args: [], specversion: '1.0', meta: { trace_id: 'abc' } },
      }, 201);

      await client.enqueue('email.send', {}, { meta: { trace_id: 'abc' } });

      const body = mock.requests[0].body as Record<string, unknown>;
      expect(body.meta).toEqual({ trace_id: 'abc' });
    });

    it('should preserve an explicitly-empty meta object rather than dropping it', async () => {
      mock.mockResponse('POST', '/jobs', {
        job: { id: 'test', type: 'email.send', queue: 'default', args: [], specversion: '1.0' },
      }, 201);

      await client.enqueue('email.send', {}, { meta: {} });

      const body = mock.requests[0].body as Record<string, unknown>;
      expect(body.meta).toEqual({});
    });

    it('should preserve deeply nested meta values exactly', async () => {
      mock.mockResponse('POST', '/jobs', {
        job: { id: 'test', type: 'email.send', queue: 'default', args: [], specversion: '1.0' },
      }, 201);

      const nested = { user: { id: 42, roles: ['admin'] }, flags: { retryable: false, count: 0 } };
      await client.enqueue('email.send', {}, { meta: nested });

      const body = mock.requests[0].body as Record<string, unknown>;
      expect(body.meta).toEqual(nested);
    });

    it('should not mutate the caller-supplied options object', async () => {
      mock.mockResponse('POST', '/jobs', {
        job: { id: 'test', type: 'email.send', queue: 'default', args: [], specversion: '1.0' },
      }, 201);

      const options = { meta: { trace_id: 'abc' }, schema: 'urn:ojs:schema:email.send:v1' };
      const optionsCopy = JSON.parse(JSON.stringify(options));

      await client.enqueue('email.send', {}, options);

      expect(options).toEqual(optionsCopy);
    });
  });

  describe('enqueue with schema', () => {
    it('should include schema at the top level of the wire format, not inside options', async () => {
      mock.mockResponse('POST', '/jobs', {
        job: { id: 'test', type: 'email.send', queue: 'default', args: [], specversion: '1.0' },
      }, 201);

      await client.enqueue('email.send', {}, {
        schema: 'urn:ojs:schema:email.send:v1',
        queue: 'email',
      });

      const body = mock.requests[0].body as Record<string, unknown>;
      expect(body.schema).toBe('urn:ojs:schema:email.send:v1');
      const options = body.options as Record<string, unknown>;
      expect(options).not.toHaveProperty('schema');
      expect(options.queue).toBe('email');
    });

    it('should omit schema entirely when not provided', async () => {
      mock.mockResponse('POST', '/jobs', {
        job: { id: 'test', type: 'email.send', queue: 'default', args: [], specversion: '1.0' },
      }, 201);

      await client.enqueue('email.send', {});

      const body = mock.requests[0].body as Record<string, unknown>;
      expect(body.schema).toBeUndefined();
    });
  });

  describe('enqueueBatch with meta/schema', () => {
    it('should include meta/schema at the top level of each batch job, not inside options', async () => {
      mock.mockResponse('POST', '/jobs/batch', {
        jobs: [
          { id: 'j1', type: 'email.send', queue: 'default', args: [], specversion: '1.0' },
          { id: 'j2', type: 'email.send', queue: 'default', args: [], specversion: '1.0' },
        ],
      }, 201);

      await client.enqueueBatch([
        {
          type: 'email.send',
          args: { to: 'a@example.com' },
          options: { meta: { trace_id: 'a' }, schema: 'urn:ojs:schema:email.send:v1', queue: 'email' },
        },
        { type: 'email.send', args: { to: 'b@example.com' } },
      ]);

      const body = mock.requests[0].body as { jobs: Array<Record<string, unknown>> };
      expect(body.jobs[0].meta).toEqual({ trace_id: 'a' });
      expect(body.jobs[0].schema).toBe('urn:ojs:schema:email.send:v1');
      const options = body.jobs[0].options as Record<string, unknown>;
      expect(options).not.toHaveProperty('meta');
      expect(options).not.toHaveProperty('schema');
      expect(options.queue).toBe('email');

      // The second job specified neither — both must be entirely absent.
      expect(body.jobs[1]).not.toHaveProperty('meta');
      expect(body.jobs[1]).not.toHaveProperty('schema');
    });
  });
});

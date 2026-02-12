import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OJSClient } from '../src/client.js';
import type { Transport, TransportRequestOptions, TransportResponse } from '../src/transport/types.js';
import type { Job } from '../src/job.js';

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

    it('should validate job type format', async () => {
      await expect(
        client.enqueue('INVALID TYPE!', {}),
      ).rejects.toThrow();
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
  });
});

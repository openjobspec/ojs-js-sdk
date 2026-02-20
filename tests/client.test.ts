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

    it('should accept typed args via generic parameter', async () => {
      interface EmailPayload { to: string; subject: string }

      mock.mockResponse('POST', '/jobs', {
        job: { id: 'test', type: 'email.send', queue: 'default', args: [{ to: 'a@b.com', subject: 'Hi' }], specversion: '1.0' },
      }, 201);

      const job = await client.enqueue<EmailPayload>('email.send', { to: 'a@b.com', subject: 'Hi' });
      expect(job.type).toBe('email.send');

      const body = mock.requests[0].body as Record<string, unknown>;
      expect(body.args).toEqual([{ to: 'a@b.com', subject: 'Hi' }]);
    });

    it('should accept typed array args via generic parameter', async () => {
      mock.mockResponse('POST', '/jobs', {
        job: { id: 'test', type: 'process.items', queue: 'default', args: ['item1', 'item2'], specversion: '1.0' },
      }, 201);

      const job = await client.enqueue<string>('process.items', ['item1', 'item2']);
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
  });
});

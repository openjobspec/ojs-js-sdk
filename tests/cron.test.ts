import { describe, it, expect, beforeEach } from 'vitest';
import { CronOperations } from '../src/cron.js';
import type { Transport, TransportRequestOptions, TransportResponse } from '../src/transport/types.js';

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

describe('CronOperations', () => {
  let mock: ReturnType<typeof createMockTransport>;
  let cron: CronOperations;

  beforeEach(() => {
    mock = createMockTransport();
    cron = new CronOperations(mock.transport);
  });

  describe('list()', () => {
    it('returns all cron jobs', async () => {
      const responseBody = {
        cron_jobs: [
          {
            name: 'daily-report',
            cron: '0 9 * * *',
            timezone: 'America/New_York',
            type: 'report.generate',
            args: [{ format: 'pdf' }],
            status: 'active',
            last_run_at: '2024-01-15T09:00:00Z',
            next_run_at: '2024-01-16T09:00:00Z',
            created_at: '2024-01-01T00:00:00Z',
          },
        ],
        pagination: { total: 1, page: 1, per_page: 25 },
      };
      mock.mockResponse('GET', '/cron', responseBody);

      const result = await cron.list();
      expect(result.cron_jobs).toHaveLength(1);
      expect(result.cron_jobs[0].name).toBe('daily-report');
      expect(result.pagination.total).toBe(1);
      expect(mock.requests[0].method).toBe('GET');
      expect(mock.requests[0].path).toBe('/cron');
    });

    it('passes pagination parameters', async () => {
      mock.mockResponse('GET', '/cron?page=2&per_page=10', {
        cron_jobs: [],
        pagination: { total: 0, page: 2, per_page: 10 },
      });

      await cron.list({ page: 2, per_page: 10 });
      expect(mock.requests[0].path).toBe('/cron?page=2&per_page=10');
    });
  });

  describe('register()', () => {
    it('registers a new cron job', async () => {
      const cronJob = {
        name: 'daily-report',
        cron: '0 9 * * *',
        timezone: 'America/New_York',
        type: 'report.generate',
        args: [{ format: 'pdf' }],
        status: 'active',
        created_at: '2024-01-01T00:00:00Z',
      };
      mock.mockResponse('POST', '/cron', { cron_job: cronJob }, 201);

      const result = await cron.register({
        name: 'daily-report',
        cron: '0 9 * * *',
        timezone: 'America/New_York',
        type: 'report.generate',
        args: [{ format: 'pdf' }],
      });

      expect(result.name).toBe('daily-report');
      expect(mock.requests[0].method).toBe('POST');
      expect(mock.requests[0].path).toBe('/cron');

      const body = mock.requests[0].body as Record<string, unknown>;
      expect(body.name).toBe('daily-report');
      expect(body.cron).toBe('0 9 * * *');
      expect(body.timezone).toBe('America/New_York');
      expect(body.type).toBe('report.generate');
      expect(body.args).toEqual([{ format: 'pdf' }]);
    });

    it('wraps non-array args in an array', async () => {
      mock.mockResponse('POST', '/cron', {
        cron_job: {
          name: 'test',
          cron: '* * * * *',
          type: 'test.job',
          args: [{ key: 'value' }],
          status: 'active',
          created_at: '2024-01-01T00:00:00Z',
        },
      }, 201);

      await cron.register({
        name: 'test',
        cron: '* * * * *',
        type: 'test.job',
        args: { key: 'value' },
      });

      const body = mock.requests[0].body as Record<string, unknown>;
      expect(body.args).toEqual([{ key: 'value' }]);
    });

    it('includes optional fields when provided', async () => {
      mock.mockResponse('POST', '/cron', {
        cron_job: {
          name: 'test',
          cron: '* * * * *',
          type: 'test.job',
          args: [],
          status: 'active',
          created_at: '2024-01-01T00:00:00Z',
        },
      }, 201);

      await cron.register({
        name: 'test',
        cron: '* * * * *',
        type: 'test.job',
        args: [],
        meta: { team: 'backend' },
        options: { queue: 'high-priority', tags: ['critical'] },
      });

      const body = mock.requests[0].body as Record<string, unknown>;
      expect(body.meta).toEqual({ team: 'backend' });
      expect(body.options).toEqual({ queue: 'high-priority', tags: ['critical'] });
    });

    it('omits optional fields when not provided', async () => {
      mock.mockResponse('POST', '/cron', {
        cron_job: {
          name: 'test',
          cron: '* * * * *',
          type: 'test.job',
          args: [],
          status: 'active',
          created_at: '2024-01-01T00:00:00Z',
        },
      }, 201);

      await cron.register({
        name: 'test',
        cron: '* * * * *',
        type: 'test.job',
        args: [],
      });

      const body = mock.requests[0].body as Record<string, unknown>;
      expect(body.timezone).toBeUndefined();
      expect(body.meta).toBeUndefined();
      expect(body.options).toBeUndefined();
    });
  });

  describe('unregister()', () => {
    it('sends DELETE to cron endpoint', async () => {
      await cron.unregister('daily-report');
      expect(mock.requests[0].method).toBe('DELETE');
      expect(mock.requests[0].path).toBe('/cron/daily-report');
    });

    it('encodes cron name in URL', async () => {
      await cron.unregister('my/cron job');
      expect(mock.requests[0].path).toBe(`/cron/${encodeURIComponent('my/cron job')}`);
    });
  });
});

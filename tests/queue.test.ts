import { describe, it, expect, beforeEach } from 'vitest';
import { QueueOperations } from '../src/queue.js';
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

describe('QueueOperations', () => {
  let mock: ReturnType<typeof createMockTransport>;
  let queues: QueueOperations;

  beforeEach(() => {
    mock = createMockTransport();
    queues = new QueueOperations(mock.transport);
  });

  describe('list()', () => {
    it('returns all queues', async () => {
      mock.mockResponse('GET', '/queues', {
        queues: [
          { name: 'default', paused: false },
          { name: 'high-priority', paused: true },
        ],
      });

      const result = await queues.list();
      expect(result).toEqual([
        { name: 'default', paused: false },
        { name: 'high-priority', paused: true },
      ]);
      expect(mock.requests[0].method).toBe('GET');
      expect(mock.requests[0].path).toBe('/queues');
    });
  });

  describe('stats()', () => {
    it('returns queue statistics', async () => {
      const stats = {
        name: 'default',
        available: 10,
        active: 3,
        scheduled: 5,
        retryable: 1,
        completed: 100,
        discarded: 2,
        paused: false,
      };
      mock.mockResponse('GET', '/queues/default/stats', stats);

      const result = await queues.stats('default');
      expect(result).toEqual(stats);
    });

    it('encodes queue name in URL', async () => {
      mock.mockResponse('GET', '/queues/my.queue/stats', {
        name: 'my.queue', available: 0, active: 0, scheduled: 0,
        retryable: 0, completed: 0, discarded: 0, paused: false,
      });

      await queues.stats('my.queue');
      expect(mock.requests[0].path).toBe('/queues/my.queue/stats');
    });
  });

  describe('pause()', () => {
    it('sends POST to pause endpoint', async () => {
      await queues.pause('default');
      expect(mock.requests[0].method).toBe('POST');
      expect(mock.requests[0].path).toBe('/queues/default/pause');
    });
  });

  describe('resume()', () => {
    it('sends POST to resume endpoint', async () => {
      await queues.resume('default');
      expect(mock.requests[0].method).toBe('POST');
      expect(mock.requests[0].path).toBe('/queues/default/resume');
    });
  });

  describe('listDeadLetter()', () => {
    it('returns dead letter jobs', async () => {
      const deadLetterJobs = [
        {
          id: 'job-1',
          type: 'email.send',
          queue: 'default',
          args: [{ to: 'test@test.com' }],
          error: { code: 'handler_error', message: 'failed' },
          discarded_at: '2024-01-15T10:00:00Z',
          total_attempts: 3,
        },
      ];
      mock.mockResponse('GET', '/dead-letter', { jobs: deadLetterJobs });

      const result = await queues.listDeadLetter();
      expect(result).toEqual(deadLetterJobs);
      expect(mock.requests[0].method).toBe('GET');
      expect(mock.requests[0].path).toBe('/dead-letter');
    });
  });

  describe('retryDeadLetter()', () => {
    it('sends POST to retry endpoint', async () => {
      await queues.retryDeadLetter('job-1');
      expect(mock.requests[0].method).toBe('POST');
      expect(mock.requests[0].path).toBe('/dead-letter/job-1/retry');
    });

    it('encodes job ID in URL', async () => {
      await queues.retryDeadLetter('job/with/slashes');
      expect(mock.requests[0].path).toBe(`/dead-letter/${encodeURIComponent('job/with/slashes')}/retry`);
    });
  });

  describe('discardDeadLetter()', () => {
    it('sends DELETE to dead letter endpoint', async () => {
      await queues.discardDeadLetter('job-1');
      expect(mock.requests[0].method).toBe('DELETE');
      expect(mock.requests[0].path).toBe('/dead-letter/job-1');
    });
  });
});

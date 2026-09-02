import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLambdaHandler } from '../src/serverless/lambda.js';
import type { SQSEvent, SQSBatchResponse } from '../src/serverless/lambda.js';

describe('Lambda serverless adapter', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    );
  });

  describe('sqsHandler', () => {
    it('processes valid SQS records', async () => {
      const processed: string[] = [];
      const handler = createLambdaHandler({ url: 'http://ojs.test', allowInsecurePush: true });
      handler.register('email.send', async (ctx) => {
        processed.push(ctx.job.id);
      });

      const event: SQSEvent = {
        Records: [
          {
            messageId: 'msg-1',
            body: JSON.stringify({
              id: 'job-1',
              type: 'email.send',
              args: ['user@test.com'],
              queue: 'email',
              state: 'active',
            }),
          },
        ],
      };

      const result = await handler.sqsHandler(event);

      expect(result.batchItemFailures).toHaveLength(0);
      expect(processed).toEqual(['job-1']);
    });

    it('reports failures for invalid JSON records', async () => {
      const handler = createLambdaHandler({ url: 'http://ojs.test', allowInsecurePush: true });
      handler.register('test', async () => {});

      const event: SQSEvent = {
        Records: [
          { messageId: 'bad-1', body: 'not-json' },
        ],
      };

      const result = await handler.sqsHandler(event);

      expect(result.batchItemFailures).toHaveLength(1);
      expect(result.batchItemFailures[0]!.itemIdentifier).toBe('bad-1');
    });

    it('reports failures for unregistered job types', async () => {
      const handler = createLambdaHandler({ url: 'http://ojs.test', allowInsecurePush: true });

      const event: SQSEvent = {
        Records: [
          {
            messageId: 'msg-1',
            body: JSON.stringify({
              id: 'job-1',
              type: 'unknown.type',
              args: [],
              queue: 'default',
              state: 'active',
            }),
          },
        ],
      };

      const result = await handler.sqsHandler(event);

      expect(result.batchItemFailures).toHaveLength(1);
      expect(result.batchItemFailures[0]!.itemIdentifier).toBe('msg-1');
    });

    it('handles partial batch failures', async () => {
      const handler = createLambdaHandler({ url: 'http://ojs.test', allowInsecurePush: true });
      handler.register('good.job', async () => {});
      handler.register('bad.job', async () => {
        throw new Error('handler failure');
      });

      const event: SQSEvent = {
        Records: [
          {
            messageId: 'msg-1',
            body: JSON.stringify({ id: 'j1', type: 'good.job', args: [], queue: 'q', state: 'active' }),
          },
          {
            messageId: 'msg-2',
            body: JSON.stringify({ id: 'j2', type: 'bad.job', args: [], queue: 'q', state: 'active' }),
          },
          {
            messageId: 'msg-3',
            body: JSON.stringify({ id: 'j3', type: 'good.job', args: [], queue: 'q', state: 'active' }),
          },
        ],
      };

      const result = await handler.sqsHandler(event);

      expect(result.batchItemFailures).toHaveLength(1);
      expect(result.batchItemFailures[0]!.itemIdentifier).toBe('msg-2');
    });

    it('handles empty SQS event', async () => {
      const handler = createLambdaHandler({ url: 'http://ojs.test', allowInsecurePush: true });
      const result = await handler.sqsHandler({ Records: [] });
      expect(result.batchItemFailures).toHaveLength(0);
    });
  });

  describe('httpHandler', () => {
    it('processes valid HTTP push delivery', async () => {
      const processed: string[] = [];
      const handler = createLambdaHandler({ url: 'http://ojs.test', allowInsecurePush: true });
      handler.register('email.send', async (ctx) => {
        processed.push(ctx.job.id);
      });

      const result = await handler.httpHandler({
        requestContext: { http: { method: 'POST' } },
        body: JSON.stringify({
          job: {
            id: 'job-http-1',
            type: 'email.send',
            args: ['test'],
            queue: 'email',
            state: 'active',
          },
        }),
      });

      expect(result.statusCode).toBe(200);
      expect(processed).toEqual(['job-http-1']);
    });

    it('rejects non-POST methods', async () => {
      const handler = createLambdaHandler({ url: 'http://ojs.test', allowInsecurePush: true });

      const result = await handler.httpHandler({
        requestContext: { http: { method: 'GET' } },
      });

      expect(result.statusCode).toBe(405);
    });

    it('returns 400 for invalid body', async () => {
      const handler = createLambdaHandler({ url: 'http://ojs.test', allowInsecurePush: true });

      const result = await handler.httpHandler({
        requestContext: { http: { method: 'POST' } },
        body: 'not-json{{{',
      });

      expect(result.statusCode).toBe(400);
    });

    it('returns the push protocol completed response on success without any OJS server callback', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      vi.stubGlobal('fetch', fetchSpy);

      const handler = createLambdaHandler({ url: 'http://ojs.test', allowInsecurePush: true });
      handler.register('ack.test', async () => {});

      const result = await handler.httpHandler({
        requestContext: { http: { method: 'POST' } },
        body: JSON.stringify({
          job: { id: 'j-ack', type: 'ack.test', args: [], queue: 'q', state: 'active' },
        }),
      });

      // The HTTP push protocol response is now the sole state-transition
      // signal; the handler no longer performs a follow-up OJS
      // `/workers/ack` callback request. The backend that pushed this job
      // derives the state transition from the returned response.
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body as string)).toEqual({
        status: 'completed',
        job_id: 'j-ack',
      });
    });

    it('returns a structured HTTP 200 failed response on handler failure without any OJS server callback', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      vi.stubGlobal('fetch', fetchSpy);

      const handler = createLambdaHandler({ url: 'http://ojs.test', allowInsecurePush: true });
      handler.register('fail.test', async () => {
        throw new Error('processing failed');
      });

      const result = await handler.httpHandler({
        requestContext: { http: { method: 'POST' } },
        body: JSON.stringify({
          job: { id: 'j-nack', type: 'fail.test', args: [], queue: 'q', state: 'active' },
        }),
      });

      // Neither an ACK nor a NACK callback is ever issued; the backend
      // derives the failed transition from this HTTP 200 response alone.
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body as string)).toEqual({
        status: 'failed',
        job_id: 'j-nack',
        error: {
          code: 'handler_error',
          message: 'processing failed',
          retryable: true,
        },
      });
    });

    it('never calls fetch even when apiKey/url/callbackTimeoutMs are configured (deprecated, unused options)', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      vi.stubGlobal('fetch', fetchSpy);

      const handler = createLambdaHandler({
        url: 'http://ojs.test',
        apiKey: 'secret',
        callbackTimeoutMs: 1234,
        allowInsecurePush: true,
      });
      handler.register('auth.test', async () => {});

      const result = await handler.httpHandler({
        requestContext: { http: { method: 'POST' } },
        body: JSON.stringify({
          job: { id: 'j-auth', type: 'auth.test', args: [], queue: 'q', state: 'active' },
        }),
      });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body as string)).toEqual({
        status: 'completed',
        job_id: 'j-auth',
      });
    });
  });

  describe('directHandler', () => {
    it('processes direct invocation', async () => {
      const handler = createLambdaHandler({ url: 'http://ojs.test', allowInsecurePush: true });
      handler.register('direct.test', async () => {});

      const result = await handler.directHandler({
        id: 'j-direct',
        type: 'direct.test',
        args: [],
        queue: 'default',
        state: 'active',
      });

      expect(result.status).toBe('completed');
      expect(result.job_id).toBe('j-direct');
    });

    it('returns failure on handler error', async () => {
      const handler = createLambdaHandler({ url: 'http://ojs.test', allowInsecurePush: true });
      handler.register('fail.direct', async () => {
        throw new Error('direct failure');
      });

      const result = await handler.directHandler({
        id: 'j-fail',
        type: 'fail.direct',
        args: [],
        queue: 'default',
        state: 'active',
      });

      expect(result.status).toBe('failed');
      expect(result.error).toBe('direct failure');
    });
  });

  describe('register', () => {
    it('allows registering multiple handlers', () => {
      const handler = createLambdaHandler({ url: 'http://ojs.test', allowInsecurePush: true });
      handler.register('type.a', async () => {});
      handler.register('type.b', async () => {});
      // No throw = success
    });
  });
});

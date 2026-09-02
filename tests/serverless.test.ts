import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWorkerHandler } from '../src/serverless/cloudflare.js';
import { createEdgeHandler } from '../src/serverless/vercel.js';

function makeJobRequest(
  type: string,
  id: string = 'job-1',
  method: string = 'POST',
): Request {
  return new Request('https://worker.example.com/ojs', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id,
      type,
      args: ['arg1'],
      queue: 'default',
      state: 'active',
    }),
  });
}

describe('Cloudflare Workers adapter', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    );
  });

  it('processes valid POST request', async () => {
    const processed: string[] = [];
    const handler = createWorkerHandler({ url: 'http://ojs.test', allowInsecurePush: true });
    handler.register('email.send', async (ctx) => {
      processed.push(ctx.job.id);
    });

    const response = await handler.handleRequest(makeJobRequest('email.send'));

    expect(response.status).toBe(200);
    expect(processed).toEqual(['job-1']);
    const body = await response.json();
    expect(body.status).toBe('completed');
  });

  it('rejects non-POST methods', async () => {
    const handler = createWorkerHandler({ url: 'http://ojs.test', allowInsecurePush: true });
    const request = new Request('https://worker.example.com', { method: 'GET' });

    const response = await handler.handleRequest(request);

    expect(response.status).toBe(405);
  });

  it('returns 400 for invalid JSON', async () => {
    const handler = createWorkerHandler({ url: 'http://ojs.test', allowInsecurePush: true });
    const request = new Request('https://worker.example.com', {
      method: 'POST',
      body: 'not-json{{{',
    });

    const response = await handler.handleRequest(request);

    expect(response.status).toBe(400);
  });

  it('returns the normal HTTP 200 failed push response for an unregistered job type without a callback', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);
    const handler = createWorkerHandler({ url: 'http://ojs.test', allowInsecurePush: true });
    const response = await handler.handleRequest(
      makeJobRequest('unknown.type', 'j-missing'),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'failed',
      job_id: 'j-missing',
      error: {
        code: 'handler_error',
        message: 'No handler registered for job type: unknown.type',
        retryable: true,
      },
    });
  });

  it('returns the push protocol completed response on success without any OJS server callback', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);

    const handler = createWorkerHandler({ url: 'http://ojs.test', allowInsecurePush: true });
    handler.register('ack.test', async () => {});

    const response = await handler.handleRequest(makeJobRequest('ack.test', 'j-ack'));

    // The HTTP push protocol response is now the sole state-transition
    // signal; the handler no longer performs a follow-up OJS
    // `/workers/ack` callback request. The backend that pushed this job
    // derives the state transition from the returned response.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'completed', job_id: 'j-ack' });
  });

  it('returns a structured HTTP 200 failed response on handler failure without any OJS server callback', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);

    const handler = createWorkerHandler({ url: 'http://ojs.test', allowInsecurePush: true });
    handler.register('fail.test', async () => {
      throw new Error('cf failure');
    });

    const response = await handler.handleRequest(makeJobRequest('fail.test', 'j-fail'));

    // Neither an ACK nor a NACK callback is ever issued; the backend derives
    // the failed transition from this HTTP 200 response alone.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'failed',
      job_id: 'j-fail',
      error: { code: 'handler_error', message: 'cf failure', retryable: true },
    });
  });

  it('never calls fetch even when apiKey/url/callbackTimeoutMs are configured (deprecated, unused options)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);

    const handler = createWorkerHandler({
      url: 'http://ojs.test',
      apiKey: 'secret',
      callbackTimeoutMs: 1234,
      allowInsecurePush: true,
    });
    handler.register('auth.test', async () => {});

    const response = await handler.handleRequest(makeJobRequest('auth.test', 'j-auth'));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'completed', job_id: 'j-auth' });
  });

  it('passes request object to handler context', async () => {
    let capturedRequest: Request | undefined;
    const handler = createWorkerHandler({ url: 'http://ojs.test', allowInsecurePush: true });
    handler.register('ctx.test', async (ctx) => {
      capturedRequest = ctx.request;
    });

    const request = makeJobRequest('ctx.test');
    await handler.handleRequest(request);

    expect(capturedRequest).toBeDefined();
  });

  describe('push-auth body acquisition (Finding: push-auth body acquisition)', () => {
    it('returns a controlled HTTP 400 for a Request whose body was already consumed, without throwing', async () => {
      const handler = createWorkerHandler({ url: 'http://ojs.test', allowInsecurePush: true });
      handler.register('email.send', async () => {});

      const request = makeJobRequest('email.send');
      // Consume the body before handing the request to the adapter --
      // simulates a framework/middleware that already read it (e.g. via
      // logging, a duplicate parse elsewhere in the same handler).
      await request.clone().text();
      await request.text();
      expect(request.bodyUsed).toBe(true);

      let response: Response | undefined;
      await expect(
        (async () => {
          response = await handler.handleRequest(request);
        })(),
      ).resolves.not.toThrow();

      expect(response?.status).toBe(400);
      const body = await response!.json();
      expect(body.error).toMatch(/already been read|locked/i);
    });

    it('returns a controlled HTTP 400 for a Request whose body is currently locked by another reader, without throwing', async () => {
      const handler = createWorkerHandler({ url: 'http://ojs.test', allowInsecurePush: true });
      handler.register('email.send', async () => {});

      const request = makeJobRequest('email.send');
      // Acquire a reader and never release it -- locks the body stream
      // without marking it fully consumed.
      const lockingReader = request.body?.getReader();
      expect(request.body?.locked).toBe(true);

      let response: Response | undefined;
      await expect(
        (async () => {
          response = await handler.handleRequest(request);
        })(),
      ).resolves.not.toThrow();

      expect(response?.status).toBe(400);
      const body = await response!.json();
      expect(body.error).toMatch(/already been read|locked/i);

      lockingReader?.releaseLock();
    });
  });
});

describe('Vercel Edge adapter', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    );
  });

  it('processes valid POST request', async () => {
    const processed: string[] = [];
    const handler = createEdgeHandler({ url: 'http://ojs.test', allowInsecurePush: true });
    handler.register('report.gen', async (ctx) => {
      processed.push(ctx.job.id);
    });

    const response = await handler.handleRequest(makeJobRequest('report.gen'));

    expect(response.status).toBe(200);
    expect(processed).toEqual(['job-1']);
  });

  it('rejects non-POST methods', async () => {
    const handler = createEdgeHandler({ url: 'http://ojs.test', allowInsecurePush: true });
    const request = new Request('https://edge.example.com', { method: 'GET' });

    const response = await handler.handleRequest(request);

    expect(response.status).toBe(405);
  });

  it('returns 400 for invalid JSON', async () => {
    const handler = createEdgeHandler({ url: 'http://ojs.test', allowInsecurePush: true });
    const request = new Request('https://edge.example.com', {
      method: 'POST',
      body: '{invalid',
    });

    const response = await handler.handleRequest(request);

    expect(response.status).toBe(400);
  });

  it('returns the normal HTTP 200 failed push response for an unregistered job type without a callback', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);
    const handler = createEdgeHandler({ url: 'http://ojs.test', allowInsecurePush: true });
    const response = await handler.handleRequest(
      makeJobRequest('unknown.type', 'j-missing'),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'failed',
      job_id: 'j-missing',
      error: {
        code: 'handler_error',
        message: 'No handler registered for job type: unknown.type',
        retryable: true,
      },
    });
  });

  it('returns the push protocol completed response on success without any OJS server callback', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);

    const handler = createEdgeHandler({ url: 'http://ojs.test', allowInsecurePush: true });
    handler.register('ack.test', async () => {});

    const response = await handler.handleRequest(makeJobRequest('ack.test', 'j-ack'));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'completed', job_id: 'j-ack' });
  });

  it('returns a structured HTTP 200 failed response on handler failure without any OJS server callback', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);

    const handler = createEdgeHandler({ url: 'http://ojs.test', allowInsecurePush: true });
    handler.register('fail.test', async () => {
      throw new Error('edge failure');
    });

    const response = await handler.handleRequest(makeJobRequest('fail.test', 'j-fail'));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'failed',
      job_id: 'j-fail',
      error: { code: 'handler_error', message: 'edge failure', retryable: true },
    });
  });

  it('never calls fetch even when apiKey/url/callbackTimeoutMs are configured (deprecated, unused options)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);

    const handler = createEdgeHandler({
      url: 'http://ojs.test',
      apiKey: 'secret',
      callbackTimeoutMs: 1234,
      allowInsecurePush: true,
    });
    handler.register('auth.test', async () => {});

    const response = await handler.handleRequest(makeJobRequest('auth.test', 'j-auth'));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'completed', job_id: 'j-auth' });
  });

  describe('push-auth body acquisition (Finding: push-auth body acquisition)', () => {
    it('returns a controlled HTTP 400 for a Request whose body was already consumed, without throwing', async () => {
      const handler = createEdgeHandler({ url: 'http://ojs.test', allowInsecurePush: true });
      handler.register('email.send', async () => {});

      const request = makeJobRequest('email.send');
      await request.clone().text();
      await request.text();
      expect(request.bodyUsed).toBe(true);

      let response: Response | undefined;
      await expect(
        (async () => {
          response = await handler.handleRequest(request);
        })(),
      ).resolves.not.toThrow();

      expect(response?.status).toBe(400);
      const body = await response!.json();
      expect(body.error).toMatch(/already been read|locked/i);
    });

    it('returns a controlled HTTP 400 for a Request whose body is currently locked by another reader, without throwing', async () => {
      const handler = createEdgeHandler({ url: 'http://ojs.test', allowInsecurePush: true });
      handler.register('email.send', async () => {});

      const request = makeJobRequest('email.send');
      const lockingReader = request.body?.getReader();
      expect(request.body?.locked).toBe(true);

      let response: Response | undefined;
      await expect(
        (async () => {
          response = await handler.handleRequest(request);
        })(),
      ).resolves.not.toThrow();

      expect(response?.status).toBe(400);
      const body = await response!.json();
      expect(body.error).toMatch(/already been read|locked/i);

      lockingReader?.releaseLock();
    });
  });
});

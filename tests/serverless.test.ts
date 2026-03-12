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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  it('processes valid POST request', async () => {
    const processed: string[] = [];
    const handler = createWorkerHandler({ url: 'http://ojs.test' });
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
    const handler = createWorkerHandler({ url: 'http://ojs.test' });
    const request = new Request('https://worker.example.com', { method: 'GET' });

    const response = await handler.handleRequest(request);

    expect(response.status).toBe(405);
  });

  it('returns 400 for invalid JSON', async () => {
    const handler = createWorkerHandler({ url: 'http://ojs.test' });
    const request = new Request('https://worker.example.com', {
      method: 'POST',
      body: 'not-json{{{',
    });

    const response = await handler.handleRequest(request);

    expect(response.status).toBe(400);
  });

  it('returns 422 for unregistered job type', async () => {
    const handler = createWorkerHandler({ url: 'http://ojs.test' });
    const response = await handler.handleRequest(makeJobRequest('unknown.type'));

    expect(response.status).toBe(422);
  });

  it('calls ack on success', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);

    const handler = createWorkerHandler({ url: 'http://ojs.test' });
    handler.register('ack.test', async () => {});

    await handler.handleRequest(makeJobRequest('ack.test', 'j-ack'));

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://ojs.test/ojs/v1/jobs/j-ack/ack',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('calls nack on handler error', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);

    const handler = createWorkerHandler({ url: 'http://ojs.test' });
    handler.register('fail.test', async () => {
      throw new Error('cf failure');
    });

    const response = await handler.handleRequest(makeJobRequest('fail.test', 'j-fail'));

    expect(response.status).toBe(500);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://ojs.test/ojs/v1/jobs/j-fail/nack',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('passes request object to handler context', async () => {
    let capturedRequest: Request | undefined;
    const handler = createWorkerHandler({ url: 'http://ojs.test' });
    handler.register('ctx.test', async (ctx) => {
      capturedRequest = ctx.request;
    });

    const request = makeJobRequest('ctx.test');
    await handler.handleRequest(request);

    expect(capturedRequest).toBeDefined();
  });
});

describe('Vercel Edge adapter', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  it('processes valid POST request', async () => {
    const processed: string[] = [];
    const handler = createEdgeHandler({ url: 'http://ojs.test' });
    handler.register('report.gen', async (ctx) => {
      processed.push(ctx.job.id);
    });

    const response = await handler.handleRequest(makeJobRequest('report.gen'));

    expect(response.status).toBe(200);
    expect(processed).toEqual(['job-1']);
  });

  it('rejects non-POST methods', async () => {
    const handler = createEdgeHandler({ url: 'http://ojs.test' });
    const request = new Request('https://edge.example.com', { method: 'GET' });

    const response = await handler.handleRequest(request);

    expect(response.status).toBe(405);
  });

  it('returns 400 for invalid JSON', async () => {
    const handler = createEdgeHandler({ url: 'http://ojs.test' });
    const request = new Request('https://edge.example.com', {
      method: 'POST',
      body: '{invalid',
    });

    const response = await handler.handleRequest(request);

    expect(response.status).toBe(400);
  });

  it('returns 422 for unregistered job type', async () => {
    const handler = createEdgeHandler({ url: 'http://ojs.test' });
    const response = await handler.handleRequest(makeJobRequest('unknown.type'));

    expect(response.status).toBe(422);
  });

  it('calls ack on success', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);

    const handler = createEdgeHandler({ url: 'http://ojs.test' });
    handler.register('ack.test', async () => {});

    await handler.handleRequest(makeJobRequest('ack.test', 'j-ack'));

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://ojs.test/ojs/v1/jobs/j-ack/ack',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('calls nack on handler error', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);

    const handler = createEdgeHandler({ url: 'http://ojs.test' });
    handler.register('fail.test', async () => {
      throw new Error('edge failure');
    });

    const response = await handler.handleRequest(makeJobRequest('fail.test', 'j-fail'));

    expect(response.status).toBe(500);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://ojs.test/ojs/v1/jobs/j-fail/nack',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

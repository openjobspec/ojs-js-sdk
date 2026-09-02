import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifyPushSignature,
  verifyPushAuth,
  readBoundedRequestBody,
} from '../src/serverless/push-auth.js';
import { createLambdaHandler } from '../src/serverless/lambda.js';
import { createWorkerHandler } from '../src/serverless/cloudflare.js';
import { createEdgeHandler } from '../src/serverless/vercel.js';

const SECRET = 'test-secret-key-12345';
const SECRET2 = 'rotated-secret-key-67890';

function sign(body: string, secret: string, timestamp?: number): { ts: string; sig: string } {
  const ts = String(timestamp ?? Math.floor(Date.now() / 1000));
  const payload = `${ts}.${body}`;
  const hex = createHmac('sha256', secret).update(payload).digest('hex');
  return { ts, sig: `sha256=${hex}` };
}

function makeEnvelope(jobType = 'test.job', jobId = 'job-1') {
  return JSON.stringify({
    job: { id: jobId, type: jobType, args: ['arg1'], queue: 'default', state: 'active' },
    worker_id: 'w-1',
    delivery_id: 'd-1',
  });
}

describe('push-auth: verifyPushSignature', () => {
  it('valid signature passes', () => {
    const body = makeEnvelope();
    const { ts, sig } = sign(body, SECRET);
    const result = verifyPushSignature(body, ts, sig, [SECRET]);
    expect(result.ok).toBe(true);
  });

  it('tampered body fails', () => {
    const body = makeEnvelope();
    const { ts, sig } = sign(body, SECRET);
    const tampered = body.replace('job-1', 'job-2');
    const result = verifyPushSignature(tampered, ts, sig, [SECRET]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it('replay (old timestamp) fails', () => {
    const body = makeEnvelope();
    const oldTs = Math.floor(Date.now() / 1000) - 600; // 10 min ago
    const { ts, sig } = sign(body, SECRET, oldTs);
    const result = verifyPushSignature(body, ts, sig, [SECRET]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('freshness');
  });

  it('future timestamp fails', () => {
    const body = makeEnvelope();
    const futureTs = Math.floor(Date.now() / 1000) + 600;
    const { ts, sig } = sign(body, SECRET, futureTs);
    const result = verifyPushSignature(body, ts, sig, [SECRET]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('freshness');
  });

  it('rotation: second secret succeeds', () => {
    const body = makeEnvelope();
    const { ts, sig } = sign(body, SECRET2);
    const result = verifyPushSignature(body, ts, sig, [SECRET, SECRET2]);
    expect(result.ok).toBe(true);
  });

  it('rotation: second comma-separated signature succeeds', () => {
    const body = makeEnvelope();
    const { ts, sig } = sign(body, SECRET);
    const wrong = sign(body, SECRET2, Number(ts)).sig;
    const result = verifyPushSignature(body, ts, `${wrong}, ${sig}`, [SECRET]);
    expect(result.ok).toBe(true);
  });

  it('missing timestamp header fails', () => {
    const body = makeEnvelope();
    const result = verifyPushSignature(body, null, 'sha256=abc', [SECRET]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it('missing signature header fails', () => {
    const body = makeEnvelope();
    const result = verifyPushSignature(body, '12345', null, [SECRET]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it('oversize body rejected', () => {
    const body = 'x'.repeat(100);
    const { ts, sig } = sign(body, SECRET);
    const result = verifyPushSignature(body, ts, sig, [SECRET], 300, 50);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(413);
  });

  it('oversize header rejected', () => {
    const body = makeEnvelope();
    const bigHeader = 'a'.repeat(9000);
    const result = verifyPushSignature(body, bigHeader, 'sha256=abc', [SECRET]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });
});

describe('push-auth: verifyPushAuth integration', () => {
  it('no secret + no insecure → fail closed', () => {
    const body = makeEnvelope();
    const result = verifyPushAuth(body, '123', 'sha256=abc', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(500);
  });

  it('no secret + insecure → pass through', () => {
    const body = makeEnvelope();
    const result = verifyPushAuth(body, null, null, { allowInsecurePush: true });
    expect(result.ok).toBe(true);
  });

  it('verifies without relying on the Node Buffer global', () => {
    const body = makeEnvelope();
    const { ts, sig } = sign(body, SECRET);
    vi.stubGlobal('Buffer', undefined);
    const result = verifyPushAuth(new TextEncoder().encode(body), ts, sig, {
      signingSecret: SECRET,
    });
    expect(result.ok).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe('push-auth: readBoundedRequestBody chunk assembly', () => {
  it('reassembles 500,000 one-byte chunks under the body limit without a call-stack error', async () => {
    const totalBytes = 500_000;
    const expected = new Uint8Array(totalBytes);
    for (let i = 0; i < totalBytes; i++) {
      expected[i] = i % 256;
    }

    // Duck-typed fake reader mirroring the Fetch API `ReadableStreamDefaultReader`
    // shape `readBoundedRequestBody` actually depends on (`read()`/`releaseLock()`/
    // `cancel()`), yielding the payload one byte at a time to reproduce a
    // fragmented/slow-loris style request body. A real `ReadableStream`
    // driving 500,000 individual one-byte `read()` calls is prohibitively
    // slow in this test environment; this fake isolates the code path under
    // test (chunk accumulation in `readBoundedRequestBody`) from that
    // unrelated per-read engine overhead while remaining a faithful
    // structural stand-in for the real Fetch API reader.
    let index = 0;
    const reader = {
      async read(): Promise<{ done: boolean; value?: Uint8Array }> {
        if (index >= totalBytes) return { done: true };
        const value = expected.subarray(index, index + 1);
        index += 1;
        return { done: false, value };
      },
      releaseLock(): void {},
      async cancel(): Promise<void> {},
    };

    const request = {
      headers: new Headers(),
      body: { getReader: () => reader },
    } as unknown as Request;

    const result = await readBoundedRequestBody(request, {
      maxBodyBytes: 10 * 1024 * 1024,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rawBody.byteLength).toBe(totalBytes);
      expect(result.rawBody).toEqual(expected);
    }
  });
});

describe('push-auth: readBoundedRequestBody body acquisition (Finding: push-auth body acquisition)', () => {
  it('returns a controlled HTTP 400 without throwing for an already-consumed (bodyUsed) request, never calling getReader()', async () => {
    const getReaderSpy = vi.fn();
    const request = {
      headers: new Headers(),
      bodyUsed: true,
      body: { locked: false, getReader: getReaderSpy },
    } as unknown as Request;

    const result = await readBoundedRequestBody(request, { maxBodyBytes: 1024 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/already been read|locked/i);
    }
    expect(getReaderSpy).not.toHaveBeenCalled();
  });

  it('returns a controlled HTTP 400 without throwing for a locked request body, never calling getReader()', async () => {
    const getReaderSpy = vi.fn();
    const request = {
      headers: new Headers(),
      bodyUsed: false,
      body: { locked: true, getReader: getReaderSpy },
    } as unknown as Request;

    const result = await readBoundedRequestBody(request, { maxBodyBytes: 1024 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/already been read|locked/i);
    }
    expect(getReaderSpy).not.toHaveBeenCalled();
  });

  it('returns a controlled HTTP 400 without throwing when getReader() itself throws synchronously, for a reason the bodyUsed/locked flags do not predict', async () => {
    const request = {
      headers: new Headers(),
      bodyUsed: false,
      body: {
        locked: false,
        getReader: () => {
          throw new TypeError('simulated unexpected getReader() failure');
        },
      },
    } as unknown as Request;

    let result: Awaited<ReturnType<typeof readBoundedRequestBody>> | undefined;
    await expect(
      (async () => {
        result = await readBoundedRequestBody(request, { maxBodyBytes: 1024 });
      })(),
    ).resolves.not.toThrow();

    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/failed to read/i);
    }
  });

  it('reads a real, unconsumed, unlocked Fetch API Request body normally (sanity check: the new guards do not reject valid requests)', async () => {
    const request = new Request('https://example.com', {
      method: 'POST',
      body: 'hello world',
    });

    const result = await readBoundedRequestBody(request, { maxBodyBytes: 1024 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new TextDecoder().decode(result.rawBody)).toBe('hello world');
    }
  });
});

describe('push-auth: Lambda adapter', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('valid signed request succeeds', async () => {
    const handler = createLambdaHandler({ url: 'http://ojs.test', signingSecret: SECRET });
    handler.register('test.job', async () => {});
    const body = makeEnvelope();
    const { ts, sig } = sign(body, SECRET);
    const event = {
      httpMethod: 'POST',
      body,
      headers: { 'X-OJS-Timestamp': ts, 'X-OJS-Signature': sig },
    };
    const result = await handler.httpHandler(event);
    expect(result.statusCode).toBe(200);
  });

  it('tampered request rejected', async () => {
    const handler = createLambdaHandler({ url: 'http://ojs.test', signingSecret: SECRET });
    handler.register('test.job', async () => {});
    const body = makeEnvelope();
    const { ts, sig } = sign(body, SECRET);
    const event = {
      httpMethod: 'POST',
      body: body.replace('job-1', 'job-hacked'),
      headers: { 'X-OJS-Timestamp': ts, 'X-OJS-Signature': sig },
    };
    const result = await handler.httpHandler(event);
    expect(result.statusCode).toBe(401);
  });

  it('replay request rejected', async () => {
    const handler = createLambdaHandler({ url: 'http://ojs.test', signingSecret: SECRET });
    const body = makeEnvelope();
    const { ts, sig } = sign(body, SECRET, Math.floor(Date.now() / 1000) - 600);
    const result = await handler.httpHandler({
      httpMethod: 'POST',
      body,
      headers: { 'X-OJS-Timestamp': ts, 'X-OJS-Signature': sig },
    });
    expect(result.statusCode).toBe(401);
  });

  it('future request rejected', async () => {
    const handler = createLambdaHandler({ url: 'http://ojs.test', signingSecret: SECRET });
    const body = makeEnvelope();
    const { ts, sig } = sign(body, SECRET, Math.floor(Date.now() / 1000) + 600);
    const result = await handler.httpHandler({
      httpMethod: 'POST',
      body,
      headers: { 'X-OJS-Timestamp': ts, 'X-OJS-Signature': sig },
    });
    expect(result.statusCode).toBe(401);
  });

  it('base64-encoded body is decoded before verification', async () => {
    const handler = createLambdaHandler({ url: 'http://ojs.test', signingSecret: SECRET });
    handler.register('test.job', async () => {});
    const body = makeEnvelope();
    const { ts, sig } = sign(body, SECRET);
    const event = {
      httpMethod: 'POST',
      body: Buffer.from(body).toString('base64'),
      isBase64Encoded: true,
      headers: { 'x-ojs-timestamp': ts, 'x-ojs-signature': sig },
    };
    const result = await handler.httpHandler(event);
    expect(result.statusCode).toBe(200);
  });

  it('case-insensitive headers work', async () => {
    const handler = createLambdaHandler({ url: 'http://ojs.test', signingSecret: SECRET });
    handler.register('test.job', async () => {});
    const body = makeEnvelope();
    const { ts, sig } = sign(body, SECRET);
    const event = {
      httpMethod: 'POST',
      body,
      headers: { 'x-ojs-timestamp': ts, 'x-ojs-signature': sig },
    };
    const result = await handler.httpHandler(event);
    expect(result.statusCode).toBe(200);
  });

  it('missing secret fails closed', async () => {
    const handler = createLambdaHandler({ url: 'http://ojs.test' });
    handler.register('test.job', async () => {});
    const body = makeEnvelope();
    const event = { httpMethod: 'POST', body, headers: {} };
    const result = await handler.httpHandler(event);
    expect(result.statusCode).toBe(500);
  });

  it('SQS handler unchanged (no auth)', async () => {
    const handler = createLambdaHandler({ url: 'http://ojs.test', signingSecret: SECRET });
    handler.register('test.job', async () => {});
    const event = {
      Records: [{ messageId: 'm1', body: JSON.stringify({ id: 'j1', type: 'test.job', args: [], queue: 'q', state: 'active' }) }],
    };
    const result = await handler.sqsHandler(event);
    expect(result.batchItemFailures).toHaveLength(0);
  });

  it('rotation: signed with second secret succeeds', async () => {
    const handler = createLambdaHandler({ url: 'http://ojs.test', signingSecrets: [SECRET, SECRET2] });
    handler.register('test.job', async () => {});
    const body = makeEnvelope();
    const { ts, sig } = sign(body, SECRET2);
    const event = {
      httpMethod: 'POST',
      body,
      headers: { 'X-OJS-Timestamp': ts, 'X-OJS-Signature': sig },
    };
    const result = await handler.httpHandler(event);
    expect(result.statusCode).toBe(200);
  });

  it('oversize body rejected', async () => {
    const handler = createLambdaHandler({
      url: 'http://ojs.test',
      signingSecret: SECRET,
      maxBodyBytes: 50,
    });
    const body = makeEnvelope();
    const { ts, sig } = sign(body, SECRET);
    const result = await handler.httpHandler({
      httpMethod: 'POST',
      body,
      headers: { 'X-OJS-Timestamp': ts, 'X-OJS-Signature': sig },
    });
    expect(result.statusCode).toBe(413);
  });

  it('oversize base64 body is rejected before decoding', async () => {
    const handler = createLambdaHandler({
      url: 'http://ojs.test',
      signingSecret: SECRET,
      maxBodyBytes: 50,
    });
    const body = makeEnvelope();
    const result = await handler.httpHandler({
      httpMethod: 'POST',
      body: Buffer.from(body).toString('base64'),
      isBase64Encoded: true,
      headers: {},
    });
    expect(result.statusCode).toBe(413);
  });
});

describe('push-auth: Cloudflare adapter', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function makeSignedRequest(body: string, secret: string) {
    const { ts, sig } = sign(body, secret);
    return new Request('https://worker.example.com/ojs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OJS-Timestamp': ts,
        'X-OJS-Signature': sig,
      },
      body,
    });
  }

  it('valid signed request succeeds', async () => {
    const handler = createWorkerHandler({ url: 'http://ojs.test', signingSecret: SECRET });
    handler.register('test.job', async () => {});
    const body = makeEnvelope();
    const resp = await handler.handleRequest(makeSignedRequest(body, SECRET));
    expect(resp.status).toBe(200);
  });

  it('tampered request rejected', async () => {
    const handler = createWorkerHandler({ url: 'http://ojs.test', signingSecret: SECRET });
    const body = makeEnvelope();
    const { ts, sig } = sign(body, SECRET);
    const tampered = body.replace('job-1', 'hacked');
    const req = new Request('https://worker.example.com', {
      method: 'POST',
      headers: { 'X-OJS-Timestamp': ts, 'X-OJS-Signature': sig },
      body: tampered,
    });
    const resp = await handler.handleRequest(req);
    expect(resp.status).toBe(401);
  });

  it('replay rejected', async () => {
    const handler = createWorkerHandler({ url: 'http://ojs.test', signingSecret: SECRET });
    const body = makeEnvelope();
    const oldTs = Math.floor(Date.now() / 1000) - 600;
    const { ts, sig } = sign(body, SECRET, oldTs);
    const req = new Request('https://worker.example.com', {
      method: 'POST',
      headers: { 'X-OJS-Timestamp': ts, 'X-OJS-Signature': sig },
      body,
    });
    const resp = await handler.handleRequest(req);
    expect(resp.status).toBe(401);
  });

  it('future timestamp rejected', async () => {
    const handler = createWorkerHandler({ url: 'http://ojs.test', signingSecret: SECRET });
    const body = makeEnvelope();
    const { ts, sig } = sign(body, SECRET, Math.floor(Date.now() / 1000) + 600);
    const req = new Request('https://worker.example.com', {
      method: 'POST',
      headers: { 'X-OJS-Timestamp': ts, 'X-OJS-Signature': sig },
      body,
    });
    const resp = await handler.handleRequest(req);
    expect(resp.status).toBe(401);
  });

  it('missing secret fails closed', async () => {
    const handler = createWorkerHandler({ url: 'http://ojs.test' });
    const body = makeEnvelope();
    const req = new Request('https://worker.example.com', { method: 'POST', body });
    const resp = await handler.handleRequest(req);
    expect(resp.status).toBe(500);
  });

  it('rotation succeeds with second secret', async () => {
    const handler = createWorkerHandler({ url: 'http://ojs.test', signingSecrets: [SECRET, SECRET2] });
    handler.register('test.job', async () => {});
    const body = makeEnvelope();
    const resp = await handler.handleRequest(makeSignedRequest(body, SECRET2));
    expect(resp.status).toBe(200);
  });

  it('oversize body rejected', async () => {
    const handler = createWorkerHandler({ url: 'http://ojs.test', signingSecret: SECRET, maxBodyBytes: 50 });
    const body = makeEnvelope(); // > 50 bytes
    const resp = await handler.handleRequest(makeSignedRequest(body, SECRET));
    expect(resp.status).toBe(413);
  });

  it('handler failure returns 200 with status:failed and never calls back to the OJS server', async () => {
    const handler = createWorkerHandler({ url: 'http://ojs.test', signingSecret: SECRET });
    handler.register('test.job', async () => { throw new Error('boom'); });
    const body = makeEnvelope();
    const resp = await handler.handleRequest(makeSignedRequest(body, SECRET));
    expect(resp.status).toBe(200);
    const json = await resp.json() as { status: string; job_id: string; error: { code: string; message: string; retryable: boolean } };
    expect(json.status).toBe('failed');
    expect(json.job_id).toBe('job-1');
    expect(json.error).toEqual({ code: 'handler_error', message: 'boom', retryable: true });
    expect(fetch).not.toHaveBeenCalled();
  });

});

describe('push-auth: Vercel adapter', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function makeSignedRequest(body: string, secret: string) {
    const { ts, sig } = sign(body, secret);
    return new Request('https://vercel.app/api/ojs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OJS-Timestamp': ts,
        'X-OJS-Signature': sig,
      },
      body,
    });
  }

  it('valid signed request succeeds', async () => {
    const handler = createEdgeHandler({ url: 'http://ojs.test', signingSecret: SECRET });
    handler.register('test.job', async () => {});
    const body = makeEnvelope();
    const resp = await handler.handleRequest(makeSignedRequest(body, SECRET));
    expect(resp.status).toBe(200);
  });

  it('tampered request rejected', async () => {
    const handler = createEdgeHandler({ url: 'http://ojs.test', signingSecret: SECRET });
    const body = makeEnvelope();
    const { ts, sig } = sign(body, SECRET);
    const req = new Request('https://vercel.app/api', {
      method: 'POST',
      headers: { 'X-OJS-Timestamp': ts, 'X-OJS-Signature': sig },
      body: body.replace('job-1', 'x'),
    });
    const resp = await handler.handleRequest(req);
    expect(resp.status).toBe(401);
  });

  it('future timestamp rejected', async () => {
    const handler = createEdgeHandler({ url: 'http://ojs.test', signingSecret: SECRET });
    const body = makeEnvelope();
    const futureTs = Math.floor(Date.now() / 1000) + 600;
    const { ts, sig } = sign(body, SECRET, futureTs);
    const req = new Request('https://vercel.app/api', {
      method: 'POST',
      headers: { 'X-OJS-Timestamp': ts, 'X-OJS-Signature': sig },
      body,
    });
    const resp = await handler.handleRequest(req);
    expect(resp.status).toBe(401);
  });

  it('replay rejected', async () => {
    const handler = createEdgeHandler({ url: 'http://ojs.test', signingSecret: SECRET });
    const body = makeEnvelope();
    const { ts, sig } = sign(body, SECRET, Math.floor(Date.now() / 1000) - 600);
    const req = new Request('https://vercel.app/api', {
      method: 'POST',
      headers: { 'X-OJS-Timestamp': ts, 'X-OJS-Signature': sig },
      body,
    });
    const resp = await handler.handleRequest(req);
    expect(resp.status).toBe(401);
  });

  it('missing secret fails closed', async () => {
    const handler = createEdgeHandler({ url: 'http://ojs.test' });
    const body = makeEnvelope();
    const req = new Request('https://vercel.app/api', { method: 'POST', body });
    const resp = await handler.handleRequest(req);
    expect(resp.status).toBe(500);
  });

  it('rotation succeeds', async () => {
    const handler = createEdgeHandler({ url: 'http://ojs.test', signingSecrets: [SECRET, SECRET2] });
    handler.register('test.job', async () => {});
    const body = makeEnvelope();
    const resp = await handler.handleRequest(makeSignedRequest(body, SECRET2));
    expect(resp.status).toBe(200);
  });

  it('oversize body rejected', async () => {
    const handler = createEdgeHandler({
      url: 'http://ojs.test',
      signingSecret: SECRET,
      maxBodyBytes: 50,
    });
    const body = makeEnvelope();
    const resp = await handler.handleRequest(makeSignedRequest(body, SECRET));
    expect(resp.status).toBe(413);
  });

  it('handler failure returns 200 with status:failed and never calls back to the OJS server', async () => {
    const handler = createEdgeHandler({ url: 'http://ojs.test', signingSecret: SECRET });
    handler.register('test.job', async () => { throw new Error('oops'); });
    const body = makeEnvelope();
    const resp = await handler.handleRequest(makeSignedRequest(body, SECRET));
    expect(resp.status).toBe(200);
    const json = await resp.json() as { status: string; job_id: string; error: { code: string; message: string; retryable: boolean } };
    expect(json.status).toBe('failed');
    expect(json.job_id).toBe('job-1');
    expect(json.error).toEqual({ code: 'handler_error', message: 'oops', retryable: true });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('push-auth: canonical envelope parsing', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('Cloudflare rejects bare Job without insecure flag', async () => {
    const handler = createWorkerHandler({ url: 'http://ojs.test', signingSecret: SECRET });
    handler.register('test.job', async () => {});
    const bareJob = JSON.stringify({ id: 'j1', type: 'test.job', args: [], queue: 'q', state: 'active' });
    const { ts, sig } = sign(bareJob, SECRET);
    const req = new Request('https://w.com', {
      method: 'POST',
      headers: { 'X-OJS-Timestamp': ts, 'X-OJS-Signature': sig },
      body: bareJob,
    });
    const resp = await handler.handleRequest(req);
    expect(resp.status).toBe(400);
  });

  it('Cloudflare allows bare Job under insecure mode', async () => {
    const handler = createWorkerHandler({ url: 'http://ojs.test', allowInsecurePush: true });
    handler.register('test.job', async () => {});
    const bareJob = JSON.stringify({ id: 'j1', type: 'test.job', args: [], queue: 'q', state: 'active' });
    const req = new Request('https://w.com', { method: 'POST', body: bareJob });
    const resp = await handler.handleRequest(req);
    expect(resp.status).toBe(200);
  });

  it('Cloudflare passes worker_id and delivery_id to handler context', async () => {
    const handler = createWorkerHandler({ url: 'http://ojs.test', signingSecret: SECRET });
    let ctx: { workerId?: string; deliveryId?: string } | undefined;
    handler.register('test.job', async (c) => { ctx = { workerId: c.workerId, deliveryId: c.deliveryId }; });
    const body = makeEnvelope();
    const { ts, sig } = sign(body, SECRET);
    const req = new Request('https://w.com', {
      method: 'POST',
      headers: { 'X-OJS-Timestamp': ts, 'X-OJS-Signature': sig },
      body,
    });
    await handler.handleRequest(req);
    expect(ctx?.workerId).toBe('w-1');
    expect(ctx?.deliveryId).toBe('d-1');
  });

  it('Vercel rejects bare Job without insecure flag', async () => {
    const handler = createEdgeHandler({ url: 'http://ojs.test', signingSecret: SECRET });
    handler.register('test.job', async () => {});
    const bareJob = JSON.stringify({ id: 'j1', type: 'test.job', args: [], queue: 'q', state: 'active' });
    const { ts, sig } = sign(bareJob, SECRET);
    const req = new Request('https://v.com', {
      method: 'POST',
      headers: { 'X-OJS-Timestamp': ts, 'X-OJS-Signature': sig },
      body: bareJob,
    });
    const resp = await handler.handleRequest(req);
    expect(resp.status).toBe(400);
  });

  it('Vercel allows bare Job under insecure mode', async () => {
    const handler = createEdgeHandler({ url: 'http://ojs.test', allowInsecurePush: true });
    handler.register('test.job', async () => {});
    const bareJob = JSON.stringify({ id: 'j1', type: 'test.job', args: [], queue: 'q', state: 'active' });
    const req = new Request('https://v.com', { method: 'POST', body: bareJob });
    const resp = await handler.handleRequest(req);
    expect(resp.status).toBe(200);
  });

  it('Vercel passes worker_id and delivery_id to handler context', async () => {
    const handler = createEdgeHandler({ url: 'http://ojs.test', signingSecret: SECRET });
    let ctx: { workerId?: string; deliveryId?: string } | undefined;
    handler.register('test.job', async (value) => {
      ctx = { workerId: value.workerId, deliveryId: value.deliveryId };
    });
    const body = makeEnvelope();
    const { ts, sig } = sign(body, SECRET);
    const req = new Request('https://v.com', {
      method: 'POST',
      headers: { 'X-OJS-Timestamp': ts, 'X-OJS-Signature': sig },
      body,
    });
    await handler.handleRequest(req);
    expect(ctx?.workerId).toBe('w-1');
    expect(ctx?.deliveryId).toBe('d-1');
  });
});

describe('push-auth: HTTP push protocol response contract (zero callback)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('Cloudflare success never calls fetch and returns the exact completed contract', async () => {
    const handler = createWorkerHandler({ url: 'http://ojs.test', signingSecret: SECRET });
    handler.register('test.job', async () => {});
    const body = makeEnvelope();
    const { ts, sig } = sign(body, SECRET);
    const req = new Request('https://worker.example.com', {
      method: 'POST',
      headers: { 'X-OJS-Timestamp': ts, 'X-OJS-Signature': sig },
      body,
    });
    const resp = await handler.handleRequest(req);
    expect(fetch).not.toHaveBeenCalled();
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ status: 'completed', job_id: 'job-1' });
  });

  it('Cloudflare failure never calls fetch and returns the exact failed contract', async () => {
    const handler = createWorkerHandler({ url: 'http://ojs.test', signingSecret: SECRET });
    handler.register('test.job', async () => { throw new Error('cf boom'); });
    const body = makeEnvelope();
    const { ts, sig } = sign(body, SECRET);
    const req = new Request('https://worker.example.com', {
      method: 'POST',
      headers: { 'X-OJS-Timestamp': ts, 'X-OJS-Signature': sig },
      body,
    });
    const resp = await handler.handleRequest(req);
    expect(fetch).not.toHaveBeenCalled();
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      status: 'failed',
      job_id: 'job-1',
      error: { code: 'handler_error', message: 'cf boom', retryable: true },
    });
  });

  it('Vercel success never calls fetch and returns the exact completed contract', async () => {
    const handler = createEdgeHandler({ url: 'http://ojs.test', signingSecret: SECRET });
    handler.register('test.job', async () => {});
    const body = makeEnvelope();
    const { ts, sig } = sign(body, SECRET);
    const req = new Request('https://vercel.app/api', {
      method: 'POST',
      headers: { 'X-OJS-Timestamp': ts, 'X-OJS-Signature': sig },
      body,
    });
    const resp = await handler.handleRequest(req);
    expect(fetch).not.toHaveBeenCalled();
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ status: 'completed', job_id: 'job-1' });
  });

  it('Vercel failure never calls fetch and returns the exact failed contract', async () => {
    const handler = createEdgeHandler({ url: 'http://ojs.test', signingSecret: SECRET });
    handler.register('test.job', async () => { throw new Error('vercel boom'); });
    const body = makeEnvelope();
    const { ts, sig } = sign(body, SECRET);
    const req = new Request('https://vercel.app/api', {
      method: 'POST',
      headers: { 'X-OJS-Timestamp': ts, 'X-OJS-Signature': sig },
      body,
    });
    const resp = await handler.handleRequest(req);
    expect(fetch).not.toHaveBeenCalled();
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      status: 'failed',
      job_id: 'job-1',
      error: { code: 'handler_error', message: 'vercel boom', retryable: true },
    });
  });

  it('Lambda success never calls fetch and returns the exact completed contract', async () => {
    const handler = createLambdaHandler({ url: 'http://ojs.test', signingSecret: SECRET });
    handler.register('test.job', async () => {});
    const body = makeEnvelope();
    const { ts, sig } = sign(body, SECRET);
    const result = await handler.httpHandler({
      httpMethod: 'POST',
      body,
      headers: { 'X-OJS-Timestamp': ts, 'X-OJS-Signature': sig },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body as string)).toEqual({ status: 'completed', job_id: 'job-1' });
  });

  it('Lambda failure never calls fetch and returns the exact failed contract', async () => {
    const handler = createLambdaHandler({ url: 'http://ojs.test', signingSecret: SECRET });
    handler.register('test.job', async () => { throw new Error('lambda boom'); });
    const body = makeEnvelope();
    const { ts, sig } = sign(body, SECRET);
    const result = await handler.httpHandler({
      httpMethod: 'POST',
      body,
      headers: { 'X-OJS-Timestamp': ts, 'X-OJS-Signature': sig },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body as string)).toEqual({
      status: 'failed',
      job_id: 'job-1',
      error: { code: 'handler_error', message: 'lambda boom', retryable: true },
    });
  });

  it('all three adapters never call fetch even without any signing configuration under allowInsecurePush', async () => {
    const bareJob = JSON.stringify({ id: 'insecure-1', type: 'test.job', args: [], queue: 'q', state: 'active' });

    const cf = createWorkerHandler({ url: 'http://ojs.test', allowInsecurePush: true });
    cf.register('test.job', async () => {});
    await cf.handleRequest(new Request('https://w.com', { method: 'POST', body: bareJob }));

    const vc = createEdgeHandler({ url: 'http://ojs.test', allowInsecurePush: true });
    vc.register('test.job', async () => {});
    await vc.handleRequest(new Request('https://v.com', { method: 'POST', body: bareJob }));

    const lam = createLambdaHandler({ url: 'http://ojs.test', allowInsecurePush: true });
    lam.register('test.job', async () => {});
    await lam.httpHandler({ httpMethod: 'POST', body: bareJob, headers: {} });

    expect(fetch).not.toHaveBeenCalled();
  });
});

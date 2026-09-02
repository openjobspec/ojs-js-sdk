import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OJSClient } from '../src/client.js';
import { CronOperations } from '../src/cron.js';
import { QueueOperations } from '../src/queue.js';
import { SchemaOperations } from '../src/schema.js';
import { HttpTransport, fetchManifest } from '../src/transport/http.js';
import { OJSConnectionError, OJSRequestTimeoutError, OJSValidationError, OJSNotFoundError, OJSServerError, OJSRateLimitError } from '../src/errors.js';

// Helper to create a mock Response
function mockResponse(body: unknown, init: ResponseInit = {}): Response {
  const status = init.status ?? 200;
  return new Response(JSON.stringify(body), {
    status,
    statusText: init.statusText ?? 'OK',
    headers: {
      'Content-Type': 'application/openjobspec+json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
}

describe('HttpTransport', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('constructor', () => {
    it('should strip trailing slashes from base URL', () => {
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ ok: true }));

      const transport = new HttpTransport({ url: 'http://localhost:8080///' });
      transport.request({ method: 'GET', path: '/health' });

      expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
        'http://localhost:8080/ojs/v1/health',
        expect.any(Object),
      );
    });

    it('should include auth header when configured', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ ok: true }));

      const transport = new HttpTransport({ url: 'http://localhost:8080', auth: 'Bearer token123' });
      await transport.request({ method: 'GET', path: '/health' });

      const callArgs = vi.mocked(globalThis.fetch).mock.calls[0];
      const headers = callArgs[1]?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer token123');
    });

    it('should include custom headers', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ ok: true }));

      const transport = new HttpTransport({
        url: 'http://localhost:8080',
        headers: { 'X-Custom': 'value' },
      });
      await transport.request({ method: 'GET', path: '/test' });

      const callArgs = vi.mocked(globalThis.fetch).mock.calls[0];
      const headers = callArgs[1]?.headers as Record<string, string>;
      expect(headers['X-Custom']).toBe('value');
    });

    it('should use custom spec version', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ ok: true }));

      const transport = new HttpTransport({
        url: 'http://localhost:8080',
        specVersion: '2.0.0',
      });
      await transport.request({ method: 'GET', path: '/test' });

      const callArgs = vi.mocked(globalThis.fetch).mock.calls[0];
      const headers = callArgs[1]?.headers as Record<string, string>;
      expect(headers['OJS-Version']).toBe('2.0.0');
    });
  });

  describe('request()', () => {
    it('should prepend /ojs/v1 base path by default', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ job: {} }));

      const transport = new HttpTransport({ url: 'http://localhost:8080' });
      await transport.request({ method: 'GET', path: '/jobs/123' });

      expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
        'http://localhost:8080/ojs/v1/jobs/123',
        expect.any(Object),
      );
    });

    it('should skip base path when rawPath is true', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ manifest: true }));

      const transport = new HttpTransport({ url: 'http://localhost:8080' });
      await transport.request({ method: 'GET', path: '/ojs/manifest', rawPath: true });

      expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
        'http://localhost:8080/ojs/manifest',
        expect.any(Object),
      );
    });

    it('should send JSON body for POST requests', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ job: {} }, { status: 201 }));

      const transport = new HttpTransport({ url: 'http://localhost:8080' });
      await transport.request({
        method: 'POST',
        path: '/jobs',
        body: { type: 'email.send', args: [] },
      });

      const callArgs = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(callArgs[1]?.body).toBe('{"type":"email.send","args":[]}');
    });

    it.each([
      {
        name: 'single enqueue',
        path: '/jobs',
        body: {
          type: 'email.send',
          args: [],
          options: { unique: { key: ['id'] } },
        },
        field: 'options.unique.key',
      },
      {
        name: 'batch default options',
        path: '/jobs/batch',
        body: {
          jobs: [],
          default_options: { unique: { key: ['id'] } },
        },
        field: 'default_options.unique.key',
      },
      {
        name: 'batch job options',
        path: '/jobs/batch',
        body: {
          jobs: [{
            type: 'email.send',
            args: [],
            options: { unique: { key: ['id'] } },
          }],
        },
        field: 'jobs[0].options.unique.key',
      },
    ])('should reject deprecated unique.key in raw HTTP $name data', async ({
      path,
      body,
      field,
    }) => {
      globalThis.fetch = vi.fn();
      const transport = new HttpTransport({ url: 'http://localhost:8080' });

      await expect(transport.request({ method: 'POST', path, body })).rejects.toMatchObject({
        name: 'OJSValidationError',
        retryable: false,
        details: { field },
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it.each([
      {
        name: 'single enqueue',
        path: '/jobs',
        body: {
          type: 'email.send',
          args: [],
          options: { unique: { keys: ['type', 'type'] } },
        },
        field: 'options.unique.keys',
      },
      {
        name: 'batch defaults',
        path: '/jobs/batch',
        body: {
          jobs: [],
          default_options: { unique: { period: '1 hour' } },
        },
        field: 'default_options.unique.period',
      },
      {
        name: 'batch job',
        path: '/jobs/batch',
        body: {
          jobs: [{
            type: 'email.send',
            args: [],
            options: { unique: { states: ['active', 'active'] } },
          }],
        },
        field: 'jobs[0].options.unique.states',
      },
    ])('should reject schema-invalid canonical unique policy in raw HTTP $name data', async ({
      path,
      body,
      field,
    }) => {
      globalThis.fetch = vi.fn();
      const transport = new HttpTransport({ url: 'http://localhost:8080' });

      await expect(
        transport.request({ method: 'POST', path, body }),
      ).rejects.toMatchObject({
        name: 'OJSValidationError',
        retryable: false,
        details: {
          validation_errors: expect.arrayContaining([
            expect.objectContaining({ field }),
          ]),
        },
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('should not send body for GET requests', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ job: {} }));

      const transport = new HttpTransport({ url: 'http://localhost:8080' });
      await transport.request({ method: 'GET', path: '/jobs/123' });

      const callArgs = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(callArgs[1]?.body).toBeUndefined();
    });

    it('should parse successful JSON response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockResponse({ job: { id: '123', type: 'test' } }),
      );

      const transport = new HttpTransport({ url: 'http://localhost:8080' });
      const response = await transport.request<{ job: { id: string } }>({
        method: 'GET',
        path: '/jobs/123',
      });

      expect(response.status).toBe(200);
      expect(response.body.job.id).toBe('123');
    });

    it('should return empty body for 204 responses', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(null, { status: 204, statusText: 'No Content' }),
      );

      const transport = new HttpTransport({ url: 'http://localhost:8080' });
      const response = await transport.request({
        method: 'DELETE',
        path: '/jobs/123',
      });

      expect(response.status).toBe(204);
    });

    it('should parse OJS response headers', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            'OJS-Version': '1.0',
            'Content-Type': 'application/openjobspec+json',
            'X-Request-Id': 'req_abc123',
            'Location': '/ojs/v1/jobs/456',
          },
        }),
      );

      const transport = new HttpTransport({ url: 'http://localhost:8080' });
      const response = await transport.request({ method: 'GET', path: '/health' });

      expect(response.headers.ojsVersion).toBe('1.0');
      expect(response.headers.requestId).toBe('req_abc123');
      expect(response.headers.location).toBe('/ojs/v1/jobs/456');
    });

    it('should throw OJSValidationError on 400', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockResponse(
          { error: { code: 'invalid_request', message: 'Invalid job type' } },
          { status: 400 },
        ),
      );

      const transport = new HttpTransport({ url: 'http://localhost:8080' });

      await expect(
        transport.request({ method: 'POST', path: '/jobs', body: {} }),
      ).rejects.toBeInstanceOf(OJSValidationError);
    });

    it('should throw OJSNotFoundError on 404', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockResponse(
          { error: { code: 'not_found', message: 'Job not found', details: { resource_type: 'job', resource_id: '123' } } },
          { status: 404 },
        ),
      );

      const transport = new HttpTransport({ url: 'http://localhost:8080' });

      await expect(
        transport.request({ method: 'GET', path: '/jobs/123' }),
      ).rejects.toBeInstanceOf(OJSNotFoundError);
    });

    it('should throw OJSRateLimitError on 429 with Retry-After header', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: 'rate_limited', message: 'Slow down' } }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/openjobspec+json',
              'Retry-After': '120',
            },
          },
        ),
      );

      const transport = new HttpTransport({
        url: 'http://localhost:8080',
        retryConfig: { enabled: false },
      });

      await expect(
        transport.request({ method: 'POST', path: '/jobs', body: {} }),
      ).rejects.toSatisfy((err: OJSRateLimitError) => {
        expect(err).toBeInstanceOf(OJSRateLimitError);
        expect(err.retryAfter).toBe(120);
        expect(err.retryable).toBe(true);
        return true;
      });
    });

    it('should throw OJSServerError on 500', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockResponse(
          { error: { code: 'server_error', message: 'Internal error' } },
          { status: 500 },
        ),
      );

      const transport = new HttpTransport({ url: 'http://localhost:8080' });

      await expect(
        transport.request({ method: 'GET', path: '/health' }),
      ).rejects.toBeInstanceOf(OJSServerError);
    });

    it('should wrap TypeError as OJSConnectionError', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

      const transport = new HttpTransport({
        url: 'http://localhost:8080',
        retryConfig: { enabled: false },
      });

      await expect(
        transport.request({ method: 'GET', path: '/health' }),
      ).rejects.toBeInstanceOf(OJSConnectionError);
    });

    it('should wrap DOMException as OJSConnectionError', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'));

      const transport = new HttpTransport({
        url: 'http://localhost:8080',
        retryConfig: { enabled: false },
      });

      await expect(
        transport.request({ method: 'GET', path: '/health' }),
      ).rejects.toBeInstanceOf(OJSConnectionError);
    });

    it('should re-throw OJS errors without wrapping', async () => {
      const ojsError = new OJSValidationError('test error');
      globalThis.fetch = vi.fn().mockRejectedValue(ojsError);

      const transport = new HttpTransport({ url: 'http://localhost:8080' });

      await expect(
        transport.request({ method: 'GET', path: '/health' }),
      ).rejects.toBe(ojsError);
    });

    it('should re-throw unknown errors as-is', async () => {
      const unknownError = { custom: 'error' };
      globalThis.fetch = vi.fn().mockRejectedValue(unknownError);

      const transport = new HttpTransport({ url: 'http://localhost:8080' });

      await expect(
        transport.request({ method: 'GET', path: '/health' }),
      ).rejects.toBe(unknownError);
    });

    it('should merge per-request headers', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ ok: true }));

      const transport = new HttpTransport({ url: 'http://localhost:8080' });
      await transport.request({
        method: 'GET',
        path: '/health',
        headers: { 'X-Request-Id': 'custom-id' },
      });

      const callArgs = vi.mocked(globalThis.fetch).mock.calls[0];
      const headers = callArgs[1]?.headers as Record<string, string>;
      expect(headers['X-Request-Id']).toBe('custom-id');
    });

    it('should chain external abort signal', async () => {
      const controller = new AbortController();
      globalThis.fetch = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'));

      const transport = new HttpTransport({ url: 'http://localhost:8080' });

      const promise = transport.request({
        method: 'GET',
        path: '/health',
        signal: controller.signal,
      });

      controller.abort();
      // Finding 6: the internal controller being aborted always yields
      // the normalized `abortReasonAsError(controller.signal)` result --
      // here the signal's own (already-`Error`-shaped) default abort
      // reason, propagated as-is -- consistently with the same rule
      // already applied to an abort during body/JSON reading, rather
      // than an unrelated generic OJSConnectionError wrapping whatever
      // fetch() itself happened to throw.
      await expect(promise).rejects.toBeInstanceOf(Error);
      await expect(promise).rejects.toBe(controller.signal.reason);
    });

    it('should reject immediately if the external signal is already aborted', async () => {
      globalThis.fetch = vi.fn().mockImplementation(
        () => new Promise((_resolve, reject) => {
          // Simulate fetch honoring the (already-aborted) controller.signal
          // it receives from the transport.
          reject(new DOMException('Aborted', 'AbortError'));
        }),
      );

      const controller = new AbortController();
      controller.abort('cancelled-before-start');

      const transport = new HttpTransport({ url: 'http://localhost:8080' });

      const err: unknown = await transport
        .request({ method: 'GET', path: '/health', signal: controller.signal })
        .catch((e: unknown) => e);

      // The external reason here is a bare string, not an Error, so
      // `abortReasonAsError` normalizes (wraps) it rather than returning
      // it as-is.
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).cause).toBe('cancelled-before-start');
    });

    it('should keep external cancellation active through streaming JSON parsing', async () => {
      const externalController = new AbortController();
      const addSpy = vi.spyOn(externalController.signal, 'addEventListener');
      const removeSpy = vi.spyOn(externalController.signal, 'removeEventListener');
      const reason = new Error('caller stopped slow response');
      const encoder = new TextEncoder();
      let markBodyRead: (() => void) | undefined;
      const bodyRead = new Promise<void>((resolve) => {
        markBodyRead = resolve;
      });

      globalThis.fetch = vi.fn().mockImplementation(
        (_url: string | URL | Request, init?: RequestInit) => {
          const requestSignal = init?.signal;
          let sentPrefix = false;
          const stream = new ReadableStream<Uint8Array>({
            start(streamController) {
              requestSignal?.addEventListener('abort', () => {
                streamController.error(requestSignal.reason);
              }, { once: true });
            },
            pull(streamController) {
              if (!sentPrefix) {
                sentPrefix = true;
                streamController.enqueue(encoder.encode('{"still":"parsing"'));
                markBodyRead?.();
              }
            },
          });
          return Promise.resolve(new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'application/openjobspec+json' },
          }));
        },
      );

      const transport = new HttpTransport({
        url: 'http://localhost:8080',
        timeout: 10_000,
      });
      const request = transport.request({
        method: 'GET',
        path: '/health',
        signal: externalController.signal,
      });

      await bodyRead;
      expect(addSpy).toHaveBeenCalledTimes(1);
      expect(removeSpy).not.toHaveBeenCalled();

      externalController.abort(reason);

      await expect(request).rejects.toBe(reason);
      expect(removeSpy).toHaveBeenCalledTimes(1);
      expect(removeSpy.mock.calls[0]?.[1]).toBe(addSpy.mock.calls[0]?.[1]);
    });

    it('normalizes a primitive value thrown directly by fetch() when the internal controller is aborted (Finding 6)', async () => {
      // Some fetch implementations throw the abort reason directly rather
      // than wrapping it in a DOMException/Error -- including, in
      // principle, a bare primitive passed to `controller.abort(reason)`.
      // The outer catch must never propagate that primitive as-is; it
      // must normalize it via `abortReasonAsError(controller.signal)`.
      const controller = new AbortController();
      globalThis.fetch = vi.fn().mockImplementation(
        (_url: string | URL | Request, init?: RequestInit) => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject('cancelled-string-reason');
          }, { once: true });
        }),
      );

      const transport = new HttpTransport({ url: 'http://localhost:8080' });
      const promise = transport.request({
        method: 'GET',
        path: '/health',
        signal: controller.signal,
      });

      controller.abort('cancelled-string-reason');

      const err: unknown = await promise.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBe('cancelled-string-reason');
      expect((err as Error).cause).toBe('cancelled-string-reason');
      expect((err as Error).message).toMatch(/aborted/i);
    });

    it('normalizes a plain object thrown directly by fetch() when the internal controller is aborted (Finding 6)', async () => {
      const controller = new AbortController();
      const objectReason = { code: 'client_cancelled', detail: 'user navigated away' };
      globalThis.fetch = vi.fn().mockImplementation(
        (_url: string | URL | Request, init?: RequestInit) => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(objectReason);
          }, { once: true });
        }),
      );

      const transport = new HttpTransport({ url: 'http://localhost:8080' });
      const promise = transport.request({
        method: 'GET',
        path: '/health',
        signal: controller.signal,
      });

      controller.abort(objectReason);

      const err: unknown = await promise.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBe(objectReason);
      expect((err as Error).cause).toBe(objectReason);
    });

    it('normalizes a primitive value thrown during body (JSON) reading when the internal controller is aborted (Finding 6)', async () => {
      const controller = new AbortController();
      const encoder = new TextEncoder();
      let markBodyRead: (() => void) | undefined;
      const bodyRead = new Promise<void>((resolve) => {
        markBodyRead = resolve;
      });

      globalThis.fetch = vi.fn().mockImplementation(
        (_url: string | URL | Request, init?: RequestInit) => {
          const requestSignal = init?.signal;
          let sentPrefix = false;
          const stream = new ReadableStream<Uint8Array>({
            start(streamController) {
              requestSignal?.addEventListener('abort', () => {
                // Errors the body stream with a bare primitive rather
                // than an Error/DOMException, exactly like the direct
                // fetch()-throw case above but for the body-read phase.
                streamController.error('body-read-cancelled');
              }, { once: true });
            },
            pull(streamController) {
              if (!sentPrefix) {
                sentPrefix = true;
                streamController.enqueue(encoder.encode('{"still":"parsing"'));
                markBodyRead?.();
              }
            },
          });
          return Promise.resolve(new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'application/openjobspec+json' },
          }));
        },
      );

      const transport = new HttpTransport({ url: 'http://localhost:8080', timeout: 10_000 });
      const request = transport.request({
        method: 'GET',
        path: '/health',
        signal: controller.signal,
      });

      await bodyRead;
      controller.abort('body-read-cancelled');

      const err: unknown = await request.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBe('body-read-cancelled');
      expect((err as Error).cause).toBe('body-read-cancelled');
    });

    it('preserves an OJS error thrown while the internal controller happens to be aborted (Finding 6: preserve OJS errors)', async () => {
      // If the thrown value is already a well-formed OJS error, it must
      // win over the abort-normalization path even when the signal is
      // (independently) aborted at the same time.
      const controller = new AbortController();
      globalThis.fetch = vi.fn().mockImplementation(
        (_url: string | URL | Request, init?: RequestInit) => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new OJSConnectionError('a distinct, already-normalized OJS error'));
          }, { once: true });
        }),
      );

      const transport = new HttpTransport({ url: 'http://localhost:8080' });
      const promise = transport.request({
        method: 'GET',
        path: '/health',
        signal: controller.signal,
      });

      controller.abort('unrelated-abort-reason');

      await expect(promise).rejects.toBeInstanceOf(OJSConnectionError);
      await expect(promise).rejects.toThrow('a distinct, already-normalized OJS error');
    });

        it('should not leak abort listeners on the external signal across requests', async () => {
      // Each Response body can only be read once, so return a fresh instance per call.
      globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(mockResponse({ ok: true })));

      const controller = new AbortController();
      const addSpy = vi.spyOn(controller.signal, 'addEventListener');
      const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

      const transport = new HttpTransport({ url: 'http://localhost:8080' });

      // Reusing the same long-lived signal across many requests (as a worker
      // polling loop might for its shutdown signal) must not accumulate
      // listeners: a new listener is registered per request, and every one
      // of them must eventually be removed (the implementation may remove
      // defensively more than once per request; that is harmless).
      for (let i = 0; i < 5; i++) {
        await transport.request({ method: 'GET', path: '/health', signal: controller.signal });
      }

      const addedListeners = addSpy.mock.calls.map((call) => call[1]);
      expect(addedListeners).toHaveLength(5);
      // Distinct listener per request — proves the old one isn't leaked/reused.
      expect(new Set(addedListeners).size).toBe(5);

      const removedListeners = new Set(removeSpy.mock.calls.map((call) => call[1]));
      for (const listener of addedListeners) {
        expect(removedListeners.has(listener)).toBe(true);
      }
    });

    it('should remove the external abort listener even when the request fails', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('network down'));

      const controller = new AbortController();
      const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

      const transport = new HttpTransport({
        url: 'http://localhost:8080',
        retryConfig: { enabled: false },
      });

      await expect(
        transport.request({ method: 'GET', path: '/health', signal: controller.signal }),
      ).rejects.toBeInstanceOf(OJSConnectionError);

      expect(removeSpy).toHaveBeenCalledTimes(1);
    });
  });
});

describe('HttpTransport internal timeout', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Deterministic fake timers: the internal abort deadline and the retry
    // backoff sleeps are all driven explicitly rather than elapsing real time.
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  /**
   * A fetch mock that never resolves on its own and rejects only when the
   * request signal aborts, forwarding the abort reason exactly as a
   * spec-compliant `fetch()` honoring `AbortController.abort(reason)` does.
   */
  function hangingFetch(): typeof globalThis.fetch {
    return vi.fn().mockImplementation(
      (_url: string | URL | Request, init?: RequestInit) => new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    );
  }

  it('surfaces the internal timeout as a retryable OJSRequestTimeoutError with timeout/path details', async () => {
    globalThis.fetch = hangingFetch();
    const transport = new HttpTransport({
      url: 'http://localhost:8080',
      timeout: 1000,
      retryConfig: { enabled: false },
    });

    const promise = transport.request({ method: 'GET', path: '/jobs/123' });
    const assertion = promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    const err = await assertion;

    expect(err).toBeInstanceOf(OJSRequestTimeoutError);
    expect(err).toBeInstanceOf(OJSConnectionError); // backward-compatible subtype
    expect((err as OJSRequestTimeoutError).retryable).toBe(true);
    expect((err as OJSRequestTimeoutError).timeoutMs).toBe(1000);
    expect((err as OJSRequestTimeoutError).path).toBe('/jobs/123');
    expect((err as OJSRequestTimeoutError).details).toMatchObject({
      timeout_ms: 1000,
      path: '/jobs/123',
    });
    expect((err as Error).name).toBe('OJSRequestTimeoutError');
  });

  it('retries a GET on internal timeout and succeeds on a later attempt', async () => {
    globalThis.fetch = vi.fn()
      // First attempt hangs until the internal deadline aborts it.
      .mockImplementationOnce(
        (_url: string | URL | Request, init?: RequestInit) => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        }),
      )
      // Second attempt resolves normally.
      .mockResolvedValueOnce(mockResponse({ job: { id: '123' } }));

    const transport = new HttpTransport({
      url: 'http://localhost:8080',
      timeout: 1000,
      retryConfig: { minBackoffMs: 10, maxBackoffMs: 50 },
    });

    const promise = transport.request<{ job: { id: string } }>({
      method: 'GET',
      path: '/jobs/123',
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.body.job.id).toBe('123');
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
  });

  it('retries the contract-safe progress PUT on internal timeout and succeeds', async () => {
    globalThis.fetch = vi.fn()
      .mockImplementationOnce(
        (_url: string | URL | Request, init?: RequestInit) => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        }),
      )
      .mockResolvedValueOnce(mockResponse({}));

    const transport = new HttpTransport({
      url: 'http://localhost:8080',
      timeout: 1000,
      retryConfig: { minBackoffMs: 10, maxBackoffMs: 50 },
    });

    const promise = transport.request({
      method: 'PUT',
      path: '/jobs/job-1/progress',
      body: { progress: 0.5 },
    });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toMatchObject({ status: 200 });
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['GET', '/jobs/123', undefined],
    ['PUT', '/jobs/job-1/progress', { progress: 0.5 }],
  ] as const)(
    'retries a %s after an ambiguous network failure',
    async (method, path, body) => {
      globalThis.fetch = vi.fn()
        .mockRejectedValueOnce(new TypeError('socket reset'))
        .mockResolvedValueOnce(mockResponse({ ok: true }));

      const transport = new HttpTransport({
        url: 'http://localhost:8080',
        retryConfig: { minBackoffMs: 10, maxBackoffMs: 50 },
      });

      const promise = transport.request({ method, path, body });
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toMatchObject({ status: 200 });
      expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
    },
  );

  it('exhausts retries on a persistent GET internal timeout and rejects with the timeout error', async () => {
    globalThis.fetch = hangingFetch();
    const transport = new HttpTransport({
      url: 'http://localhost:8080',
      timeout: 1000,
      retryConfig: { maxRetries: 2, minBackoffMs: 10, maxBackoffMs: 50 },
    });

    const promise = transport.request({ method: 'GET', path: '/health' });
    const assertion = promise.catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await assertion;

    expect(err).toBeInstanceOf(OJSRequestTimeoutError);
    // 1 initial + 2 retries = 3 total attempts.
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a POST on internal timeout (avoids duplicate enqueue)', async () => {
    globalThis.fetch = hangingFetch();
    const transport = new HttpTransport({
      url: 'http://localhost:8080',
      timeout: 1000,
      retryConfig: { maxRetries: 3, minBackoffMs: 10, maxBackoffMs: 50 },
    });

    const promise = transport.request({
      method: 'POST',
      path: '/jobs',
      body: { type: 'email.send', args: [] },
    });
    const assertion = promise.catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await assertion;

    expect(err).toBeInstanceOf(OJSRequestTimeoutError);
    // POST is not idempotent — exactly one transport attempt, no retry.
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      endpoint: 'checkpoint',
      path: '/jobs/job-1/checkpoint',
      invoke: (transport: HttpTransport) => transport.request({
        method: 'DELETE',
        path: '/jobs/job-1/checkpoint',
      }),
    },
    {
      endpoint: 'cron',
      path: '/cron/daily-report',
      invoke: (transport: HttpTransport) =>
        new CronOperations(transport).unregister('daily-report'),
    },
    {
      endpoint: 'workflow',
      path: '/workflows/wf-1',
      invoke: (transport: HttpTransport) =>
        new OJSClient({ url: 'http://localhost:8080', transport })
          .cancelWorkflow('wf-1'),
    },
    {
      endpoint: 'schema',
      path: `/schemas/${encodeURIComponent('urn:ojs:schema:test:1')}`,
      invoke: (transport: HttpTransport) =>
        new SchemaOperations(transport).delete('urn:ojs:schema:test:1'),
    },
    {
      endpoint: 'dead-letter',
      path: '/dead-letter/job-1',
      invoke: (transport: HttpTransport) =>
        new QueueOperations(transport).discardDeadLetter('job-1'),
    },
  ])(
    'does not retry the $endpoint DELETE when the first call commits then times out',
    async ({ path, invoke }) => {
      globalThis.fetch = vi.fn()
        // The server has committed the delete, but the response never reaches
        // the client before its internal deadline.
        .mockImplementationOnce(
          (_url: string | URL | Request, init?: RequestInit) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener(
                'abort',
                () => reject(init.signal!.reason),
                { once: true },
              );
            }),
        )
        // A buggy retry would now observe the normal post-delete 404 and mask
        // the original timeout.
        .mockResolvedValueOnce(mockResponse(
          {
            error: {
              code: 'not_found',
              message: 'Resource already deleted',
            },
          },
          { status: 404 },
        ));

      const transport = new HttpTransport({
        url: 'http://localhost:8080',
        timeout: 1000,
        retryConfig: { maxRetries: 3, minBackoffMs: 10, maxBackoffMs: 50 },
      });

      const outcome = invoke(transport).catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      const error = await outcome;

      expect(error).toBeInstanceOf(OJSRequestTimeoutError);
      expect(error).not.toBeInstanceOf(OJSNotFoundError);
      expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(globalThis.fetch).mock.calls[0]?.[0]).toBe(
        `http://localhost:8080/ojs/v1${path}`,
      );
      expect(vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.method).toBe('DELETE');
    },
  );

  it.each([
    {
      name: '429 Retry-After',
      response: () => mockResponse(
        { error: { code: 'rate_limited', message: 'Slow down' } },
        { status: 429, headers: { 'Retry-After': '1' } },
      ),
      errorType: OJSRateLimitError,
    },
    {
      name: '503 transient server response',
      response: () => mockResponse(
        { error: { code: 'server_error', message: 'Unavailable' } },
        { status: 503 },
      ),
      errorType: OJSServerError,
    },
  ])('does not retry DELETE after a $name', async ({ response, errorType }) => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(mockResponse({}));
    const transport = new HttpTransport({
      url: 'http://localhost:8080',
      retryConfig: { maxRetries: 3, minBackoffMs: 10, maxBackoffMs: 50 },
    });

    const outcome = transport.request({
      method: 'DELETE',
      path: '/workflows/wf-1',
    }).catch((error: unknown) => error);
    await vi.runAllTimersAsync();

    expect(await outcome).toBeInstanceOf(errorType);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it('keeps an external primitive abort reason distinct and does not retry it', async () => {
    globalThis.fetch = hangingFetch();
    const controller = new AbortController();
    const transport = new HttpTransport({
      url: 'http://localhost:8080',
      timeout: 10_000,
      retryConfig: { maxRetries: 3, minBackoffMs: 10, maxBackoffMs: 50 },
    });

    const promise = transport.request({
      method: 'GET',
      path: '/health',
      signal: controller.signal,
    });
    const assertion = promise.catch((e: unknown) => e);
    controller.abort('user-cancelled');
    await vi.runAllTimersAsync();
    const err = await assertion;

    // External cancellation is normalized to an Error but is NOT a retryable
    // timeout, and is never retried.
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(OJSRequestTimeoutError);
    expect((err as Error).cause).toBe('user-cancelled');
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it('surfaces an internal timeout during body reading as a retryable timeout and retries a GET', async () => {
    const encoder = new TextEncoder();
    let attempt = 0;
    globalThis.fetch = vi.fn().mockImplementation(
      (_url: string | URL | Request, init?: RequestInit) => {
        attempt++;
        if (attempt === 1) {
          // First attempt: emit a partial body once, then hang so the
          // internal deadline aborts mid-parse (never enqueue again — an
          // unbounded producer would buffer forever and never yield to the
          // timer).
          const signal = init?.signal;
          let sentPrefix = false;
          const stream = new ReadableStream<Uint8Array>({
            start(streamController) {
              signal?.addEventListener('abort', () => {
                streamController.error(signal.reason);
              }, { once: true });
            },
            pull(streamController) {
              if (!sentPrefix) {
                sentPrefix = true;
                streamController.enqueue(encoder.encode('{"partial":'));
              }
            },
          });
          return Promise.resolve(new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'application/openjobspec+json' },
          }));
        }
        // Second attempt: a complete, valid body.
        return Promise.resolve(mockResponse({ job: { id: 'ok' } }));
      },
    );

    const transport = new HttpTransport({
      url: 'http://localhost:8080',
      timeout: 1000,
      retryConfig: { minBackoffMs: 10, maxBackoffMs: 50 },
    });

    const promise = transport.request<{ job: { id: string } }>({
      method: 'GET',
      path: '/jobs/123',
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.body.job.id).toBe('ok');
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
  });
});

describe('fetchManifest', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should fetch manifest from /ojs/manifest', async () => {
    const manifestData = { specversion: '1.0', layers: [1, 2, 3] };
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(manifestData), {
        status: 200,
        headers: { 'Content-Type': 'application/openjobspec+json' },
      }),
    );

    const response = await fetchManifest('http://localhost:8080/');

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      'http://localhost:8080/ojs/manifest',
      expect.any(Object),
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual(manifestData);
  });

  it('should include custom headers', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200, headers: {} }),
    );

    await fetchManifest('http://localhost:8080', { 'Authorization': 'Bearer token' });

    const callArgs = vi.mocked(globalThis.fetch).mock.calls[0];
    const headers = callArgs[1]?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer token');
  });
});

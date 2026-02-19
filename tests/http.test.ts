import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpTransport, fetchManifest } from '../src/transport/http.js';
import { OJSConnectionError, OJSValidationError, OJSNotFoundError, OJSServerError, OJSRateLimitError } from '../src/errors.js';

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

      const transport = new HttpTransport({ url: 'http://localhost:8080' });

      await expect(
        transport.request({ method: 'GET', path: '/health' }),
      ).rejects.toBeInstanceOf(OJSConnectionError);
    });

    it('should wrap DOMException as OJSConnectionError', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'));

      const transport = new HttpTransport({ url: 'http://localhost:8080' });

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
      await expect(promise).rejects.toBeInstanceOf(OJSConnectionError);
    });
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

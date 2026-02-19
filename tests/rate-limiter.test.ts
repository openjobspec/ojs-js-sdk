import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpTransport } from '../src/transport/http.js';
import { OJSRateLimitError, OJSServerError, OJSValidationError } from '../src/errors.js';
import { DEFAULT_RETRY_CONFIG, parseRetryAfterMs, computeRetryDelay } from '../src/rate-limiter.js';
import type { RetryConfig } from '../src/rate-limiter.js';

function mockRateLimitResponse(retryAfter?: string): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/openjobspec+json',
  };
  if (retryAfter !== undefined) {
    headers['Retry-After'] = retryAfter;
  }
  return new Response(
    JSON.stringify({ error: { code: 'rate_limited', message: 'Too many requests' } }),
    { status: 429, headers },
  );
}

function mockSuccessResponse(body: unknown = { ok: true }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/openjobspec+json' },
  });
}

function mockServerErrorResponse(): Response {
  return new Response(
    JSON.stringify({ error: { code: 'server_error', message: 'Internal error' } }),
    { status: 500, headers: { 'Content-Type': 'application/openjobspec+json' } },
  );
}

function mockValidationErrorResponse(): Response {
  return new Response(
    JSON.stringify({ error: { code: 'invalid_request', message: 'Bad request' } }),
    { status: 400, headers: { 'Content-Type': 'application/openjobspec+json' } },
  );
}

describe('rate-limiter utilities', () => {
  describe('parseRetryAfterMs', () => {
    it('should return undefined for null', () => {
      expect(parseRetryAfterMs(null)).toBeUndefined();
    });

    it('should parse numeric seconds', () => {
      expect(parseRetryAfterMs('120')).toBe(120_000);
    });

    it('should parse fractional seconds', () => {
      expect(parseRetryAfterMs('1.5')).toBe(1500);
    });

    it('should parse HTTP-date format', () => {
      const futureDate = new Date(Date.now() + 60_000).toUTCString();
      const result = parseRetryAfterMs(futureDate);
      expect(result).toBeDefined();
      // Should be approximately 60 seconds (with some tolerance)
      expect(result!).toBeGreaterThan(50_000);
      expect(result!).toBeLessThanOrEqual(61_000);
    });

    it('should return 0 for past HTTP-date', () => {
      const pastDate = new Date(Date.now() - 10_000).toUTCString();
      expect(parseRetryAfterMs(pastDate)).toBe(0);
    });

    it('should return undefined for unparseable string', () => {
      expect(parseRetryAfterMs('not-a-date-or-number')).toBeUndefined();
    });

    it('should handle zero seconds', () => {
      expect(parseRetryAfterMs('0')).toBe(0);
    });
  });

  describe('computeRetryDelay', () => {
    it('should use retryAfterMs when provided', () => {
      const config = { ...DEFAULT_RETRY_CONFIG };
      expect(computeRetryDelay(0, config, 5000)).toBe(5000);
    });

    it('should clamp retryAfterMs to maxBackoffMs', () => {
      const config = { ...DEFAULT_RETRY_CONFIG, maxBackoffMs: 10_000 };
      expect(computeRetryDelay(0, config, 60_000)).toBe(10_000);
    });

    it('should compute exponential backoff without retryAfterMs', () => {
      const config = { ...DEFAULT_RETRY_CONFIG, minBackoffMs: 1000, maxBackoffMs: 60_000 };
      // Attempt 0: min(1000 * 2^0, 60000) * rand(0.5, 1.0) = [500, 1000)
      const delay = computeRetryDelay(0, config, undefined);
      expect(delay).toBeGreaterThanOrEqual(500);
      expect(delay).toBeLessThanOrEqual(1000);
    });

    it('should increase backoff with attempts', () => {
      const config = { ...DEFAULT_RETRY_CONFIG, minBackoffMs: 500, maxBackoffMs: 60_000 };
      // Attempt 2: min(500 * 2^2, 60000) * rand(0.5, 1.0) = [1000, 2000)
      const delay = computeRetryDelay(2, config, undefined);
      expect(delay).toBeGreaterThanOrEqual(1000);
    });

    it('should not exceed maxBackoffMs', () => {
      const config = { ...DEFAULT_RETRY_CONFIG, minBackoffMs: 1000, maxBackoffMs: 5000 };
      const delay = computeRetryDelay(10, config, undefined);
      expect(delay).toBeLessThanOrEqual(5000);
    });
  });

  describe('DEFAULT_RETRY_CONFIG', () => {
    it('should have expected defaults', () => {
      expect(DEFAULT_RETRY_CONFIG).toEqual({
        maxRetries: 3,
        minBackoffMs: 500,
        maxBackoffMs: 30_000,
        enabled: true,
      });
    });
  });
});

describe('HttpTransport rate-limit retry', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('should retry on 429 and succeed on next attempt', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(mockRateLimitResponse('1'))
      .mockResolvedValueOnce(mockSuccessResponse({ job: { id: '123' } }));

    const transport = new HttpTransport({
      url: 'http://localhost:8080',
      retryConfig: { minBackoffMs: 10, maxBackoffMs: 5000 },
    });

    const result = await transport.request<{ job: { id: string } }>({
      method: 'GET',
      path: '/jobs/123',
    });

    expect(result.body.job.id).toBe('123');
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
  });

  it('should respect Retry-After header value', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(mockRateLimitResponse('2'))
      .mockResolvedValueOnce(mockSuccessResponse());

    const transport = new HttpTransport({
      url: 'http://localhost:8080',
      retryConfig: { minBackoffMs: 10 },
    });

    const start = Date.now();
    await transport.request({ method: 'GET', path: '/health' });
    const elapsed = Date.now() - start;

    // Retry-After: 2 means 2000ms delay
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
  });

  it('should throw after max retries exhausted', async () => {
    globalThis.fetch = vi.fn()
      .mockImplementation(() => Promise.resolve(mockRateLimitResponse('0')));

    const transport = new HttpTransport({
      url: 'http://localhost:8080',
      retryConfig: { maxRetries: 2, minBackoffMs: 10, maxBackoffMs: 50 },
    });

    await expect(
      transport.request({ method: 'GET', path: '/health' }),
    ).rejects.toBeInstanceOf(OJSRateLimitError);

    // 1 initial + 2 retries = 3 total
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(3);
  });

  it('should not retry non-429 errors', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(mockServerErrorResponse());

    const transport = new HttpTransport({
      url: 'http://localhost:8080',
      retryConfig: { minBackoffMs: 10 },
    });

    await expect(
      transport.request({ method: 'GET', path: '/health' }),
    ).rejects.toBeInstanceOf(OJSServerError);

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it('should not retry 400 errors', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(mockValidationErrorResponse());

    const transport = new HttpTransport({
      url: 'http://localhost:8080',
      retryConfig: { minBackoffMs: 10 },
    });

    await expect(
      transport.request({ method: 'POST', path: '/jobs', body: {} }),
    ).rejects.toBeInstanceOf(OJSValidationError);

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it('should not retry when retries are disabled', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(mockRateLimitResponse('1'));

    const transport = new HttpTransport({
      url: 'http://localhost:8080',
      retryConfig: { enabled: false },
    });

    await expect(
      transport.request({ method: 'GET', path: '/health' }),
    ).rejects.toBeInstanceOf(OJSRateLimitError);

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it('should retry multiple times before succeeding', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(mockRateLimitResponse('0'))
      .mockResolvedValueOnce(mockRateLimitResponse('0'))
      .mockResolvedValueOnce(mockSuccessResponse({ status: 'ok' }));

    const transport = new HttpTransport({
      url: 'http://localhost:8080',
      retryConfig: { maxRetries: 3, minBackoffMs: 10, maxBackoffMs: 50 },
    });

    const result = await transport.request<{ status: string }>({
      method: 'GET',
      path: '/health',
    });

    expect(result.body.status).toBe('ok');
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(3);
  });

  it('should use default retry config when none provided', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(mockRateLimitResponse('0'))
      .mockResolvedValueOnce(mockSuccessResponse());

    const transport = new HttpTransport({ url: 'http://localhost:8080' });

    await transport.request({ method: 'GET', path: '/health' });
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
  });

  it('should handle 429 without Retry-After header', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(mockRateLimitResponse()) // no Retry-After
      .mockResolvedValueOnce(mockSuccessResponse());

    const transport = new HttpTransport({
      url: 'http://localhost:8080',
      retryConfig: { minBackoffMs: 10, maxBackoffMs: 100 },
    });

    const result = await transport.request({ method: 'GET', path: '/health' });
    expect(result.status).toBe(200);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
  });

  it('should abort retry sleep when signal is aborted', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(mockRateLimitResponse('10'))
      .mockResolvedValueOnce(mockSuccessResponse());

    const controller = new AbortController();
    const transport = new HttpTransport({
      url: 'http://localhost:8080',
      retryConfig: { minBackoffMs: 10, maxBackoffMs: 60_000 },
    });

    // Abort after a short delay so the retry sleep is interrupted
    setTimeout(() => controller.abort(), 50);

    await expect(
      transport.request({ method: 'GET', path: '/health', signal: controller.signal }),
    ).rejects.toThrow();

    // Only one fetch call — the retry sleep was aborted before the second attempt
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it('should allow partial retry config override', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(mockRateLimitResponse('0'))
      .mockResolvedValueOnce(mockSuccessResponse());

    // Only override maxRetries, rest should be defaults
    const transport = new HttpTransport({
      url: 'http://localhost:8080',
      retryConfig: { maxRetries: 1 },
    });

    await transport.request({ method: 'GET', path: '/health' });
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
  });
});

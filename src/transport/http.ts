/**
 * HTTP transport implementation using the built-in `fetch` API.
 * Zero dependencies — works in Node.js 18+, Deno, Bun, and browsers.
 */

import { OJSConnectionError, OJSRateLimitError, parseErrorResponse } from '../errors.js';
import { DEFAULT_RETRY_CONFIG, computeRetryDelay } from '../rate-limiter.js';
import type { RetryConfig } from '../rate-limiter.js';
import type {
  Transport,
  TransportConfig,
  TransportRequestOptions,
  TransportResponse,
  OJSResponseHeaders,
} from './types.js';

const OJS_CONTENT_TYPE = 'application/openjobspec+json';
const OJS_BASE_PATH = '/ojs/v1';
const DEFAULT_SPEC_VERSION = '1.0';
const DEFAULT_TIMEOUT = 30_000;

export class HttpTransport implements Transport {
  private readonly baseUrl: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly defaultTimeout: number;
  private readonly retryConfig: RetryConfig;

  constructor(config: TransportConfig) {
    // Strip trailing slash from base URL
    this.baseUrl = config.url.replace(/\/+$/, '');
    this.defaultTimeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...config.retryConfig };

    this.defaultHeaders = {
      'Content-Type': OJS_CONTENT_TYPE,
      'Accept': OJS_CONTENT_TYPE,
      'OJS-Version': config.specVersion ?? DEFAULT_SPEC_VERSION,
      ...config.headers,
    };

    if (config.auth) {
      this.defaultHeaders['Authorization'] = config.auth;
    }
  }

  async request<T = unknown>(
    options: TransportRequestOptions,
  ): Promise<TransportResponse<T>> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        const result = await this.executeRequest<T>(options);
        return result;
      } catch (error) {
        lastError = error;

        // Only retry on rate limit errors when retries are enabled
        if (
          !(error instanceof OJSRateLimitError) ||
          !this.retryConfig.enabled ||
          attempt >= this.retryConfig.maxRetries
        ) {
          throw error;
        }

        const retryAfterMs = error.retryAfter !== undefined
          ? error.retryAfter * 1000
          : undefined;
        const delayMs = computeRetryDelay(attempt, this.retryConfig, retryAfterMs);
        await abortableSleep(delayMs, options.signal);
      }
    }

    // Should not reach here, but satisfy TypeScript
    throw lastError;
  }

  private async executeRequest<T = unknown>(
    options: TransportRequestOptions,
  ): Promise<TransportResponse<T>> {
    const url = options.rawPath
      ? `${this.baseUrl}${options.path}`
      : `${this.baseUrl}${OJS_BASE_PATH}${options.path}`;
    const timeout = options.timeout ?? this.defaultTimeout;

    // Set up timeout via AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    // Chain the external signal if provided
    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort());
    }

    try {
      const requestInit: RequestInit = {
        method: options.method,
        headers: {
          ...this.defaultHeaders,
          ...options.headers,
        },
        signal: controller.signal,
        ...(options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
      };
      const response = await fetch(url, requestInit);

      clearTimeout(timeoutId);

      const headers = parseResponseHeaders(response.headers);

      // No content response
      if (response.status === 204) {
        return { status: response.status, headers, body: {} as T };
      }

      const body = (await response.json()) as T;

      // Throw on error status codes
      if (!response.ok) {
        throw parseErrorResponse(
          response.status,
          body as Record<string, unknown>,
          response.headers,
        );
      }

      return { status: response.status, headers, body };
    } catch (error) {
      clearTimeout(timeoutId);

      // Re-throw OJS errors as-is
      if (error instanceof Error && error.name.startsWith('OJS')) {
        throw error;
      }

      // Wrap fetch/network errors
      if (error instanceof TypeError || error instanceof DOMException) {
        throw new OJSConnectionError(
          `Connection failed: ${(error as Error).message}`,
          error as Error,
        );
      }

      throw error;
    }
  }
}

function parseResponseHeaders(headers: Headers): OJSResponseHeaders {
  const parsed: OJSResponseHeaders = {};
  const ojsVersion = headers.get('OJS-Version');
  const contentType = headers.get('Content-Type');
  const requestId = headers.get('X-Request-Id');
  const location = headers.get('Location');
  if (ojsVersion !== null) parsed.ojsVersion = ojsVersion;
  if (contentType !== null) parsed.contentType = contentType;
  if (requestId !== null) parsed.requestId = requestId;
  if (location !== null) parsed.location = location;
  return parsed;
}

/**
 * Sleep that can be cancelled via an AbortSignal.
 * If the signal is already aborted, rejects immediately.
 * If the signal fires during the sleep, the timer is cleared and the
 * promise rejects with the signal's reason.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(signal.reason);
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/**
 * Make a raw request to a URL outside the OJS base path (e.g., /ojs/manifest).
 */
export async function fetchManifest(
  baseUrl: string,
  headers?: Record<string, string>,
): Promise<TransportResponse> {
  const url = `${baseUrl.replace(/\/+$/, '')}/ojs/manifest`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': OJS_CONTENT_TYPE,
      ...headers,
    },
  });

  const body = await response.json();
  return {
    status: response.status,
    headers: parseResponseHeaders(response.headers),
    body,
  };
}

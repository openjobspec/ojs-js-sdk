/**
 * HTTP transport implementation using the built-in `fetch` API.
 * Zero dependencies — works in Node.js 18+, Deno, Bun, and browsers.
 */

import { OJSConnectionError, parseErrorResponse } from '../errors.js';
import type {
  Transport,
  TransportConfig,
  TransportRequestOptions,
  TransportResponse,
  OJSResponseHeaders,
} from './types.js';

const OJS_CONTENT_TYPE = 'application/openjobspec+json';
const OJS_BASE_PATH = '/ojs/v1';
const DEFAULT_SPEC_VERSION = '1.0.0-rc.1';
const DEFAULT_TIMEOUT = 30_000;

export class HttpTransport implements Transport {
  private readonly baseUrl: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly defaultTimeout: number;

  constructor(config: TransportConfig) {
    // Strip trailing slash from base URL
    this.baseUrl = config.url.replace(/\/+$/, '');
    this.defaultTimeout = config.timeout ?? DEFAULT_TIMEOUT;

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
    const url = `${this.baseUrl}${OJS_BASE_PATH}${options.path}`;
    const timeout = options.timeout ?? this.defaultTimeout;

    // Set up timeout via AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    // Chain the external signal if provided
    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort());
    }

    try {
      const response = await fetch(url, {
        method: options.method,
        headers: {
          ...this.defaultHeaders,
          ...options.headers,
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

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
  return {
    ojsVersion: headers.get('OJS-Version') ?? undefined,
    contentType: headers.get('Content-Type') ?? undefined,
    requestId: headers.get('X-Request-Id') ?? undefined,
    location: headers.get('Location') ?? undefined,
  };
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

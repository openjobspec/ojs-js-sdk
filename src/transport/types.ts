/**
 * Transport interface for OJS HTTP communication.
 * Defines the contract that transport implementations must satisfy.
 */

import type { RetryConfig } from '../rate-limiter.js';

/** Standard OJS response headers. */
export interface OJSResponseHeaders {
  ojsVersion?: string | undefined;
  contentType?: string | undefined;
  requestId?: string | undefined;
  location?: string | undefined;
}

/** A transport response wrapping the parsed body and headers. */
export interface TransportResponse<T = unknown> {
  status: number;
  headers: OJSResponseHeaders;
  body: T;
}

/** Options for transport requests. */
export interface TransportRequestOptions {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown | undefined;
  headers?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
  timeout?: number | undefined;
  /** If true, the path is used as-is (no /ojs/v1 prefix). */
  rawPath?: boolean | undefined;
}

/**
 * Transport interface — the abstraction over HTTP communication.
 * The default implementation uses the built-in `fetch` API.
 */
export interface Transport {
  /**
   * Send a request to the OJS server.
   * @returns The parsed response.
   */
  request<T = unknown>(options: TransportRequestOptions): Promise<TransportResponse<T>>;
}

/** Configuration for creating a transport. */
export interface TransportConfig {
  /** Base URL of the OJS server (e.g., 'http://localhost:8080'). */
  url: string;

  /** Optional authorization header value (e.g., 'Bearer <token>'). */
  auth?: string | undefined;

  /** Custom headers to include in every request. */
  headers?: Record<string, string> | undefined;

  /** Default request timeout in milliseconds. */
  timeout?: number | undefined;

  /** OJS spec version to send in the OJS-Version header. */
  specVersion?: string | undefined;

  /** Configuration for automatic retry on 429 responses. */
  retryConfig?: Partial<RetryConfig> | undefined;
}

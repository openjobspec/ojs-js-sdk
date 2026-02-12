/**
 * Transport interface for OJS HTTP communication.
 * Defines the contract that transport implementations must satisfy.
 */

/** Standard OJS response headers. */
export interface OJSResponseHeaders {
  ojsVersion?: string;
  contentType?: string;
  requestId?: string;
  location?: string;
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
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeout?: number;
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
  auth?: string;

  /** Custom headers to include in every request. */
  headers?: Record<string, string>;

  /** Default request timeout in milliseconds. */
  timeout?: number;

  /** OJS spec version to send in the OJS-Version header. */
  specVersion?: string;
}

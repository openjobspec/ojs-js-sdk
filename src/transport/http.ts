/**
 * HTTP transport implementation using the built-in `fetch` API.
 * Works in Node.js 18+, Deno, Bun, and browsers. Internal request IDs go
 * through the SDK's private cross-runtime crypto provider rather than
 * touching ambient Web Crypto directly.
 */

import {
  OJSConnectionError,
  OJSRateLimitError,
  OJSRequestTimeoutError,
  OJSServerError,
  OJSValidationError,
  parseErrorResponse,
} from '../errors.js';
import { generateUuidV4 } from '../uuid.js';
import { DEFAULT_RETRY_CONFIG, computeRetryDelay, isRetryableStatus } from '../rate-limiter.js';
import type { RetryConfig } from '../rate-limiter.js';
import { validateUniquePolicy } from '../validation/schemas.js';
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
  readonly supportsLegacyCheckpointResume = true;

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
      this.defaultHeaders.Authorization = config.auth;
    }
  }

  async request<T = unknown>(
    options: TransportRequestOptions,
  ): Promise<TransportResponse<T>> {
    assertCanonicalHttpUniqueOptions(options);
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        const result = await this.executeRequest<T>(options);
        return result;
      } catch (error) {
        lastError = error;

        // DELETE responses are not generically retry-safe in OJS: a delete
        // can commit before the client sees the response, and the repeated
        // request then returns 404. Endpoint-specific normalization may opt
        // in elsewhere, but the base transport must preserve the ambiguous
        // first-attempt error.
        const retryNotCancelled = options.signal?.aborted !== true;
        const canRetryResponseFailure =
          retryNotCancelled && options.method !== 'DELETE';

        // Retry on rate limit (429) and optionally on transient server errors
        // (502/503/504), except for DELETE as described above.
        const isRateLimit = canRetryResponseFailure &&
          error instanceof OJSRateLimitError;
        const isServerError = error instanceof OJSServerError &&
          canRetryResponseFailure &&
          isRetryableStatus(error.statusCode, this.retryConfig);

        // Ambiguous connection failures include the transport's own internal
        // timeout (see `executeRequest`) and fetch/network failures. Retry
        // them only where the response contract makes replay safe: GET/HEAD,
        // plus the SDK's contract-safe PUT operation. POST may have committed
        // a non-idempotent action, and DELETE may have committed successfully
        // before a retry observes the endpoint's post-delete 404.
        // An external caller abort surfaces its own non-OJS reason and is
        // intentionally excluded.
        const isRetryableConnectionFailure = retryNotCancelled &&
          error instanceof OJSConnectionError &&
          isAmbiguousFailureRetryMethod(options.method);

        if (
          (!isRateLimit && !isServerError && !isRetryableConnectionFailure) ||
          !this.retryConfig.enabled ||
          attempt >= this.retryConfig.maxRetries
        ) {
          throw error;
        }

        const retryAfterMs = isRateLimit && error.retryAfter !== undefined
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

    // Set up timeout via AbortController. The internal deadline aborts the
    // controller with a distinct, retryable OJSRequestTimeoutError as the
    // abort *reason* (not the default reason-less DOMException). Because the
    // catch/parse paths below normalize `controller.signal.reason` via
    // `abortReasonAsError`, an internal timeout surfaces as this typed,
    // retryable error carrying the timeout duration and path, while an
    // external `options.signal` abort still surfaces its own (non-retryable)
    // reason unchanged.
    const controller = new AbortController();
    const timeoutError = new OJSRequestTimeoutError(timeout, options.path);
    const timeoutId = setTimeout(() => controller.abort(timeoutError), timeout);

    // Chain the external signal if provided, forwarding its abort reason so
    // callers see the original cause rather than a generic timeout abort.
    // The listener is named (not an inline closure) so it can actually be
    // removed later via removeEventListener — passing a fresh arrow function
    // to removeEventListener is a no-op and leaks the listener for the
    // lifetime of the external signal.
    const externalSignal = options.signal;
    const onExternalAbort = (): void => controller.abort(externalSignal?.reason);
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort(externalSignal.reason);
      } else {
        externalSignal.addEventListener('abort', onExternalAbort);
      }
    }

    try {
      const requestInit: RequestInit = {
        method: options.method,
        headers: {
          ...this.defaultHeaders,
          'X-Request-ID': generateUuidV4(),
          ...options.headers,
        },
        signal: controller.signal,
        ...(options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
      };
      const response = await fetch(url, requestInit);

      const headers = parseResponseHeaders(response.headers);

      // No content response
      if (response.status === 204) {
        return { status: response.status, headers, body: {} as T };
      }

      let body: T;
      try {
        body = (await response.json()) as T;
      } catch (parseError) {
        if (controller.signal.aborted) {
          throw abortReasonAsError(controller.signal);
        }
        throw new OJSConnectionError(
          `Invalid JSON response (status ${response.status})`,
          parseError instanceof Error ? parseError : undefined,
        );
      }

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
      // Re-throw OJS errors as-is
      if (error instanceof Error && error.name.startsWith('OJS')) {
        throw error;
      }

      // If our internal controller was aborted (either this request's own
      // timeout, or an external `options.signal` forwarded into it above),
      // always reject with the normalized Error derived from its `reason`
      // — regardless of what `fetch()` itself actually threw. Some
      // environments throw the abort reason directly rather than a
      // DOMException/Error (including, in principle, a bare primitive
      // like a string or number passed to `controller.abort(reason)`),
      // which would otherwise bypass every check below and propagate
      // un-normalized via the final `throw error;`, breaking the "always
      // reject with a real Error" invariant this SDK relies on elsewhere
      // (see `abortReasonAsError`'s own doc comment). This takes priority
      // over the generic TypeError/DOMException/SyntaxError wrapping
      // below so the caller sees the actual abort reason (e.g. the
      // original timeout or external cancellation cause) rather than a
      // generic "Connection failed" message.
      if (controller.signal.aborted) {
        throw abortReasonAsError(controller.signal);
      }

      // Wrap fetch/network errors
      if (
        error instanceof TypeError ||
        error instanceof DOMException ||
        error instanceof SyntaxError
      ) {
        throw new OJSConnectionError(
          `Connection failed: ${(error as Error).message}`,
          error as Error,
        );
      }

      throw error;
    } finally {
      // Always clear the timeout and detach the external abort listener,
      // regardless of which return/throw path was taken above, so a reused
      // AbortSignal (e.g. a worker's shared shutdown signal) never
      // accumulates listeners across requests.
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }
}

/**
 * Whether an HTTP method is safe to transparently retry after an ambiguous
 * timeout or network failure under the OJS response contract.
 *
 * DELETE is deliberately excluded despite its HTTP-level idempotence: OJS
 * delete endpoints return 404 after the resource was successfully removed,
 * so replay would replace the original ambiguous failure with a misleading
 * not-found response. POST is excluded because it may duplicate side effects.
 */
function isAmbiguousFailureRetryMethod(
  method: TransportRequestOptions['method'],
): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'PUT';
}

function assertCanonicalHttpUniqueOptions(options: TransportRequestOptions): void {
  if (options.method !== 'POST') return;

  const path = options.path.split(/[?#]/u, 1)[0] ?? options.path;
  const isSingleEnqueue = path === '/jobs' || path === '/ojs/v1/jobs';
  const isBatchEnqueue = path === '/jobs/batch' || path === '/ojs/v1/jobs/batch';
  if (!isSingleEnqueue && !isBatchEnqueue) return;

  const body = asRecord(options.body);
  if (!body) return;

  if (isSingleEnqueue) {
    assertCanonicalUniquePolicy(body.options, 'options.unique');
    return;
  }

  assertCanonicalUniquePolicy(body.default_options, 'default_options.unique');
  if (!Array.isArray(body.jobs)) return;
  for (const [index, job] of body.jobs.entries()) {
    assertCanonicalUniquePolicy(
      asRecord(job)?.options,
      `jobs[${index}].options.unique`,
    );
  }
}

function assertCanonicalUniquePolicy(value: unknown, field: string): void {
  const options = asRecord(value);
  if (options?.unique === undefined) return;

  const unique = asRecord(options.unique);
  if (unique && Object.prototype.hasOwnProperty.call(unique, 'key')) {
    const legacyField = `${field}.key`;
    throw new OJSValidationError(
      `${legacyField} is an SDK-only deprecated alias and is not valid canonical HTTP wire data; use keys and args_keys.`,
      { field: legacyField },
    );
  }

  const errors = validateUniquePolicy(options.unique, field);
  if (errors.length > 0) {
    throw new OJSValidationError(
      errors.map((error) => error.message).join('; '),
      { validation_errors: errors },
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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
    if (!signal) {
      setTimeout(resolve, ms);
      return;
    }

    if (signal.aborted) {
      reject(abortReasonAsError(signal));
      return;
    }

    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(abortReasonAsError(signal));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Normalizes an AbortSignal's `reason` to an Error instance. `reason` is
 * typed `any` and, per spec, may be any value the caller passed to
 * `controller.abort(reason)` — rejecting with a non-Error value would
 * silently break `instanceof Error`/stack-trace expectations downstream.
 * The default (argument-less) `abort()` reason is already a DOMException,
 * which passes through unchanged.
 */
function abortReasonAsError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new Error('The operation was aborted', { cause: reason });
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

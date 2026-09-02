/**
 * OJS error types following the OJS Core Specification error reporting format.
 */

/** Base error class for all OJS errors. */
export class OJSError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;
  readonly requestId: string | undefined;

  constructor(
    message: string,
    code: string,
    options?: {
      retryable?: boolean | undefined;
      details?: Record<string, unknown> | undefined;
      requestId?: string | undefined;
      cause?: Error | undefined;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'OJSError';
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.details = options?.details;
    this.requestId = options?.requestId;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
      requestId: this.requestId,
    };
  }
}

/** The server returned a validation error (400). */
export class OJSValidationError extends OJSError {
  constructor(
    message: string,
    details?: Record<string, unknown>,
    requestId?: string,
  ) {
    super(message, 'invalid_request', {
      retryable: false,
      details,
      requestId,
    });
    this.name = 'OJSValidationError';
  }
}

/** The requested resource was not found (404). */
export class OJSNotFoundError extends OJSError {
  constructor(
    resourceType: string,
    resourceId: string,
    requestId?: string,
  ) {
    super(
      `${resourceType} '${resourceId}' not found.`,
      'not_found',
      {
        retryable: false,
        details: { resource_type: resourceType, resource_id: resourceId },
        requestId,
      },
    );
    this.name = 'OJSNotFoundError';
  }
}

/** The requested HTTP method is not supported for this resource (405). */
export class OJSMethodNotAllowedError extends OJSError {
  readonly statusCode = 405;

  constructor(
    message = 'Method Not Allowed',
    details?: Record<string, unknown>,
    requestId?: string,
  ) {
    super(message, 'method_not_allowed', {
      retryable: false,
      details,
      requestId,
    });
    this.name = 'OJSMethodNotAllowedError';
  }
}

/** A duplicate job conflict occurred (409). */
export class OJSDuplicateError extends OJSError {
  readonly existingJobId: string | undefined;

  constructor(
    message: string,
    details?: Record<string, unknown>,
    requestId?: string,
  ) {
    super(message, 'duplicate', { retryable: false, details, requestId });
    this.name = 'OJSDuplicateError';
    this.existingJobId = details?.existing_job_id as string | undefined;
  }
}

/** A state conflict occurred (409). */
export class OJSConflictError extends OJSError {
  constructor(
    message: string,
    details?: Record<string, unknown>,
    requestId?: string,
  ) {
    super(message, 'conflict', { retryable: false, details, requestId });
    this.name = 'OJSConflictError';
  }
}

/** The server returned an unexpected error (5xx). */
export class OJSServerError extends OJSError {
  readonly statusCode: number;

  constructor(message: string, statusCode: number, requestId?: string) {
    super(message, 'server_error', { retryable: true, requestId });
    this.name = 'OJSServerError';
    this.statusCode = statusCode;
  }
}

/** A network or connection error occurred. */
export class OJSConnectionError extends OJSError {
  constructor(
    message: string,
    cause?: Error,
    details?: Record<string, unknown>,
  ) {
    super(message, 'connection_error', { retryable: true, cause, details });
    this.name = 'OJSConnectionError';
  }
}

/**
 * A client-side request exceeded its configured timeout before the server
 * responded (or before the response body finished streaming). This is the
 * transport's *own* internal deadline firing — distinct from an external
 * caller-supplied `AbortSignal` cancellation, which surfaces its own abort
 * reason unchanged and is never retried.
 *
 * It extends {@link OJSConnectionError} so existing `instanceof
 * OJSConnectionError` handling keeps treating it as a retryable transient
 * connection failure (backward compatible), while `name`, `timeoutMs`,
 * `path`, and structured `details` (`timeout_ms`/`path`) let callers
 * identify a timeout specifically rather than receiving an opaque,
 * reason-less `AbortError`.
 */
export class OJSRequestTimeoutError extends OJSConnectionError {
  /** The elapsed timeout duration in milliseconds. */
  readonly timeoutMs: number;
  /** The logical request path that timed out. */
  readonly path: string;

  constructor(timeoutMs: number, path: string, cause?: Error) {
    super(`Request to '${path}' timed out after ${timeoutMs}ms.`, cause, {
      timeout_ms: timeoutMs,
      path,
    });
    this.name = 'OJSRequestTimeoutError';
    this.timeoutMs = timeoutMs;
    this.path = path;
  }
}

/** A job handler timeout occurred. */
export class OJSTimeoutError extends OJSError {
  constructor(jobId: string, timeoutMs: number) {
    super(
      `Job '${jobId}' exceeded ${timeoutMs}ms timeout.`,
      'timeout',
      { retryable: true, details: { job_id: jobId, timeout_ms: timeoutMs } },
    );
    this.name = 'OJSTimeoutError';
  }
}

/**
 * Loading an existing durable-execution checkpoint failed for a reason
 * other than "no checkpoint exists yet" ({@link OJSNotFoundError}). This
 * covers network/connection failures, authentication/authorization
 * failures, malformed/undecodable responses, and server-side (5xx)
 * errors from the canonical checkpoint endpoint.
 *
 * Unlike a 404 (which legitimately means "this is the job's first
 * execution" and is handled silently), any other failure here means the
 * SDK genuinely does not know whether a checkpoint exists. Silently
 * treating that as "start fresh" would risk re-executing non-idempotent
 * side effects that were already recorded — a correctness violation of
 * durable execution's exactly-once-recording guarantee. {@link
 * DurableContext.create} therefore throws this error instead, so the
 * caller (typically `OJSWorker.registerDurable`) never invokes the user
 * handler and the job is nacked for retry instead.
 *
 * The original failure is preserved as `.cause` (so `instanceof`
 * checks against e.g. {@link OJSConnectionError}/{@link OJSServerError}
 * still work against `error.cause`), and `retryable` mirrors the
 * underlying error's own classification when it is an {@link OJSError}
 * (defaulting to `true` for unclassified errors, since a transient
 * lookup failure is the common case).
 */
export class OJSCheckpointLoadError extends OJSError {
  /** The job whose checkpoint could not be loaded. */
  readonly jobId: string;
  /** The attempt number the checkpoint load was performed for. */
  readonly attempt: number;

  constructor(
    jobId: string,
    attempt: number,
    cause: unknown,
    source: 'canonical' | 'legacy' = 'canonical',
  ) {
    const causeError = cause instanceof Error ? cause : new Error(String(cause));
    const retryable = cause instanceof OJSError ? cause.retryable : true;
    const checkpointLabel = source === 'legacy' ? 'legacy checkpoint' : 'checkpoint';
    super(
      `Failed to load ${checkpointLabel} for job '${jobId}' (attempt ${attempt}): ${causeError.message}`,
      'checkpoint_load_failed',
      {
        retryable,
        details: source === 'legacy'
          ? { job_id: jobId, attempt, checkpoint_source: source }
          : { job_id: jobId, attempt },
        cause: causeError,
      },
    );
    this.name = 'OJSCheckpointLoadError';
    this.jobId = jobId;
    this.attempt = attempt;
  }
}

/**
 * The durable handler requested a different replay operation than the next
 * checkpoint entry. Executing the live operation would corrupt deterministic
 * replay, so this error is non-retryable until the handler/checkpoint mismatch
 * is resolved.
 */
export class ReplayIntegrityError extends OJSError {
  readonly jobId: string;
  readonly attempt: number;
  readonly position: number;
  readonly expectedType: string;
  readonly actualType: string;
  readonly expectedKey: string | undefined;
  readonly actualKey: string | undefined;

  constructor(
    jobId: string,
    attempt: number,
    position: number,
    expectedType: string,
    actualType: string,
    expectedKey?: string,
    actualKey?: string,
  ) {
    const keyMismatch = expectedType === actualType && expectedKey !== actualKey;
    const mismatch = keyMismatch
      ? `checkpoint key is ${JSON.stringify(actualKey)} but handler requested ${JSON.stringify(expectedKey)}`
      : `checkpoint type is '${actualType}' but handler requested '${expectedType}'`;

    super(
      `Durable replay mismatch for job '${jobId}' (attempt ${attempt}) at position ${position}: ${mismatch}.`,
      'replay_integrity_error',
      {
        retryable: false,
        details: {
          job_id: jobId,
          attempt,
          position,
          expected_type: expectedType,
          actual_type: actualType,
          ...(expectedKey === undefined ? {} : { expected_key: expectedKey }),
          ...(actualKey === undefined ? {} : { actual_key: actualKey }),
        },
      },
    );
    this.name = 'ReplayIntegrityError';
    this.jobId = jobId;
    this.attempt = attempt;
    this.position = position;
    this.expectedType = expectedType;
    this.actualType = actualType;
    this.expectedKey = expectedKey;
    this.actualKey = actualKey;
  }
}

/** Rate limit metadata extracted from response headers. */
export interface RateLimitInfo {
  /** Maximum requests allowed per window (X-RateLimit-Limit). */
  limit?: number | undefined;
  /** Remaining requests in current window (X-RateLimit-Remaining). */
  remaining?: number | undefined;
  /** Unix timestamp when window resets (X-RateLimit-Reset). */
  reset?: number | undefined;
  /** Seconds to wait before retrying (Retry-After). */
  retryAfter?: number | undefined;
}

/** The server rate-limited the request (429). */
export class OJSRateLimitError extends OJSError {
  /** Seconds to wait before retrying, if provided by the server. */
  readonly retryAfter: number | undefined;
  /** Rate limit metadata from response headers. */
  readonly rateLimit: RateLimitInfo | undefined;

  constructor(
    message: string,
    options?: {
      retryAfter?: number | undefined;
      rateLimit?: RateLimitInfo | undefined;
      details?: Record<string, unknown> | undefined;
      requestId?: string | undefined;
    },
  ) {
    super(message, 'rate_limited', {
      retryable: true,
      details: options?.details,
      requestId: options?.requestId,
    });
    this.name = 'OJSRateLimitError';
    this.retryAfter = options?.retryAfter;
    this.rateLimit = options?.rateLimit;
  }
}

/**
 * Parse an OJS error response body into the appropriate error class.
 */
export function parseErrorResponse(
  status: number,
  body: {
    error?: {
      code?: string;
      message?: string;
      retryable?: boolean;
      details?: Record<string, unknown>;
      request_id?: string;
    };
  },
  headers?: Headers,
): OJSError {
  const err = body.error;
  const message = err?.message ?? `HTTP ${status}`;
  const details = err?.details;
  const requestId = err?.request_id;

  if (status === 400) {
    return new OJSValidationError(message, details, requestId);
  }
  if (status === 404) {
    return new OJSNotFoundError(
      (details?.resource_type as string) ?? 'resource',
      (details?.resource_id as string) ?? 'unknown',
      requestId,
    );
  }
  if (status === 405) {
    return new OJSMethodNotAllowedError(message, details, requestId);
  }
  if (status === 409) {
    if (err?.code === 'duplicate') {
      return new OJSDuplicateError(message, details, requestId);
    }
    return new OJSConflictError(message, details, requestId);
  }
  if (status === 429) {
    let retryAfter: number | undefined;
    let rateLimit: RateLimitInfo | undefined;
    if (headers) {
      const raw = headers.get('Retry-After');
      if (raw !== null) {
        const parsed = parseFloat(raw);
        if (!isNaN(parsed)) {
          retryAfter = parsed;
        }
      }
      const limitRaw = headers.get('X-RateLimit-Limit');
      const remainingRaw = headers.get('X-RateLimit-Remaining');
      const resetRaw = headers.get('X-RateLimit-Reset');
      if (limitRaw !== null || remainingRaw !== null || resetRaw !== null || retryAfter !== undefined) {
        const parsedRateLimit: RateLimitInfo = {};
        if (retryAfter !== undefined) parsedRateLimit.retryAfter = retryAfter;
        if (limitRaw !== null) {
          const v = parseInt(limitRaw, 10);
          if (!isNaN(v)) parsedRateLimit.limit = v;
        }
        if (remainingRaw !== null) {
          const v = parseInt(remainingRaw, 10);
          if (!isNaN(v)) parsedRateLimit.remaining = v;
        }
        if (resetRaw !== null) {
          const v = parseInt(resetRaw, 10);
          if (!isNaN(v)) parsedRateLimit.reset = v;
        }
        rateLimit = parsedRateLimit;
      }
    }
    return new OJSRateLimitError(message, { retryAfter, rateLimit, details, requestId });
  }
  if (status >= 500) {
    return new OJSServerError(message, status, requestId);
  }

  return new OJSError(message, err?.code ?? 'unknown', {
    retryable: err?.retryable ?? false,
    details,
    requestId,
  });
}

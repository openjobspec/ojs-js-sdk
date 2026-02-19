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
  constructor(message: string, cause?: Error) {
    super(message, 'connection_error', { retryable: true, cause });
    this.name = 'OJSConnectionError';
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

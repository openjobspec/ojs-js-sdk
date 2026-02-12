/**
 * OJS error types following the OJS Core Specification error reporting format.
 */

/** Base error class for all OJS errors. */
export class OJSError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly requestId?: string;

  constructor(
    message: string,
    code: string,
    options?: {
      retryable?: boolean;
      details?: Record<string, unknown>;
      requestId?: string;
      cause?: Error;
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
  readonly existingJobId?: string;

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
  if (status >= 500) {
    return new OJSServerError(message, status, requestId);
  }

  return new OJSError(message, err?.code ?? 'unknown', {
    retryable: err?.retryable ?? false,
    details,
    requestId,
  });
}

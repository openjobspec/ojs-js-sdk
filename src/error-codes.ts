/**
 * Standardized OJS error codes as defined in the OJS SDK Error Catalog
 * (spec/ojs-error-catalog.md). Each code maps to a canonical wire-format
 * string code from the OJS Error Specification.
 */

/** Describes a single entry in the OJS error catalog. */
export interface ErrorCodeEntry {
  /** The OJS-XXXX numeric identifier (e.g., "OJS-1000"). */
  readonly code: string;
  /** Human-readable error name (e.g., "InvalidPayload"). */
  readonly name: string;
  /** SCREAMING_SNAKE_CASE wire-format code (e.g., "INVALID_PAYLOAD"), or empty for client-side errors. */
  readonly canonicalCode: string;
  /** Default HTTP status code, or 0 for client-side errors. */
  readonly httpStatus: number;
  /** Default human-readable description. */
  readonly message: string;
  /** Default retryability. */
  readonly retryable: boolean;
}

function entry(
  code: string,
  name: string,
  canonicalCode: string,
  httpStatus: number,
  message: string,
  retryable: boolean,
): ErrorCodeEntry {
  return Object.freeze({ code, name, canonicalCode, httpStatus, message, retryable });
}

// ---------------------------------------------------------------------------
// OJS-1xxx: Client Errors
// ---------------------------------------------------------------------------

export const OJS_1000_INVALID_PAYLOAD = entry('OJS-1000', 'InvalidPayload', 'INVALID_PAYLOAD', 400, 'Job envelope fails structural validation', false);
export const OJS_1001_INVALID_JOB_TYPE = entry('OJS-1001', 'InvalidJobType', 'INVALID_JOB_TYPE', 400, 'Job type is not registered or does not match the allowlist', false);
export const OJS_1002_INVALID_QUEUE = entry('OJS-1002', 'InvalidQueue', 'INVALID_QUEUE', 400, 'Queue name is invalid or does not match naming rules', false);
export const OJS_1003_INVALID_ARGS = entry('OJS-1003', 'InvalidArgs', 'INVALID_ARGS', 400, 'Job args fail type checking or schema validation', false);
export const OJS_1004_INVALID_METADATA = entry('OJS-1004', 'InvalidMetadata', 'INVALID_METADATA', 400, 'Metadata field is malformed or exceeds the 64 KB size limit', false);
export const OJS_1005_INVALID_STATE_TRANSITION = entry('OJS-1005', 'InvalidStateTransition', 'INVALID_STATE_TRANSITION', 409, 'Attempted an invalid lifecycle state change', false);
export const OJS_1006_INVALID_RETRY_POLICY = entry('OJS-1006', 'InvalidRetryPolicy', 'INVALID_RETRY_POLICY', 400, 'Retry policy configuration is invalid', false);
export const OJS_1007_INVALID_CRON_EXPRESSION = entry('OJS-1007', 'InvalidCronExpression', 'INVALID_CRON_EXPRESSION', 400, 'Cron expression syntax cannot be parsed', false);
export const OJS_1008_SCHEMA_VALIDATION_FAILED = entry('OJS-1008', 'SchemaValidationFailed', 'SCHEMA_VALIDATION_FAILED', 422, 'Job args do not conform to the registered schema', false);
export const OJS_1009_PAYLOAD_TOO_LARGE = entry('OJS-1009', 'PayloadTooLarge', 'PAYLOAD_TOO_LARGE', 413, 'Job envelope exceeds the server\'s maximum payload size', false);
export const OJS_1010_METADATA_TOO_LARGE = entry('OJS-1010', 'MetadataTooLarge', 'METADATA_TOO_LARGE', 413, 'Metadata field exceeds the 64 KB limit', false);
export const OJS_1011_CONNECTION_ERROR = entry('OJS-1011', 'ConnectionError', '', 0, 'Could not establish a connection to the OJS server', true);
export const OJS_1012_REQUEST_TIMEOUT = entry('OJS-1012', 'RequestTimeout', '', 0, 'HTTP request to the OJS server timed out', true);
export const OJS_1013_SERIALIZATION_ERROR = entry('OJS-1013', 'SerializationError', '', 0, 'Failed to serialize the request or deserialize the response', false);
export const OJS_1014_QUEUE_NAME_TOO_LONG = entry('OJS-1014', 'QueueNameTooLong', 'QUEUE_NAME_TOO_LONG', 400, 'Queue name exceeds the 255-byte maximum length', false);
export const OJS_1015_JOB_TYPE_TOO_LONG = entry('OJS-1015', 'JobTypeTooLong', 'JOB_TYPE_TOO_LONG', 400, 'Job type exceeds the 255-byte maximum length', false);
export const OJS_1016_CHECKSUM_MISMATCH = entry('OJS-1016', 'ChecksumMismatch', 'CHECKSUM_MISMATCH', 400, 'External payload reference checksum verification failed', false);
export const OJS_1017_UNSUPPORTED_COMPRESSION = entry('OJS-1017', 'UnsupportedCompression', 'UNSUPPORTED_COMPRESSION', 400, 'The specified compression codec is not supported', false);

// ---------------------------------------------------------------------------
// OJS-2xxx: Server Errors
// ---------------------------------------------------------------------------

export const OJS_2000_BACKEND_ERROR = entry('OJS-2000', 'BackendError', 'BACKEND_ERROR', 500, 'Internal backend storage or transport failure', true);
export const OJS_2001_BACKEND_UNAVAILABLE = entry('OJS-2001', 'BackendUnavailable', 'BACKEND_UNAVAILABLE', 503, 'Backend storage system is unreachable', true);
export const OJS_2002_BACKEND_TIMEOUT = entry('OJS-2002', 'BackendTimeout', 'BACKEND_TIMEOUT', 504, 'Backend operation timed out', true);
export const OJS_2003_REPLICATION_LAG = entry('OJS-2003', 'ReplicationLag', 'REPLICATION_LAG', 500, 'Operation failed due to replication consistency issue', true);
export const OJS_2004_INTERNAL_SERVER_ERROR = entry('OJS-2004', 'InternalServerError', '', 500, 'Unclassified internal server error', true);

// ---------------------------------------------------------------------------
// OJS-3xxx: Job Lifecycle Errors
// ---------------------------------------------------------------------------

export const OJS_3000_JOB_NOT_FOUND = entry('OJS-3000', 'JobNotFound', 'NOT_FOUND', 404, 'The requested job, queue, or resource does not exist', false);
export const OJS_3001_DUPLICATE_JOB = entry('OJS-3001', 'DuplicateJob', 'DUPLICATE_JOB', 409, 'Unique job constraint was violated', false);
export const OJS_3002_JOB_ALREADY_COMPLETED = entry('OJS-3002', 'JobAlreadyCompleted', 'JOB_ALREADY_COMPLETED', 409, 'Operation attempted on a job that has already completed', false);
export const OJS_3003_JOB_ALREADY_CANCELLED = entry('OJS-3003', 'JobAlreadyCancelled', 'JOB_ALREADY_CANCELLED', 409, 'Operation attempted on a job that has already been cancelled', false);
export const OJS_3004_QUEUE_PAUSED = entry('OJS-3004', 'QueuePaused', 'QUEUE_PAUSED', 422, 'The target queue is paused and not accepting new jobs', true);
export const OJS_3005_HANDLER_ERROR = entry('OJS-3005', 'HandlerError', 'HANDLER_ERROR', 0, 'Job handler threw an exception during execution', true);
export const OJS_3006_HANDLER_TIMEOUT = entry('OJS-3006', 'HandlerTimeout', 'HANDLER_TIMEOUT', 0, 'Job handler exceeded the configured execution timeout', true);
export const OJS_3007_HANDLER_PANIC = entry('OJS-3007', 'HandlerPanic', 'HANDLER_PANIC', 0, 'Job handler caused an unrecoverable error', true);
export const OJS_3008_NON_RETRYABLE_ERROR = entry('OJS-3008', 'NonRetryableError', 'NON_RETRYABLE_ERROR', 0, 'Error type matched non_retryable_errors in the retry policy', false);
export const OJS_3009_JOB_CANCELLED = entry('OJS-3009', 'JobCancelled', 'JOB_CANCELLED', 0, 'Job was cancelled while it was executing', false);
export const OJS_3010_NO_HANDLER_REGISTERED = entry('OJS-3010', 'NoHandlerRegistered', '', 0, 'No handler is registered for the received job type', false);

// ---------------------------------------------------------------------------
// OJS-4xxx: Workflow Errors
// ---------------------------------------------------------------------------

export const OJS_4000_WORKFLOW_NOT_FOUND = entry('OJS-4000', 'WorkflowNotFound', '', 404, 'The specified workflow does not exist', false);
export const OJS_4001_CHAIN_STEP_FAILED = entry('OJS-4001', 'ChainStepFailed', '', 422, 'A step in a chain workflow failed, halting subsequent steps', false);
export const OJS_4002_GROUP_TIMEOUT = entry('OJS-4002', 'GroupTimeout', '', 504, 'A group workflow did not complete within the allowed timeout', true);
export const OJS_4003_DEPENDENCY_FAILED = entry('OJS-4003', 'DependencyFailed', '', 422, 'A required dependency job failed, preventing execution', false);
export const OJS_4004_CYCLIC_DEPENDENCY = entry('OJS-4004', 'CyclicDependency', '', 400, 'The workflow definition contains circular dependencies', false);
export const OJS_4005_BATCH_CALLBACK_FAILED = entry('OJS-4005', 'BatchCallbackFailed', '', 422, 'The batch completion callback job failed', true);
export const OJS_4006_WORKFLOW_CANCELLED = entry('OJS-4006', 'WorkflowCancelled', '', 409, 'The entire workflow was cancelled', false);

// ---------------------------------------------------------------------------
// OJS-5xxx: Authentication & Authorization Errors
// ---------------------------------------------------------------------------

export const OJS_5000_UNAUTHENTICATED = entry('OJS-5000', 'Unauthenticated', 'UNAUTHENTICATED', 401, 'No authentication credentials provided or credentials are invalid', false);
export const OJS_5001_PERMISSION_DENIED = entry('OJS-5001', 'PermissionDenied', 'PERMISSION_DENIED', 403, 'Authenticated but lacks the required permission', false);
export const OJS_5002_TOKEN_EXPIRED = entry('OJS-5002', 'TokenExpired', 'TOKEN_EXPIRED', 401, 'The authentication token has expired', false);
export const OJS_5003_TENANT_ACCESS_DENIED = entry('OJS-5003', 'TenantAccessDenied', 'TENANT_ACCESS_DENIED', 403, 'Operation on a tenant the caller does not have access to', false);

// ---------------------------------------------------------------------------
// OJS-6xxx: Rate Limiting & Backpressure Errors
// ---------------------------------------------------------------------------

export const OJS_6000_RATE_LIMITED = entry('OJS-6000', 'RateLimited', 'RATE_LIMITED', 429, 'Rate limit exceeded', true);
export const OJS_6001_QUEUE_FULL = entry('OJS-6001', 'QueueFull', 'QUEUE_FULL', 429, 'The queue has reached its configured maximum depth', true);
export const OJS_6002_CONCURRENCY_LIMITED = entry('OJS-6002', 'ConcurrencyLimited', '', 429, 'The concurrency limit has been reached', true);
export const OJS_6003_BACKPRESSURE_APPLIED = entry('OJS-6003', 'BackpressureApplied', '', 429, 'The server is applying backpressure', true);

// ---------------------------------------------------------------------------
// OJS-7xxx: Extension Errors
// ---------------------------------------------------------------------------

export const OJS_7000_UNSUPPORTED_FEATURE = entry('OJS-7000', 'UnsupportedFeature', 'UNSUPPORTED_FEATURE', 422, 'Feature requires a conformance level the backend does not support', false);
export const OJS_7001_CRON_SCHEDULE_CONFLICT = entry('OJS-7001', 'CronScheduleConflict', '', 409, 'The cron schedule conflicts with an existing schedule', false);
export const OJS_7002_UNIQUE_KEY_INVALID = entry('OJS-7002', 'UniqueKeyInvalid', '', 400, 'The unique key specification is invalid or malformed', false);
export const OJS_7003_MIDDLEWARE_ERROR = entry('OJS-7003', 'MiddlewareError', '', 500, 'An error occurred in the middleware chain', true);
export const OJS_7004_MIDDLEWARE_TIMEOUT = entry('OJS-7004', 'MiddlewareTimeout', '', 504, 'A middleware handler exceeded its allowed execution time', true);

// ---------------------------------------------------------------------------
// Catalog utilities
// ---------------------------------------------------------------------------

/** All defined OJS error catalog entries. */
export const ALL_ERROR_CODES: ErrorCodeEntry[] = [
  // OJS-1xxx
  OJS_1000_INVALID_PAYLOAD, OJS_1001_INVALID_JOB_TYPE, OJS_1002_INVALID_QUEUE,
  OJS_1003_INVALID_ARGS, OJS_1004_INVALID_METADATA, OJS_1005_INVALID_STATE_TRANSITION,
  OJS_1006_INVALID_RETRY_POLICY, OJS_1007_INVALID_CRON_EXPRESSION,
  OJS_1008_SCHEMA_VALIDATION_FAILED, OJS_1009_PAYLOAD_TOO_LARGE,
  OJS_1010_METADATA_TOO_LARGE, OJS_1011_CONNECTION_ERROR, OJS_1012_REQUEST_TIMEOUT,
  OJS_1013_SERIALIZATION_ERROR, OJS_1014_QUEUE_NAME_TOO_LONG, OJS_1015_JOB_TYPE_TOO_LONG,
  OJS_1016_CHECKSUM_MISMATCH, OJS_1017_UNSUPPORTED_COMPRESSION,
  // OJS-2xxx
  OJS_2000_BACKEND_ERROR, OJS_2001_BACKEND_UNAVAILABLE, OJS_2002_BACKEND_TIMEOUT,
  OJS_2003_REPLICATION_LAG, OJS_2004_INTERNAL_SERVER_ERROR,
  // OJS-3xxx
  OJS_3000_JOB_NOT_FOUND, OJS_3001_DUPLICATE_JOB, OJS_3002_JOB_ALREADY_COMPLETED,
  OJS_3003_JOB_ALREADY_CANCELLED, OJS_3004_QUEUE_PAUSED, OJS_3005_HANDLER_ERROR,
  OJS_3006_HANDLER_TIMEOUT, OJS_3007_HANDLER_PANIC, OJS_3008_NON_RETRYABLE_ERROR,
  OJS_3009_JOB_CANCELLED, OJS_3010_NO_HANDLER_REGISTERED,
  // OJS-4xxx
  OJS_4000_WORKFLOW_NOT_FOUND, OJS_4001_CHAIN_STEP_FAILED, OJS_4002_GROUP_TIMEOUT,
  OJS_4003_DEPENDENCY_FAILED, OJS_4004_CYCLIC_DEPENDENCY, OJS_4005_BATCH_CALLBACK_FAILED,
  OJS_4006_WORKFLOW_CANCELLED,
  // OJS-5xxx
  OJS_5000_UNAUTHENTICATED, OJS_5001_PERMISSION_DENIED, OJS_5002_TOKEN_EXPIRED,
  OJS_5003_TENANT_ACCESS_DENIED,
  // OJS-6xxx
  OJS_6000_RATE_LIMITED, OJS_6001_QUEUE_FULL, OJS_6002_CONCURRENCY_LIMITED,
  OJS_6003_BACKPRESSURE_APPLIED,
  // OJS-7xxx
  OJS_7000_UNSUPPORTED_FEATURE, OJS_7001_CRON_SCHEDULE_CONFLICT,
  OJS_7002_UNIQUE_KEY_INVALID, OJS_7003_MIDDLEWARE_ERROR, OJS_7004_MIDDLEWARE_TIMEOUT,
];

/**
 * Look up an ErrorCodeEntry by its canonical wire-format code
 * (e.g., "INVALID_PAYLOAD"). Returns undefined if not found.
 */
export function lookupByCanonicalCode(canonicalCode: string): ErrorCodeEntry | undefined {
  return ALL_ERROR_CODES.find((e) => e.canonicalCode === canonicalCode);
}

/**
 * Look up an ErrorCodeEntry by its OJS-XXXX numeric code
 * (e.g., "OJS-1000"). Returns undefined if not found.
 */
export function lookupByCode(code: string): ErrorCodeEntry | undefined {
  return ALL_ERROR_CODES.find((e) => e.code === code);
}

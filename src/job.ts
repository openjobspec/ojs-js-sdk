/**
 * Job type definitions following the OJS Core Specification.
 *
 * The job envelope contains required, optional, and system-managed attributes.
 */

/** JSON-native types that can appear in job args. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** OJS job lifecycle states (8-state model). */
export type JobState =
  | 'scheduled'
  | 'available'
  | 'pending'
  | 'active'
  | 'completed'
  | 'retryable'
  | 'cancelled'
  | 'discarded';

/** Terminal states from which no further automatic transitions occur. */
export const TERMINAL_STATES: ReadonlySet<JobState> = new Set([
  'completed',
  'cancelled',
  'discarded',
]);

/** Retry policy as defined in ojs-retry.md. */
export interface RetryPolicy {
  max_attempts?: number;
  initial_interval?: string;
  backoff_coefficient?: number;
  max_interval?: string;
  jitter?: boolean;
  non_retryable_errors?: string[];
  on_exhaustion?: 'discard' | 'dead_letter';
}

/** Unique job policy as defined in ojs-unique-jobs.md. */
export interface UniquePolicy {
  key?: string[];
  period?: string;
  on_conflict?: 'reject' | 'replace' | 'ignore';
  states?: JobState[];
}

/** Structured error object from OJS error reporting. */
export interface JobError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

/**
 * The full OJS job envelope as returned by the server.
 * Contains required, optional, and system-managed attributes.
 */
export interface Job {
  // Required attributes
  specversion: string;
  id: string;
  type: string;
  queue: string;
  args: JsonValue[];

  // Optional attributes
  meta?: Record<string, JsonValue>;
  priority?: number;
  timeout?: number;
  scheduled_at?: string;
  expires_at?: string;
  retry?: RetryPolicy;
  unique?: UniquePolicy;
  schema?: string;
  visibility_timeout?: number;
  tags?: string[];

  // System-managed attributes
  state?: JobState;
  attempt?: number;
  max_attempts?: number;
  created_at?: string;
  enqueued_at?: string;
  started_at?: string;
  completed_at?: string;
  error?: JobError;
  errors?: JobError[];
  result?: JsonValue;

  // Extension attributes
  [key: string]: unknown;
}

/**
 * Options for enqueuing a job via the SDK.
 * Uses camelCase for developer-friendly API, converted to wire format internally.
 */
export interface EnqueueOptions {
  queue?: string;
  priority?: number;
  timeout?: number;
  delay?: string;
  expiresAt?: string;
  retry?: RetryOptions;
  unique?: UniqueOptions;
  tags?: string[];
  meta?: Record<string, JsonValue>;
  schema?: string;
  visibilityTimeout?: number;
}

/** Developer-friendly retry options (camelCase). */
export interface RetryOptions {
  maxAttempts?: number;
  backoff?: 'none' | 'linear' | 'exponential' | 'polynomial';
  backoffCoefficient?: number;
  initialInterval?: string;
  maxInterval?: string;
  jitter?: boolean;
  nonRetryableErrors?: string[];
  onExhaustion?: 'discard' | 'dead_letter';
}

/** Developer-friendly unique options (camelCase). */
export interface UniqueOptions {
  key?: string[];
  period?: string;
  onConflict?: 'reject' | 'replace' | 'ignore';
  states?: JobState[];
}

/** A job definition for batch enqueue or workflow steps. */
export interface JobSpec {
  type: string;
  args?: JsonValue | JsonValue[];
  options?: EnqueueOptions;
}

/**
 * Convert developer-friendly EnqueueOptions to wire-format options object.
 */
export function toWireOptions(
  opts?: EnqueueOptions,
): Record<string, unknown> | undefined {
  if (!opts) return undefined;

  const wire: Record<string, unknown> = {};

  if (opts.queue !== undefined) wire.queue = opts.queue;
  if (opts.priority !== undefined) wire.priority = opts.priority;
  if (opts.timeout !== undefined) wire.timeout_ms = opts.timeout;
  if (opts.delay !== undefined) wire.delay_until = parseDuration(opts.delay);
  if (opts.expiresAt !== undefined) wire.expires_at = opts.expiresAt;
  if (opts.tags !== undefined) wire.tags = opts.tags;
  if (opts.visibilityTimeout !== undefined)
    wire.visibility_timeout_ms = opts.visibilityTimeout;

  if (opts.retry) {
    wire.retry = toWireRetry(opts.retry);
  }
  if (opts.unique) {
    wire.unique = toWireUnique(opts.unique);
  }

  return Object.keys(wire).length > 0 ? wire : undefined;
}

/**
 * Convert developer-friendly RetryOptions to wire format.
 */
function toWireRetry(opts: RetryOptions): RetryPolicy {
  const policy: RetryPolicy = {};

  if (opts.maxAttempts !== undefined) policy.max_attempts = opts.maxAttempts;
  if (opts.backoffCoefficient !== undefined)
    policy.backoff_coefficient = opts.backoffCoefficient;
  if (opts.initialInterval !== undefined)
    policy.initial_interval = opts.initialInterval;
  if (opts.maxInterval !== undefined) policy.max_interval = opts.maxInterval;
  if (opts.jitter !== undefined) policy.jitter = opts.jitter;
  if (opts.nonRetryableErrors !== undefined)
    policy.non_retryable_errors = opts.nonRetryableErrors;
  if (opts.onExhaustion !== undefined)
    policy.on_exhaustion = opts.onExhaustion;

  return policy;
}

/**
 * Convert developer-friendly UniqueOptions to wire format.
 */
function toWireUnique(opts: UniqueOptions): UniquePolicy {
  const policy: UniquePolicy = {};

  if (opts.key !== undefined) policy.key = opts.key;
  if (opts.period !== undefined) policy.period = opts.period;
  if (opts.onConflict !== undefined) policy.on_conflict = opts.onConflict;
  if (opts.states !== undefined) policy.states = opts.states;

  return policy;
}

/**
 * Normalize args: if a plain object or primitive is passed, wrap in array.
 * If already an array, use as-is.
 */
export function normalizeArgs(args: JsonValue | JsonValue[]): JsonValue[] {
  if (Array.isArray(args)) return args;
  return [args];
}

/**
 * Parse a human-friendly duration string (e.g., '5m', '30s', '1h') into
 * an ISO 8601 timestamp relative to now, for the `delay_until` field.
 */
function parseDuration(delay: string): string {
  const match = delay.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) {
    // Assume it's already an ISO 8601 timestamp or duration
    return delay;
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  let ms: number;
  switch (unit) {
    case 'ms':
      ms = value;
      break;
    case 's':
      ms = value * 1000;
      break;
    case 'm':
      ms = value * 60 * 1000;
      break;
    case 'h':
      ms = value * 60 * 60 * 1000;
      break;
    case 'd':
      ms = value * 24 * 60 * 60 * 1000;
      break;
    default:
      return delay;
  }

  return new Date(Date.now() + ms).toISOString();
}

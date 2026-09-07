/**
 * Job type definitions following the OJS Core Specification.
 *
 * The job envelope contains required, optional, and system-managed attributes.
 */

import { OJSValidationError } from './errors.js';
import {
  validateEnqueueRequest,
  validateUniquePolicy,
} from './validation/schemas.js';

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

/** Dimensions that may participate in a uniqueness fingerprint. */
export type UniqueKeyDimension = 'type' | 'queue' | 'args' | 'meta';

/** Unique job policy as defined in ojs-unique-jobs.md. */
export interface UniquePolicy {
  keys?: UniqueKeyDimension[];
  /**
   * @deprecated Legacy response alias. New SDK requests only serialize
   * {@link keys}; this field remains readable for older backends.
   */
  key?: string[];
  period?: string;
  on_conflict?: 'reject' | 'replace' | 'replace_except_schedule' | 'ignore';
  states?: JobState[];
  args_keys?: string[];
  meta_keys?: string[];
}

/** Structured error object from OJS error reporting. */
export interface JobError {
  code: string;
  message: string;
  retryable?: boolean;
  attempt?: number;
  occurred_at?: string;
  /**
   * Canonical OJS stack frames. A legacy newline-delimited string remains
   * accepted for compatibility with the current gRPC proto field.
   */
  backtrace?: string[] | string;
  details?: Record<string, unknown>;
}

function normalizeJobError(error: JobError): JobError {
  const backtrace =
    typeof error.backtrace === 'string'
      ? error.backtrace === ''
        ? []
        : error.backtrace.split(/\r?\n/u)
      : error.backtrace;
  return backtrace === undefined ? { ...error } : { ...error, backtrace };
}

/** Normalizes transport-specific job response details without mutating input. */
export function normalizeJobResponse(job: Job): Job {
  const normalized: Job = { ...job };
  if (job.error !== undefined && job.error !== null) {
    normalized.error = normalizeJobError(job.error);
  }
  if (job.errors !== undefined) {
    normalized.errors = job.errors.map(normalizeJobError);
  }
  return normalized;
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
  trace_id?: string;
  workflow_id?: string;
  parent_id?: string;
  root_id?: string;
  caused_by?: string;

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
  /** Canonical dimensions that define the uniqueness fingerprint. */
  keys?: UniqueKeyDimension[];
  /** Selected top-level args fields; requires the `args` dimension. */
  argsKeys?: string[];
  /** Selected metadata fields; requires the `meta` dimension. */
  metaKeys?: string[];
  /**
   * @deprecated Use `keys` with `argsKeys` instead.
   *
   * Every entry is a legacy args field selector, including entries named
   * `type`, `queue`, `args`, or `meta`. The `args` dimension is implied.
   * Canonical fields are ordered first when both forms are supplied.
   */
  key?: string[];
  period?: string;
  onConflict?: 'reject' | 'replace' | 'replace_except_schedule' | 'ignore';
  states?: JobState[];
}

const UNIQUE_KEY_DIMENSIONS: ReadonlySet<string> = new Set([
  'type',
  'queue',
  'args',
  'meta',
]);

interface UniqueSelectionInput {
  keys?: unknown;
  key?: unknown;
  argsKeys?: unknown;
  metaKeys?: unknown;
}

interface UniqueSelectionFieldNames {
  keys: string;
  key: string;
  argsKeys: string;
  metaKeys: string;
}

export interface NormalizedUniqueSelection {
  keys?: UniqueKeyDimension[];
  argsKeys?: string[];
  metaKeys?: string[];
}

const DEFAULT_UNIQUE_SELECTION_FIELD_NAMES: UniqueSelectionFieldNames = {
  keys: 'unique.keys',
  key: 'unique.key',
  argsKeys: 'unique.argsKeys',
  metaKeys: 'unique.metaKeys',
};

function invalidUniqueSelection(field: string, reason: string): never {
  throw new OJSValidationError(`Unique policy '${field}' ${reason}.`);
}

function requireUniqueStringArray(
  value: unknown,
  field: string,
  options: {
    allowEmptyArray?: boolean;
    dimensionsOnly?: boolean;
  } = {},
): string[] {
  if (!Array.isArray(value) || (!options.allowEmptyArray && value.length === 0)) {
    invalidUniqueSelection(field, 'must be a non-empty array of strings');
  }

  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      invalidUniqueSelection(field, 'must contain only non-empty strings');
    }
    if (options.dimensionsOnly && !UNIQUE_KEY_DIMENSIONS.has(entry)) {
      invalidUniqueSelection(
        field,
        "must contain only 'type', 'queue', 'args', or 'meta'",
      );
    }
    if (normalized.includes(entry)) {
      invalidUniqueSelection(field, 'must not contain duplicate values');
    }
    normalized.push(entry);
  }
  return normalized;
}

/**
 * Normalizes canonical and legacy unique key selection without mutating input.
 *
 * @internal
 */
export function normalizeUniqueSelection(
  input: UniqueSelectionInput,
  fieldNames: UniqueSelectionFieldNames = DEFAULT_UNIQUE_SELECTION_FIELD_NAMES,
): NormalizedUniqueSelection {
  const keys =
    input.keys === undefined
      ? []
      : (requireUniqueStringArray(input.keys, fieldNames.keys, {
          allowEmptyArray: true,
          dimensionsOnly: true,
        }) as UniqueKeyDimension[]);
  const argsKeys =
    input.argsKeys === undefined
      ? []
      : requireUniqueStringArray(input.argsKeys, fieldNames.argsKeys, {
          allowEmptyArray: true,
        });
  const metaKeys =
    input.metaKeys === undefined
      ? []
      : requireUniqueStringArray(input.metaKeys, fieldNames.metaKeys);

  if (input.key !== undefined) {
    const legacyKeys = requireUniqueStringArray(input.key, fieldNames.key);
    for (const legacyKey of legacyKeys) {
      if (!keys.includes('args')) keys.push('args');
      if (!argsKeys.includes(legacyKey)) argsKeys.push(legacyKey);
    }
  }

  if (keys.includes('meta') && metaKeys.length === 0) {
    invalidUniqueSelection(fieldNames.keys, "requires non-empty 'metaKeys'");
  }

  const normalized: NormalizedUniqueSelection = {};
  if (input.keys !== undefined || input.key !== undefined) normalized.keys = keys;
  if (input.argsKeys !== undefined || argsKeys.length > 0) {
    normalized.argsKeys = argsKeys;
  }
  if (input.metaKeys !== undefined) normalized.metaKeys = metaKeys;
  return normalized;
}

/** A job definition for batch enqueue or workflow steps. */
export interface JobSpec {
  type: string;
  args?: JsonValue | JsonValue[];
  options?: EnqueueOptions;
}

/** Canonical HTTP-shaped enqueue request shared by both transports. */
export interface WireEnqueueRequest {
  type: string;
  args: JsonValue[];
  meta?: Record<string, JsonValue>;
  schema?: string;
  options?: Record<string, unknown>;
}

/**
 * Build the complete mutable job envelope passed through enqueue middleware.
 *
 * @internal
 */
export function createEnqueueEnvelope(
  type: string,
  args: JsonValue[],
  options?: EnqueueOptions,
): Job {
  const job: Job = {
    specversion: '1.0',
    id: '',
    type,
    queue: options?.queue ?? 'default',
    args: cloneJsonArray(args),
  };

  if (options?.priority !== undefined) job.priority = options.priority;
  if (options?.timeout !== undefined) job.timeout = options.timeout;
  if (options?.delay !== undefined) job.scheduled_at = parseDuration(options.delay);
  if (options?.expiresAt !== undefined) job.expires_at = options.expiresAt;
  if (options?.retry !== undefined) job.retry = toWireRetry(options.retry);
  if (options?.unique !== undefined) {
    job.unique = toEnvelopeUnique(options.unique);
  }
  if (options?.tags !== undefined) job.tags = [...options.tags];
  if (options?.visibilityTimeout !== undefined) {
    job.visibility_timeout = options.visibilityTimeout;
  }
  if (options?.meta !== undefined) job.meta = cloneJsonRecord(options.meta);
  if (options?.schema !== undefined) job.schema = options.schema;

  return job;
}

/**
 * Serialize a post-middleware job envelope into the canonical enqueue wire
 * request. Only request fields are copied, so response/system/extension fields
 * can never leak back to the server.
 *
 * @internal
 */
export function toWireEnqueueRequest(job: Job): WireEnqueueRequest {
  const args = cloneJsonArray(job.args);
  const meta =
    job.meta === undefined ? undefined : cloneJsonRecord(job.meta);
  const errors = validateEnqueueRequest({
    type: job.type,
    args,
    meta,
    schema: job.schema,
    options: {
      queue: job.queue,
      priority: job.priority,
      timeout_ms: job.timeout,
      delay_until: job.scheduled_at,
      expires_at: job.expires_at,
      retry: job.retry,
      unique: job.unique,
      tags: job.tags,
      visibility_timeout_ms: job.visibility_timeout,
    },
  });
  if (errors.length > 0) {
    throw new OJSValidationError(
      errors.map((error) => error.message).join('; '),
      { validation_errors: errors },
    );
  }

  const options: Record<string, unknown> = { queue: job.queue };
  if (job.priority !== undefined) options.priority = job.priority;
  if (job.timeout !== undefined) options.timeout_ms = job.timeout;
  if (job.scheduled_at !== undefined) options.delay_until = job.scheduled_at;
  if (job.expires_at !== undefined) options.expires_at = job.expires_at;
  if (job.retry !== undefined) options.retry = copyRetryPolicy(job.retry);
  if (job.unique !== undefined) options.unique = copyUniquePolicy(job.unique);
  if (job.tags !== undefined) options.tags = [...job.tags];
  if (job.visibility_timeout !== undefined) {
    options.visibility_timeout_ms = job.visibility_timeout;
  }

  const body: WireEnqueueRequest = {
    type: job.type,
    args,
    options,
  };
  if (meta !== undefined) body.meta = meta;
  if (job.schema !== undefined) body.schema = job.schema;
  return body;
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
 * Extract the subset of {@link EnqueueOptions} that the OJS wire format
 * places at the *job-envelope* level — sibling to `type`/`args`/`options`
 * — rather than nested inside the `options` object itself.
 *
 * `meta` and `schema` are both top-level job-envelope fields per
 * `ojs-core.md` section 5.2 and the `enqueue-request.schema.json` /
 * `job.schema.json` JSON Schema contracts (`ojs-json-schema` repo).
 * Critically, `job-options.schema.json` — the schema `options` itself must
 * conform to — declares `additionalProperties: false` and does not define
 * `meta`/`schema` at all: nesting either field inside `options` would make
 * an otherwise wire-compatible request fail schema validation against a
 * conformant backend. `workflow.schema.json`'s `workflow_step` definition
 * points its own `options` field at that exact same `job-options.schema.json`
 * for per-step overrides, so the same placement rule applies there too.
 *
 * This helper is the single shared place that maps `meta`/`schema` for
 * every wire-building call site (ordinary enqueue and batch enqueue in
 * `client.ts`, workflow steps/callbacks in `toWireStep()` below) so they
 * all stay consistent, instead of each one separately hand-rolling — and
 * inevitably drifting out of sync on — the same mapping.
 */
export function toWireEnvelopeFields(
  opts?: EnqueueOptions,
): { meta?: Record<string, JsonValue>; schema?: string } {
  const fields: { meta?: Record<string, JsonValue>; schema?: string } = {};
  if (opts?.meta !== undefined) fields.meta = opts.meta;
  if (opts?.schema !== undefined) fields.schema = opts.schema;
  return fields;
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
    policy.non_retryable_errors = [...opts.nonRetryableErrors];
  if (opts.onExhaustion !== undefined)
    policy.on_exhaustion = opts.onExhaustion;

  return policy;
}

/**
 * Convert developer-friendly UniqueOptions to wire format.
 */
function toWireUnique(opts: UniqueOptions): UniquePolicy {
  const policy = toEnvelopeUnique(opts);

  const errors = validateUniquePolicy(policy, 'unique');
  if (errors.length > 0) {
    throw new OJSValidationError(
      `Unique policy ${errors.map((error) => error.message).join('; ')}`,
      { validation_errors: errors },
    );
  }

  return policy;
}

function toEnvelopeUnique(opts: UniqueOptions): UniquePolicy {
  const policy: UniquePolicy = {};
  const input: UniqueSelectionInput = opts;
  const keys = Array.isArray(input.keys) ? [...input.keys] : input.keys;
  const argsKeys = Array.isArray(input.argsKeys)
    ? [...input.argsKeys]
    : input.argsKeys;
  const metaKeys = Array.isArray(input.metaKeys)
    ? [...input.metaKeys]
    : input.metaKeys;

  if (Array.isArray(keys)) policy.keys = keys as UniqueKeyDimension[];
  else if (keys !== undefined) {
    (policy as Record<string, unknown>).keys = keys;
  }
  if (Array.isArray(argsKeys)) policy.args_keys = argsKeys;
  else if (argsKeys !== undefined) {
    (policy as Record<string, unknown>).args_keys = argsKeys;
  }
  if (Array.isArray(metaKeys)) policy.meta_keys = metaKeys;
  else if (metaKeys !== undefined) {
    (policy as Record<string, unknown>).meta_keys = metaKeys;
  }

  if (input.key !== undefined) {
    if (Array.isArray(input.key)) {
      const normalizedKeys = policy.keys ?? [];
      if (!normalizedKeys.includes('args')) normalizedKeys.push('args');
      policy.keys = normalizedKeys;

      const normalizedArgsKeys = policy.args_keys ?? [];
      for (const selector of input.key) {
        if (!normalizedArgsKeys.includes(selector)) {
          normalizedArgsKeys.push(selector);
        }
      }
      policy.args_keys = normalizedArgsKeys;
    } else {
      (policy as Record<string, unknown>).key = input.key;
    }
  }

  if (opts.period !== undefined) policy.period = opts.period;
  if (opts.onConflict !== undefined) policy.on_conflict = opts.onConflict;
  if (Array.isArray(opts.states)) policy.states = [...opts.states];
  else if (opts.states !== undefined) {
    (policy as Record<string, unknown>).states = opts.states;
  }

  return policy;
}

function copyRetryPolicy(policy: RetryPolicy): RetryPolicy {
  const copy: RetryPolicy = {};
  if (policy.max_attempts !== undefined) copy.max_attempts = policy.max_attempts;
  if (policy.initial_interval !== undefined) {
    copy.initial_interval = policy.initial_interval;
  }
  if (policy.backoff_coefficient !== undefined) {
    copy.backoff_coefficient = policy.backoff_coefficient;
  }
  if (policy.max_interval !== undefined) copy.max_interval = policy.max_interval;
  if (policy.jitter !== undefined) copy.jitter = policy.jitter;
  if (policy.non_retryable_errors !== undefined) {
    copy.non_retryable_errors = [...policy.non_retryable_errors];
  }
  if (policy.on_exhaustion !== undefined) {
    copy.on_exhaustion = policy.on_exhaustion;
  }
  return copy;
}

function copyUniquePolicy(policy: UniquePolicy): UniquePolicy {
  const copy: UniquePolicy = {};
  if (policy.keys !== undefined) copy.keys = [...policy.keys];
  if (policy.args_keys !== undefined) copy.args_keys = [...policy.args_keys];
  if (policy.meta_keys !== undefined) copy.meta_keys = [...policy.meta_keys];
  if (policy.period !== undefined) copy.period = policy.period;
  if (policy.on_conflict !== undefined) copy.on_conflict = policy.on_conflict;
  if (policy.states !== undefined) copy.states = [...policy.states];
  return copy;
}

/**
 * Sentinel returned by {@link normalizeJsonValue} for a value that JSON
 * serialization *omits* entirely (`undefined`, a function, or a symbol).
 * The caller decides how to represent the omission: an array element
 * becomes `null` (matching `JSON.stringify([undefined]) === '[null]'`),
 * an object property is dropped, and a top-level omission is impossible
 * here because {@link cloneJsonArray}/{@link cloneJsonRecord} only ever
 * pass an array/object root.
 */
const JSON_OMIT = Symbol('ojs.json.omit');

/**
 * Normalizes an arbitrary runtime value using the exact semantics of
 * `JSON.parse(JSON.stringify(value))`, with two deliberate departures that
 * fail *closed* instead of silently corrupting the wire payload:
 *
 * - `JSON.stringify` turns `NaN`/`Infinity`/`-Infinity` into `null`; here
 *   they throw {@link OJSValidationError} so a producer learns its args are
 *   unrepresentable rather than silently enqueuing a `null`.
 * - `JSON.stringify` throws a `TypeError` on `BigInt` and on circular
 *   references; here both throw {@link OJSValidationError} for a single,
 *   typed, non-retryable error class consumers can catch.
 *
 * Everything else mirrors `JSON.stringify`: a `toJSON(key)` method (as on
 * `Date`, `URL`, and custom classes) is invoked and its result normalized;
 * finite numbers, strings, booleans, and `null` pass through; `undefined`,
 * functions, and symbols are omitted (as {@link JSON_OMIT}); array holes
 * and omitted elements become `null`; and omitted object properties are
 * dropped. The result is built on null-prototype objects so hostile keys
 * (`__proto__`, `constructor`, `prototype`) are preserved as ordinary data
 * without ever walking or polluting a real prototype chain.
 *
 * `seen` tracks only the current ancestor chain (added on entry, removed on
 * exit), so a value legitimately referenced twice as siblings (a diamond)
 * is allowed exactly like `JSON.stringify`, while a true cycle is rejected.
 */
function normalizeJsonValue(
  value: unknown,
  seen: Set<object>,
  key: string,
): JsonValue | typeof JSON_OMIT {
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  ) {
    value = (value as { toJSON: (k: string) => unknown }).toJSON(key);
  }

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new OJSValidationError(
          `Cannot serialize the non-finite number ${String(value)} to JSON`,
        );
      }
      return value;
    case 'bigint':
      throw new OJSValidationError('Cannot serialize a BigInt value to JSON');
    case 'undefined':
    case 'function':
    case 'symbol':
      return JSON_OMIT;
    case 'object': {
      if (value === null) return null;
      if (seen.has(value)) {
        throw new OJSValidationError(
          'Cannot serialize a value with circular references to JSON',
        );
      }
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          const arr: JsonValue[] = [];
          for (let i = 0; i < value.length; i++) {
            const normalized = normalizeJsonValue(value[i], seen, String(i));
            arr.push(normalized === JSON_OMIT ? null : normalized);
          }
          return arr;
        }
        const record: Record<string, JsonValue> = Object.create(
          null,
        ) as Record<string, JsonValue>;
        for (const [k, entry] of Object.entries(
          value as Record<string, unknown>,
        )) {
          const normalized = normalizeJsonValue(entry, seen, k);
          if (normalized !== JSON_OMIT) {
            record[k] = normalized;
          }
        }
        return record;
      } finally {
        seen.delete(value);
      }
    }
    default:
      return JSON_OMIT;
  }
}

/**
 * Deep-clones a `JsonValue[]` using the exact JSON-semantic normalization
 * rules documented on {@link normalizeJsonValue} (a `Date`/`URL`/custom
 * `toJSON()` value is normalized the same way `JSON.stringify` would,
 * `__proto__`/`constructor`/`prototype` keys are preserved as ordinary
 * data rather than polluting a prototype chain, and non-finite numbers/
 * `BigInt`/circular references throw). Exported (not just used internally
 * by {@link createEnqueueEnvelope}) so any other in-package module that
 * independently stores or re-emits `args`/`meta` — e.g. `testing.ts`'s
 * fake-mode job store — can apply the identical cloning/normalization
 * rules the real enqueue path already does, so a value recorded or
 * returned in fake/inline mode is byte-for-byte consistent with what the
 * same input would produce in real mode.
 */
export function cloneJsonArray(values: JsonValue[]): JsonValue[] {
  const normalized = normalizeJsonValue(values, new Set<object>(), '');
  // The root is always the args array, so normalization never omits it and
  // always yields an array (or throws for a non-JSON value inside it).
  return normalized as JsonValue[];
}

/** Deep-clones a `Record<string, JsonValue>` (e.g. job `meta`) with the
 * same semantics as {@link cloneJsonArray}; see its doc comment. */
export function cloneJsonRecord(
  value: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const normalized = normalizeJsonValue(value, new Set<object>(), '');
  if (
    normalized === JSON_OMIT ||
    normalized === null ||
    typeof normalized !== 'object' ||
    Array.isArray(normalized)
  ) {
    throw new OJSValidationError(
      'Job metadata must serialize to a JSON object',
    );
  }
  return normalized;
}

/**
 * Normalizes a job handler's returned/resolved value into a wire-safe
 * {@link JsonValue} before it is ever sent to the server in an ack, using
 * the exact JSON-semantic normalization rules documented on
 * {@link normalizeJsonValue}: a `Date`/`URL`/custom `toJSON()` value is
 * honored (so returning `new Date()` yields an ISO string, not a decode
 * error); `__proto__`/`constructor`/`prototype` keys are preserved as
 * ordinary data; and -- the property this exists to enforce -- `BigInt`,
 * non-finite numbers (`NaN`/`Infinity`), and circular references all throw
 * {@link OJSValidationError} instead of silently reaching `JSON.stringify()`
 * deep inside a transport, where the same failure would be indistinguishable
 * from a network/serialization bug instead of a handler defect. The caller
 * (`OJSWorker`) treats this throw as a deterministic handler/result failure:
 * a non-retryable NACK, never an ack, and never a completion event/metric.
 *
 * A top-level `undefined` is returned unchanged (never run through
 * `toJSON()`/normalization at all) so "the handler resolved with nothing"
 * keeps meaning "no result" -- exactly what `OJSWorker`'s `ack()` already
 * does with an `undefined` result (omits the wire `result` field entirely)
 * -- rather than becoming a literal `null`. A top-level function or symbol
 * return normalizes to that same `undefined` "no result", mirroring
 * `JSON.stringify(fn) === undefined`; this is a deliberate, minimal
 * interpretation consistent with every other JSON-semantic boundary in
 * this module -- it is not treated as an error the way BigInt/circular/
 * non-finite are, since `JSON.stringify` itself does not treat it as one.
 */
export function normalizeHandlerResult(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeJsonValue(value, new Set<object>(), '');
  return normalized === JSON_OMIT ? undefined : normalized;
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
 * Matches the developer-friendly relative duration shorthand this SDK
 * accepts for `EnqueueOptions.delay` (e.g. `'5m'`, `'30s'`, `'1h'`,
 * `'100ms'`, `'2d'`) -- the only strings {@link parseDuration} actually
 * converts, relative to `Date.now()` *at the moment it runs*. Exported so
 * other modules (`workflow.ts`'s `assertNoRelativeDelay`) can detect
 * exactly this shorthand without duplicating or drifting from the
 * pattern {@link parseDuration} itself uses: only an *immediate*
 * `enqueue()` may convert it, because the OJS wire protocol carries no
 * relative delay at all -- only an absolute `delay_until` timestamp (see
 * ojs-http-binding.md's `delay_until` field and ojs-grpc-binding.md's
 * `google.protobuf.Timestamp delay_until`). Converting "N units from now"
 * is only correct if "now" is the actual moment the job is scheduled --
 * true for `enqueue()` (which submits immediately) but false for a
 * workflow step or batch callback, whose underlying job may not be
 * created until some unrelated, unpredictable point in the future once
 * its predecessors finish.
 */
export const RELATIVE_DELAY_PATTERN = /^(\d+)(ms|s|m|h|d)$/;

/**
 * Returns `true` for exactly the developer-friendly relative duration
 * shorthand {@link parseDuration} converts relative to `Date.now()`
 * (e.g. `'5m'`); `false` for anything else, including an absolute RFC
 * 3339 timestamp, which {@link parseDuration} passes through unchanged.
 */
export function isRelativeDelayString(delay: string): boolean {
  return RELATIVE_DELAY_PATTERN.test(delay);
}

/**
 * Parse a human-friendly duration string (e.g., '5m', '30s', '1h') into
 * an ISO 8601 timestamp relative to now, for the `delay_until` field.
 */
function parseDuration(delay: string): string {
  const match = RELATIVE_DELAY_PATTERN.exec(delay);
  if (!match) {
    // Assume it's already an ISO 8601 timestamp or duration
    return delay;
  }

  const valuePart = match[1];
  const unit = match[2];
  if (!valuePart || !unit) {
    return delay;
  }
  const value = parseInt(valuePart, 10);

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

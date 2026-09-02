/**
 * Embedded validation helpers for OJS job envelopes.
 *
 * Lightweight validation without external schema libraries.
 * Validates the structure before sending to the server.
 */

const JOB_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const QUEUE_PATTERN = /^[a-z0-9][a-z0-9\-.]*$/;
const QUEUE_MAX_LENGTH = 128;
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UNIQUE_KEY_DIMENSIONS = new Set(['type', 'queue', 'args', 'meta']);
const UNIQUE_STATES = new Set([
  'scheduled',
  'available',
  'pending',
  'active',
  'completed',
  'retryable',
  'cancelled',
  'discarded',
]);
const UNIQUE_CONFLICT_ACTIONS = new Set([
  'reject',
  'replace',
  'replace_except_schedule',
  'ignore',
]);
const UNIQUE_PERIOD_PATTERN =
  /^P(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/;

export interface ValidationError {
  field: string;
  message: string;
  expected?: string;
  received?: string;
}

/**
 * Validate a job type string.
 */
export function validateJobType(type: string): ValidationError | null {
  if (!type || typeof type !== 'string') {
    return { field: 'type', message: 'Job type is required and must be a string.' };
  }
  if (!JOB_TYPE_PATTERN.test(type)) {
    return {
      field: 'type',
      message:
        'Job type must be dot-namespaced lowercase (e.g., "email.send"). ' +
        'Each segment must match [a-z][a-z0-9_]*.',
      expected: 'dot-namespaced lowercase string',
      received: type,
    };
  }
  return null;
}

/**
 * Validate a queue name.
 */
export function validateQueueName(queue: string): ValidationError | null {
  if (!queue || typeof queue !== 'string') {
    return { field: 'queue', message: 'Queue name is required and must be a string.' };
  }
  if (queue.length > QUEUE_MAX_LENGTH) {
    return {
      field: 'queue',
      message: `Queue name must not exceed ${QUEUE_MAX_LENGTH} characters.`,
    };
  }
  if (!QUEUE_PATTERN.test(queue)) {
    return {
      field: 'queue',
      message:
        'Queue name must be lowercase alphanumeric with hyphens and dots.',
      expected: '[a-z0-9][a-z0-9\\-\\.]*',
      received: queue,
    };
  }
  return null;
}

/**
 * Validate args is an array of JSON-native types.
 */
export function validateArgs(args: unknown): ValidationError | null {
  if (!Array.isArray(args)) {
    return {
      field: 'args',
      message: 'The args field must be a JSON array.',
      expected: 'array',
      received: typeof args,
    };
  }
  if (!isJsonValue(args)) {
    return {
      field: 'args',
      message: 'The args field must contain only finite JSON-native values.',
      expected: 'JSON array',
    };
  }
  return null;
}

/**
 * Validate a UUIDv7 string.
 */
export function validateUUIDv7(id: string): ValidationError | null {
  if (!id || typeof id !== 'string') {
    return { field: 'id', message: 'Job ID is required and must be a string.' };
  }
  if (!UUID_V7_PATTERN.test(id.toLowerCase())) {
    return {
      field: 'id',
      message: 'Job ID must be a valid UUIDv7.',
      received: id,
    };
  }
  return null;
}

/**
 * Validate an ISO 8601 timestamp.
 */
export function validateTimestamp(
  value: string,
  field: string,
): ValidationError | null {
  if (!value || typeof value !== 'string') {
    return { field, message: `${field} must be a string.` };
  }
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    return {
      field,
      message: `${field} must be a valid ISO 8601 / RFC 3339 timestamp with timezone.`,
      received: value,
    };
  }
  // Check timezone designator exists (Z or +/-offset)
  if (!/[Zz]$/.test(value) && !/[+-]\d{2}:\d{2}$/.test(value)) {
    return {
      field,
      message: `${field} must include a timezone designator (Z or +/-hh:mm).`,
      received: value,
    };
  }
  return null;
}

/**
 * Validate an ISO 8601 duration string.
 */
export function validateDuration(
  value: string,
  field: string,
): ValidationError | null {
  if (!value || typeof value !== 'string') {
    return { field, message: `${field} must be a string.` };
  }
  const pattern =
    /^P(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/;
  if (!pattern.test(value) || value === 'P' || value === 'PT') {
    return {
      field,
      message: `${field} must be a valid ISO 8601 duration (e.g., "PT1S", "PT5M").`,
      received: value,
    };
  }
  return null;
}

/**
 * Validate the canonical wire shape of a unique policy.
 */
export function validateUniquePolicy(
  value: unknown,
  fieldPrefix = 'options.unique',
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{
      field: fieldPrefix,
      message: 'Unique policy must be an object.',
      expected: 'object',
      received: Array.isArray(value) ? 'array' : typeof value,
    }];
  }

  const policy = value as Record<string, unknown>;
  const allowed = new Set([
    'keys',
    'args_keys',
    'meta_keys',
    'period',
    'states',
    'on_conflict',
  ]);
  for (const field of Object.keys(policy)) {
    if (!allowed.has(field)) {
      errors.push({
        field: `${fieldPrefix}.${field}`,
        message: `Unknown unique policy field: ${field}.`,
      });
    }
  }

  const validateSelectors = (
    field: 'args_keys' | 'meta_keys',
    allowEmpty: boolean,
  ): void => {
    const selectors = policy[field];
    if (selectors === undefined) return;
    if (
      !Array.isArray(selectors) ||
      (!allowEmpty && selectors.length === 0) ||
      !selectors.every((entry) => typeof entry === 'string' && entry.length > 0)
    ) {
      errors.push({
        field: `${fieldPrefix}.${field}`,
        message: `${field} must be ${allowEmpty ? 'an array' : 'a non-empty array'} of non-empty strings.`,
      });
      return;
    }
    if (new Set(selectors).size !== selectors.length) {
      errors.push({
        field: `${fieldPrefix}.${field}`,
        message: `${field} must not contain duplicate selectors.`,
      });
    }
  };

  const keys = policy.keys;
  if (keys !== undefined) {
    if (
      !Array.isArray(keys) ||
      !keys.every(
        (entry) => typeof entry === 'string' && UNIQUE_KEY_DIMENSIONS.has(entry),
      )
    ) {
      errors.push({
        field: `${fieldPrefix}.keys`,
        message:
          "keys must contain only 'type', 'queue', 'args', or 'meta'.",
      });
    } else if (new Set(keys).size !== keys.length) {
      errors.push({
        field: `${fieldPrefix}.keys`,
        message: 'keys must not contain duplicate dimensions.',
      });
    }
  }

  validateSelectors('args_keys', true);
  validateSelectors('meta_keys', false);

  if (
    Array.isArray(keys) &&
    keys.includes('meta') &&
    policy.meta_keys === undefined
  ) {
    errors.push({
      field: `${fieldPrefix}.meta_keys`,
      message: 'meta_keys is required and must be non-empty when keys includes meta.',
    });
  }

  if (policy.period !== undefined) {
    if (
      typeof policy.period !== 'string' ||
      !UNIQUE_PERIOD_PATTERN.test(policy.period) ||
      policy.period === 'P' ||
      policy.period === 'PT'
    ) {
      errors.push({
        field: `${fieldPrefix}.period`,
        message: 'period must be a valid ISO 8601 duration.',
      });
    }
  }

  if (policy.states !== undefined) {
    if (
      !Array.isArray(policy.states) ||
      !policy.states.every(
        (entry) => typeof entry === 'string' && UNIQUE_STATES.has(entry),
      )
    ) {
      errors.push({
        field: `${fieldPrefix}.states`,
        message: 'states must contain only canonical OJS job states.',
      });
    } else if (new Set(policy.states).size !== policy.states.length) {
      errors.push({
        field: `${fieldPrefix}.states`,
        message: 'states must not contain duplicate values.',
      });
    }
  }

  if (
    policy.on_conflict !== undefined &&
    (typeof policy.on_conflict !== 'string' ||
      !UNIQUE_CONFLICT_ACTIONS.has(policy.on_conflict))
  ) {
    errors.push({
      field: `${fieldPrefix}.on_conflict`,
      message:
        "on_conflict must be 'reject', 'replace', 'replace_except_schedule', or 'ignore'.",
    });
  }

  return errors;
}

/**
 * Validate an enqueue request (client-side pre-flight check).
 */
export function validateEnqueueRequest(body: {
  type?: string;
  args?: unknown;
  meta?: unknown;
  schema?: unknown;
  options?: {
    queue?: unknown;
    priority?: unknown;
    timeout_ms?: unknown;
    delay_until?: unknown;
    expires_at?: unknown;
    retry?: unknown;
    unique?: unknown;
    tags?: unknown;
    visibility_timeout_ms?: unknown;
  };
}): ValidationError[] {
  const errors: ValidationError[] = [];

  if (body.type) {
    const typeErr = validateJobType(body.type);
    if (typeErr) errors.push(typeErr);
  } else {
    errors.push({ field: 'type', message: 'Job type is required.' });
  }

  if (body.args !== undefined) {
    const argsErr = validateArgs(body.args);
    if (argsErr) errors.push(argsErr);
  }

  if (
    body.meta !== undefined &&
    (!isJsonObject(body.meta) || !isJsonValue(body.meta))
  ) {
    errors.push({
      field: 'meta',
      message: 'Metadata must be a JSON object.',
      expected: 'object',
      received: Array.isArray(body.meta) ? 'array' : typeof body.meta,
    });
  }

  if (body.schema !== undefined) {
    if (typeof body.schema !== 'string' || !isValidUri(body.schema)) {
      errors.push({
        field: 'schema',
        message: 'Schema must be a valid URI.',
        expected: 'URI string',
        received: String(body.schema),
      });
    }
  }

  if (body.options?.queue !== undefined) {
    const queueErr =
      typeof body.options.queue === 'string'
        ? validateQueueName(body.options.queue)
        : {
            field: 'queue',
            message: 'Queue name is required and must be a string.',
            expected: 'string',
            received: typeof body.options.queue,
          };
    if (queueErr) errors.push(queueErr);
  }

  validateIntegerRange(
    errors,
    body.options?.priority,
    'options.priority',
    -100,
    100,
  );
  validateIntegerRange(
    errors,
    body.options?.timeout_ms,
    'options.timeout_ms',
    0,
  );

  if (body.options?.delay_until !== undefined) {
    if (typeof body.options.delay_until !== 'string') {
      errors.push({
        field: 'options.delay_until',
        message: 'options.delay_until must be a string.',
      });
    } else {
      const error = validateTimestamp(
        body.options.delay_until,
        'options.delay_until',
      );
      if (error) errors.push(error);
    }
  }

  if (body.options?.expires_at !== undefined) {
    if (typeof body.options.expires_at !== 'string') {
      errors.push({
        field: 'options.expires_at',
        message: 'options.expires_at must be a string.',
      });
    } else {
      const error = validateTimestamp(
        body.options.expires_at,
        'options.expires_at',
      );
      if (error) errors.push(error);
    }
  }

  if (body.options?.retry !== undefined) {
    errors.push(...validateRetryPolicy(body.options.retry));
  }

  if (body.options?.unique !== undefined) {
    errors.push(...validateUniquePolicy(body.options.unique));
  }

  if (body.options?.tags !== undefined) {
    const tags = body.options.tags;
    if (
      !Array.isArray(tags) ||
      !tags.every((tag) => typeof tag === 'string' && tag.length > 0)
    ) {
      errors.push({
        field: 'options.tags',
        message: 'Tags must be an array of non-empty strings.',
      });
    } else if (new Set(tags).size !== tags.length) {
      errors.push({
        field: 'options.tags',
        message: 'Tags must not contain duplicate values.',
      });
    }
  }

  validateIntegerRange(
    errors,
    body.options?.visibility_timeout_ms,
    'options.visibility_timeout_ms',
    1000,
  );

  return errors;
}

function validateRetryPolicy(
  value: unknown,
  fieldPrefix = 'options.retry',
): ValidationError[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{
      field: fieldPrefix,
      message: 'Retry policy must be an object.',
      expected: 'object',
      received: Array.isArray(value) ? 'array' : typeof value,
    }];
  }

  const errors: ValidationError[] = [];
  const policy = value as Record<string, unknown>;
  const allowed = new Set([
    'max_attempts',
    'initial_interval',
    'backoff_coefficient',
    'max_interval',
    'jitter',
    'non_retryable_errors',
    'on_exhaustion',
  ]);
  for (const field of Object.keys(policy)) {
    if (!allowed.has(field)) {
      errors.push({
        field: `${fieldPrefix}.${field}`,
        message: `Unknown retry policy field: ${field}.`,
      });
    }
  }

  validateIntegerRange(
    errors,
    policy.max_attempts,
    `${fieldPrefix}.max_attempts`,
    0,
  );

  for (const field of ['initial_interval', 'max_interval'] as const) {
    const duration = policy[field];
    if (duration === undefined) continue;
    if (
      typeof duration !== 'string' ||
      !UNIQUE_PERIOD_PATTERN.test(duration) ||
      duration === 'P' ||
      duration === 'PT'
    ) {
      errors.push({
        field: `${fieldPrefix}.${field}`,
        message: `${field} must be a valid ISO 8601 duration.`,
      });
    }
  }

  const coefficient = policy.backoff_coefficient;
  if (
    coefficient !== undefined &&
    (typeof coefficient !== 'number' ||
      !Number.isFinite(coefficient) ||
      coefficient < 1)
  ) {
    errors.push({
      field: `${fieldPrefix}.backoff_coefficient`,
      message: 'backoff_coefficient must be a finite number greater than or equal to 1.',
    });
  }

  if (policy.jitter !== undefined && typeof policy.jitter !== 'boolean') {
    errors.push({
      field: `${fieldPrefix}.jitter`,
      message: 'jitter must be a boolean.',
    });
  }

  const nonRetryable = policy.non_retryable_errors;
  if (
    nonRetryable !== undefined &&
    (!Array.isArray(nonRetryable) ||
      !nonRetryable.every(
        (entry) => typeof entry === 'string' && entry.length > 0,
      ))
  ) {
    errors.push({
      field: `${fieldPrefix}.non_retryable_errors`,
      message: 'non_retryable_errors must be an array of non-empty strings.',
    });
  } else if (
    Array.isArray(nonRetryable) &&
    new Set(nonRetryable).size !== nonRetryable.length
  ) {
    errors.push({
      field: `${fieldPrefix}.non_retryable_errors`,
      message: 'non_retryable_errors must not contain duplicate values.',
    });
  }

  if (
    policy.on_exhaustion !== undefined &&
    policy.on_exhaustion !== 'discard' &&
    policy.on_exhaustion !== 'dead_letter'
  ) {
    errors.push({
      field: `${fieldPrefix}.on_exhaustion`,
      message: "on_exhaustion must be 'discard' or 'dead_letter'.",
    });
  }

  return errors;
}

function validateIntegerRange(
  errors: ValidationError[],
  value: unknown,
  field: string,
  minimum: number,
  maximum?: number,
): void {
  if (value === undefined) return;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < minimum ||
    (maximum !== undefined && value > maximum)
  ) {
    errors.push({
      field,
      message:
        maximum === undefined
          ? `${field} must be an integer greater than or equal to ${minimum}.`
          : `${field} must be an integer between ${minimum} and ${maximum}.`,
      received: String(value),
    });
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(
  value: unknown,
  ancestors: Set<object> = new Set<object>(),
): boolean {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;

  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, ancestors))
    : Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null
      ? Object.values(value).every((entry) => isJsonValue(entry, ancestors))
      : false;
  ancestors.delete(value);
  return valid;
}

function isValidUri(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

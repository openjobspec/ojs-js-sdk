/**
 * Embedded validation helpers for OJS job envelopes.
 *
 * Lightweight validation without external schema libraries.
 * Validates the structure before sending to the server.
 */

const JOB_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const QUEUE_PATTERN = /^[a-z0-9][a-z0-9\-.]*$/;
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
  if (queue.length > 128) {
    return {
      field: 'queue',
      message: 'Queue name must not exceed 128 characters.',
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
 * Validate an enqueue request (client-side pre-flight check).
 */
export function validateEnqueueRequest(body: {
  type?: string;
  args?: unknown;
  options?: { queue?: string };
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

  if (body.options?.queue) {
    const queueErr = validateQueueName(body.options.queue);
    if (queueErr) errors.push(queueErr);
  }

  return errors;
}

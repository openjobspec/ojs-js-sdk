import { describe, it, expect } from 'vitest';
import {
  validateJobType,
  validateQueueName,
  validateArgs,
  validateUUIDv7,
  validateTimestamp,
  validateDuration,
  validateEnqueueRequest,
} from '../src/validation/schemas.js';

describe('validateJobType', () => {
  it('accepts valid dot-namespaced types', () => {
    expect(validateJobType('email')).toBeNull();
    expect(validateJobType('email.send')).toBeNull();
    expect(validateJobType('data.etl.transform')).toBeNull();
    expect(validateJobType('a1_b2')).toBeNull();
  });

  it('rejects empty or non-string values', () => {
    expect(validateJobType('')).not.toBeNull();
    expect(validateJobType('')!.field).toBe('type');
  });

  it('rejects uppercase characters', () => {
    expect(validateJobType('Email.Send')).not.toBeNull();
  });

  it('rejects types starting with numbers', () => {
    expect(validateJobType('1email')).not.toBeNull();
  });

  it('rejects types with leading dots or trailing dots', () => {
    expect(validateJobType('.email')).not.toBeNull();
    expect(validateJobType('email.')).not.toBeNull();
  });

  it('rejects types with consecutive dots', () => {
    expect(validateJobType('email..send')).not.toBeNull();
  });

  it('rejects types with spaces or special characters', () => {
    expect(validateJobType('email send')).not.toBeNull();
    expect(validateJobType('email-send')).not.toBeNull();
    expect(validateJobType('email@send')).not.toBeNull();
  });

  it('includes expected and received in error', () => {
    const err = validateJobType('INVALID');
    expect(err).not.toBeNull();
    expect(err!.expected).toBeDefined();
    expect(err!.received).toBe('INVALID');
  });
});

describe('validateQueueName', () => {
  it('accepts valid queue names', () => {
    expect(validateQueueName('default')).toBeNull();
    expect(validateQueueName('high-priority')).toBeNull();
    expect(validateQueueName('queue.emails')).toBeNull();
    expect(validateQueueName('0-queue')).toBeNull();
  });

  it('rejects empty or non-string values', () => {
    expect(validateQueueName('')).not.toBeNull();
    expect(validateQueueName('')!.field).toBe('queue');
  });

  it('rejects names exceeding 128 characters', () => {
    const long = 'a'.repeat(129);
    expect(validateQueueName(long)).not.toBeNull();
  });

  it('accepts names at exactly 128 characters', () => {
    const exact = 'a'.repeat(128);
    expect(validateQueueName(exact)).toBeNull();
  });

  it('rejects names starting with hyphens or dots', () => {
    expect(validateQueueName('-queue')).not.toBeNull();
    expect(validateQueueName('.queue')).not.toBeNull();
  });

  it('rejects names with uppercase letters', () => {
    expect(validateQueueName('Default')).not.toBeNull();
  });

  it('rejects names with special characters', () => {
    expect(validateQueueName('queue@name')).not.toBeNull();
    expect(validateQueueName('queue name')).not.toBeNull();
  });
});

describe('validateArgs', () => {
  it('accepts valid arrays', () => {
    expect(validateArgs([])).toBeNull();
    expect(validateArgs([1, 'hello', { key: 'value' }])).toBeNull();
    expect(validateArgs([null, true, false])).toBeNull();
  });

  it('rejects non-array values', () => {
    expect(validateArgs('string')).not.toBeNull();
    expect(validateArgs(123)).not.toBeNull();
    expect(validateArgs({ key: 'value' })).not.toBeNull();
    expect(validateArgs(null)).not.toBeNull();
  });

  it('includes type info in error', () => {
    const err = validateArgs('string');
    expect(err!.expected).toBe('array');
    expect(err!.received).toBe('string');
  });
});

describe('validateUUIDv7', () => {
  it('accepts valid UUIDv7 strings', () => {
    expect(validateUUIDv7('01912345-6789-7abc-8def-0123456789ab')).toBeNull();
  });

  it('rejects empty or non-string values', () => {
    expect(validateUUIDv7('')).not.toBeNull();
    expect(validateUUIDv7('')!.field).toBe('id');
  });

  it('rejects non-v7 UUIDs (wrong version nibble)', () => {
    // Version 4 UUID — version nibble is 4, not 7
    expect(validateUUIDv7('550e8400-e29b-41d4-a716-446655440000')).not.toBeNull();
  });

  it('rejects malformed UUIDs', () => {
    expect(validateUUIDv7('not-a-uuid')).not.toBeNull();
    expect(validateUUIDv7('01912345-6789-7abc-8def')).not.toBeNull();
  });

  it('accepts uppercase UUIDv7 (case insensitive)', () => {
    expect(validateUUIDv7('01912345-6789-7ABC-8DEF-0123456789AB')).toBeNull();
  });
});

describe('validateTimestamp', () => {
  it('accepts valid RFC 3339 timestamps with UTC', () => {
    expect(validateTimestamp('2024-01-15T10:30:00Z', 'scheduled_at')).toBeNull();
    expect(validateTimestamp('2024-01-15T10:30:00z', 'scheduled_at')).toBeNull();
  });

  it('accepts timestamps with timezone offset', () => {
    expect(validateTimestamp('2024-01-15T10:30:00+05:00', 'scheduled_at')).toBeNull();
    expect(validateTimestamp('2024-01-15T10:30:00-07:00', 'scheduled_at')).toBeNull();
  });

  it('rejects empty or non-string values', () => {
    expect(validateTimestamp('', 'ts')).not.toBeNull();
  });

  it('rejects timestamps without timezone', () => {
    expect(validateTimestamp('2024-01-15T10:30:00', 'ts')).not.toBeNull();
  });

  it('rejects invalid date strings', () => {
    expect(validateTimestamp('not-a-date', 'ts')).not.toBeNull();
  });

  it('uses the field name in error messages', () => {
    const err = validateTimestamp('', 'my_field');
    expect(err!.field).toBe('my_field');
    expect(err!.message).toContain('my_field');
  });
});

describe('validateDuration', () => {
  it('accepts valid ISO 8601 durations', () => {
    expect(validateDuration('PT1S', 'interval')).toBeNull();
    expect(validateDuration('PT5M', 'interval')).toBeNull();
    expect(validateDuration('PT1H', 'interval')).toBeNull();
    expect(validateDuration('PT1H30M', 'interval')).toBeNull();
    expect(validateDuration('P1D', 'interval')).toBeNull();
    expect(validateDuration('P1DT12H', 'interval')).toBeNull();
    expect(validateDuration('PT1.5S', 'interval')).toBeNull();
  });

  it('rejects empty or non-string values', () => {
    expect(validateDuration('', 'interval')).not.toBeNull();
  });

  it('rejects bare P or PT', () => {
    expect(validateDuration('P', 'interval')).not.toBeNull();
    expect(validateDuration('PT', 'interval')).not.toBeNull();
  });

  it('rejects invalid duration strings', () => {
    expect(validateDuration('5 minutes', 'interval')).not.toBeNull();
    expect(validateDuration('1000', 'interval')).not.toBeNull();
  });

  it('uses the field name in error messages', () => {
    const err = validateDuration('bad', 'my_duration');
    expect(err!.field).toBe('my_duration');
    expect(err!.message).toContain('my_duration');
  });
});

describe('validateEnqueueRequest', () => {
  it('passes with valid type', () => {
    expect(validateEnqueueRequest({ type: 'email.send' })).toEqual([]);
  });

  it('passes with valid type, args, and queue', () => {
    const errors = validateEnqueueRequest({
      type: 'email.send',
      args: [{ to: 'test@test.com' }],
      options: { queue: 'high-priority' },
    });
    expect(errors).toEqual([]);
  });

  it('returns error when type is missing', () => {
    const errors = validateEnqueueRequest({});
    expect(errors.length).toBe(1);
    expect(errors[0].field).toBe('type');
  });

  it('returns error when type is invalid', () => {
    const errors = validateEnqueueRequest({ type: 'INVALID' });
    expect(errors.length).toBe(1);
    expect(errors[0].field).toBe('type');
  });

  it('returns error when args is not an array', () => {
    const errors = validateEnqueueRequest({
      type: 'email.send',
      args: 'not-array',
    });
    expect(errors.length).toBe(1);
    expect(errors[0].field).toBe('args');
  });

  it('returns error when queue name is invalid', () => {
    const errors = validateEnqueueRequest({
      type: 'email.send',
      options: { queue: 'INVALID' },
    });
    expect(errors.length).toBe(1);
    expect(errors[0].field).toBe('queue');
  });

  it('returns multiple errors when multiple fields invalid', () => {
    const errors = validateEnqueueRequest({
      type: 'INVALID',
      args: 'not-array',
      options: { queue: 'ALSO-INVALID' },
    });
    expect(errors.length).toBe(3);
  });

  it('skips args validation if args not provided', () => {
    const errors = validateEnqueueRequest({ type: 'email.send' });
    expect(errors).toEqual([]);
  });

  it('skips queue validation if options not provided', () => {
    const errors = validateEnqueueRequest({ type: 'email.send' });
    expect(errors).toEqual([]);
  });
});

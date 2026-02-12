import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalizeArgs, toWireOptions, TERMINAL_STATES } from '../src/job.js';
import type { EnqueueOptions } from '../src/job.js';

describe('normalizeArgs', () => {
  it('returns array as-is', () => {
    const args = [1, 'hello', { key: 'value' }];
    expect(normalizeArgs(args)).toBe(args);
  });

  it('wraps a string in array', () => {
    expect(normalizeArgs('hello')).toEqual(['hello']);
  });

  it('wraps a number in array', () => {
    expect(normalizeArgs(42)).toEqual([42]);
  });

  it('wraps a boolean in array', () => {
    expect(normalizeArgs(true)).toEqual([true]);
  });

  it('wraps null in array', () => {
    expect(normalizeArgs(null)).toEqual([null]);
  });

  it('wraps an object in array', () => {
    const obj = { to: 'test@test.com' };
    expect(normalizeArgs(obj)).toEqual([obj]);
  });

  it('returns empty array as-is', () => {
    expect(normalizeArgs([])).toEqual([]);
  });
});

describe('TERMINAL_STATES', () => {
  it('contains completed, cancelled, and discarded', () => {
    expect(TERMINAL_STATES.has('completed')).toBe(true);
    expect(TERMINAL_STATES.has('cancelled')).toBe(true);
    expect(TERMINAL_STATES.has('discarded')).toBe(true);
  });

  it('does not contain non-terminal states', () => {
    expect(TERMINAL_STATES.has('scheduled')).toBe(false);
    expect(TERMINAL_STATES.has('available')).toBe(false);
    expect(TERMINAL_STATES.has('pending')).toBe(false);
    expect(TERMINAL_STATES.has('active')).toBe(false);
    expect(TERMINAL_STATES.has('retryable')).toBe(false);
  });
});

describe('toWireOptions', () => {
  it('returns undefined for undefined input', () => {
    expect(toWireOptions(undefined)).toBeUndefined();
  });

  it('returns undefined for empty options', () => {
    expect(toWireOptions({})).toBeUndefined();
  });

  it('maps queue directly', () => {
    const result = toWireOptions({ queue: 'high-priority' });
    expect(result).toEqual({ queue: 'high-priority' });
  });

  it('maps priority directly', () => {
    const result = toWireOptions({ priority: 10 });
    expect(result).toEqual({ priority: 10 });
  });

  it('maps timeout to timeout_ms', () => {
    const result = toWireOptions({ timeout: 30000 });
    expect(result).toEqual({ timeout_ms: 30000 });
  });

  it('maps tags directly', () => {
    const result = toWireOptions({ tags: ['urgent', 'billing'] });
    expect(result).toEqual({ tags: ['urgent', 'billing'] });
  });

  it('maps visibilityTimeout to visibility_timeout_ms', () => {
    const result = toWireOptions({ visibilityTimeout: 60000 });
    expect(result).toEqual({ visibility_timeout_ms: 60000 });
  });

  it('maps expiresAt to expires_at', () => {
    const result = toWireOptions({ expiresAt: '2024-12-31T23:59:59Z' });
    expect(result).toEqual({ expires_at: '2024-12-31T23:59:59Z' });
  });

  describe('delay parsing', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-06-15T12:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('parses seconds shorthand', () => {
      const result = toWireOptions({ delay: '30s' });
      expect(result!.delay_until).toBe('2024-06-15T12:00:30.000Z');
    });

    it('parses minutes shorthand', () => {
      const result = toWireOptions({ delay: '5m' });
      expect(result!.delay_until).toBe('2024-06-15T12:05:00.000Z');
    });

    it('parses hours shorthand', () => {
      const result = toWireOptions({ delay: '1h' });
      expect(result!.delay_until).toBe('2024-06-15T13:00:00.000Z');
    });

    it('parses days shorthand', () => {
      const result = toWireOptions({ delay: '1d' });
      expect(result!.delay_until).toBe('2024-06-16T12:00:00.000Z');
    });

    it('parses milliseconds shorthand', () => {
      const result = toWireOptions({ delay: '500ms' });
      expect(result!.delay_until).toBe('2024-06-15T12:00:00.500Z');
    });

    it('passes ISO 8601 strings through unchanged', () => {
      const result = toWireOptions({ delay: '2024-12-31T00:00:00Z' });
      expect(result!.delay_until).toBe('2024-12-31T00:00:00Z');
    });
  });

  describe('retry options', () => {
    it('maps camelCase retry to snake_case wire format', () => {
      const opts: EnqueueOptions = {
        retry: {
          maxAttempts: 5,
          backoffCoefficient: 2.0,
          initialInterval: 'PT1S',
          maxInterval: 'PT10M',
          jitter: true,
          nonRetryableErrors: ['auth.*'],
          onExhaustion: 'dead_letter',
        },
      };
      const result = toWireOptions(opts);
      expect(result!.retry).toEqual({
        max_attempts: 5,
        backoff_coefficient: 2.0,
        initial_interval: 'PT1S',
        max_interval: 'PT10M',
        jitter: true,
        non_retryable_errors: ['auth.*'],
        on_exhaustion: 'dead_letter',
      });
    });

    it('handles partial retry options', () => {
      const result = toWireOptions({ retry: { maxAttempts: 3 } });
      expect(result!.retry).toEqual({ max_attempts: 3 });
    });
  });

  describe('unique options', () => {
    it('maps camelCase unique to snake_case wire format', () => {
      const opts: EnqueueOptions = {
        unique: {
          key: ['type', 'args'],
          period: 'PT1H',
          onConflict: 'reject',
          states: ['available', 'active'],
        },
      };
      const result = toWireOptions(opts);
      expect(result!.unique).toEqual({
        key: ['type', 'args'],
        period: 'PT1H',
        on_conflict: 'reject',
        states: ['available', 'active'],
      });
    });

    it('handles partial unique options', () => {
      const result = toWireOptions({ unique: { onConflict: 'ignore' } });
      expect(result!.unique).toEqual({ on_conflict: 'ignore' });
    });
  });

  it('combines multiple options', () => {
    const result = toWireOptions({
      queue: 'critical',
      priority: 100,
      timeout: 5000,
      tags: ['urgent'],
    });
    expect(result).toEqual({
      queue: 'critical',
      priority: 100,
      timeout_ms: 5000,
      tags: ['urgent'],
    });
  });
});

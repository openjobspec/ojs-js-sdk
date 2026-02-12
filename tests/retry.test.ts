import { describe, it, expect } from 'vitest';
import {
  computeBackoff,
  mergeWithDefaults,
  isNonRetryable,
  parseDurationToMs,
  msToIsoDuration,
  DEFAULT_RETRY_POLICY,
} from '../src/retry.js';

describe('Retry Policy', () => {
  describe('DEFAULT_RETRY_POLICY', () => {
    it('should have correct defaults per OJS spec', () => {
      expect(DEFAULT_RETRY_POLICY.max_attempts).toBe(3);
      expect(DEFAULT_RETRY_POLICY.initial_interval).toBe('PT1S');
      expect(DEFAULT_RETRY_POLICY.backoff_coefficient).toBe(2.0);
      expect(DEFAULT_RETRY_POLICY.max_interval).toBe('PT5M');
      expect(DEFAULT_RETRY_POLICY.jitter).toBe(true);
      expect(DEFAULT_RETRY_POLICY.non_retryable_errors).toEqual([]);
      expect(DEFAULT_RETRY_POLICY.on_exhaustion).toBe('discard');
    });
  });

  describe('mergeWithDefaults', () => {
    it('should merge partial policy with defaults', () => {
      const policy = mergeWithDefaults({ max_attempts: 10 });
      expect(policy.max_attempts).toBe(10);
      expect(policy.initial_interval).toBe('PT1S'); // from default
      expect(policy.jitter).toBe(true); // from default
    });

    it('should return full defaults when no policy given', () => {
      const policy = mergeWithDefaults();
      expect(policy).toEqual(DEFAULT_RETRY_POLICY);
    });
  });

  describe('computeBackoff', () => {
    const noJitterPolicy = mergeWithDefaults({ jitter: false });

    it('should compute constant backoff (none)', () => {
      expect(computeBackoff(1, noJitterPolicy, 'none')).toBe(1000);
      expect(computeBackoff(2, noJitterPolicy, 'none')).toBe(1000);
      expect(computeBackoff(5, noJitterPolicy, 'none')).toBe(1000);
    });

    it('should compute linear backoff', () => {
      expect(computeBackoff(1, noJitterPolicy, 'linear')).toBe(1000);
      expect(computeBackoff(2, noJitterPolicy, 'linear')).toBe(2000);
      expect(computeBackoff(3, noJitterPolicy, 'linear')).toBe(3000);
    });

    it('should compute exponential backoff', () => {
      expect(computeBackoff(1, noJitterPolicy, 'exponential')).toBe(1000);
      expect(computeBackoff(2, noJitterPolicy, 'exponential')).toBe(2000);
      expect(computeBackoff(3, noJitterPolicy, 'exponential')).toBe(4000);
      expect(computeBackoff(4, noJitterPolicy, 'exponential')).toBe(8000);
    });

    it('should compute polynomial backoff', () => {
      const policy = mergeWithDefaults({
        jitter: false,
        backoff_coefficient: 4.0,
      });
      expect(computeBackoff(1, policy, 'polynomial')).toBe(1000);   // 1^4 * 1000
      expect(computeBackoff(2, policy, 'polynomial')).toBe(16000);  // 2^4 * 1000
      expect(computeBackoff(3, policy, 'polynomial')).toBe(81000);  // 3^4 * 1000
    });

    it('should cap at max_interval', () => {
      const policy = mergeWithDefaults({
        jitter: false,
        max_interval: 'PT10S',
      });
      // Retry 5: 1s * 2^4 = 16s, capped at 10s
      expect(computeBackoff(5, policy, 'exponential')).toBe(10000);
    });

    it('should apply jitter within [0.5, 1.5) range', () => {
      const policy = mergeWithDefaults({ jitter: true });
      const delays = new Set<number>();
      for (let i = 0; i < 100; i++) {
        delays.add(computeBackoff(1, policy, 'exponential'));
      }
      // With jitter, retry 1 base is 1000ms, so range is [500, 1500)
      for (const delay of delays) {
        expect(delay).toBeGreaterThanOrEqual(500);
        expect(delay).toBeLessThan(1500);
      }
      // Should have some variance (not all the same)
      expect(delays.size).toBeGreaterThan(1);
    });
  });

  describe('isNonRetryable', () => {
    it('should match exact error types', () => {
      const errors = ['validation.payload_invalid', 'auth.token_expired'];
      expect(isNonRetryable('validation.payload_invalid', errors)).toBe(true);
      expect(isNonRetryable('auth.token_expired', errors)).toBe(true);
      expect(isNonRetryable('validation.schema_error', errors)).toBe(false);
    });

    it('should match prefix patterns with .*', () => {
      const errors = ['auth.*'];
      expect(isNonRetryable('auth.token_expired', errors)).toBe(true);
      expect(isNonRetryable('auth.forbidden', errors)).toBe(true);
      expect(isNonRetryable('auth', errors)).toBe(false);
      expect(isNonRetryable('external.auth.failure', errors)).toBe(false);
    });

    it('should return false for empty list', () => {
      expect(isNonRetryable('any.error', [])).toBe(false);
    });
  });

  describe('parseDurationToMs', () => {
    it('should parse seconds', () => {
      expect(parseDurationToMs('PT1S')).toBe(1000);
      expect(parseDurationToMs('PT30S')).toBe(30000);
      expect(parseDurationToMs('PT0.5S')).toBe(500);
    });

    it('should parse minutes', () => {
      expect(parseDurationToMs('PT5M')).toBe(300000);
      expect(parseDurationToMs('PT1M')).toBe(60000);
    });

    it('should parse hours', () => {
      expect(parseDurationToMs('PT1H')).toBe(3600000);
      expect(parseDurationToMs('PT24H')).toBe(86400000);
    });

    it('should parse days', () => {
      expect(parseDurationToMs('P1D')).toBe(86400000);
    });

    it('should parse combined durations', () => {
      expect(parseDurationToMs('PT1H30M')).toBe(5400000);
      expect(parseDurationToMs('PT1H30M15S')).toBe(5415000);
    });

    it('should throw on invalid durations', () => {
      expect(() => parseDurationToMs('invalid')).toThrow('Invalid ISO 8601 duration');
      expect(() => parseDurationToMs('5m')).toThrow('Invalid ISO 8601 duration');
    });
  });

  describe('msToIsoDuration', () => {
    it('should convert milliseconds to ISO duration', () => {
      expect(msToIsoDuration(1000)).toBe('PT1S');
      expect(msToIsoDuration(60000)).toBe('PT1M');
      expect(msToIsoDuration(3600000)).toBe('PT1H');
      expect(msToIsoDuration(5415000)).toBe('PT1H30M15S');
    });

    it('should handle sub-second durations', () => {
      const result = msToIsoDuration(500);
      expect(result).toBe('PT0.5S');
    });
  });
});

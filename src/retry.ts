/**
 * Retry policy helpers following the OJS Retry Policy Specification.
 *
 * Provides backoff calculation, duration parsing, and default policy constants.
 */

import type { RetryPolicy } from './job.js';

/** The default retry policy applied when no retry is specified. */
export const DEFAULT_RETRY_POLICY: Readonly<Required<RetryPolicy>> = {
  max_attempts: 3,
  initial_interval: 'PT1S',
  backoff_coefficient: 2.0,
  max_interval: 'PT5M',
  jitter: true,
  non_retryable_errors: [],
  on_exhaustion: 'discard',
};

/** Backoff strategy type. */
export type BackoffStrategy = 'none' | 'linear' | 'exponential' | 'polynomial';

/**
 * Merge a partial retry policy with defaults.
 */
export function mergeWithDefaults(
  policy?: Partial<RetryPolicy>,
): Required<RetryPolicy> {
  return { ...DEFAULT_RETRY_POLICY, ...policy };
}

/**
 * Compute the raw backoff delay in milliseconds for a given retry number.
 *
 * @param retryNumber - The retry number (1-indexed; retry 1 is the first retry).
 * @param policy - The retry policy to use.
 * @param strategy - The backoff strategy. Defaults to 'exponential'.
 * @returns The raw delay in milliseconds before jitter/cap.
 */
export function computeBackoff(
  retryNumber: number,
  policy: Required<RetryPolicy>,
  strategy: BackoffStrategy = 'exponential',
): number {
  const initialMs = parseDurationToMs(policy.initial_interval);
  const maxMs = parseDurationToMs(policy.max_interval);

  let rawDelay: number;

  switch (strategy) {
    case 'none':
      rawDelay = initialMs;
      break;
    case 'linear':
      rawDelay = initialMs * retryNumber;
      break;
    case 'exponential':
      rawDelay = initialMs * Math.pow(policy.backoff_coefficient, retryNumber - 1);
      break;
    case 'polynomial':
      rawDelay = initialMs * Math.pow(retryNumber, policy.backoff_coefficient);
      break;
  }

  // Apply max_interval cap before jitter
  const effectiveDelay = Math.min(rawDelay, maxMs);

  // Apply jitter if enabled
  if (policy.jitter) {
    const jitterMultiplier = 0.5 + Math.random();
    const jitteredDelay = effectiveDelay * jitterMultiplier;
    // Apply cap again after jitter
    return Math.min(Math.max(0, jitteredDelay), maxMs);
  }

  return effectiveDelay;
}

/**
 * Determine if an error type matches any entry in the non-retryable list.
 * Supports exact matching and prefix matching (entries ending with `.*`).
 */
export function isNonRetryable(
  errorType: string,
  nonRetryableErrors: string[],
): boolean {
  for (const entry of nonRetryableErrors) {
    if (entry.endsWith('.*')) {
      const prefix = entry.slice(0, -1); // Remove the '*', keep the '.'
      if (errorType.startsWith(prefix)) return true;
    } else if (errorType === entry) {
      return true;
    }
  }
  return false;
}

/**
 * Parse an ISO 8601 duration string into milliseconds.
 * Supports: PTnHnMnS, PTn.nS, PnD, and common subsets.
 */
export function parseDurationToMs(duration: string): number {
  const match = duration.match(
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/,
  );
  if (!match) {
    throw new Error(`Invalid ISO 8601 duration: ${duration}`);
  }

  const days = parseInt(match[1] || '0', 10);
  const hours = parseInt(match[2] || '0', 10);
  const minutes = parseInt(match[3] || '0', 10);
  const seconds = parseFloat(match[4] || '0');

  return (
    days * 86400000 +
    hours * 3600000 +
    minutes * 60000 +
    seconds * 1000
  );
}

/**
 * Convert milliseconds to an ISO 8601 duration string.
 */
export function msToIsoDuration(ms: number): string {
  if (ms < 1000) return `PT${(ms / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}S`;

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  let result = 'PT';
  if (hours > 0) result += `${hours}H`;
  if (minutes > 0) result += `${minutes}M`;
  if (seconds > 0) result += `${seconds}S`;

  return result === 'PT' ? 'PT0S' : result;
}

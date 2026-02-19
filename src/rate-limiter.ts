/**
 * Rate-limit retry configuration and backoff utilities for the HTTP transport.
 */

/** Configuration for automatic retry on 429 (rate-limited) responses. */
export interface RetryConfig {
  /** Maximum number of retries before giving up. Default: 3. */
  maxRetries: number;
  /** Minimum backoff delay in milliseconds. Default: 500. */
  minBackoffMs: number;
  /** Maximum backoff delay in milliseconds. Default: 30000. */
  maxBackoffMs: number;
  /** Whether automatic retry is enabled. Default: true. */
  enabled: boolean;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  minBackoffMs: 500,
  maxBackoffMs: 30_000,
  enabled: true,
};

/**
 * Parse a Retry-After header value into milliseconds.
 * Supports both delta-seconds (e.g., "120") and HTTP-date formats.
 * Returns undefined if the header cannot be parsed.
 */
export function parseRetryAfterMs(raw: string | null): number | undefined {
  if (raw === null) return undefined;

  // Try as a number of seconds first
  const seconds = parseFloat(raw);
  if (!isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  // Try as an HTTP-date
  const date = Date.parse(raw);
  if (!isNaN(date)) {
    const delayMs = date - Date.now();
    return delayMs > 0 ? delayMs : 0;
  }

  return undefined;
}

/**
 * Compute the delay for a retry attempt, respecting Retry-After and applying jitter.
 */
export function computeRetryDelay(
  attempt: number,
  config: RetryConfig,
  retryAfterMs?: number,
): number {
  // If the server specified Retry-After, use it (clamped to maxBackoffMs)
  if (retryAfterMs !== undefined) {
    return Math.min(retryAfterMs, config.maxBackoffMs);
  }

  // Exponential backoff with decorrelated jitter: base * random(0.5, 1.0)
  const base = config.minBackoffMs * Math.pow(2, attempt);
  const backoff = Math.min(base, config.maxBackoffMs);
  const jitter = 0.5 + Math.random() * 0.5;
  return backoff * jitter;
}

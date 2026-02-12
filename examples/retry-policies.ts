/**
 * Example: Retry policy configuration and backoff computation.
 *
 * Demonstrates different retry strategies and the backoff calculation API.
 */

import {
  OJSClient,
  DEFAULT_RETRY_POLICY,
  computeBackoff,
  mergeWithDefaults,
  parseDurationToMs,
} from '@openjobspec/sdk';

const client = new OJSClient({ url: 'http://localhost:8080' });

// --- Job with default retry (3 attempts, exponential backoff) ---
await client.enqueue('payment.charge', { orderId: 'ord_123' });

// --- Job with custom retry policy ---
await client.enqueue(
  'data.sync',
  { source: 'crm', dest: 'warehouse' },
  {
    retry: {
      maxAttempts: 10,
      backoff: 'polynomial',
      backoffCoefficient: 4.0,
      initialInterval: 'PT5S',
      maxInterval: 'PT1H',
      jitter: true,
      nonRetryableErrors: ['validation.*', 'auth.token_expired'],
      onExhaustion: 'dead_letter',
    },
  },
);

// --- Job with no retries ---
await client.enqueue(
  'analytics.track',
  { event: 'page_view', userId: 'usr_456' },
  {
    retry: {
      maxAttempts: 1,  // Run once, no retries
    },
  },
);

// --- Compute backoff delays for visualization ---
console.log('Default retry policy:', DEFAULT_RETRY_POLICY);

const policy = mergeWithDefaults({ max_attempts: 10 });
console.log('\nExponential backoff delays (no jitter):');

const noJitterPolicy = { ...policy, jitter: false };
for (let retry = 1; retry <= 9; retry++) {
  const delayMs = computeBackoff(retry, noJitterPolicy, 'exponential');
  console.log(`  Retry ${retry}: ${delayMs}ms`);
}

// --- Duration parsing ---
console.log('\nDuration parsing:');
console.log(`  PT1S  = ${parseDurationToMs('PT1S')}ms`);
console.log(`  PT5M  = ${parseDurationToMs('PT5M')}ms`);
console.log(`  PT1H  = ${parseDurationToMs('PT1H')}ms`);
console.log(`  P1D   = ${parseDurationToMs('P1D')}ms`);
console.log(`  PT0.5S = ${parseDurationToMs('PT0.5S')}ms`);

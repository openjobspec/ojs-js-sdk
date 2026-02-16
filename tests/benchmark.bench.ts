import { describe, bench } from 'vitest';
import {
  validateJobType,
  validateQueueName,
  validateArgs,
  validateUUIDv7,
  validateEnqueueRequest,
} from '../src/validation/schemas.js';
import { normalizeArgs } from '../src/job.js';

describe('Job validation benchmarks', () => {
  bench('validateJobType - valid', () => {
    validateJobType('email.send');
  });

  bench('validateJobType - invalid', () => {
    validateJobType('');
  });

  bench('validateQueueName - valid', () => {
    validateQueueName('default');
  });

  bench('validateUUIDv7 - valid', () => {
    validateUUIDv7('019539a4-b68c-7def-8000-1a2b3c4d5e6f');
  });

  bench('validateUUIDv7 - invalid', () => {
    validateUUIDv7('not-a-uuid');
  });

  bench('validateArgs - small object', () => {
    validateArgs([{ to: 'user@example.com' }]);
  });

  bench('validateArgs - large object', () => {
    validateArgs([{
      to: 'user@example.com',
      subject: 'Welcome to the platform',
      body: 'Hello, this is a longer message body for benchmarking purposes.',
      headers: { 'X-Priority': 'high', 'X-Campaign': 'onboarding' },
      tags: ['email', 'onboarding', 'welcome'],
      retries: 5,
      delay: 300,
    }]);
  });
});

describe('Args normalization benchmarks', () => {
  bench('normalizeArgs - single value', () => {
    normalizeArgs('hello');
  });

  bench('normalizeArgs - array', () => {
    normalizeArgs(['user@example.com', 'Welcome!', 42]);
  });

  bench('normalizeArgs - object', () => {
    normalizeArgs({ to: 'user@example.com', subject: 'hello' });
  });
});

describe('Enqueue request validation benchmarks', () => {
  bench('validateEnqueueRequest - minimal', () => {
    validateEnqueueRequest({
      type: 'email.send',
      args: ['user@example.com'],
    });
  });

  bench('validateEnqueueRequest - full', () => {
    validateEnqueueRequest({
      type: 'email.send',
      args: ['user@example.com', 'Welcome!'],
      queue: 'email',
      priority: 10,
      tags: ['onboarding'],
    });
  });
});

describe('JSON serialization benchmarks', () => {
  const minimalJob = {
    id: '019539a4-b68c-7def-8000-1a2b3c4d5e6f',
    type: 'email.send',
    state: 'available',
    queue: 'default',
    args: [{ to: 'user@example.com' }],
  };

  const fullJob = {
    id: '019539a4-b68c-7def-8000-1a2b3c4d5e6f',
    type: 'email.send',
    state: 'active',
    queue: 'email',
    args: [{ to: 'user@example.com', subject: 'Welcome!' }],
    priority: 10,
    attempt: 2,
    max_retries: 5,
    tags: ['onboarding', 'email'],
    meta: { campaign_id: '123', source: 'api' },
    created_at: '2024-01-15T10:30:00Z',
    scheduled_at: '2024-01-15T11:00:00Z',
  };

  bench('JSON.stringify - minimal job', () => {
    JSON.stringify(minimalJob);
  });

  bench('JSON.stringify - full job', () => {
    JSON.stringify(fullJob);
  });

  const minimalStr = JSON.stringify(minimalJob);
  const fullStr = JSON.stringify(fullJob);

  bench('JSON.parse - minimal job', () => {
    JSON.parse(minimalStr);
  });

  bench('JSON.parse - full job', () => {
    JSON.parse(fullStr);
  });
});

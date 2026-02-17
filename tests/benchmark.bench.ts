import { describe, bench } from 'vitest';
import {
  validateJobType,
  validateQueueName,
  validateArgs,
  validateUUIDv7,
  validateEnqueueRequest,
} from '../src/validation/schemas.js';
import { normalizeArgs, toWireOptions } from '../src/job.js';
import type { Job, EnqueueOptions } from '../src/job.js';
import { parseErrorResponse, OJSError } from '../src/errors.js';
import {
  MiddlewareChain,
  composeExecution,
  composeEnqueue,
  type ExecutionMiddleware,
  type EnqueueMiddleware,
  type JobContext,
} from '../src/middleware.js';

// ---- Helpers ----

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    specversion: '1.0',
    id: '019539a4-b68c-7def-8000-1a2b3c4d5e6f',
    type: 'email.send',
    queue: 'default',
    args: [{ to: 'user@example.com' }],
    ...overrides,
  };
}

function makeJobContext(): JobContext {
  return {
    job: makeJob(),
    attempt: 1,
    queue: 'default',
    workerId: 'bench-worker',
    metadata: new Map(),
    signal: new AbortController().signal,
  };
}

function buildExecutionChain(depth: number) {
  const chain = new MiddlewareChain<ExecutionMiddleware>();
  for (let i = 0; i < depth; i++) {
    chain.add(`mw-${i}`, async (_ctx, next) => next());
  }
  return composeExecution(
    chain.entries(),
    async () => 'done',
  );
}

function buildEnqueueChain(depth: number) {
  const chain = new MiddlewareChain<EnqueueMiddleware>();
  for (let i = 0; i < depth; i++) {
    chain.add(`mw-${i}`, async (job, next) => next(job));
  }
  return composeEnqueue(
    chain.entries(),
    async (job) => job,
  );
}

// ---- Validation benchmarks ----

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

  bench('validateArgs - small array', () => {
    validateArgs([{ to: 'user@example.com' }]);
  });

  bench('validateArgs - large array', () => {
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

describe('Enqueue request validation benchmarks', () => {
  bench('validateEnqueueRequest - minimal', () => {
    validateEnqueueRequest({
      type: 'email.send',
      args: [{ to: 'user@example.com' }],
    });
  });

  bench('validateEnqueueRequest - with queue', () => {
    validateEnqueueRequest({
      type: 'email.send',
      args: [{ to: 'user@example.com' }],
      options: { queue: 'email' },
    });
  });

  bench('validateEnqueueRequest - invalid type', () => {
    validateEnqueueRequest({
      type: 'INVALID',
      args: [{ to: 'user@example.com' }],
    });
  });
});

// ---- Args encoding benchmarks ----

describe('Args encoding benchmarks', () => {
  bench('normalizeArgs - empty array', () => {
    normalizeArgs([]);
  });

  bench('normalizeArgs - single primitive', () => {
    normalizeArgs('hello');
  });

  bench('normalizeArgs - small object', () => {
    normalizeArgs({ to: 'user@example.com', subject: 'hello' });
  });

  bench('normalizeArgs - array passthrough', () => {
    normalizeArgs(['user@example.com', 'Welcome!', 42]);
  });

  bench('normalizeArgs - large nested object', () => {
    normalizeArgs({
      to: 'user@example.com',
      subject: 'Welcome to the platform',
      body: 'Hello, this is a longer message body for benchmarking purposes.',
      headers: { 'X-Priority': 'high', 'X-Campaign': 'onboarding' },
      tags: ['email', 'onboarding', 'welcome'],
      nested: {
        level1: {
          level2: {
            level3: { value: 'deep' },
          },
        },
      },
      items: Array.from({ length: 50 }, (_, i) => ({ id: i, name: `item-${i}` })),
    });
  });
});

// ---- Job serialization benchmarks ----

describe('Job serialization benchmarks', () => {
  const smallJob = makeJob();

  const mediumJob = makeJob({
    state: 'active',
    queue: 'email',
    priority: 10,
    attempt: 2,
    max_attempts: 5,
    timeout: 30000,
    tags: ['onboarding', 'email', 'priority'],
    meta: { campaign: 'welcome', source: 'api' },
    args: [{ to: 'user@example.com', subject: 'Welcome', body: 'Hello and welcome!' }],
    created_at: '2024-01-15T10:30:00Z',
    scheduled_at: '2024-01-15T11:00:00Z',
  });

  const largeJob = makeJob({
    state: 'active',
    queue: 'data-pipeline',
    priority: 100,
    attempt: 3,
    max_attempts: 10,
    timeout: 60000,
    tags: Array.from({ length: 20 }, (_, i) => `tag-${i}`),
    meta: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`key${i}`, `value-${i}`])),
    args: [
      {
        records: Array.from({ length: 100 }, (_, i) => ({
          id: i,
          name: `record-${i}`,
          email: `user${i}@example.com`,
          active: i % 2 === 0,
        })),
      },
    ],
    retry: {
      max_attempts: 10,
      initial_interval: 'PT1S',
      backoff_coefficient: 2.0,
      max_interval: 'PT10M',
      jitter: true,
      non_retryable_errors: ['auth.*', 'validation.*'],
    },
    unique: {
      key: ['type', 'args'],
      period: 'PT1H',
      on_conflict: 'reject',
      states: ['available', 'active'],
    },
    created_at: '2024-01-15T10:30:00Z',
    scheduled_at: '2024-01-15T11:00:00Z',
    error: { code: 'timeout', message: 'Previous attempt timed out', retryable: true },
    errors: [
      { code: 'timeout', message: 'Attempt 1 timed out', retryable: true },
      { code: 'timeout', message: 'Attempt 2 timed out', retryable: true },
    ],
  });

  bench('JSON.stringify - small job', () => {
    JSON.stringify(smallJob);
  });

  bench('JSON.stringify - medium job', () => {
    JSON.stringify(mediumJob);
  });

  bench('JSON.stringify - large job', () => {
    JSON.stringify(largeJob);
  });

  const smallStr = JSON.stringify(smallJob);
  const mediumStr = JSON.stringify(mediumJob);
  const largeStr = JSON.stringify(largeJob);

  bench('JSON.parse - small job', () => {
    JSON.parse(smallStr);
  });

  bench('JSON.parse - medium job', () => {
    JSON.parse(mediumStr);
  });

  bench('JSON.parse - large job', () => {
    JSON.parse(largeStr);
  });

  bench('JSON roundtrip - medium job', () => {
    JSON.parse(JSON.stringify(mediumJob));
  });
});

// ---- Error parsing benchmarks ----

describe('Error parsing benchmarks', () => {
  bench('parseErrorResponse - 400 validation', () => {
    parseErrorResponse(400, {
      error: {
        code: 'invalid_request',
        message: 'Invalid job type format',
        details: { field: 'type', expected: 'dot-namespaced', received: 'INVALID' },
      },
    });
  });

  bench('parseErrorResponse - 404 not found', () => {
    parseErrorResponse(404, {
      error: {
        code: 'not_found',
        message: "Job '019539a4-b68c-7def-8000-1a2b3c4d5e6f' not found",
        details: { resource_type: 'job', resource_id: '019539a4-b68c-7def-8000-1a2b3c4d5e6f' },
      },
    });
  });

  bench('parseErrorResponse - 409 duplicate', () => {
    parseErrorResponse(409, {
      error: {
        code: 'duplicate',
        message: 'A job with the same unique key already exists',
        details: { existing_job_id: '019539a4-0000-7def-8000-000000000000' },
      },
    });
  });

  bench('parseErrorResponse - 409 conflict', () => {
    parseErrorResponse(409, {
      error: {
        code: 'conflict',
        message: 'Job is not in a cancellable state',
        details: { current_state: 'completed' },
      },
    });
  });

  bench('parseErrorResponse - 500 server error', () => {
    parseErrorResponse(500, {
      error: {
        code: 'server_error',
        message: 'Internal server error',
        request_id: 'req-abc-123',
      },
    });
  });

  bench('OJSError.toJSON', () => {
    const err = parseErrorResponse(400, {
      error: {
        code: 'invalid_request',
        message: 'Bad request',
        details: { field: 'type' },
        request_id: 'req-xyz',
      },
    });
    err.toJSON();
  });
});

// ---- Middleware chain benchmarks ----

describe('Middleware chain execution benchmarks', () => {
  const ctx = makeJobContext();
  const exec1 = buildExecutionChain(1);
  const exec5 = buildExecutionChain(5);
  const exec10 = buildExecutionChain(10);

  bench('execution middleware - direct (no middleware)', async () => {
    const handler = async () => 'done';
    await handler();
  });

  bench('execution middleware - depth 1', async () => {
    await exec1(ctx);
  });

  bench('execution middleware - depth 5', async () => {
    await exec5(ctx);
  });

  bench('execution middleware - depth 10', async () => {
    await exec10(ctx);
  });

  const job = makeJob();
  const enq1 = buildEnqueueChain(1);
  const enq5 = buildEnqueueChain(5);
  const enq10 = buildEnqueueChain(10);

  bench('enqueue middleware - depth 1', async () => {
    await enq1(job);
  });

  bench('enqueue middleware - depth 5', async () => {
    await enq5(job);
  });

  bench('enqueue middleware - depth 10', async () => {
    await enq10(job);
  });
});

// ---- Client request building benchmarks ----

describe('Client request building benchmarks', () => {
  bench('toWireOptions - minimal (queue only)', () => {
    toWireOptions({ queue: 'default' });
  });

  bench('toWireOptions - with retry', () => {
    toWireOptions({
      queue: 'email',
      priority: 10,
      retry: {
        maxAttempts: 5,
        backoffCoefficient: 2.0,
        initialInterval: 'PT1S',
        maxInterval: 'PT10M',
        jitter: true,
        nonRetryableErrors: ['auth.*'],
      },
    });
  });

  bench('toWireOptions - with unique', () => {
    toWireOptions({
      queue: 'default',
      unique: {
        key: ['type', 'args'],
        period: 'PT1H',
        onConflict: 'reject',
        states: ['available', 'active'],
      },
    });
  });

  bench('toWireOptions - full options', () => {
    toWireOptions({
      queue: 'critical',
      priority: 100,
      timeout: 30000,
      tags: ['urgent', 'billing'],
      visibilityTimeout: 60000,
      expiresAt: '2024-12-31T23:59:59Z',
      retry: {
        maxAttempts: 5,
        backoffCoefficient: 2.0,
        initialInterval: 'PT1S',
        maxInterval: 'PT10M',
        jitter: true,
        nonRetryableErrors: ['auth.*'],
        onExhaustion: 'dead_letter',
      },
      unique: {
        key: ['type', 'args'],
        period: 'PT1H',
        onConflict: 'reject',
        states: ['available', 'active'],
      },
    });
  });

  bench('build enqueue request body', () => {
    const args = normalizeArgs({ to: 'user@example.com', subject: 'Welcome' });
    const wireOptions = toWireOptions({
      queue: 'email',
      priority: 10,
      retry: { maxAttempts: 5 },
      tags: ['onboarding'],
    });
    const body: Record<string, unknown> = {
      type: 'email.send',
      args,
    };
    if (wireOptions) body.options = wireOptions;
    JSON.stringify(body);
  });

  bench('build batch enqueue request body', () => {
    const specs = Array.from({ length: 10 }, (_, i) => ({
      type: 'email.send',
      args: normalizeArgs({ to: `user${i}@example.com`, subject: `Message ${i}` }),
      options: toWireOptions({ queue: 'email', priority: i }),
    }));
    const wireJobs = specs.map((spec) => {
      const body: Record<string, unknown> = { type: spec.type, args: spec.args };
      if (spec.options) body.options = spec.options;
      return body;
    });
    JSON.stringify({ jobs: wireJobs });
  });
});

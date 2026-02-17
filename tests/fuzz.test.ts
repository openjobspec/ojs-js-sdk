/**
 * Property-based / fuzz tests for the OJS JS SDK.
 *
 * Mirrors the patterns in ojs-go-sdk/fuzz_test.go using fast-check
 * to verify that serialization, validation, error parsing, and
 * middleware composition never crash on arbitrary inputs.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { normalizeArgs, toWireOptions } from '../src/job.js';
import type { Job, JsonValue, JobState } from '../src/job.js';
import { parseErrorResponse, OJSError } from '../src/errors.js';
import {
  validateJobType,
  validateQueueName,
  validateArgs,
  validateEnqueueRequest,
} from '../src/validation/schemas.js';
import {
  MiddlewareChain,
  composeExecution,
  type ExecutionMiddleware,
  type JobContext,
} from '../src/middleware.js';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Arbitrary that produces JSON-compatible values (mirrors JsonValue type). */
const jsonValueArb: fc.Arbitrary<JsonValue> = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: 'small' },
    fc.string(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie('value') as fc.Arbitrary<JsonValue>, { maxLength: 5 }),
    fc.dictionary(
      fc.string({ maxLength: 10 }),
      tie('value') as fc.Arbitrary<JsonValue>,
      { maxKeys: 5 },
    ),
  ),
})).value;

const JOB_STATES: JobState[] = [
  'scheduled',
  'available',
  'pending',
  'active',
  'completed',
  'retryable',
  'cancelled',
  'discarded',
];

/** Arbitrary that produces a plausible Job envelope. */
const jobArb: fc.Arbitrary<Job> = fc.record({
  specversion: fc.constant('1.0'),
  id: fc.uuid(),
  type: fc.stringMatching(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$/, { maxLength: 30 }),
  queue: fc.stringMatching(/^[a-z0-9][a-z0-9\-.]{0,19}$/, { maxLength: 20 }),
  args: fc.array(jsonValueArb, { maxLength: 5 }),
  state: fc.constantFrom(...JOB_STATES),
  attempt: fc.nat(10),
  priority: fc.integer({ min: -100, max: 100 }),
});

// ---------------------------------------------------------------------------
// 1. Job JSON roundtrip
// ---------------------------------------------------------------------------

describe('fuzz: Job JSON roundtrip', () => {
  it('serialize → deserialize preserves required fields', () => {
    fc.assert(
      fc.property(jobArb, (job) => {
        const json = JSON.stringify(job);
        const parsed: Job = JSON.parse(json);

        expect(parsed.specversion).toBe(job.specversion);
        expect(parsed.id).toBe(job.id);
        expect(parsed.type).toBe(job.type);
        expect(parsed.queue).toBe(job.queue);
        expect(parsed.args).toEqual(job.args);
        expect(parsed.state).toBe(job.state);
      }),
      { numRuns: 200 },
    );
  });

  it('JSON.parse(JSON.stringify(job)) never throws', () => {
    fc.assert(
      fc.property(jobArb, (job) => {
        // Must not throw regardless of generated content
        const roundtripped = JSON.parse(JSON.stringify(job));
        expect(roundtripped).toBeDefined();
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Args serialization
// ---------------------------------------------------------------------------

describe('fuzz: args serialization', () => {
  it('arbitrary arrays survive JSON roundtrip', () => {
    fc.assert(
      fc.property(fc.array(jsonValueArb, { maxLength: 10 }), (args) => {
        const serialized = JSON.stringify(args);
        const deserialized = JSON.parse(serialized);
        expect(deserialized).toEqual(args);
      }),
      { numRuns: 200 },
    );
  });

  it('normalizeArgs never throws on JsonValue input', () => {
    fc.assert(
      fc.property(jsonValueArb, (value) => {
        // normalizeArgs accepts JsonValue | JsonValue[], must not throw
        const result = normalizeArgs(value);
        expect(Array.isArray(result)).toBe(true);
        // Arrays pass through as-is (may be empty); non-arrays get wrapped
        if (!Array.isArray(value)) {
          expect(result.length).toBe(1);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('normalizeArgs on arrays returns the same array', () => {
    fc.assert(
      fc.property(fc.array(jsonValueArb, { maxLength: 10 }), (args) => {
        const result = normalizeArgs(args);
        expect(result).toBe(args);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Validation fuzzing
// ---------------------------------------------------------------------------

describe('fuzz: validation', () => {
  it('validateJobType never throws on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (type) => {
        // Must return null (valid) or a ValidationError object — never throw
        const result = validateJobType(type);
        if (result !== null) {
          expect(result).toHaveProperty('field');
          expect(result).toHaveProperty('message');
        }
      }),
      { numRuns: 300 },
    );
  });

  it('validateQueueName never throws on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (queue) => {
        const result = validateQueueName(queue);
        if (result !== null) {
          expect(result).toHaveProperty('field');
          expect(result).toHaveProperty('message');
        }
      }),
      { numRuns: 300 },
    );
  });

  it('validateArgs never throws on arbitrary inputs', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          jsonValueArb,
          fc.string(),
          fc.integer(),
          fc.constant(undefined),
          fc.constant(null),
          fc.array(jsonValueArb),
        ),
        (args) => {
          const result = validateArgs(args);
          if (result !== null) {
            expect(result).toHaveProperty('field', 'args');
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('validateEnqueueRequest never throws on arbitrary payloads', () => {
    fc.assert(
      fc.property(
        fc.record({
          type: fc.option(fc.string({ maxLength: 100 }), { nil: undefined }),
          args: fc.option(fc.oneof(fc.array(jsonValueArb), fc.string(), fc.integer()), {
            nil: undefined,
          }),
          options: fc.option(
            fc.record({
              queue: fc.option(fc.string({ maxLength: 150 }), { nil: undefined }),
            }),
            { nil: undefined },
          ),
        }),
        (body) => {
          const errors = validateEnqueueRequest(body);
          expect(Array.isArray(errors)).toBe(true);
          for (const err of errors) {
            expect(err).toHaveProperty('field');
            expect(err).toHaveProperty('message');
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Error parsing
// ---------------------------------------------------------------------------

describe('fuzz: error parsing', () => {
  it('parseErrorResponse never throws on arbitrary status + body', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 599 }),
        fc.record({
          error: fc.option(
            fc.record({
              code: fc.option(fc.string(), { nil: undefined }),
              message: fc.option(fc.string(), { nil: undefined }),
              retryable: fc.option(fc.boolean(), { nil: undefined }),
              details: fc.option(
                fc.dictionary(fc.string({ maxLength: 10 }), fc.string()),
                { nil: undefined },
              ),
              request_id: fc.option(fc.string(), { nil: undefined }),
            }),
            { nil: undefined },
          ),
        }),
        (status, body) => {
          const err = parseErrorResponse(status, body);
          expect(err).toBeInstanceOf(OJSError);
          expect(typeof err.message).toBe('string');
          expect(typeof err.code).toBe('string');
        },
      ),
      { numRuns: 300 },
    );
  });

  it('parseErrorResponse handles empty/malformed bodies', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 599 }),
        (status) => {
          // Completely empty body
          const err1 = parseErrorResponse(status, {});
          expect(err1).toBeInstanceOf(OJSError);

          // Body with empty error object
          const err2 = parseErrorResponse(status, { error: {} });
          expect(err2).toBeInstanceOf(OJSError);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Middleware chain
// ---------------------------------------------------------------------------

describe('fuzz: middleware chain', () => {
  function createTestContext(): JobContext {
    return {
      job: {
        specversion: '1.0',
        id: 'fuzz-job',
        type: 'fuzz.test',
        queue: 'default',
        args: [],
      },
      attempt: 1,
      queue: 'default',
      workerId: 'fuzz-worker',
      metadata: new Map(),
      signal: new AbortController().signal,
    };
  }

  it('composeExecution completes with N pass-through middlewares', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 50 }),
        async (count) => {
          const chain = new MiddlewareChain<ExecutionMiddleware>();
          for (let i = 0; i < count; i++) {
            chain.add(`mw-${i}`, async (_ctx, next) => next());
          }

          const handler = async () => 'done';
          const composed = composeExecution(chain.entries(), handler);
          const result = await composed(createTestContext());
          expect(result).toBe('done');
        },
      ),
      { numRuns: 50 },
    );
  });

  it('middleware chain tracks execution order for N middlewares', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }),
        async (count) => {
          const order: number[] = [];
          const chain = new MiddlewareChain<ExecutionMiddleware>();

          for (let i = 0; i < count; i++) {
            const idx = i;
            chain.add(`mw-${i}`, async (_ctx, next) => {
              order.push(idx);
              return next();
            });
          }

          const handler = async () => 'done';
          const composed = composeExecution(chain.entries(), handler);
          await composed(createTestContext());

          // Middleware should execute in insertion order
          expect(order).toEqual(Array.from({ length: count }, (_, i) => i));
        },
      ),
      { numRuns: 50 },
    );
  });

  it('MiddlewareChain add/remove never crashes with arbitrary names', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 50 }), { maxLength: 30 }),
        (names) => {
          const chain = new MiddlewareChain<ExecutionMiddleware>();
          const passthrough: ExecutionMiddleware = async (_ctx, next) => next();

          for (const name of names) {
            chain.add(name, passthrough);
          }
          expect(chain.length).toBe(names.length);

          // Remove all — must not throw
          for (const name of names) {
            chain.remove(name);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

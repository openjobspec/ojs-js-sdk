/**
 * Focused tests for `src/transport/grpc.ts`'s strict HTTP-wire ->
 * protobuf `EnqueueOptions` converter (`mapEnqueueOptions` /
 * `buildProtoEnqueueOptions` and friends), shared by single `enqueue()`,
 * every job in `enqueueBatch()`, including client-side expansion of raw
 * `default_options`/`defaultOptions` without emitting protobuf
 * `EnqueueBatchRequest.default_options`.
 *
 * Two complementary techniques are used throughout:
 *
 *   1. "Captured generated-client request" tests: a fake generated
 *      client (the same override-`call()` technique
 *      `tests/transport-grpc.test.ts`'s `createMockGrpcTransport()`
 *      uses) records the *exact* request object `GrpcTransport` builds
 *      and hands to the generated client, so assertions can inspect the
 *      converter's output directly.
 *   2. Actual `@grpc/proto-loader` serialization tests: every captured
 *      `options` object is round-tripped through a *real* generated
 *      protobuf message type — loaded via `protoLoader.loadSync()` from
 *      `tests/fixtures/proto/ojs/v1/enqueue_options.proto` (a field-for-
 *      field-identical fixture subset of ojs-proto's real job.proto) —
 *      using its `serialize()`/`deserialize()` methods, the same pair
 *      the real generated `OJSService` client would use on the wire.
 *      This is strictly stronger than a plain JSON structural
 *      comparison: an accidental wrong field name, wrong nesting, or a
 *      value shape a real protobuf message can't represent would fail
 *      here even if it happened to "look right" as a bare JS object.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as protoLoader from '@grpc/proto-loader';
import { OJSClient } from '../src/client.js';
import { GrpcTransport } from '../src/transport/grpc.js';
import { OJSError, OJSValidationError } from '../src/errors.js';

const FIXTURE_PROTO = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/proto/ojs/v1/enqueue_options.proto',
);

// Real generated message types (`serialize`/`deserialize`), loaded with
// the exact same proto-loader options `GrpcTransport` itself passes to
// `loadSync()` (see `src/transport/grpc.ts`'s `keepCase`/`longs`/`enums`/
// `defaults`/`oneofs` config), so decode/encode behavior matches exactly.
let EnqueueOptionsType: protoLoader.AnyDefinition;
let EnqueueRequestType: protoLoader.AnyDefinition;
let BatchJobEntryType: protoLoader.AnyDefinition;
let EnqueueBatchRequestType: protoLoader.AnyDefinition;

beforeAll(() => {
  const pkgDef = protoLoader.loadSync(FIXTURE_PROTO, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  EnqueueOptionsType = (pkgDef as Record<string, protoLoader.AnyDefinition>)['ojs.v1.EnqueueOptions']!;
  EnqueueRequestType = (pkgDef as Record<string, protoLoader.AnyDefinition>)['ojs.v1.EnqueueRequest']!;
  BatchJobEntryType = (pkgDef as Record<string, protoLoader.AnyDefinition>)['ojs.v1.BatchJobEntry']!;
  EnqueueBatchRequestType = (pkgDef as Record<string, protoLoader.AnyDefinition>)['ojs.v1.EnqueueBatchRequest']!;
});

/** A recorded `call()` invocation captured by `createCapturingGrpcTransport`. */
interface CapturedCall {
  method: string;
  request: Record<string, unknown>;
}

/**
 * Wires a `GrpcTransport` the same way `tests/transport-grpc.test.ts`'s
 * `createMockGrpcTransport()` does (bypassing lazy init, overriding the
 * private `call()`), but records every request verbatim instead of
 * asserting on it inline, and fabricates a minimal-but-valid response
 * shaped after the real `EnqueueResponse`/`EnqueueBatchResponse`
 * messages so `transport.request()` resolves normally.
 */
function createCapturingGrpcTransport(): { transport: GrpcTransport; calls: CapturedCall[] } {
  const transport = new GrpcTransport({ url: 'localhost:9090' });
  const calls: CapturedCall[] = [];

  (transport as unknown as { client: unknown }).client = { close: vi.fn() };
  (transport as unknown as { initPromise: Promise<void> }).initPromise = Promise.resolve();
  (transport as unknown as { grpcModule: unknown }).grpcModule = {
    Metadata: class {
      entries: Record<string, string> = {};
      set(key: string, value: string): void {
        this.entries[key] = value;
      }
    },
    credentials: { createInsecure: () => ({}) },
    loadPackageDefinition: () => ({}),
  };

  (transport as unknown as {
    call: (method: string, request: unknown) => Promise<unknown>;
  }).call = async (method: string, request: unknown): Promise<unknown> => {
    const req = request as Record<string, unknown>;
    calls.push({ method, request: req });

    if (method === 'enqueue') {
      return {
        job: {
          id: 'job-1',
          type: req.type,
          queue: 'default',
          state: 'JOB_STATE_AVAILABLE',
          args: [],
        },
      };
    }
    if (method === 'enqueueBatch') {
      const jobs = (req.jobs as Array<{ type: unknown }>) ?? [];
      return {
        jobs: jobs.map((j, i) => ({
          id: `job-${i}`,
          type: j.type,
          queue: 'default',
          state: 'JOB_STATE_AVAILABLE',
          args: [],
        })),
      };
    }
    throw new Error(`createCapturingGrpcTransport: unexpected method '${method}'`);
  };

  return { transport, calls };
}

/** Deep-clones a plain JSON-compatible value for later no-mutation comparison. */
function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('GrpcTransport enqueue options: single enqueue', () => {
  it('maps the pre-next post-middleware envelope and never re-sends post-next mutations', async () => {
    // Onion semantics: the terminal gRPC enqueue happens when next() is
    // reached, so mutations applied *before* next() are what gets serialized
    // and sent. Mutations applied *after* next() affect the returned Job only
    // and are never re-sent, so response-only fields cannot reach the wire.
    const { transport, calls } = createCapturingGrpcTransport();
    const client = new OJSClient({ url: 'grpc://localhost', transport });
    client.useEnqueue('mutate', async (job, next) => {
      // Applied before next(): serialized and sent.
      job.type = 'mutated.job';
      job.args = [{ encrypted: true }];
      job.queue = 'mutated';
      job.priority = 0;
      job.timeout = 0;
      job.scheduled_at = '2026-09-01T00:00:00Z';
      job.retry = { max_attempts: 0, jitter: false };
      job.unique = {
        keys: ['type', 'args', 'meta'],
        args_keys: ['encrypted'],
        meta_keys: ['tenant'],
        on_conflict: 'ignore',
      };
      job.tags = ['middleware'];
      job.visibility_timeout = 5_000;
      job.meta = { tenant: 'acme' };

      const created = await next(job);
      if (created === null) return null;

      // Applied after next(): reflected in the return only, never re-sent.
      created.queue = 'post-next-queue';
      created.priority = 42;
      created.state = 'completed';
      created.result = 'must not be sent';
      return created;
    });

    const returned = await client.enqueue('original.job', { plaintext: true }, {
      queue: 'original',
      priority: 99,
      timeout: 99,
      retry: { maxAttempts: 9, jitter: true },
      meta: { original: true },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.request.type).toBe('mutated.job');
    expect(calls[0]!.request.args).toEqual([
      { structValue: { fields: { encrypted: { boolValue: true } } } },
    ]);
    expect(calls[0]!.request.options).toEqual({
      queue: 'mutated',
      priority: 0,
      delayUntil: { seconds: '1788220800', nanos: 0 },
      timeout: { seconds: '0', nanos: 0 },
      retry: {
        maxAttempts: 0,
        jitter: false,
      },
      unique: {
        key: ['type', 'args', 'meta'],
        onConflict: 'UNIQUE_CONFLICT_ACTION_IGNORE',
        argsKeys: ['encrypted'],
        metaKeys: ['tenant'],
      },
      tags: ['middleware'],
      meta: {
        fields: {
          tenant: { stringValue: 'acme' },
        },
      },
      visibilityTimeout: { seconds: '5', nanos: 0 },
    });

    // Post-next mutations are visible on the returned Job but were never sent.
    expect(returned).not.toBeNull();
    expect(returned!.queue).toBe('post-next-queue');
    expect(returned!.priority).toBe(42);
  });

  it('maps every EnqueueOptions field from a fully-populated wire body', async () => {
    const { transport, calls } = createCapturingGrpcTransport();

    await transport.request({
      method: 'POST',
      path: '/jobs',
      body: {
        type: 'email.send',
        args: ['user@example.com'],
        meta: { tenant_id: 'acme', source: 'signup' },
        options: {
          queue: 'email',
          priority: 7,
          delay_until: '2026-03-15T09:30:00.000Z',
          timeout_ms: 30_500,
          expires_at: '2099-01-01T00:00:00.000Z',
          retry: {
            max_attempts: 5,
            initial_interval: 'PT1S',
            backoff_coefficient: 2.0,
            max_interval: 'PT5M',
            jitter: true,
            non_retryable_errors: ['ValidationError'],
            on_exhaustion: 'dead_letter',
          },
          unique: {
            keys: ['type', 'args', 'meta'],
            period: 'PT1H',
            on_conflict: 'replace_except_schedule',
            states: ['available', 'active'],
            args_keys: ['user_id'],
            meta_keys: ['tenant_id'],
          },
          tags: ['onboarding', 'email'],
          trace_id: 'trace-abc',
          max_attempts: 3,
          visibility_timeout_ms: 45_000,
        },
      },
    });

    expect(calls).toHaveLength(1);
    const options = calls[0]!.request.options as Record<string, unknown>;

    expect(options).toEqual({
      queue: 'email',
      priority: 7,
      delayUntil: { seconds: '1773567000', nanos: 0 },
      timeout: { seconds: '30', nanos: 500_000_000 },
      ttl: expect.objectContaining({ seconds: expect.any(String) }),
      retry: {
        maxAttempts: 5,
        initialInterval: { seconds: '1', nanos: 0 },
        backoffCoefficient: 2.0,
        maxInterval: { seconds: '300', nanos: 0 },
        jitter: true,
        nonRetryableErrors: ['ValidationError'],
        onExhaustion: 'dead_letter',
      },
      unique: {
        key: ['type', 'args', 'meta'],
        period: { seconds: '3600', nanos: 0 },
        onConflict: 'UNIQUE_CONFLICT_ACTION_REPLACE_EXCEPT_SCHEDULE',
        states: ['JOB_STATE_AVAILABLE', 'JOB_STATE_ACTIVE'],
        argsKeys: ['user_id'],
        metaKeys: ['tenant_id'],
      },
      tags: ['onboarding', 'email'],
      traceId: 'trace-abc',
      meta: { fields: expect.any(Object) },
      maxAttempts: 3,
      visibilityTimeout: { seconds: '45', nanos: 0 },
    });

    // Actual @grpc/proto-loader serialization: round-trip the captured
    // options object through the real generated EnqueueOptions message.
    const buf = EnqueueOptionsType.serialize(options);
    const decoded = EnqueueOptionsType.deserialize(buf) as Record<string, unknown>;
    expect(decoded.queue).toBe('email');
    expect(decoded.priority).toBe(7);
    expect(decoded.delayUntil).toEqual({ seconds: '1773567000', nanos: 0 });
    expect(decoded.timeout).toEqual({ seconds: '30', nanos: 500_000_000 });
    expect(decoded.retry).toEqual({
      maxAttempts: 5,
      initialInterval: { seconds: '1', nanos: 0 },
      backoffCoefficient: 2,
      maxInterval: { seconds: '300', nanos: 0 },
      jitter: true,
      nonRetryableErrors: ['ValidationError'],
      onExhaustion: 'dead_letter',
    });
    expect(decoded.unique).toEqual({
      key: ['type', 'args', 'meta'],
      period: { seconds: '3600', nanos: 0 },
      onConflict: 'UNIQUE_CONFLICT_ACTION_REPLACE_EXCEPT_SCHEDULE',
      states: ['JOB_STATE_AVAILABLE', 'JOB_STATE_ACTIVE'],
      argsKeys: ['user_id'],
      metaKeys: ['tenant_id'],
    });
    expect(decoded.tags).toEqual(['onboarding', 'email']);
    expect(decoded.traceId).toBe('trace-abc');
    expect(decoded.maxAttempts).toBe(3);
    expect(decoded.visibilityTimeout).toEqual({ seconds: '45', nanos: 0 });

    // The whole EnqueueRequest (type/args/options) is itself wire-valid too.
    const reqBuf = EnqueueRequestType.serialize(calls[0]!.request);
    const reqDecoded = EnqueueRequestType.deserialize(reqBuf) as Record<string, unknown>;
    expect(reqDecoded.type).toBe('email.send');
  });

  it('preserves an explicit priority 0, timeout_ms 0, jitter false, max_attempts 0, and empty tags', async () => {
    const { transport, calls } = createCapturingGrpcTransport();

    await transport.request({
      method: 'POST',
      path: '/jobs',
      body: {
        type: 'test.zero',
        args: [],
        options: {
          priority: 0,
          timeout_ms: 0,
          retry: { jitter: false, max_attempts: 0 },
          tags: [],
          max_attempts: 0,
          visibility_timeout_ms: 0,
        },
      },
    });

    const options = calls[0]!.request.options as Record<string, unknown>;
    expect(options.priority).toBe(0);
    expect(options.timeout).toEqual({ seconds: '0', nanos: 0 });
    expect((options.retry as Record<string, unknown>).jitter).toBe(false);
    expect((options.retry as Record<string, unknown>).maxAttempts).toBe(0);
    expect(options.tags).toEqual([]);
    expect(options.maxAttempts).toBe(0);
    expect(options.visibilityTimeout).toEqual({ seconds: '0', nanos: 0 });

    // Round-trip through the real message type to confirm zero-valued
    // fields survive actual protobuf encode/decode too.
    const buf = EnqueueOptionsType.serialize(options);
    const decoded = EnqueueOptionsType.deserialize(buf) as Record<string, unknown>;
    expect(decoded.priority).toBe(0);
    expect(decoded.maxAttempts).toBe(0);
    expect((decoded.retry as Record<string, unknown>).jitter).toBe(false);
  });

  it('supports backward-compatible top-level queue/priority, with nested options winning on conflict', async () => {
    const { transport, calls } = createCapturingGrpcTransport();

    await transport.request({
      method: 'POST',
      path: '/jobs',
      body: {
        type: 'test.legacy',
        args: [],
        queue: 'legacy-queue',
        priority: 1,
        options: { queue: 'nested-queue' },
      },
    });

    const options = calls[0]!.request.options as Record<string, unknown>;
    // options.queue is explicit, so it wins over the top-level queue;
    // top-level priority is used since options didn't set its own.
    expect(options.queue).toBe('nested-queue');
    expect(options.priority).toBe(1);
  });

  it('threads envelope-level meta into EnqueueOptions.meta as a Struct', async () => {
    const { transport, calls } = createCapturingGrpcTransport();

    await transport.request({
      method: 'POST',
      path: '/jobs',
      body: {
        type: 'test.meta',
        args: [],
        meta: { tenant_id: 'acme', enabled: false, count: 0 },
      },
    });

    const options = calls[0]!.request.options as Record<string, unknown>;
    const buf = EnqueueOptionsType.serialize(options);
    const decoded = EnqueueOptionsType.deserialize(buf) as { meta: { fields: Record<string, unknown> } };
    expect(decoded.meta.fields.tenant_id).toEqual({ kind: 'stringValue', stringValue: 'acme' });
    expect(decoded.meta.fields.enabled).toEqual({ kind: 'boolValue', boolValue: false });
    expect(decoded.meta.fields.count).toEqual({ kind: 'numberValue', numberValue: 0 });
  });

  it('preserves __proto__/constructor/prototype as real meta Struct keys through actual proto-loader serialization (Finding: prototype-pollution-safe encoding)', async () => {
    // JSON.parse gives `__proto__`/`constructor`/`prototype` real *own*
    // enumerable properties (its [[DefineOwnProperty]]-based semantics
    // bypass the `Object.prototype.__proto__` accessor entirely) — a
    // realistic shape for meta coming off an actual HTTP/JSON request
    // body, not a contrived object literal.
    const maliciousMeta = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":"not-a-function","prototype":42,"tenant_id":"acme"}',
    ) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(maliciousMeta, '__proto__')).toBe(true);

    const { transport, calls } = createCapturingGrpcTransport();
    await transport.request({
      method: 'POST',
      path: '/jobs',
      body: { type: 'test.malicious-meta', args: [], meta: maliciousMeta },
    });

    const options = calls[0]!.request.options as Record<string, unknown>;
    const metaFields = (options.meta as { fields: Record<string, unknown> }).fields;
    expect(Object.prototype.hasOwnProperty.call(metaFields, '__proto__')).toBe(true);
    expect(metaFields.__proto__).toEqual({
      structValue: { fields: { polluted: { boolValue: true } } },
    });
    expect(metaFields.constructor).toEqual({ stringValue: 'not-a-function' });
    expect(metaFields.prototype).toEqual({ numberValue: 42 });
    expect(metaFields.tenant_id).toEqual({ stringValue: 'acme' });

    // Real wire round-trip through the actual EnqueueOptions message.
    const buf = EnqueueOptionsType.serialize(options);
    const decoded = EnqueueOptionsType.deserialize(buf) as { meta: { fields: Record<string, unknown> } };
    const f = decoded.meta.fields as Record<string, { kind: string; [k: string]: unknown }>;
    expect(f.__proto__).toMatchObject({ kind: 'structValue' });
    expect(f.constructor).toMatchObject({ kind: 'stringValue', stringValue: 'not-a-function' });
    expect(f.prototype).toMatchObject({ kind: 'numberValue', numberValue: 42 });
    expect(f.tenant_id).toMatchObject({ kind: 'stringValue', stringValue: 'acme' });

    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('preserves __proto__/constructor/prototype as real job-args Value keys through actual proto-loader serialization (Finding: prototype-pollution-safe encoding)', async () => {
    const maliciousArg = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":"not-a-function","prototype":42,"safe":"ok"}',
    ) as Record<string, unknown>;

    const { transport, calls } = createCapturingGrpcTransport();
    await transport.request({
      method: 'POST',
      path: '/jobs',
      body: { type: 'test.malicious-args', args: [maliciousArg] },
    });

    const args = calls[0]!.request.args as Array<{ structValue: { fields: Record<string, unknown> } }>;
    const fields = args[0]!.structValue.fields;
    expect(Object.prototype.hasOwnProperty.call(fields, '__proto__')).toBe(true);
    expect(fields.__proto__).toEqual({
      structValue: { fields: { polluted: { boolValue: true } } },
    });
    expect(fields.constructor).toEqual({ stringValue: 'not-a-function' });
    expect(fields.prototype).toEqual({ numberValue: 42 });
    expect(fields.safe).toEqual({ stringValue: 'ok' });

    // Real wire round-trip through the actual EnqueueRequest message.
    const buf = EnqueueRequestType.serialize(calls[0]!.request);
    const decoded = EnqueueRequestType.deserialize(buf) as {
      args: Array<{ kind: string; structValue: { fields: Record<string, { kind: string; [k: string]: unknown }> } }>;
    };
    const decodedFields = decoded.args[0]!.structValue.fields;
    expect(decodedFields.__proto__).toMatchObject({ kind: 'structValue' });
    expect(decodedFields.constructor).toMatchObject({ kind: 'stringValue', stringValue: 'not-a-function' });
    expect(decodedFields.prototype).toMatchObject({ kind: 'numberValue', numberValue: 42 });
    expect(decodedFields.safe).toMatchObject({ kind: 'stringValue', stringValue: 'ok' });

    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('accepts an explicit options.meta shorthand, taking precedence over envelope meta', async () => {
    const { transport, calls } = createCapturingGrpcTransport();

    await transport.request({
      method: 'POST',
      path: '/jobs',
      body: {
        type: 'test.meta-precedence',
        args: [],
        meta: { tenant_id: 'from-envelope' },
        options: { meta: { tenant_id: 'from-options' } },
      },
    });

    const options = calls[0]!.request.options as Record<string, unknown>;
    const buf = EnqueueOptionsType.serialize(options);
    const decoded = EnqueueOptionsType.deserialize(buf) as { meta: { fields: Record<string, unknown> } };
    expect(decoded.meta.fields.tenant_id).toEqual({ kind: 'stringValue', stringValue: 'from-options' });
  });

  it('converts a pre-epoch delay_until with canonical non-negative Timestamp nanos', async () => {
    const { transport, calls } = createCapturingGrpcTransport();

    await transport.request({
      method: 'POST',
      path: '/jobs',
      body: {
        type: 'test.pre-epoch',
        args: [],
        options: { delay_until: '1969-12-31T23:59:58.500Z' },
      },
    });

    const options = calls[0]!.request.options as Record<string, unknown>;
    expect(options.delayUntil).toEqual({ seconds: '-2', nanos: 500_000_000 });

    const buf = EnqueueOptionsType.serialize(options);
    const decoded = EnqueueOptionsType.deserialize(buf) as { delayUntil: { seconds: string; nanos: number } };
    expect(decoded.delayUntil).toEqual({ seconds: '-2', nanos: 500_000_000 });
  });

  it('preserves all nine RFC 3339 fractional-second digits in Timestamp nanos', async () => {
    const { transport, calls } = createCapturingGrpcTransport();

    await transport.request({
      method: 'POST',
      path: '/jobs',
      body: {
        type: 'test.nanos',
        args: [],
        options: { delay_until: '2026-03-15T09:30:00.123456789Z' },
      },
    });

    const options = calls[0]!.request.options as Record<string, unknown>;
    expect(options.delayUntil).toEqual({
      seconds: '1773567000',
      nanos: 123_456_789,
    });
  });

  it('omits options entirely when the body has no recognized enqueue option', async () => {
    const { transport, calls } = createCapturingGrpcTransport();

    await transport.request({
      method: 'POST',
      path: '/jobs',
      body: { type: 'test.none', args: [] },
    });

    expect(calls[0]!.request.options).toBeUndefined();
  });

  it('rejects an envelope-level schema with an explicit unimplemented OJSError', async () => {
    const { transport, calls } = createCapturingGrpcTransport();

    await expect(
      transport.request({
        method: 'POST',
        path: '/jobs',
        body: { type: 'test.schema', args: [], schema: 'urn:ojs:schema:test:v1' },
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(OJSError);
      expect((err as OJSError).code).toBe('unimplemented');
      expect((err as OJSError).retryable).toBe(false);
      return true;
    });
    expect(calls).toHaveLength(0);
  });
});

describe('GrpcTransport enqueue options: canonical and SDK-legacy unique fields', () => {
  it('maps canonical keys/args_keys/meta_keys to protobuf key/argsKeys/metaKeys', async () => {
    const { transport, calls } = createCapturingGrpcTransport();

    await transport.request({
      method: 'POST',
      path: '/jobs',
      body: {
        type: 'email.send',
        args: [{ id: 42 }],
        options: {
          unique: {
            keys: ['type', 'args', 'meta'],
            args_keys: ['id'],
            meta_keys: ['tenant_id'],
          },
        },
      },
    });

    const options = calls[0]!.request.options as Record<string, unknown>;
    expect(options.unique).toEqual({
      key: ['type', 'args', 'meta'],
      argsKeys: ['id'],
      metaKeys: ['tenant_id'],
    });
  });

  it('accepts empty args_keys/states and converts an exact week duration', async () => {
    const { transport, calls } = createCapturingGrpcTransport();

    await transport.request({
      method: 'POST',
      path: '/jobs',
      body: {
        type: 'email.send',
        args: [],
        options: {
          unique: {
            keys: ['type'],
            args_keys: [],
            states: [],
            period: 'P2W',
            on_conflict: 'ignore',
          },
        },
      },
    });

    const options = calls[0]!.request.options as Record<string, unknown>;
    expect(options.unique).toEqual({
      key: ['type'],
      argsKeys: [],
      states: [],
      period: { seconds: '1209600', nanos: 0 },
      onConflict: 'UNIQUE_CONFLICT_ACTION_IGNORE',
    });
  });

  it('treats every direct legacy key entry as an args selector', async () => {
    const { transport, calls } = createCapturingGrpcTransport();

    await transport.request({
      method: 'POST',
      path: '/jobs',
      body: {
        type: 'email.send',
        args: [{ type: 'transactional', queue: 'priority', id: 42 }],
        options: { unique: { key: ['type', 'queue', 'args', 'meta', 'id'] } },
      },
    });

    const options = calls[0]!.request.options as Record<string, unknown>;
    expect(options.unique).toEqual({
      key: ['args'],
      argsKeys: ['type', 'queue', 'args', 'meta', 'id'],
    });
  });

  it('merges canonical selectors before direct legacy selectors without mutation', async () => {
    const { transport, calls } = createCapturingGrpcTransport();
    const keys = ['type'];
    const argsKeys = ['id', 'type'];
    const legacyKey = ['queue', 'id', 'type'];
    const snapshotBefore = snapshot({ keys, argsKeys, legacyKey });

    await transport.request({
      method: 'POST',
      path: '/jobs',
      body: {
        type: 'email.send',
        args: [{ id: 42, type: 'transactional', queue: 'priority' }],
        options: {
          unique: {
            keys,
            args_keys: argsKeys,
            key: legacyKey,
          },
        },
      },
    });

    const options = calls[0]!.request.options as Record<string, unknown>;
    expect(options.unique).toEqual({
      key: ['type', 'args'],
      argsKeys: ['id', 'type', 'queue'],
    });
    expect({ keys, argsKeys, legacyKey }).toEqual(snapshotBefore);
  });
});

describe('GrpcTransport enqueue options: validation of malformed fields', () => {
  const invalidCases: Array<{ name: string; options: Record<string, unknown> }> = [
    { name: 'delay_until is not a valid timestamp', options: { delay_until: 'not-a-date' } },
    { name: 'delay_until omits its RFC 3339 timezone', options: { delay_until: '2026-03-15T09:30:00' } },
    { name: 'delay_until names an impossible calendar date', options: { delay_until: '2026-02-30T09:30:00Z' } },
    { name: 'queue is an empty string', options: { queue: '' } },
    { name: 'queue violates the wire naming rules', options: { queue: 'Not Valid' } },
    { name: 'retry.jitter is not a boolean', options: { retry: { jitter: 'yes' } } },
    { name: 'timeout_ms is negative', options: { timeout_ms: -1 } },
    { name: 'timeout_ms is not a number', options: { timeout_ms: '30000' } },
    { name: 'timeout_ms is fractional', options: { timeout_ms: 1.5 } },
    { name: 'priority is out of range', options: { priority: 1000 } },
    { name: 'priority is not an integer', options: { priority: 1.5 } },
    { name: 'expires_at is not a valid timestamp', options: { expires_at: 'not-a-date' } },
    { name: 'retry is not an object', options: { retry: 'nope' } },
    { name: 'retry.initial_interval is not a valid duration', options: { retry: { initial_interval: 'nope' } } },
    { name: 'retry.max_attempts is negative', options: { retry: { max_attempts: -1 } } },
    { name: 'retry.backoff_coefficient is below one', options: { retry: { backoff_coefficient: 0.5 } } },
    { name: 'retry.on_exhaustion is not a valid value', options: { retry: { on_exhaustion: 'retry_forever' } } },
    { name: 'retry contains an unsupported field', options: { retry: { unknown: true } } },
    { name: 'unique is not an object', options: { unique: 'nope' } },
    { name: 'unique.on_conflict is not a valid value', options: { unique: { on_conflict: 'explode' } } },
    { name: 'unique.keys contains an invalid dimension', options: { unique: { keys: ['type', 'argz'] } } },
    { name: 'unique.key contains an empty string', options: { unique: { key: ['type', ''] } } },
    { name: 'unique.args_keys contains an empty string', options: { unique: { args_keys: ['id', ''] } } },
    { name: 'unique.keys contains duplicates', options: { unique: { keys: ['type', 'type'] } } },
    { name: 'unique.args_keys contains duplicates', options: { unique: { args_keys: ['id', 'id'] } } },
    { name: 'unique.meta_keys is empty', options: { unique: { meta_keys: [] } } },
    { name: 'unique.keys contains meta without meta_keys', options: { unique: { keys: ['type', 'meta'] } } },
    { name: 'unique.states has an invalid entry', options: { unique: { states: ['available', 'bogus'] } } },
    { name: 'unique.states contains duplicates', options: { unique: { states: ['active', 'active'] } } },
    { name: 'unique.states is not an array', options: { unique: { states: 'available' } } },
    { name: 'unique.period is not a valid duration', options: { unique: { period: 'nope' } } },
    { name: 'tags is not an array of strings', options: { tags: ['ok', 42] } },
    { name: 'tags contains an empty string', options: { tags: [''] } },
    { name: 'trace_id is not a string', options: { trace_id: 42 } },
    { name: 'max_attempts is negative', options: { max_attempts: -1 } },
    { name: 'visibility_timeout_ms is negative', options: { visibility_timeout_ms: -1 } },
    { name: 'options contains an unsupported field', options: { unknown: true } },
  ];

  for (const { name, options } of invalidCases) {
    it(`rejects: ${name}`, async () => {
      const { transport, calls } = createCapturingGrpcTransport();

      await expect(
        transport.request({
          method: 'POST',
          path: '/jobs',
          body: { type: 'test.invalid', args: [], options },
        }),
      ).rejects.toBeInstanceOf(OJSValidationError);
      expect(calls).toHaveLength(0);
    });
  }

  it.each([null, [], 'queue=email'])(
    'rejects a non-object nested options value (%j) before calling the client',
    async (options) => {
      const { transport, calls } = createCapturingGrpcTransport();

      await expect(
        transport.request({
          method: 'POST',
          path: '/jobs',
          body: { type: 'test.invalid-options', args: [], options },
        }),
      ).rejects.toBeInstanceOf(OJSValidationError);
      expect(calls).toHaveLength(0);
    },
  );

  it.each([
    { name: 'scalar', meta: 'tenant=acme' },
    { name: 'non-finite number', meta: { score: Number.NaN } },
    { name: 'undefined value', meta: { tenant: undefined } },
    { name: 'non-plain object', meta: { created: new Date() } },
  ])('rejects invalid $name metadata before calling the client', async ({ meta }) => {
    const { transport, calls } = createCapturingGrpcTransport();

    await expect(
      transport.request({
        method: 'POST',
        path: '/jobs',
        body: { type: 'test.invalid-meta', args: [], meta },
      }),
    ).rejects.toBeInstanceOf(OJSValidationError);
    expect(calls).toHaveLength(0);
  });

  it('rejects cyclic metadata before calling the client', async () => {
    const { transport, calls } = createCapturingGrpcTransport();
    const meta: Record<string, unknown> = {};
    meta.self = meta;

    await expect(
      transport.request({
        method: 'POST',
        path: '/jobs',
        body: { type: 'test.cyclic-meta', args: [], meta },
      }),
    ).rejects.toBeInstanceOf(OJSValidationError);
    expect(calls).toHaveLength(0);
  });

  it('rejects an expires_at that has already passed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
    const { transport } = createCapturingGrpcTransport();

    await expect(
      transport.request({
        method: 'POST',
        path: '/jobs',
        body: {
          type: 'test.expired',
          args: [],
          options: { expires_at: '2026-05-31T23:59:59.000Z' },
        },
      }),
    ).rejects.toBeInstanceOf(OJSValidationError);
  });

  it('accepts an expires_at in the future and converts it to a relative ttl Duration', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
    const { transport, calls } = createCapturingGrpcTransport();

    await transport.request({
      method: 'POST',
      path: '/jobs',
      body: {
        type: 'test.ttl',
        args: [],
        options: { expires_at: '2026-06-01T01:00:00.000Z' },
      },
    });

    const options = calls[0]!.request.options as Record<string, unknown>;
    expect(options.ttl).toEqual({ seconds: '3600', nanos: 0 });
  });
});

describe('GrpcTransport enqueue options: batch (per-job + expanded defaults)', () => {
  it('preserves job order and applies distinct per-job options', async () => {
    const { transport, calls } = createCapturingGrpcTransport();

    const response = (await transport.request({
      method: 'POST',
      path: '/jobs/batch',
      body: {
        jobs: [
          { type: 'a.first', args: [], options: { queue: 'q1', priority: 1 } },
          { type: 'b.second', args: [], options: { queue: 'q2', priority: 2 } },
          { type: 'c.third', args: [] },
        ],
      },
    })) as { body: { jobs: Array<{ type: string }> } };

    expect(response.body.jobs.map((j) => j.type)).toEqual(['a.first', 'b.second', 'c.third']);

    const request = calls[0]!.request;
    const jobs = request.jobs as Array<{ type: unknown; options?: Record<string, unknown> }>;
    expect(jobs.map((j) => j.type)).toEqual(['a.first', 'b.second', 'c.third']);
    expect(jobs[0]!.options).toEqual({ queue: 'q1', priority: 1 });
    expect(jobs[1]!.options).toEqual({ queue: 'q2', priority: 2 });
    expect(jobs[2]!.options).toBeUndefined();

    // Real serialization of the whole batch request.
    const buf = EnqueueBatchRequestType.serialize(request);
    const decoded = EnqueueBatchRequestType.deserialize(buf) as {
      jobs: Array<{ type: string; options: { queue: string; priority: number } }>;
    };
    expect(decoded.jobs.map((j) => j.type)).toEqual(['a.first', 'b.second', 'c.third']);
    expect(decoded.jobs[0]!.options.queue).toBe('q1');
    expect(decoded.jobs[1]!.options.queue).toBe('q2');
  });

  it('merges default_options under each job, with per-job fields overriding whole-field', async () => {
    const { transport, calls } = createCapturingGrpcTransport();

    await transport.request({
      method: 'POST',
      path: '/jobs/batch',
      body: {
        default_options: {
          queue: 'batch-default',
          priority: 5,
          retry: { max_attempts: 3, jitter: true },
          tags: ['batch'],
        },
        jobs: [
          { type: 'a', args: [] },
          { type: 'b', args: [], options: { queue: 'override-queue' } },
          { type: 'c', args: [], options: { retry: { max_attempts: 9 } } },
        ],
      },
    });

    const request = calls[0]!.request;
    const jobs = request.jobs as Array<{ options?: Record<string, unknown> }>;

    expect(request).not.toHaveProperty('defaultOptions');

    // Job "a": pure defaults.
    expect(jobs[0]!.options).toEqual({
      queue: 'batch-default',
      priority: 5,
      retry: { maxAttempts: 3, jitter: true },
      tags: ['batch'],
    });

    // Job "b": queue overridden, everything else defaulted.
    expect(jobs[1]!.options).toEqual({
      queue: 'override-queue',
      priority: 5,
      retry: { maxAttempts: 3, jitter: true },
      tags: ['batch'],
    });

    // Job "c": retry replaced *entirely* by the per-job value (whole-field
    // override, not a deep merge with the default retry sub-fields) —
    // the default's `jitter: true` does not leak into job "c"'s retry.
    expect(jobs[2]!.options).toEqual({
      queue: 'batch-default',
      priority: 5,
      retry: { maxAttempts: 9 },
      tags: ['batch'],
    });

    const buf = EnqueueBatchRequestType.serialize(request);
    const decoded = EnqueueBatchRequestType.deserialize(buf) as {
      defaultOptions?: unknown;
      jobs: Array<{ options: { queue: string; priority: number } }>;
    };
    expect(decoded.defaultOptions == null).toBe(true);
    expect(decoded.jobs[0]!.options).toMatchObject({
      queue: 'batch-default',
      priority: 5,
    });
  });

  it('accepts the camelCase defaultOptions spelling from a raw JS-object caller', async () => {
    const { transport, calls } = createCapturingGrpcTransport();

    await transport.request({
      method: 'POST',
      path: '/jobs/batch',
      body: {
        defaultOptions: { queue: 'camel-default' },
        jobs: [{ type: 'a', args: [] }],
      },
    });

    expect(calls[0]!.request).not.toHaveProperty('defaultOptions');
    const jobs = calls[0]!.request.jobs as Array<{ options?: Record<string, unknown> }>;
    expect(jobs[0]!.options).toEqual({ queue: 'camel-default' });
  });

  it('lets per-job envelope meta override default_options.meta without mutating either input', async () => {
    const { transport, calls } = createCapturingGrpcTransport();
    const defaultOptions = { meta: { tenant_id: 'default' } };
    const jobMeta = { tenant_id: 'per-job' };

    await transport.request({
      method: 'POST',
      path: '/jobs/batch',
      body: {
        default_options: defaultOptions,
        jobs: [{ type: 'a', args: [], meta: jobMeta }],
      },
    });

    const request = calls[0]!.request as {
      jobs: Array<{ options: { meta: { fields: Record<string, unknown> } } }>;
    };
    expect(request).not.toHaveProperty('defaultOptions');
    expect(request.jobs[0]!.options.meta.fields.tenant_id).toEqual({
      stringValue: 'per-job',
    });
    expect(defaultOptions).toEqual({ meta: { tenant_id: 'default' } });
    expect(jobMeta).toEqual({ tenant_id: 'per-job' });
  });

  it('preserves explicit 0/false/empty overrides after serialization and backend-style merge', async () => {
    const { transport, calls } = createCapturingGrpcTransport();

    await transport.request({
      method: 'POST',
      path: '/jobs/batch',
      body: {
        default_options: {
          priority: 7,
          retry: {
            max_attempts: 5,
            jitter: true,
            non_retryable_errors: ['fatal.*'],
          },
          tags: ['default-tag'],
        },
        jobs: [
          {
            type: 'explicit.defaults',
            args: [],
            options: {
              priority: 0,
              retry: {
                max_attempts: 0,
                jitter: false,
                non_retryable_errors: [],
              },
              tags: [],
            },
          },
        ],
      },
    });

    const request = calls[0]!.request;
    expect(request).not.toHaveProperty('defaultOptions');
    expect((request.jobs as Array<{ options: unknown }>)[0]!.options).toEqual({
      priority: 0,
      retry: {
        maxAttempts: 0,
        jitter: false,
        nonRetryableErrors: [],
      },
      tags: [],
    });

    const decoded = EnqueueBatchRequestType.deserialize(
      EnqueueBatchRequestType.serialize(request),
    ) as {
      defaultOptions?: Record<string, unknown> | null;
      jobs: Array<{
        options: {
          priority: number;
          retry: {
            maxAttempts: number;
            jitter: boolean;
            nonRetryableErrors: string[];
          };
          tags: string[];
        };
      }>;
    };
    expect(decoded.defaultOptions == null).toBe(true);

    // Mirrors the backend's default-merge phase: it runs only when the
    // protobuf default_options message is present. Because the SDK omits
    // that message after expansion, proto3-default-valued overrides cannot
    // be mistaken for absent values and overwritten a second time.
    const backendMerged = decoded.defaultOptions
      ? decoded.jobs.map((job) => ({
          ...decoded.defaultOptions,
          ...job.options,
        }))
      : decoded.jobs.map((job) => job.options);
    expect(backendMerged[0]).toMatchObject({
      priority: 0,
      retry: {
        maxAttempts: 0,
        jitter: false,
        nonRetryableErrors: [],
      },
      tags: [],
    });
  });

  it('does not mutate the caller-supplied default_options or per-job options objects', async () => {
    const { transport } = createCapturingGrpcTransport();

    const defaultOptions = { queue: 'batch-default', retry: { max_attempts: 3 } };
    const jobOptions = { priority: 2 };
    const defaultSnapshot = snapshot(defaultOptions);
    const jobSnapshot = snapshot(jobOptions);

    await transport.request({
      method: 'POST',
      path: '/jobs/batch',
      body: {
        default_options: defaultOptions,
        jobs: [{ type: 'a', args: [], options: jobOptions }],
      },
    });

    expect(defaultOptions).toEqual(defaultSnapshot);
    expect(jobOptions).toEqual(jobSnapshot);
  });

  it('rejects a malformed default_options that is not an object', async () => {
    const { transport, calls } = createCapturingGrpcTransport();

    await expect(
      transport.request({
        method: 'POST',
        path: '/jobs/batch',
        body: { default_options: 'nope', jobs: [{ type: 'a', args: [] }] },
      }),
    ).rejects.toBeInstanceOf(OJSValidationError);
    expect(calls).toHaveLength(0);
  });

  it('rejects a malformed default_options even when every job overrides every one of its fields', async () => {
    const { transport } = createCapturingGrpcTransport();

    await expect(
      transport.request({
        method: 'POST',
        path: '/jobs/batch',
        body: {
          default_options: { priority: 'not-a-number' },
          jobs: [{ type: 'a', args: [], options: { priority: 1 } }],
        },
      }),
    ).rejects.toBeInstanceOf(OJSValidationError);
  });

  it('rejects an unsupported default_options field before calling the client', async () => {
    const { transport, calls } = createCapturingGrpcTransport();

    await expect(
      transport.request({
        method: 'POST',
        path: '/jobs/batch',
        body: {
          default_options: { queue: 'default', unknown: true },
          jobs: [{ type: 'a', args: [] }],
        },
      }),
    ).rejects.toBeInstanceOf(OJSValidationError);
    expect(calls).toHaveLength(0);
  });

  it('rejects an envelope-level schema on an individual batch job entry', async () => {
    const { transport, calls } = createCapturingGrpcTransport();

    await expect(
      transport.request({
        method: 'POST',
        path: '/jobs/batch',
        body: {
          jobs: [
            { type: 'a', args: [] },
            { type: 'b', args: [], schema: 'urn:ojs:schema:test:v1' },
          ],
        },
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(OJSError);
      expect((err as OJSError).code).toBe('unimplemented');
      return true;
    });
    expect(calls).toHaveLength(0);
  });

  it('threads each job entry envelope meta into that job entry options.meta', async () => {
    const { transport, calls } = createCapturingGrpcTransport();

    await transport.request({
      method: 'POST',
      path: '/jobs/batch',
      body: {
        jobs: [
          { type: 'a', args: [], meta: { tenant_id: 'acme' } },
          { type: 'b', args: [], meta: { tenant_id: 'globex' } },
        ],
      },
    });

    const jobs = calls[0]!.request.jobs as Array<{ options?: { meta?: { fields: Record<string, unknown> } } }>;
    // toProtoValue() (this file's existing google.protobuf.Value encoder)
    // sets only the active oneof member key on encode; the synthetic
    // `kind` discriminator is something protobufjs adds on *decode*
    // (oneofs:true), not something the encode side needs to set itself.
    expect(jobs[0]!.options?.meta?.fields.tenant_id).toEqual({ stringValue: 'acme' });
    expect(jobs[1]!.options?.meta?.fields.tenant_id).toEqual({ stringValue: 'globex' });

    // Real per-entry serialization.
    for (const job of jobs) {
      const buf = BatchJobEntryType.serialize({ type: 'x', args: [], options: job.options });
      expect(() => BatchJobEntryType.deserialize(buf)).not.toThrow();
    }
  });
});

/**
 * Focused tests for `src/transport/grpc.ts`'s three gRPC-binding
 * conversions closed in this pass:
 *
 *   1. ACK result (`grpcAck`): `AckRequest.result` is a
 *      `google.protobuf.Struct`, so an object result MUST be encoded as
 *      `{ fields: { ... } }` via `toProtoStruct` before the RPC; an
 *      omitted/`null` result omits the field; a bare scalar/array is
 *      rejected with a non-retryable validation error.
 *   2. NACK error mapping (`grpcNack`): all public JobError fields map to
 *      their proto equivalents, timestamps/Struct details are validated
 *      before the RPC, and response timestamps are normalized.
 *   3. Workflow mapping (`grpcCreateWorkflow`): the nested public
 *      chain/group wire shape (including nested group-in-chain and
 *      chain-in-group) is flattened into a proto `CreateWorkflowRequest`
 *      WorkflowStep DAG with deterministic stable step IDs, correct
 *      `dependsOn`, converted `args`, and shared enqueue-options
 *      conversion (including envelope `meta`); a batch is rejected with a
 *      non-retryable `unimplemented` error before the RPC.
 *   4. Cron (`grpcRegisterCron`/`grpcListCron`): registration maps the
 *      definition's `options` + envelope `meta` into
 *      `RegisterCronRequest.options`; listing maps `args`/`options`/
 *      `next_run_at`/`last_run_at` back out via `fromProtoEnqueueOptions`.
 *
 * As in `tests/transport-grpc-enqueue-options.test.ts`, two complementary
 * techniques are used: a capturing fake client records the *exact* request
 * `GrpcTransport` builds, and every captured request is additionally
 * round-tripped through a *real* `@grpc/proto-loader` message type loaded
 * from the field-for-field fixture proto — strictly stronger than a plain
 * JSON structural comparison.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as protoLoader from '@grpc/proto-loader';
import { GrpcTransport, type GrpcTransportConfig, type GrpcProtocolWarning } from '../src/transport/grpc.js';
import { OJSError, OJSValidationError } from '../src/errors.js';
import { chain, group, batch, toWireWorkflow } from '../src/workflow.js';
import { OJSClient } from '../src/client.js';
import type { JobSpec } from '../src/job.js';

const FIXTURE_PROTO = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/proto/ojs/v1/enqueue_options.proto',
);

let AckRequestType: protoLoader.AnyDefinition;
let NackRequestType: protoLoader.AnyDefinition;
let NackResponseType: protoLoader.AnyDefinition;
let SaveCheckpointRequestType: protoLoader.AnyDefinition;
let CreateWorkflowRequestType: protoLoader.AnyDefinition;
let CreateWorkflowResponseType: protoLoader.AnyDefinition;
let GetWorkflowResponseType: protoLoader.AnyDefinition;
let RegisterCronRequestType: protoLoader.AnyDefinition;
let ListCronResponseType: protoLoader.AnyDefinition;
let CronEntryType: protoLoader.AnyDefinition;
let EnqueueOptionsType: protoLoader.AnyDefinition;

beforeAll(() => {
  const pkgDef = protoLoader.loadSync(FIXTURE_PROTO, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const types = pkgDef as Record<string, protoLoader.AnyDefinition>;
  AckRequestType = types['ojs.v1.AckRequest']!;
  NackRequestType = types['ojs.v1.NackRequest']!;
  NackResponseType = types['ojs.v1.NackResponse']!;
  SaveCheckpointRequestType = types['ojs.v1.SaveCheckpointRequest']!;
  CreateWorkflowRequestType = types['ojs.v1.CreateWorkflowRequest']!;
  CreateWorkflowResponseType = types['ojs.v1.CreateWorkflowResponse']!;
  GetWorkflowResponseType = types['ojs.v1.GetWorkflowResponse']!;
  RegisterCronRequestType = types['ojs.v1.RegisterCronRequest']!;
  ListCronResponseType = types['ojs.v1.ListCronResponse']!;
  CronEntryType = types['ojs.v1.CronEntry']!;
  EnqueueOptionsType = types['ojs.v1.EnqueueOptions']!;
});

interface CapturedCall {
  method: string;
  request: Record<string, unknown>;
}

/**
 * Wires a `GrpcTransport` the same way the enqueue-options test's
 * `createCapturingGrpcTransport` does — bypassing lazy init and
 * overriding the private `call()` — recording each request and returning
 * a minimal valid response for the ack/createWorkflow/registerCron/
 * listCron methods. `listCronEntries` seeds the entries `listCron`
 * returns, so a listing test can round-trip real proto-decoded entries.
 */
function createCapturingGrpcTransport(
  listCronEntries: unknown[] = [],
  configOverrides: Partial<GrpcTransportConfig> = {},
): {
  transport: GrpcTransport;
  calls: CapturedCall[];
} {
  const transport = new GrpcTransport({ url: 'localhost:9090', ...configOverrides });
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
    calls.push({ method, request: request as Record<string, unknown> });
    switch (method) {
      case 'ack':
        return { acknowledged: true };
      case 'nack':
        return NackResponseType.deserialize(
          NackResponseType.serialize({
            state: 'JOB_STATE_RETRYABLE',
            nextAttemptAt: { seconds: '1704067230', nanos: 250_000_000 },
          }),
        );
      case 'saveCheckpoint':
        return { sequence: 1 };
      case 'createWorkflow':
        return {
          workflow: {
            id: 'wf-1',
            name: (request as Record<string, unknown>).name ?? '',
            state: 'WORKFLOW_STATE_RUNNING',
            steps: [],
          },
        };
      case 'registerCron':
        return { name: (request as Record<string, unknown>).name };
      case 'listCron':
        return { entries: listCronEntries };
      default:
        throw new Error(`unexpected method '${method}'`);
    }
  };

  return { transport, calls };
}

function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ===========================================================================
// Finding 1: ACK result (google.protobuf.Struct)
// ===========================================================================

describe('GrpcTransport ack result: Struct conversion', () => {
  async function ack(result: unknown): Promise<CapturedCall[]> {
    const { transport, calls } = createCapturingGrpcTransport();
    await transport.request({
      method: 'POST',
      path: '/workers/ack',
      body: result === undefined ? { job_id: 'job-1' } : { job_id: 'job-1', result },
    });
    return calls;
  }

  it('encodes an empty object result as an empty Struct and round-trips it', async () => {
    const calls = await ack({});
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request).toEqual({ jobId: 'job-1', result: { fields: {} } });

    const buf = AckRequestType.serialize(calls[0]!.request);
    const decoded = AckRequestType.deserialize(buf) as { jobId: string; result: { fields: Record<string, unknown> } };
    expect(decoded.jobId).toBe('job-1');
    expect(decoded.result).toEqual({ fields: {} });
  });

  it('encodes a nested object result as a Struct of Values and round-trips it', async () => {
    const calls = await ack({
      status: 'ok',
      counts: { processed: 3, failed: 0 },
      ids: ['a', 'b'],
    });
    const result = calls[0]!.request.result as { fields: Record<string, unknown> };
    expect(result).toEqual({
      fields: {
        status: { stringValue: 'ok' },
        counts: {
          structValue: {
            fields: {
              processed: { numberValue: 3 },
              failed: { numberValue: 0 },
            },
          },
        },
        ids: { listValue: { values: [{ stringValue: 'a' }, { stringValue: 'b' }] } },
      },
    });

    // Actual proto-loader round-trip through the real AckRequest message.
    const buf = AckRequestType.serialize(calls[0]!.request);
    const decoded = AckRequestType.deserialize(buf) as {
      result: { fields: Record<string, { kind: string; [k: string]: unknown }> };
    };
    const f = decoded.result.fields;
    expect(f.status).toMatchObject({ kind: 'stringValue', stringValue: 'ok' });
    expect(f.counts).toMatchObject({ kind: 'structValue' });
    expect(f.ids).toMatchObject({ kind: 'listValue' });
  });

  it('preserves numeric, boolean, empty-string and null values faithfully through the wire', async () => {
    const calls = await ack({ zero: 0, flag: false, empty: '', nothing: null, nested: { z: 0 } });
    const buf = AckRequestType.serialize(calls[0]!.request);
    const decoded = AckRequestType.deserialize(buf) as {
      result: { fields: Record<string, { kind: string; [k: string]: unknown }> };
    };
    const f = decoded.result.fields;
    expect(f.zero).toMatchObject({ kind: 'numberValue', numberValue: 0 });
    expect(f.flag).toMatchObject({ kind: 'boolValue', boolValue: false });
    expect(f.empty).toMatchObject({ kind: 'stringValue', stringValue: '' });
    expect(f.nothing).toMatchObject({ kind: 'nullValue' });
    expect(f.nested).toMatchObject({ kind: 'structValue' });
  });

  // Finding: Protobuf encoding maps must use a null-prototype (or
  // defineProperty-based) accumulator for every dynamic Struct/map field
  // builder, so a malicious/unusual key coming from a real JSON payload
  // (JSON.parse gives `__proto__`/`constructor`/`prototype` real *own*
  // properties — see json-parse's spec-defined [[DefineOwnProperty]]
  // semantics) is faithfully encoded as data instead of silently
  // vanishing (or corrupting the accumulator's own prototype chain) via
  // `Object.prototype`'s `__proto__` accessor.
  it('preserves __proto__/constructor/prototype as real Struct field keys through actual proto-loader serialization (Finding: prototype-pollution-safe encoding)', async () => {
    const maliciousResult = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":"not-a-function","prototype":42,"safe":"ok"}',
    ) as Record<string, unknown>;
    // Confirm the test fixture itself really does carry these as own,
    // enumerable properties (i.e. this is testing the real vulnerability
    // class, not something JSON.parse already neutralized).
    expect(Object.prototype.hasOwnProperty.call(maliciousResult, '__proto__')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(maliciousResult, 'constructor')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(maliciousResult, 'prototype')).toBe(true);
    expect(Object.getPrototypeOf(maliciousResult)).toBe(Object.prototype); // not polluted itself

    const calls = await ack(maliciousResult);
    const requestFields = (calls[0]!.request.result as { fields: Record<string, unknown> }).fields;

    // The accumulator built by `toProtoStruct`/`toProtoValue` must itself
    // remain unpolluted (still Object.prototype's own methods absent, or
    // at minimum not silently reassigned to attacker data) ...
    expect(Object.getPrototypeOf(requestFields)).not.toEqual({ polluted: true });
    // ... and, critically, every one of the three dangerous-looking keys
    // must have actually been encoded as real Struct data, not dropped.
    expect(Object.prototype.hasOwnProperty.call(requestFields, '__proto__')).toBe(true);
    expect(requestFields.__proto__).toEqual({
      structValue: { fields: { polluted: { boolValue: true } } },
    });
    expect(requestFields.constructor).toEqual({ stringValue: 'not-a-function' });
    expect(requestFields.prototype).toEqual({ numberValue: 42 });
    expect(requestFields.safe).toEqual({ stringValue: 'ok' });

    // Strictly stronger: round-trip the exact captured request through a
    // *real* @grpc/proto-loader AckRequest message, proving the malicious
    // keys survive actual wire serialization/deserialization intact.
    const buf = AckRequestType.serialize(calls[0]!.request);
    const decoded = AckRequestType.deserialize(buf) as {
      result: { fields: Record<string, { kind: string; [k: string]: unknown }> };
    };
    const f = decoded.result.fields;
    expect(f.__proto__).toMatchObject({ kind: 'structValue' });
    expect((f.__proto__.structValue as { fields: Record<string, unknown> }).fields.polluted).toMatchObject({
      kind: 'boolValue',
      boolValue: true,
    });
    expect(f.constructor).toMatchObject({ kind: 'stringValue', stringValue: 'not-a-function' });
    expect(f.prototype).toMatchObject({ kind: 'numberValue', numberValue: 42 });
    expect(f.safe).toMatchObject({ kind: 'stringValue', stringValue: 'ok' });

    // The global Object.prototype itself must never have been touched.
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('omits the result field entirely when result is undefined', async () => {
    const calls = await ack(undefined);
    expect(calls[0]!.request).toEqual({ jobId: 'job-1' });
    expect('result' in calls[0]!.request).toBe(false);
  });

  it('omits the result field entirely when result is null', async () => {
    const calls = await ack(null);
    expect(calls[0]!.request).toEqual({ jobId: 'job-1' });
    expect('result' in calls[0]!.request).toBe(false);
  });

  // AckRequest.result is a google.protobuf.Struct, which can only model a
  // JSON object/map. A bare scalar/array/other non-object result cannot be
  // represented on the wire at all — but the handler has ALREADY completed
  // successfully by the time ack() runs, so this transport must not reject
  // the ack (which would leave a successfully-executed job unacknowledged,
  // stranding it for redelivery) nor silently drop the completion. Instead
  // it acks WITHOUT the result and reports the limitation exactly once via
  // `onWarning` (defaulting to `console.warn`).
  it('acknowledges without a result and warns exactly once for a bare string result — never rejects a completed handler', async () => {
    const warnings: GrpcProtocolWarning[] = [];
    const { transport, calls } = createCapturingGrpcTransport([], {
      onWarning: (w) => warnings.push(w),
    });
    const response = await transport.request({
      method: 'POST',
      path: '/workers/ack',
      body: { job_id: 'job-1', result: 'done' },
    });
    expect(response.body).toEqual({ acknowledged: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request).toEqual({ jobId: 'job-1' });
    expect('result' in calls[0]!.request).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe('ack_result_unrepresentable');
    expect(warnings[0]!.originalResultType).toBe('string');
    expect(warnings[0]!.message).toMatch(/AckRequest\.result/);
  });

  it('acknowledges without a result and warns exactly once for an array result', async () => {
    const warnings: GrpcProtocolWarning[] = [];
    const { transport, calls } = createCapturingGrpcTransport([], {
      onWarning: (w) => warnings.push(w),
    });
    const response = await transport.request({
      method: 'POST',
      path: '/workers/ack',
      body: { job_id: 'job-1', result: [1, 2, 3] },
    });
    expect(response.body).toEqual({ acknowledged: true });
    expect('result' in calls[0]!.request).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.originalResultType).toBe('array');
  });

  it('acknowledges without a result and warns exactly once for a numeric result, defaulting to console.warn when onWarning is not configured', async () => {
    const { transport, calls } = createCapturingGrpcTransport();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const response = await transport.request({
        method: 'POST',
        path: '/workers/ack',
        body: { job_id: 'job-1', result: 42 },
      });
      expect(response.body).toEqual({ acknowledged: true });
      expect('result' in calls[0]!.request).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toMatchObject({
        code: 'ack_result_unrepresentable',
        originalResultType: 'number',
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('never warns for an omitted or null result', async () => {
    const warnings: GrpcProtocolWarning[] = [];
    const { transport } = createCapturingGrpcTransport([], {
      onWarning: (w) => warnings.push(w),
    });
    await transport.request({ method: 'POST', path: '/workers/ack', body: { job_id: 'job-1' } });
    await transport.request({
      method: 'POST',
      path: '/workers/ack',
      body: { job_id: 'job-1', result: null },
    });
    expect(warnings).toHaveLength(0);
  });

  it('never warns for a valid object result', async () => {
    const warnings: GrpcProtocolWarning[] = [];
    const { transport } = createCapturingGrpcTransport([], {
      onWarning: (w) => warnings.push(w),
    });
    await transport.request({
      method: 'POST',
      path: '/workers/ack',
      body: { job_id: 'job-1', result: { ok: true } },
    });
    expect(warnings).toHaveLength(0);
  });
});

describe('GrpcTransport checkpoint state: Struct conversion', () => {
  it('normalizes Date and undefined values with JSON semantics before actual serialization', async () => {
    const { transport, calls } = createCapturingGrpcTransport();

    await transport.request({
      method: 'POST',
      path: '/jobs/job-checkpoint/checkpoint',
      body: {
        state: {
          savedAt: new Date('2026-08-08T12:00:00.123Z'),
          omitted: undefined,
          nested: { kept: true, omitted: undefined },
          values: [1, undefined, , 4],
        },
      },
    });

    const requestState = calls[0]!.request.state as {
      fields: Record<string, unknown>;
    };
    expect(requestState.fields).toEqual({
      savedAt: { stringValue: '2026-08-08T12:00:00.123Z' },
      nested: {
        structValue: {
          fields: { kept: { boolValue: true } },
        },
      },
      values: {
        listValue: {
          values: [
            { numberValue: 1 },
            { nullValue: 0 },
            { nullValue: 0 },
            { numberValue: 4 },
          ],
        },
      },
    });
    expect(Object.hasOwn(requestState.fields, 'omitted')).toBe(false);

    const decoded = SaveCheckpointRequestType.deserialize(
      SaveCheckpointRequestType.serialize(calls[0]!.request),
    ) as {
      state: {
        fields: Record<
          string,
          {
            kind: string;
            stringValue?: string;
            structValue?: { fields: Record<string, unknown> };
            listValue?: { values: { kind: string; nullValue?: string }[] };
          }
        >;
      };
    };
    expect(decoded.state.fields.savedAt).toMatchObject({
      kind: 'stringValue',
      stringValue: '2026-08-08T12:00:00.123Z',
    });
    expect(decoded.state.fields.nested).toMatchObject({ kind: 'structValue' });
    expect(decoded.state.fields.values!.listValue!.values.map((value) => value.kind))
      .toEqual(['numberValue', 'nullValue', 'nullValue', 'numberValue']);
  });

  it('preserves special own keys and nested values through actual proto-loader serialization', async () => {
    const state = JSON.parse(
      '{"__proto__":{"__proto__":"nested","constructor":"inner"},"constructor":"outer","prototype":[{"prototype":true}]}',
    ) as Record<string, unknown>;
    const { transport, calls } = createCapturingGrpcTransport();

    await transport.request({
      method: 'POST',
      path: '/jobs/job-checkpoint/checkpoint',
      body: { state },
    });

    const decoded = SaveCheckpointRequestType.deserialize(
      SaveCheckpointRequestType.serialize(calls[0]!.request),
    ) as {
      state: {
        fields: Record<
          string,
          {
            kind: string;
            stringValue?: string;
            structValue?: { fields: Record<string, unknown> };
            listValue?: { values: Array<Record<string, unknown>> };
          }
        >;
      };
    };
    const fields = decoded.state.fields;

    expect(Object.hasOwn(fields, '__proto__')).toBe(true);
    expect(fields.__proto__).toMatchObject({ kind: 'structValue' });
    const nestedFields = fields.__proto__!.structValue!.fields;
    expect(Object.hasOwn(nestedFields, '__proto__')).toBe(true);
    expect(nestedFields.__proto__).toMatchObject({
      kind: 'stringValue',
      stringValue: 'nested',
    });
    expect(nestedFields.constructor).toMatchObject({
      kind: 'stringValue',
      stringValue: 'inner',
    });
    expect(fields.constructor).toMatchObject({
      kind: 'stringValue',
      stringValue: 'outer',
    });
    expect(fields.prototype).toMatchObject({ kind: 'listValue' });
    expect(fields.prototype!.listValue!.values[0]).toMatchObject({
      kind: 'structValue',
      structValue: {
        fields: {
          prototype: { kind: 'boolValue', boolValue: true },
        },
      },
    });
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each([
    ['cycle', () => {
      const state: Record<string, unknown> = {};
      state.self = state;
      return state;
    }, /cycles/],
    ['NaN', () => ({ value: Number.NaN }), /non-finite/],
    ['positive infinity', () => ({ value: Number.POSITIVE_INFINITY }), /non-finite/],
    ['negative infinity', () => ({ value: Number.NEGATIVE_INFINITY }), /non-finite/],
    ['BigInt', () => ({ value: BigInt(1) }), /BigInt/],
    ['function', () => ({ value: () => 1 }), /unsupported function/],
    ['symbol', () => ({ value: Symbol('value') }), /unsupported symbol/],
  ])('rejects invalid checkpoint JSON containing %s before the RPC', async (_label, createState, message) => {
    const { transport, calls } = createCapturingGrpcTransport();

    await expect(transport.request({
      method: 'POST',
      path: '/jobs/job-checkpoint/checkpoint',
      body: { state: createState() },
    })).rejects.toMatchObject({
      name: 'OJSValidationError',
      retryable: false,
      message: expect.stringMatching(message),
    });
    expect(calls).toHaveLength(0);
  });
});

// ===========================================================================
// Finding 2: NACK error mapping
// ===========================================================================

describe('GrpcTransport nack: JobError conversion', () => {
  async function nack(error: Record<string, unknown>): Promise<{
    calls: CapturedCall[];
    body: unknown;
  }> {
    const { transport, calls } = createCapturingGrpcTransport();
    const response = await transport.request({
      method: 'POST',
      path: '/workers/nack',
      body: { job_id: 'job-1', error },
    });
    return { calls, body: response.body };
  }

  it('maps every JobError field and serializes Timestamp/Struct values through the real proto', async () => {
    const { calls } = await nack({
      code: 'upstream_timeout',
      message: 'upstream did not respond',
      retryable: true,
      attempt: 3,
      occurred_at: '2024-01-01T00:00:00.123456789Z',
      backtrace: [
        'Error: upstream did not respond',
        '    at handler.ts:10:5',
      ],
      details: {
        service: 'payments',
        status: 504,
        nested: { circuit_open: false },
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.request).toEqual({
      jobId: 'job-1',
      error: {
        code: 'upstream_timeout',
        message: 'upstream did not respond',
        retryable: true,
        attempt: 3,
        occurredAt: { seconds: '1704067200', nanos: 123_456_789 },
        backtrace: 'Error: upstream did not respond\n    at handler.ts:10:5',
        details: {
          fields: {
            service: { stringValue: 'payments' },
            status: { numberValue: 504 },
            nested: {
              structValue: {
                fields: {
                  circuit_open: { boolValue: false },
                },
              },
            },
          },
        },
      },
    });

    const decoded = NackRequestType.deserialize(
      NackRequestType.serialize(calls[0]!.request),
    ) as {
      jobId: string;
      error: {
        code: string;
        message: string;
        retryable: boolean;
        attempt: number;
        occurredAt: { seconds: string; nanos: number };
        backtrace: string;
        details: { fields: Record<string, { kind: string }> };
      };
    };
    expect(decoded.jobId).toBe('job-1');
    expect(decoded.error).toMatchObject({
      code: 'upstream_timeout',
      message: 'upstream did not respond',
      retryable: true,
      attempt: 3,
      occurredAt: { seconds: '1704067200', nanos: 123_456_789 },
      backtrace: 'Error: upstream did not respond\n    at handler.ts:10:5',
    });
    expect(decoded.error.details.fields.service).toMatchObject({ kind: 'stringValue' });
    expect(decoded.error.details.fields.status).toMatchObject({ kind: 'numberValue' });
    expect(decoded.error.details.fields.nested).toMatchObject({ kind: 'structValue' });
  });

  it('preserves special own keys in error details through actual proto-loader serialization', async () => {
    const details = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":"detail-constructor","prototype":{"__proto__":"nested"}}',
    ) as Record<string, unknown>;
    const { calls } = await nack({
      code: 'handler_error',
      message: 'failed',
      details,
    });

    const decoded = NackRequestType.deserialize(
      NackRequestType.serialize(calls[0]!.request),
    ) as {
      error: {
        details: {
          fields: Record<
            string,
            {
              kind: string;
              stringValue?: string;
              structValue?: { fields: Record<string, unknown> };
            }
          >;
        };
      };
    };
    const fields = decoded.error.details.fields;

    expect(Object.hasOwn(fields, '__proto__')).toBe(true);
    expect(fields.__proto__).toMatchObject({ kind: 'structValue' });
    expect(fields.constructor).toMatchObject({
      kind: 'stringValue',
      stringValue: 'detail-constructor',
    });
    expect(fields.prototype).toMatchObject({ kind: 'structValue' });
    expect(
      Object.hasOwn(fields.prototype!.structValue!.fields, '__proto__'),
    ).toBe(true);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('defaults an omitted retryable flag to true despite proto3 scalar presence limits', async () => {
    const { calls } = await nack({ code: 'handler_error', message: 'failed' });

    expect(calls[0]!.request).toEqual({
      jobId: 'job-1',
      error: {
        code: 'handler_error',
        message: 'failed',
        retryable: true,
        attempt: 0,
        backtrace: '',
      },
    });

    const decoded = NackRequestType.deserialize(
      NackRequestType.serialize(calls[0]!.request),
    ) as { error: { retryable: boolean; attempt: number; backtrace: string } };
    expect(decoded.error).toMatchObject({
      retryable: true,
      attempt: 0,
      backtrace: '',
    });
  });

  it('preserves an explicit zero attempt in the captured and serialized request', async () => {
    const { calls } = await nack({
      code: 'first_attempt',
      message: 'failed immediately',
      attempt: 0,
    });

    expect((calls[0]!.request.error as Record<string, unknown>).attempt).toBe(0);
    const decoded = NackRequestType.deserialize(
      NackRequestType.serialize(calls[0]!.request),
    ) as { error: { attempt: number } };
    expect(decoded.error.attempt).toBe(0);
  });

  it('preserves an explicit retryable false instead of replacing it with the default', async () => {
    const { calls } = await nack({
      code: 'validation_failed',
      message: 'do not retry',
      retryable: false,
    });

    expect((calls[0]!.request.error as Record<string, unknown>).retryable).toBe(false);
    const decoded = NackRequestType.deserialize(
      NackRequestType.serialize(calls[0]!.request),
    ) as { error: { retryable: boolean } };
    expect(decoded.error.retryable).toBe(false);
  });

  it('rejects an invalid occurred_at timestamp before invoking the RPC', async () => {
    const { transport, calls } = createCapturingGrpcTransport();

    await expect(
      transport.request({
        method: 'POST',
        path: '/workers/nack',
        body: {
          job_id: 'job-1',
          error: {
            code: 'handler_error',
            message: 'failed',
            occurred_at: 'not-a-timestamp',
          },
        },
      }),
    ).rejects.toBeInstanceOf(OJSValidationError);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['a scalar', 'not-an-object'],
    ['an array', ['not', 'an', 'object']],
  ])('rejects details supplied as %s before invoking the RPC', async (_label, details) => {
    const { transport, calls } = createCapturingGrpcTransport();

    await expect(
      transport.request({
        method: 'POST',
        path: '/workers/nack',
        body: {
          job_id: 'job-1',
          error: { code: 'handler_error', message: 'failed', details },
        },
      }),
    ).rejects.toBeInstanceOf(OJSValidationError);
    expect(calls).toHaveLength(0);
  });

  it('returns next_attempt_at as an RFC 3339 string, never the raw proto object', async () => {
    const { body } = await nack({ code: 'handler_error', message: 'failed' });

    expect(body).toEqual({
      state: 'retryable',
      next_attempt_at: '2024-01-01T00:00:30.250Z',
    });
    expect(typeof (body as { next_attempt_at: unknown }).next_attempt_at).toBe('string');
  });
});

// ===========================================================================
// Finding 3: Workflow mapping (nested chain/group -> WorkflowStep DAG)
// ===========================================================================

function job(type: string, args?: unknown[], options?: JobSpec['options']): JobSpec {
  return { type, args: args as JobSpec['args'], options } as JobSpec;
}

async function createWorkflow(
  transport: GrpcTransport,
  wire: Record<string, unknown>,
): Promise<void> {
  await transport.request({ method: 'POST', path: '/workflows', body: wire });
}

interface CapturedStep {
  id: string;
  type: string;
  args: unknown[];
  dependsOn: string[];
  options?: Record<string, unknown>;
}

describe('OJSClient.workflow()/getWorkflow() over GrpcTransport: response envelope', () => {
  // Regression coverage for Finding 2's client-side half: GrpcTransport's
  // grpcCreateWorkflow/grpcGetWorkflow both return `{ workflow: {...} }`
  // (matching the HTTP binding's spec envelope) — OJSClient must unwrap
  // that envelope, not hand the wrapper itself back as WorkflowStatus.
  it('workflow() returns the unwrapped WorkflowStatus, not the { workflow } envelope', async () => {
    const { transport } = createCapturingGrpcTransport();
    const client = new OJSClient({ url: 'unused', transport });

    const status = await client.workflow(chain(job('a', [])));

    expect(status.id).toBe('wf-1');
    expect(status.state).toBe('running');
    expect((status as unknown as { workflow?: unknown }).workflow).toBeUndefined();
  });

  it('getWorkflow() returns the unwrapped WorkflowStatus', async () => {
    const transport = new GrpcTransport({ url: 'localhost:9090' });
    (transport as unknown as { client: unknown }).client = { close: () => {} };
    (transport as unknown as { initPromise: Promise<void> }).initPromise = Promise.resolve();
    (transport as unknown as { grpcModule: unknown }).grpcModule = {
      Metadata: class {
        set(): void {}
      },
      credentials: { createInsecure: () => ({}) },
      loadPackageDefinition: () => ({}),
    };
    (transport as unknown as {
      call: (method: string, request: unknown) => Promise<unknown>;
    }).call = async (method: string): Promise<unknown> => {
      expect(method).toBe('getWorkflow');
      return { workflow: { id: 'wf-2', name: '', state: 'WORKFLOW_STATE_COMPLETED', steps: [] } };
    };
    // Seed the creation-time type cache so this empty response can still
    // report an authoritative type (the gRPC Workflow proto carries none).
    (transport as unknown as {
      workflowTypeCache: Map<string, 'chain' | 'group'>;
    }).workflowTypeCache.set('wf-2', 'chain');

    const client = new OJSClient({ url: 'unused', transport });
    const status = await client.getWorkflow('wf-2');
    expect(status.type).toBe('chain');
    expect(status.id).toBe('wf-2');
    expect(status.state).toBe('completed');
    expect((status as unknown as { workflow?: unknown }).workflow).toBeUndefined();
  });
});

describe('GrpcTransport workflow response normalization', () => {
  function runtimeTransport(
    method: 'createWorkflow' | 'getWorkflow',
    responseType: protoLoader.AnyDefinition,
    response: Record<string, unknown>,
  ): GrpcTransport {
    const transport = new GrpcTransport({ url: 'localhost:9090' });
    (transport as unknown as { client: unknown }).client = { close: () => {} };
    (transport as unknown as { initPromise: Promise<void> }).initPromise = Promise.resolve();
    (transport as unknown as { grpcModule: unknown }).grpcModule = {
      Metadata: class {
        set(): void {}
      },
      credentials: { createInsecure: () => ({}) },
      loadPackageDefinition: () => ({}),
    };
    (transport as unknown as {
      call: (calledMethod: string) => Promise<unknown>;
    }).call = async (calledMethod: string): Promise<unknown> => {
      expect(calledMethod).toBe(method);
      return responseType.deserialize(responseType.serialize(response));
    };
    return transport;
  }

  it('normalizes create responses and retains the original top-level type hint', async () => {
    const transport = runtimeTransport('createWorkflow', CreateWorkflowResponseType, {
      workflow: {
        id: 'wf-create',
        name: 'parallel-pipelines',
        state: 'WORKFLOW_STATE_RUNNING',
        createdAt: { seconds: '1704067200', nanos: 123_000_000 },
        steps: [
          {
            id: 'step-0-0',
            index: 0,
            type: 'extract',
            state: 'WORKFLOW_STEP_STATE_COMPLETED',
            jobId: 'job-1',
            dependsOn: [],
          },
          {
            id: 'step-0-1',
            index: 1,
            type: 'load',
            state: 'WORKFLOW_STEP_STATE_ACTIVE',
            jobId: 'job-2',
            dependsOn: ['step-0-0'],
          },
          {
            id: 'step-1',
            type: 'notify',
            state: 'WORKFLOW_STEP_STATE_FAILED',
            jobId: '',
            dependsOn: [],
          },
        ],
      },
    });
    const client = new OJSClient({ url: 'unused', transport });

    const status = await client.workflow(
      group(
        chain(job('extract'), job('load')),
        job('notify'),
      ),
    );

    expect(status).toEqual({
      id: 'wf-create',
      name: 'parallel-pipelines',
      type: 'group',
      state: 'running',
      metadata: {
        created_at: '2024-01-01T00:00:00.123Z',
        job_count: 3,
        completed_count: 1,
        failed_count: 1,
      },
      steps: [
        {
          index: 0,
          id: 'step-0-0',
          type: 'extract',
          state: 'completed',
          job_id: 'job-1',
          depends_on: [],
        },
        {
          index: 1,
          id: 'step-0-1',
          type: 'load',
          state: 'active',
          job_id: 'job-2',
          depends_on: ['step-0-0'],
        },
        {
          index: 2,
          id: 'step-1',
          type: 'notify',
          state: 'failed',
          job_id: null,
          depends_on: [],
        },
      ],
    });
  });

  it('gets a strict linear workflow from another transport instance and infers chain', async () => {
    const creator = runtimeTransport('createWorkflow', CreateWorkflowResponseType, {
      workflow: {
        id: 'wf-chain',
        state: 'WORKFLOW_STATE_RUNNING',
        steps: [
          { id: 'first', type: 'first.job', dependsOn: [] },
          { id: 'second', type: 'second.job', dependsOn: ['first'] },
        ],
      },
    });
    await new OJSClient({ url: 'unused', transport: creator }).workflow(
      chain(job('first.job'), job('second.job')),
    );

    const reader = runtimeTransport('getWorkflow', GetWorkflowResponseType, {
      workflow: {
        id: 'wf-chain',
        name: 'sequential',
        state: 'WORKFLOW_STATE_COMPLETED',
        createdAt: { seconds: '1704067200', nanos: 0 },
        completedAt: { seconds: '1704067260', nanos: 500_000_000 },
        steps: [
          {
            id: 'first',
            type: 'first.job',
            state: 'WORKFLOW_STEP_STATE_COMPLETED',
            jobId: 'job-a',
            dependsOn: [],
          },
          {
            id: 'second',
            type: 'second.job',
            state: 'WORKFLOW_STEP_STATE_COMPLETED',
            jobId: 'job-b',
            dependsOn: ['first'],
          },
        ],
      },
    });
    const client = new OJSClient({ url: 'unused', transport: reader });

    const status = await client.getWorkflow('wf-chain');
    expect(status.type).toBe('chain');
    expect(status.metadata.completed_count).toBe(2);
  });

  it('infers group for a multi-step edge-free get response without a cache entry', async () => {
    const transport = runtimeTransport('getWorkflow', GetWorkflowResponseType, {
      workflow: {
        id: 'wf-parallel',
        state: 'WORKFLOW_STATE_RUNNING',
        createdAt: { seconds: '1704067200', nanos: 0 },
        steps: [
          { id: 'a', type: 'a', state: 'WORKFLOW_STEP_STATE_WAITING' },
          { id: 'b', type: 'b', state: 'WORKFLOW_STEP_STATE_PENDING' },
        ],
      },
    });
    const client = new OJSClient({ url: 'unused', transport });

    await expect(client.getWorkflow('wf-parallel')).resolves.toMatchObject({
      id: 'wf-parallel',
      type: 'group',
    });
  });

  it('omits type for a one-step get response without a cache entry', async () => {
    const transport = runtimeTransport('getWorkflow', GetWorkflowResponseType, {
      workflow: {
        id: 'wf-one-step-foreign',
        state: 'WORKFLOW_STATE_RUNNING',
        steps: [
          {
            id: 'only',
            type: 'solo.job',
            state: 'WORKFLOW_STEP_STATE_PENDING',
            dependsOn: [],
          },
        ],
      },
    });
    const status = await new OJSClient({ url: 'unused', transport })
      .getWorkflow('wf-one-step-foreign');

    expect(status).not.toHaveProperty('type');
  });

  it('omits type for an arbitrary DAG without a cache entry', async () => {
    const transport = runtimeTransport('getWorkflow', GetWorkflowResponseType, {
      workflow: {
        id: 'wf-dag',
        state: 'WORKFLOW_STATE_RUNNING',
        steps: [
          { id: 'a', type: 'a', state: 'WORKFLOW_STEP_STATE_COMPLETED', dependsOn: [] },
          { id: 'b', type: 'b', state: 'WORKFLOW_STEP_STATE_COMPLETED', dependsOn: [] },
          { id: 'join', type: 'join', state: 'WORKFLOW_STEP_STATE_PENDING', dependsOn: ['a', 'b'] },
        ],
      },
    });
    const status = await new OJSClient({ url: 'unused', transport })
      .getWorkflow('wf-dag');

    expect(status).not.toHaveProperty('type');
  });

  it('reports the real cached type for a one-step chain created by this transport, which has zero dependency edges (Finding: workflow type honesty)', async () => {
    // A single-step chain is the sharpest counter-example to
    // edge-based inference: there is nothing for its one step to depend
    // on, so it has *no* dependency edges at all — indistinguishable by
    // structure alone from a one-job group. The per-instance
    // creation-time cache (keyed by workflow ID, not by structure) is
    // what makes this reported correctly.
    const transport = runtimeTransport('createWorkflow', CreateWorkflowResponseType, {
      workflow: {
        id: 'wf-one-step-chain',
        name: '',
        state: 'WORKFLOW_STATE_RUNNING',
        createdAt: { seconds: '1704067200', nanos: 0 },
        steps: [
          {
            id: 'step-0',
            type: 'solo.job',
            state: 'WORKFLOW_STEP_STATE_PENDING',
            jobId: '',
            dependsOn: [],
          },
        ],
      },
    });
    const client = new OJSClient({ url: 'unused', transport });

    const created = await client.workflow(chain(job('solo.job')));
    expect(created.type).toBe('chain');

    // Re-point the same transport instance's `call()` at `getWorkflow` so
    // this asserts the *cache*, not just the create-time type hint.
    (transport as unknown as {
      call: (calledMethod: string) => Promise<unknown>;
    }).call = async (calledMethod: string): Promise<unknown> => {
      expect(calledMethod).toBe('getWorkflow');
      return GetWorkflowResponseType.deserialize(
        GetWorkflowResponseType.serialize({
          workflow: {
            id: 'wf-one-step-chain',
            name: '',
            state: 'WORKFLOW_STATE_RUNNING',
            createdAt: { seconds: '1704067200', nanos: 0 },
            steps: [
              {
                id: 'step-0',
                type: 'solo.job',
                state: 'WORKFLOW_STEP_STATE_PENDING',
                jobId: '',
                dependsOn: [],
              },
            ],
          },
        }),
      );
    };

    const fetched = await client.getWorkflow('wf-one-step-chain');
    expect(fetched.type).toBe('chain');
  });

  it('reports the real cached type for a nested group-inside-chain and chain-inside-group created by this transport (Finding: workflow type honesty)', async () => {
    const outerChain = runtimeTransport('createWorkflow', CreateWorkflowResponseType, {
      workflow: {
        id: 'wf-nested-chain',
        name: '',
        state: 'WORKFLOW_STATE_RUNNING',
        createdAt: { seconds: '1704067200', nanos: 0 },
        steps: [
          { id: 'step-0-0', type: 'fan.a', state: 'WORKFLOW_STEP_STATE_PENDING', jobId: '', dependsOn: [] },
          { id: 'step-0-1', type: 'fan.b', state: 'WORKFLOW_STEP_STATE_PENDING', jobId: '', dependsOn: [] },
          { id: 'step-1', type: 'join', state: 'WORKFLOW_STEP_STATE_PENDING', jobId: '', dependsOn: ['step-0-0', 'step-0-1'] },
        ],
      },
    });
    const outerChainClient = new OJSClient({ url: 'unused', transport: outerChain });
    // A chain whose single element is a nested group (fan-out), followed
    // by a join step — the *outer* primitive is still 'chain'.
    const outerChainStatus = await outerChainClient.workflow(
      chain(group(job('fan.a'), job('fan.b')), job('join')),
    );
    expect(outerChainStatus.type).toBe('chain');

    const outerGroup = runtimeTransport('createWorkflow', CreateWorkflowResponseType, {
      workflow: {
        id: 'wf-nested-group',
        name: '',
        state: 'WORKFLOW_STATE_RUNNING',
        createdAt: { seconds: '1704067200', nanos: 0 },
        steps: [
          { id: 'step-0-0', type: 'seq.a', state: 'WORKFLOW_STEP_STATE_PENDING', jobId: '', dependsOn: [] },
          { id: 'step-0-1', type: 'seq.b', state: 'WORKFLOW_STEP_STATE_PENDING', jobId: '', dependsOn: ['step-0-0'] },
          { id: 'step-1', type: 'parallel.other', state: 'WORKFLOW_STEP_STATE_PENDING', jobId: '', dependsOn: [] },
        ],
      },
    });
    const outerGroupClient = new OJSClient({ url: 'unused', transport: outerGroup });
    // A group whose first element is a nested chain (sequential
    // sub-pipeline) running alongside a second, independent job — the
    // *outer* primitive is still 'group'.
    const outerGroupStatus = await outerGroupClient.workflow(
      group(chain(job('seq.a'), job('seq.b')), job('parallel.other')),
    );
    expect(outerGroupStatus.type).toBe('group');
  });
});

describe('GrpcTransport workflow mapping: chain', () => {
  it('flattens a sequential chain into stable IDs with linear dependsOn', async () => {
    const { transport, calls } = createCapturingGrpcTransport();
    const wire = toWireWorkflow(
      chain(
        job('a.fetch', [{ url: 'x' }]),
        job('a.transform', ['csv']),
        job('a.load', []),
      ),
    );
    await createWorkflow(transport, wire);

    expect(calls).toHaveLength(1);
    const req = calls[0]!.request as { name: string; steps: CapturedStep[] };
    expect(req.steps.map((s) => s.id)).toEqual(['step-0', 'step-1', 'step-2']);
    expect(req.steps.map((s) => s.type)).toEqual(['a.fetch', 'a.transform', 'a.load']);
    expect(req.steps.map((s) => s.dependsOn)).toEqual([[], ['step-0'], ['step-1']]);
    // args are converted to proto Value shapes.
    expect(req.steps[0]!.args).toEqual([{ structValue: { fields: { url: { stringValue: 'x' } } } }]);
    expect(req.steps[1]!.args).toEqual([{ stringValue: 'csv' }]);
    expect(req.steps[2]!.args).toEqual([]);
  });

  it('serializes the CreateWorkflowRequest through real proto-loader', async () => {
    const { transport, calls } = createCapturingGrpcTransport();
    await createWorkflow(
      transport,
      toWireWorkflow(chain(job('a', ['1']), job('b', ['2']))),
    );
    const buf = CreateWorkflowRequestType.serialize(calls[0]!.request);
    const decoded = CreateWorkflowRequestType.deserialize(buf) as {
      name: string;
      steps: { id: string; type: string; dependsOn: string[] }[];
    };
    expect(decoded.steps.map((s) => s.id)).toEqual(['step-0', 'step-1']);
    expect(decoded.steps[1]!.dependsOn).toEqual(['step-0']);
  });

  it('preserves the top-level workflow name', async () => {
    const { transport, calls } = createCapturingGrpcTransport();
    const wire = toWireWorkflow({
      type: 'chain',
      name: 'nightly-etl',
      steps: [job('a', [])],
    });
    await createWorkflow(transport, wire);
    expect((calls[0]!.request as { name: string }).name).toBe('nightly-etl');
  });

  it('defaults an absent name to an empty string', async () => {
    const { transport, calls } = createCapturingGrpcTransport();
    await createWorkflow(transport, toWireWorkflow(chain(job('a', []))));
    expect((calls[0]!.request as { name: string }).name).toBe('');
  });
});

describe('GrpcTransport workflow mapping: group', () => {
  it('flattens a parallel group with a shared (empty) dependsOn', async () => {
    const { transport, calls } = createCapturingGrpcTransport();
    const wire = toWireWorkflow(
      group(job('export.csv', []), job('export.pdf', []), job('export.xlsx', [])),
    );
    await createWorkflow(transport, wire);
    const req = calls[0]!.request as { steps: CapturedStep[] };
    expect(req.steps.map((s) => s.id)).toEqual(['step-0', 'step-1', 'step-2']);
    expect(req.steps.every((s) => s.dependsOn.length === 0)).toBe(true);
  });
});

describe('GrpcTransport workflow mapping: nested', () => {
  it('handles a group nested inside a chain (fan-out then join)', async () => {
    const { transport, calls } = createCapturingGrpcTransport();
    const wire = toWireWorkflow(
      chain(
        job('first', []),
        group(job('p1', []), job('p2', [])),
        job('last', []),
      ),
    );
    await createWorkflow(transport, wire);
    const req = calls[0]!.request as { steps: CapturedStep[] };
    const byId = Object.fromEntries(req.steps.map((s) => [s.id, s]));
    // first -> [p1, p2] (parallel) -> last depends on BOTH group exits.
    expect(byId['step-0']!.dependsOn).toEqual([]);
    expect(byId['step-1-0']!.type).toBe('p1');
    expect(byId['step-1-0']!.dependsOn).toEqual(['step-0']);
    expect(byId['step-1-1']!.type).toBe('p2');
    expect(byId['step-1-1']!.dependsOn).toEqual(['step-0']);
    expect(byId['step-2']!.type).toBe('last');
    expect(byId['step-2']!.dependsOn).toEqual(['step-1-0', 'step-1-1']);
  });

  it('handles a chain nested inside a group (parallel sub-sequences)', async () => {
    const { transport, calls } = createCapturingGrpcTransport();
    const wire = toWireWorkflow(
      group(
        chain(job('c1a', []), job('c1b', [])),
        job('solo', []),
      ),
    );
    await createWorkflow(transport, wire);
    const req = calls[0]!.request as { steps: CapturedStep[] };
    const byId = Object.fromEntries(req.steps.map((s) => [s.id, s]));
    // The inner chain: c1a -> c1b, both under group -> no incoming deps for c1a.
    expect(byId['step-0-0']!.type).toBe('c1a');
    expect(byId['step-0-0']!.dependsOn).toEqual([]);
    expect(byId['step-0-1']!.type).toBe('c1b');
    expect(byId['step-0-1']!.dependsOn).toEqual(['step-0-0']);
    // The solo job runs in parallel with the whole chain.
    expect(byId['step-1']!.type).toBe('solo');
    expect(byId['step-1']!.dependsOn).toEqual([]);
  });

  it('produces deterministic IDs/order across repeated conversions', async () => {
    const build = async (): Promise<CapturedStep[]> => {
      const { transport, calls } = createCapturingGrpcTransport();
      await createWorkflow(
        transport,
        toWireWorkflow(chain(job('a', []), group(job('b', []), job('c', [])))),
      );
      return (calls[0]!.request as { steps: CapturedStep[] }).steps;
    };
    const first = await build();
    const second = await build();
    expect(snapshot(first)).toEqual(snapshot(second));
    expect(first.map((s) => s.id)).toEqual(['step-0', 'step-1-0', 'step-1-1']);
  });
});

describe('GrpcTransport workflow mapping: step options and meta', () => {
  it('converts a step\'s enqueue options and envelope meta into EnqueueOptions', async () => {
    const { transport, calls } = createCapturingGrpcTransport();
    const wire = toWireWorkflow(
      chain(
        job('a', ['x'], {
          queue: 'reports',
          priority: 5,
          timeout: 30_000,
          tags: ['nightly'],
          retry: { maxAttempts: 3 },
          meta: { tenant: 'acme' },
        } as JobSpec['options']),
      ),
    );
    await createWorkflow(transport, wire);
    const step = (calls[0]!.request as { steps: CapturedStep[] }).steps[0]!;
    expect(step.options).toMatchObject({
      queue: 'reports',
      priority: 5,
      timeout: { seconds: '30', nanos: 0 },
      tags: ['nightly'],
      meta: { fields: { tenant: { stringValue: 'acme' } } },
    });

    // Round-trip the whole CreateWorkflowRequest (options included) through
    // real proto-loader.
    const buf = CreateWorkflowRequestType.serialize(calls[0]!.request);
    const decoded = CreateWorkflowRequestType.deserialize(buf) as {
      steps: { options: { queue: string; priority: number } }[];
    };
    expect(decoded.steps[0]!.options.queue).toBe('reports');
    expect(decoded.steps[0]!.options.priority).toBe(5);
  });

  it('omits options for a step with no configured options', async () => {
    const { transport, calls } = createCapturingGrpcTransport();
    await createWorkflow(transport, toWireWorkflow(chain(job('a', []))));
    const step = (calls[0]!.request as { steps: CapturedStep[] }).steps[0]!;
    expect('options' in step).toBe(false);
  });
});

describe('GrpcTransport workflow mapping: rejections', () => {
  it('does not confuse a job handler named batch with the batch workflow primitive', async () => {
    const { transport, calls } = createCapturingGrpcTransport();
    await createWorkflow(
      transport,
      toWireWorkflow(chain(job('before', []), job('batch', []))),
    );

    const steps = (calls[0]!.request as { steps: CapturedStep[] }).steps;
    expect(steps.map((step) => step.type)).toEqual(['before', 'batch']);
    expect(steps[1]!.dependsOn).toEqual(['step-0']);
  });

  it('rejects a top-level batch with a non-retryable unimplemented error and never calls the RPC', async () => {
    const { transport, calls } = createCapturingGrpcTransport();
    const wire = toWireWorkflow(
      batch([job('e1', []), job('e2', [])], { on_complete: job('report', []) }),
    );
    await expect(createWorkflow(transport, wire)).rejects.toSatisfy((err: OJSError) => {
      expect(err).toBeInstanceOf(OJSError);
      expect(err.code).toBe('unimplemented');
      expect(err.retryable).toBe(false);
      expect(err.message).toMatch(/batch/);
      return true;
    });
    expect(calls).toHaveLength(0);
  });

  it('rejects a batch nested inside a chain', async () => {
    const { transport, calls } = createCapturingGrpcTransport();
    const wire = toWireWorkflow(
      chain(
        job('a', []),
        batch([job('e1', [])], { on_failure: job('alert', []) }),
      ),
    );
    await expect(createWorkflow(transport, wire)).rejects.toSatisfy((err: OJSError) => {
      expect(err.code).toBe('unimplemented');
      return true;
    });
    expect(calls).toHaveLength(0);
  });

  it('rejects a step carrying an unrepresentable envelope schema', async () => {
    const { transport, calls } = createCapturingGrpcTransport();
    // Build the wire body by hand: a job step with a top-level `schema`
    // sibling (as toWireEnvelopeFields would place it).
    const wire = {
      type: 'chain',
      steps: [{ type: 'a', args: [], schema: 'https://schemas/x.json' }],
    };
    await expect(createWorkflow(transport, wire)).rejects.toSatisfy((err: OJSError) => {
      expect(err.code).toBe('unimplemented');
      expect(err.message).toMatch(/schema/);
      return true;
    });
    expect(calls).toHaveLength(0);
  });

  it('rejects raw wire expires_at on a workflow step before the RPC', async () => {
    const { transport, calls } = createCapturingGrpcTransport();
    await expect(
      createWorkflow(transport, {
        type: 'chain',
        steps: [
          {
            type: 'a',
            args: [],
            options: { expires_at: '2030-01-01T00:00:00Z' },
          },
        ],
      }),
    ).rejects.toMatchObject({
      name: 'OJSValidationError',
      code: 'invalid_request',
      retryable: false,
      message: expect.stringMatching(/deferred|shift/i),
    });
    expect(calls).toHaveLength(0);
  });

  it('rejects an empty chain body before the RPC (never sends empty steps)', async () => {
    const { transport, calls } = createCapturingGrpcTransport();
    await expect(
      createWorkflow(transport, { type: 'chain', steps: [] }),
    ).rejects.toBeInstanceOf(OJSValidationError);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['group', { type: 'group', jobs: [] }],
    ['chain', { type: 'chain', steps: [] }],
  ])(
    'rejects A -> empty nested %s -> B before flattening or calling the RPC',
    async (_label, empty) => {
      const { transport, calls } = createCapturingGrpcTransport();
      await expect(
        createWorkflow(transport, {
          type: 'chain',
          steps: [
            { type: 'a', args: [] },
            empty,
            { type: 'b', args: [] },
          ],
        }),
      ).rejects.toMatchObject({
        name: 'OJSValidationError',
        retryable: false,
        message: expect.stringMatching(/at path 1/),
      });
      expect(calls).toHaveLength(0);
    },
  );
});

// ===========================================================================
// Finding 3: Cron registration + listing
// ===========================================================================

describe('GrpcTransport cron registration', () => {
  it('maps definition options and envelope meta into RegisterCronRequest.options', async () => {
    const { transport, calls } = createCapturingGrpcTransport();
    await transport.request({
      method: 'POST',
      path: '/cron',
      body: {
        name: 'daily-report',
        cron: '0 9 * * *',
        type: 'report.generate',
        args: [{ scope: 'all' }],
        timezone: 'America/New_York',
        meta: { owner: 'ops' },
        options: {
          queue: 'reports',
          priority: 0,
          tags: ['cron'],
          retry: { max_attempts: 0, initial_interval: 'PT1S', backoff_coefficient: 2, max_interval: 'PT1M' },
        },
      },
    });

    // grpcRegisterCron issues exactly one RPC (Finding 5): no racy,
    // O(n) follow-up `listCron` lookup.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('registerCron');
    const req = calls[0]!.request;
    expect(req.name).toBe('daily-report');
    expect(req.cron).toBe('0 9 * * *');
    expect(req.timezone).toBe('America/New_York');
    expect(req.args).toEqual([{ structValue: { fields: { scope: { stringValue: 'all' } } } }]);
    const options = req.options as Record<string, unknown>;
    // Explicit priority 0 is preserved (presence, not truthiness).
    expect(options.priority).toBe(0);
    expect(options.queue).toBe('reports');
    expect(options.tags).toEqual(['cron']);
    expect(options.retry).toMatchObject({ maxAttempts: 0 });
    // Envelope meta becomes EnqueueOptions.meta.
    expect(options.meta).toEqual({ fields: { owner: { stringValue: 'ops' } } });
  });

  it('serializes the RegisterCronRequest (with options) through real proto-loader', async () => {
    const { transport, calls } = createCapturingGrpcTransport();
    await transport.request({
      method: 'POST',
      path: '/cron',
      body: {
        name: 'daily-report',
        cron: '@daily',
        type: 'report.generate',
        args: [],
        options: { queue: 'reports', priority: 0 },
      },
    });
    const buf = RegisterCronRequestType.serialize(calls[0]!.request);
    const decoded = RegisterCronRequestType.deserialize(buf) as {
      name: string;
      cron: string;
      options: { queue: string; priority: number };
    };
    expect(decoded.name).toBe('daily-report');
    expect(decoded.cron).toBe('@daily');
    expect(decoded.options.queue).toBe('reports');
    expect(decoded.options.priority).toBe(0);
  });

  it('omits options when the definition has none', async () => {
    const { transport, calls } = createCapturingGrpcTransport();
    await transport.request({
      method: 'POST',
      path: '/cron',
      body: { name: 'ping', cron: '@hourly', type: 'ping', args: [] },
    });
    expect('options' in calls[0]!.request).toBe(false);
  });

  it('rejects a cron definition with an unrepresentable envelope schema', async () => {
    const { transport, calls } = createCapturingGrpcTransport();
    await expect(
      transport.request({
        method: 'POST',
        path: '/cron',
        body: {
          name: 'x',
          cron: '@daily',
          type: 't',
          args: [],
          schema: 'https://schemas/x.json',
        },
      }),
    ).rejects.toSatisfy((err: OJSError) => {
      expect(err.code).toBe('unimplemented');
      expect(err.message).toMatch(/schema/);
      expect(err.message).toMatch(/cron registration/);
      return true;
    });
    expect(calls).toHaveLength(0);
  });

  it('rejects raw wire expires_at before the cron registration RPC', async () => {
    const { transport, calls } = createCapturingGrpcTransport();
    await expect(
      transport.request({
        method: 'POST',
        path: '/cron',
        body: {
          name: 'expiring',
          cron: '@daily',
          type: 't',
          args: [],
          options: { expires_at: '2030-01-01T00:00:00Z' },
        },
      }),
    ).rejects.toMatchObject({
      name: 'OJSValidationError',
      code: 'invalid_request',
      retryable: false,
      message: expect.stringMatching(/deferred|shift/i),
    });
    expect(calls).toHaveLength(0);
  });
});

describe('GrpcTransport cron listing', () => {
  /** Builds a real proto-decoded ListCronResponse entries array by
   * serializing a proto-shaped CronEntry and deserializing it — the same
   * shape the generated client would hand `grpcListCron`. */
  function decodeCronEntries(entries: unknown[]): unknown[] {
    const buf = ListCronResponseType.serialize({ entries });
    const decoded = ListCronResponseType.deserialize(buf) as { entries: unknown[] };
    return decoded.entries;
  }

  it('maps args, options, next_run_at, and last_run_at out of a CronEntry', async () => {
    // A proto-shaped EnqueueOptions built the same way GrpcTransport builds
    // it (validated by serializing through the real message below).
    const protoOptions = {
      queue: 'reports',
      priority: 5,
      timeout: { seconds: '30', nanos: 0 },
      tags: ['nightly'],
      retry: {
        maxAttempts: 3,
        initialInterval: { seconds: '1', nanos: 0 },
        backoffCoefficient: 2,
        maxInterval: { seconds: '60', nanos: 0 },
        jitter: false,
        nonRetryableErrors: [],
        onExhaustion: '',
      },
      meta: { fields: { owner: { stringValue: 'ops' } } },
    };
    // Sanity: the options shape is itself wire-valid.
    expect(() => EnqueueOptionsType.serialize(protoOptions)).not.toThrow();

    const entries = decodeCronEntries([
      {
        name: 'daily-report',
        cron: '0 9 * * *',
        timezone: 'America/New_York',
        type: 'report.generate',
        args: [{ stringValue: 'all' }, { numberValue: 7 }],
        options: protoOptions,
        nextRunAt: { seconds: '1773567000', nanos: 0 },
        lastRunAt: { seconds: '1773480600', nanos: 0 },
      },
    ]);

    const { transport } = createCapturingGrpcTransport(entries);
    const response = await transport.request({ method: 'GET', path: '/cron' });
    const body = response.body as { cron_jobs: Record<string, unknown>[] };

    expect(body.cron_jobs).toHaveLength(1);
    const info = body.cron_jobs[0]!;
    expect(info.name).toBe('daily-report');
    expect(info.cron).toBe('0 9 * * *');
    expect(info.timezone).toBe('America/New_York');
    expect(info.type).toBe('report.generate');
    expect(info.args).toEqual(['all', 7]);
    expect(info.status).toBe('active');
    expect('created_at' in info).toBe(false);
    expect(info.next_run_at).toBe('2026-03-15T09:30:00.000Z');
    expect(info.last_run_at).toBe('2026-03-14T09:30:00.000Z');
    const options = info.options as Record<string, unknown>;
    expect(options.queue).toBe('reports');
    expect(options.priority).toBe(5);
    expect(options.timeout_ms).toBe(30_000);
    expect(options.tags).toEqual(['nightly']);
    expect(options.retry).toMatchObject({ max_attempts: 3, backoff_coefficient: 2 });
    expect(info.meta).toEqual({ owner: 'ops' });
    expect(options).not.toHaveProperty('meta');
  });

  it('omits options/timestamps for an entry with all-default fields', async () => {
    const entries = decodeCronEntries([
      { name: 'ping', cron: '@hourly', timezone: 'UTC', type: 'ping', args: [] },
    ]);
    const { transport } = createCapturingGrpcTransport(entries);
    const response = await transport.request({ method: 'GET', path: '/cron' });
    const info = (response.body as { cron_jobs: Record<string, unknown>[] }).cron_jobs[0]!;
    expect(info.name).toBe('ping');
    expect(info.args).toEqual([]);
    expect(info.status).toBe('active');
    expect('created_at' in info).toBe(false);
    expect('options' in info).toBe(false);
    expect('next_run_at' in info).toBe(false);
    expect('last_run_at' in info).toBe(false);
  });

  it('decodes an all-proto3-default retry message via a real proto round-trip, preserving max_attempts:0/jitter:false while defaulting the invalid coefficient/empty exhaustion/absent durations (Finding: proto retry decoding)', async () => {
    // `retry: {}` round-trips through the *real* proto-loader
    // serialize/deserialize with every scalar at its proto3 zero value
    // (maxAttempts: 0, backoffCoefficient: 0, jitter: false,
    // onExhaustion: '') and both Duration sub-messages absent. Since the
    // RetryPolicy message itself is present, max_attempts and jitter are
    // preserved exactly rather than being rewritten to the "absent
    // policy" defaults of 3/true.
    const entries = decodeCronEntries([
      {
        name: 'retry-defaults',
        cron: '@hourly',
        type: 'ping',
        args: [],
        options: { retry: {} },
      },
    ]);
    const { transport } = createCapturingGrpcTransport(entries);
    const response = await transport.request({ method: 'GET', path: '/cron' });
    const info = (response.body as { cron_jobs: Record<string, unknown>[] })
      .cron_jobs[0]!;

    expect((info.options as Record<string, unknown>).retry).toEqual({
      max_attempts: 0,
      initial_interval: 'PT1S',
      backoff_coefficient: 2,
      max_interval: 'PT5M',
      jitter: false,
      non_retryable_errors: [],
      on_exhaustion: 'discard',
    });
  });

  it('decodes a partial proto-loader retry message without synthetic zero/empty fields, preserving the proto3-omitted jitter scalar as false', async () => {
    // `jitter` is never explicitly set on this fixture -- documenting the
    // exact proto3 ambiguity this decoder resolves in favor of trusting
    // the wire value: with proto-loader's `defaults: true`, an omitted
    // singular non-optional `bool jitter` and an explicit `jitter: false`
    // both decode identically, and this SDK cannot tell them apart once
    // the RetryPolicy message itself is present (see
    // `fromProtoRetryPolicy`'s doc comment). A backend that wants the
    // documented default `true` must send it explicitly.
    const entries = decodeCronEntries([
      {
        name: 'retry-partial',
        cron: '@hourly',
        type: 'ping',
        args: [],
        options: {
          retry: {
            maxAttempts: 7,
            initialInterval: { seconds: '2', nanos: 0 },
            onExhaustion: 'dead_letter',
          },
        },
      },
    ]);
    const { transport } = createCapturingGrpcTransport(entries);
    const response = await transport.request({ method: 'GET', path: '/cron' });
    const info = (response.body as { cron_jobs: Record<string, unknown>[] })
      .cron_jobs[0]!;

    expect((info.options as Record<string, unknown>).retry).toEqual({
      max_attempts: 7,
      initial_interval: 'PT2S',
      backoff_coefficient: 2,
      max_interval: 'PT5M',
      jitter: false,
      non_retryable_errors: [],
      on_exhaustion: 'dead_letter',
    });
  });

  it('preserves an explicit jitter:true through a real proto round-trip (sanity check: the fix does not merely flip the default)', async () => {
    const entries = decodeCronEntries([
      {
        name: 'retry-explicit-jitter',
        cron: '@hourly',
        type: 'ping',
        args: [],
        options: {
          retry: {
            maxAttempts: 4,
            jitter: true,
            onExhaustion: 'discard',
          },
        },
      },
    ]);
    const { transport } = createCapturingGrpcTransport(entries);
    const response = await transport.request({ method: 'GET', path: '/cron' });
    const info = (response.body as { cron_jobs: Record<string, unknown>[] })
      .cron_jobs[0]!;

    expect((info.options as Record<string, unknown>).retry).toMatchObject({
      max_attempts: 4,
      jitter: true,
    });
  });

  it('round-trips a registered cron entry back through listing', async () => {
    // Register (capture the proto options GrpcTransport builds)...
    const reg = createCapturingGrpcTransport();
    await reg.transport.request({
      method: 'POST',
      path: '/cron',
      body: {
        name: 'roundtrip',
        cron: '@daily',
        type: 'job.run',
        args: [{ k: 1 }],
        options: { queue: 'q', tags: ['t'] },
      },
    });
    const builtOptions = reg.calls[0]!.request.options;

    // ...then feed those exact options back through a CronEntry listing.
    const entries = decodeCronEntries([
      {
        name: 'roundtrip',
        cron: '@daily',
        timezone: 'UTC',
        type: 'job.run',
        args: [{ structValue: { fields: { k: { numberValue: 1 } } } }],
        options: builtOptions,
      },
    ]);
    const { transport } = createCapturingGrpcTransport(entries);
    const response = await transport.request({ method: 'GET', path: '/cron' });
    const info = (response.body as { cron_jobs: Record<string, unknown>[] }).cron_jobs[0]!;
    expect(info.args).toEqual([{ k: 1 }]);
    expect(info.options).toMatchObject({ queue: 'q', tags: ['t'] });
  });
});

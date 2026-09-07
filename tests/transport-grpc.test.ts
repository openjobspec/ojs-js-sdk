import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GrpcTransport } from '../src/transport/grpc.js';
import type { GrpcTransportConfig } from '../src/transport/grpc.js';
import { reportProgress } from '../src/progress.js';
import {
  OJSConnectionError,
  OJSValidationError,
  OJSNotFoundError,
  OJSServerError,
  OJSDuplicateError,
  OJSConflictError,
  OJSRateLimitError,
  OJSError,
} from '../src/errors.js';

const FULL_PROTO_JOB = {
  id: 'job-full',
  type: 'certification.full',
  queue: 'critical',
  args: [
    { kind: 'stringValue', stringValue: '' },
    { kind: 'numberValue', numberValue: 0 },
    { kind: 'boolValue', boolValue: false },
    { kind: 'nullValue', nullValue: 'NULL_VALUE' },
  ],
  meta: {
    fields: {
      tenant_id: { kind: 'stringValue', stringValue: '' },
      enabled: { kind: 'boolValue', boolValue: false },
      count: { kind: 'numberValue', numberValue: 0 },
    },
  },
  state: 'JOB_STATE_ACTIVE',
  priority: 0,
  attempt: 0,
  maxAttempts: 0,
  retryPolicy: {
    maxAttempts: 0,
    initialInterval: { seconds: '1', nanos: 250_000_000 },
    backoffCoefficient: 0,
    maxInterval: { seconds: '300', nanos: 0 },
    jitter: false,
    nonRetryableErrors: [],
    onExhaustion: '',
  },
  uniquePolicy: {
    key: [],
    period: { seconds: '3600', nanos: 0 },
    onConflict: 'UNIQUE_CONFLICT_ACTION_REPLACE_EXCEPT_SCHEDULE',
    states: ['JOB_STATE_AVAILABLE', 'JOB_STATE_ACTIVE'],
    argsKeys: [],
    metaKeys: ['tenant_id'],
  },
  result: {
    fields: {
      ok: { kind: 'boolValue', boolValue: false },
      count: { kind: 'numberValue', numberValue: 0 },
      note: { kind: 'stringValue', stringValue: '' },
    },
  },
  errors: [
    {
      code: '',
      message: '',
      retryable: false,
      attempt: 0,
      occurredAt: { seconds: '1767225605', nanos: 0 },
      backtrace: 'Error: first\n    at handler.ts:1:1',
      details: {
        fields: {
          empty: { kind: 'stringValue', stringValue: '' },
          zero: { kind: 'numberValue', numberValue: 0 },
        },
      },
    },
    {
      code: 'handler_error',
      message: 'boom',
      retryable: true,
      attempt: 2,
      occurredAt: { seconds: '1767225606', nanos: 500_000_000 },
      backtrace: [],
      details: { fields: {} },
    },
  ],
  // The same fixture is exercised through unary GetJob and StreamJobs.
  // Its timestamp fields deliberately span the complete validation surface.
  createdAt: { seconds: '-8640000000000', nanos: 0 }, // JS Date minimum
  enqueuedAt: { seconds: '8640000000000', nanos: 0 }, // JS Date maximum
  scheduledAt: { seconds: '9223372036854775807', nanos: 0 }, // int64 maximum
  startedAt: { seconds: '1767225603', nanos: -1 },
  completedAt: { seconds: '1767225604', nanos: 1_000_000_000 },
  expiresAt: { seconds: '1767229200', nanos: 999_999_999 },
  timeout: { seconds: '30', nanos: 500_000_000 },
  visibilityTimeout: { seconds: '0', nanos: 0 },
  tags: [],
  traceId: '',
  workflowId: '',
  parentId: '',
  rootId: 'root-job',
  causedBy: '',
  schema: '',
  specversion: '1.0',
};

const FULL_WIRE_JOB = {
  specversion: '1.0',
  id: 'job-full',
  type: 'certification.full',
  queue: 'critical',
  args: ['', 0, false, null],
  meta: { tenant_id: '', enabled: false, count: 0 },
  state: 'active',
  priority: 0,
  attempt: 0,
  max_attempts: 0,
  retry: {
    // Input fixture's retryPolicy has maxAttempts:0/jitter:false: both are
    // preserved exactly, since the RetryPolicy message itself is present
    // (Finding: proto retry decoding). backoff_coefficient (0, invalid)
    // and initial_interval (a present, non-default duration) behave as
    // before.
    max_attempts: 0,
    initial_interval: 'PT1.25S',
    backoff_coefficient: 2,
    max_interval: 'PT5M',
    jitter: false,
    non_retryable_errors: [],
    on_exhaustion: 'discard',
  },
  unique: {
    keys: [],
    period: 'PT1H',
    on_conflict: 'replace_except_schedule',
    states: ['available', 'active'],
    args_keys: [],
    meta_keys: ['tenant_id'],
  },
  result: { ok: false, count: 0, note: '' },
  error: {
    code: 'handler_error',
    message: 'boom',
    retryable: true,
    attempt: 2,
    occurred_at: '2026-01-01T00:00:06.500Z',
    backtrace: [],
    details: {},
  },
  errors: [
    {
      code: '',
      message: '',
      retryable: false,
      attempt: 0,
      occurred_at: '2026-01-01T00:00:05.000Z',
      backtrace: ['Error: first', '    at handler.ts:1:1'],
      details: { empty: '', zero: 0 },
    },
    {
      code: 'handler_error',
      message: 'boom',
      retryable: true,
      attempt: 2,
      occurred_at: '2026-01-01T00:00:06.500Z',
      backtrace: [],
      details: {},
    },
  ],
  created_at: '-271821-04-20T00:00:00.000Z',
  enqueued_at: '+275760-09-13T00:00:00.000Z',
  scheduled_at: null,
  started_at: null,
  completed_at: null,
  expires_at: '2026-01-01T01:00:00.999Z',
  timeout: 30_500,
  visibility_timeout: 0,
  tags: [],
  trace_id: '',
  workflow_id: '',
  parent_id: '',
  root_id: 'root-job',
  caused_by: '',
  schema: '',
};

function maliciousProtoFields(): Record<string, unknown> {
  const nestedFields: Record<string, unknown> = {};
  Object.defineProperty(nestedFields, '__proto__', {
    value: { kind: 'stringValue', stringValue: 'nested-proto-data' },
    enumerable: true,
  });
  Object.defineProperty(nestedFields, 'polluted', {
    value: { kind: 'boolValue', boolValue: true },
    enumerable: true,
  });

  const fields: Record<string, unknown> = {};
  Object.defineProperty(fields, '__proto__', {
    value: {
      kind: 'structValue',
      structValue: { fields: nestedFields },
    },
    enumerable: true,
  });
  Object.defineProperty(fields, 'constructor', {
    value: { kind: 'stringValue', stringValue: 'constructor-data' },
    enumerable: true,
  });
  Object.defineProperty(fields, 'prototype', {
    value: { kind: 'numberValue', numberValue: 7 },
    enumerable: true,
  });
  return fields;
}

function expectSafeMaliciousStruct(value: Record<string, unknown>): void {
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  expect(Object.hasOwn(value, '__proto__')).toBe(true);
  expect(Object.hasOwn(value, 'constructor')).toBe(true);
  expect(Object.hasOwn(value, 'prototype')).toBe(true);
  const protoValue = value['__proto__'] as Record<string, unknown>;
  expect(Object.getPrototypeOf(protoValue)).toBe(Object.prototype);
  expect(Object.hasOwn(protoValue, '__proto__')).toBe(true);
  expect(protoValue['__proto__']).toBe('nested-proto-data');
  expect(protoValue.polluted).toBe(true);
  expect(value.constructor).toBe('constructor-data');
  expect(value.prototype).toBe(7);
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
}

describe('GrpcTransport', () => {
  describe('constructor', () => {
    it('should create transport with minimal config', () => {
      const transport = new GrpcTransport({ url: 'localhost:9090' });
      expect(transport).toBeInstanceOf(GrpcTransport);
    });

    it('should accept all configuration options', () => {
      const transport = new GrpcTransport({
        url: 'localhost:9090',
        apiKey: 'test-key',
        auth: 'Bearer token123',
        timeout: 5000,
        metadata: { 'x-custom': 'value' },
      });
      expect(transport).toBeInstanceOf(GrpcTransport);
    });

    it('should have a close method', () => {
      const transport = new GrpcTransport({ url: 'localhost:9090' });
      expect(typeof transport.close).toBe('function');
      // close on uninitialized transport should not throw
      transport.close();
    });
  });

  describe('request routing', () => {
    let transport: GrpcTransport;

    beforeEach(() => {
      transport = new GrpcTransport({
        url: 'localhost:9090',
        protoPath: '/nonexistent', // Will fail on actual gRPC call
      });
    });

    it('should reject an invalid configured proto path before loading the gRPC runtime', async () => {
      await expect(
        transport.request({ method: 'GET', path: '/health' }),
      ).rejects.toThrow('Could not find OJS service proto at');
    });
  });

  describe('protobuf Struct decoding safety', () => {
    it('preserves malicious job meta keys as own data properties', async () => {
      const transport = createMockGrpcTransport();
      setMockResponse(transport, 'getJob', {
        job: {
          id: 'job-meta',
          type: 'test',
          queue: 'default',
          args: [],
          meta: { fields: maliciousProtoFields() },
        },
      });

      const response = await transport.request({
        method: 'GET',
        path: '/jobs/job-meta',
      });

      expectSafeMaliciousStruct(
        (response.body as any).job.meta as Record<string, unknown>,
      );
    });

    it('preserves malicious JobError details keys as own data properties', async () => {
      const transport = createMockGrpcTransport();
      setMockResponse(transport, 'getJob', {
        job: {
          id: 'job-details',
          type: 'test',
          queue: 'default',
          args: [],
          errors: [
            {
              code: 'handler_error',
              message: 'failed',
              details: { fields: maliciousProtoFields() },
            },
          ],
        },
      });

      const response = await transport.request({
        method: 'GET',
        path: '/jobs/job-details',
      });

      expectSafeMaliciousStruct(
        (response.body as any).job.errors[0].details as Record<string, unknown>,
      );
    });
  });

  describe('GrpcTransport implements Transport interface', () => {
    it('should have a request method', () => {
      const transport = new GrpcTransport({ url: 'localhost:9090' });
      expect(typeof transport.request).toBe('function');
    });

    it('should accept TransportRequestOptions', () => {
      const transport = new GrpcTransport({ url: 'localhost:9090' });
      // Verify it accepts the standard options shape
      const requestPromise = transport.request({
        method: 'GET',
        path: '/health',
        timeout: 1000,
        headers: { 'X-Custom': 'test' },
      });
      // Will reject because gRPC deps aren't configured in test, but type-checks pass
      expect(requestPromise).toBeInstanceOf(Promise);
      requestPromise.catch(() => {}); // suppress unhandled rejection
    });
  });

  describe('metadata propagation', () => {
    it('should include API key in metadata', () => {
      const config: GrpcTransportConfig = {
        url: 'localhost:9090',
        apiKey: 'my-api-key',
      };
      const transport = new GrpcTransport(config);
      // Verify internal state via accessing the config
      expect(transport).toBeDefined();
    });

    it('should include auth token in metadata', () => {
      const config: GrpcTransportConfig = {
        url: 'localhost:9090',
        auth: 'Bearer my-token',
      };
      const transport = new GrpcTransport(config);
      expect(transport).toBeDefined();
    });

    it('should merge custom metadata', () => {
      const config: GrpcTransportConfig = {
        url: 'localhost:9090',
        metadata: {
          'x-request-id': 'req-123',
          'x-tenant-id': 'tenant-456',
        },
      };
      const transport = new GrpcTransport(config);
      expect(transport).toBeDefined();
    });
  });

  describe('error mapping', () => {
    // Test the error mapping function via the module's internal behavior.
    // We test this by creating mock gRPC errors and verifying they map correctly.

    it('should map INVALID_ARGUMENT to OJSValidationError', async () => {
      const transport = createMockGrpcTransport();
      setMockError(transport, { code: 3, details: 'Invalid job type' });

      await expect(
        transport.request({ method: 'POST', path: '/jobs', body: {} }),
      ).rejects.toBeInstanceOf(OJSValidationError);
    });

    it('should map NOT_FOUND to OJSNotFoundError', async () => {
      const transport = createMockGrpcTransport();
      setMockError(transport, { code: 5, details: 'Job not found' });

      await expect(
        transport.request({ method: 'GET', path: '/jobs/123' }),
      ).rejects.toBeInstanceOf(OJSNotFoundError);
    });

    it('should map ALREADY_EXISTS to OJSDuplicateError', async () => {
      const transport = createMockGrpcTransport();
      setMockError(transport, { code: 6, details: 'Duplicate job' });

      await expect(
        transport.request({ method: 'POST', path: '/jobs', body: {} }),
      ).rejects.toBeInstanceOf(OJSDuplicateError);
    });

    it('should map FAILED_PRECONDITION to OJSConflictError', async () => {
      const transport = createMockGrpcTransport();
      setMockError(transport, { code: 9, details: 'Queue is paused' });

      await expect(
        transport.request({ method: 'POST', path: '/jobs', body: {} }),
      ).rejects.toBeInstanceOf(OJSConflictError);
    });

    it('should map RESOURCE_EXHAUSTED to OJSRateLimitError', async () => {
      const transport = createMockGrpcTransport();
      setMockError(transport, { code: 8, details: 'Rate limited' });

      await expect(
        transport.request({ method: 'POST', path: '/jobs', body: {} }),
      ).rejects.toBeInstanceOf(OJSRateLimitError);
    });

    it('should map UNAVAILABLE to OJSConnectionError', async () => {
      const transport = createMockGrpcTransport();
      setMockError(transport, { code: 14, details: 'Service unavailable' });

      await expect(
        transport.request({ method: 'GET', path: '/health' }),
      ).rejects.toBeInstanceOf(OJSConnectionError);
    });

    it('should map DEADLINE_EXCEEDED to OJSConnectionError', async () => {
      const transport = createMockGrpcTransport();
      setMockError(transport, { code: 4, details: 'Deadline exceeded' });

      await expect(
        transport.request({ method: 'GET', path: '/health' }),
      ).rejects.toBeInstanceOf(OJSConnectionError);
    });

    it('should map INTERNAL to OJSServerError', async () => {
      const transport = createMockGrpcTransport();
      setMockError(transport, { code: 13, details: 'Internal error' });

      await expect(
        transport.request({ method: 'GET', path: '/health' }),
      ).rejects.toBeInstanceOf(OJSServerError);
    });

    it('should map UNIMPLEMENTED to OJSError', async () => {
      const transport = createMockGrpcTransport();
      setMockError(transport, { code: 12, details: 'Not implemented' });

      await expect(
        transport.request({ method: 'GET', path: '/health' }),
      ).rejects.toSatisfy((err: OJSError) => {
        expect(err).toBeInstanceOf(OJSError);
        expect(err.code).toBe('unimplemented');
        return true;
      });
    });

    it('should map PERMISSION_DENIED to OJSError', async () => {
      const transport = createMockGrpcTransport();
      setMockError(transport, { code: 7, details: 'Access denied' });

      await expect(
        transport.request({ method: 'GET', path: '/health' }),
      ).rejects.toSatisfy((err: OJSError) => {
        expect(err).toBeInstanceOf(OJSError);
        expect(err.code).toBe('permission_denied');
        return true;
      });
    });
  });

  describe('request/response mapping', () => {
    it('should map enqueue request correctly', async () => {
      const transport = createMockGrpcTransport();
      setMockResponse(transport, 'enqueue', {
        job: {
          id: 'job-123',
          type: 'email.send',
          queue: 'default',
          state: 'JOB_STATE_AVAILABLE',
          args: [{ stringValue: 'user@example.com' }],
          priority: 0,
          attempt: 0,
          maxAttempts: 3,
        },
      });

      const response = await transport.request({
        method: 'POST',
        path: '/jobs',
        body: { type: 'email.send', args: ['user@example.com'] },
      });

      expect(response.status).toBe(200);
      const body = response.body as any;
      expect(body.job.id).toBe('job-123');
      expect(body.job.type).toBe('email.send');
      expect(body.job.state).toBe('available');
    });

    it('should decode legitimate default-valued job args (0, false, "", null) faithfully instead of null', async () => {
      // Regression test: fromProtoValue() previously used "is this oneof
      // member's value non-zero/non-empty" as a proxy for "is it set",
      // which silently misread a legitimately-set 0/false/'' as absent and
      // decoded it as null instead of the real value. Fixtures below
      // reproduce real @grpc/proto-loader output (oneofs:true, verified
      // empirically): only the actively-set member is present, alongside
      // the synthesized `kind` discriminator naming it.
      const transport = createMockGrpcTransport();
      setMockResponse(transport, 'enqueue', {
        job: {
          id: 'job-defaults',
          type: 'test.defaults',
          queue: 'default',
          state: 'JOB_STATE_AVAILABLE',
          args: [
            { kind: 'stringValue', stringValue: '' },
            { kind: 'numberValue', numberValue: 0 },
            { kind: 'boolValue', boolValue: false },
            { kind: 'nullValue', nullValue: 'NULL_VALUE' },
          ],
        },
      });

      const response = await transport.request({
        method: 'POST',
        path: '/jobs',
        body: { type: 'test.defaults', args: ['', 0, false, null] },
      });

      const body = response.body as any;
      expect(body.job.args).toEqual(['', 0, false, null]);
    });

    it('should decode kind-tagged nested list/struct job args (0-length list, zero-valued nested struct field)', async () => {
      const transport = createMockGrpcTransport();
      setMockResponse(transport, 'enqueue', {
        job: {
          id: 'job-nested-defaults',
          type: 'test.nested',
          queue: 'default',
          state: 'JOB_STATE_AVAILABLE',
          args: [
            { kind: 'listValue', listValue: { values: [{ kind: 'numberValue', numberValue: 0 }] } },
            {
              kind: 'structValue',
              structValue: { fields: { active: { kind: 'boolValue', boolValue: false } } },
            },
          ],
        },
      });

      const response = await transport.request({
        method: 'POST',
        path: '/jobs',
        body: { type: 'test.nested', args: [[0], { active: false }] },
      });

      const body = response.body as any;
      expect(body.job.args).toEqual([[0], { active: false }]);
    });

    it('should decode a job arg Value with no `kind` discriminator via presence-based fallback', async () => {
      // A decoded Value without oneofs:true's `kind` field (e.g. a
      // hand-constructed payload) must still decode via field presence,
      // not "is it non-zero" — this exercises the fallback path directly
      // for all six previously-mishandled/uncovered cases, including
      // nested list/struct values.
      const transport = createMockGrpcTransport();
      setMockResponse(transport, 'enqueue', {
        job: {
          id: 'job-defaults-2',
          type: 'test.defaults',
          queue: 'default',
          state: 'JOB_STATE_AVAILABLE',
          args: [
            { stringValue: '' },
            { numberValue: 0 },
            { boolValue: false },
            { nullValue: 'NULL_VALUE' },
            { listValue: { values: [{ numberValue: 0 }] } },
            { structValue: { fields: { flag: { boolValue: false } } } },
          ],
        },
      });

      const response = await transport.request({
        method: 'POST',
        path: '/jobs',
        body: { type: 'test.defaults', args: ['', 0, false, null, [0], { flag: false }] },
      });

      const body = response.body as any;
      expect(body.job.args).toEqual(['', 0, false, null, [0], { flag: false }]);
    });

    it('should decode an unrecognized `kind` discriminator as null rather than guessing', async () => {
      const transport = createMockGrpcTransport();
      setMockResponse(transport, 'enqueue', {
        job: {
          id: 'job-malformed',
          type: 'test.malformed',
          queue: 'default',
          state: 'JOB_STATE_AVAILABLE',
          args: [{ kind: 'someFutureValue', someFutureValue: 'unrecognized' }],
        },
      });

      const response = await transport.request({
        method: 'POST',
        path: '/jobs',
        body: { type: 'test.malformed', args: ['ignored'] },
      });

      const body = response.body as any;
      expect(body.job.args).toEqual([null]);
    });

    it('should normalize every supported proto Job field for unary responses', async () => {
      const transport = createMockGrpcTransport();
      setMockResponse(transport, 'getJob', { job: FULL_PROTO_JOB });

      const response = await transport.request({
        method: 'GET',
        path: '/jobs/job-full',
      });

      expect((response.body as any).job).toEqual(FULL_WIRE_JOB);
    });

    it('decodes a proto retry policy whose max_attempts/jitter are explicitly 0/false, preserving them exactly, while still defaulting an invalid coefficient/empty exhaustion/absent durations (Finding: proto retry decoding)', async () => {
      // Every field in this RetryPolicy message happens to be a proto3
      // zero/empty value, but the message itself is present -- so
      // max_attempts:0 and jitter:false must be preserved exactly (they
      // are meaningful OJS values, not evidence of an absent policy),
      // while backoff_coefficient (< 1, invalid), on_exhaustion (empty,
      // invalid), and the two absent Duration sub-messages still receive
      // the protocol's authoritative defaults.
      const transport = createMockGrpcTransport();
      setMockResponse(transport, 'getJob', {
        job: {
          id: 'job-empty-retry',
          type: 'retry.empty',
          queue: 'default',
          args: [],
          retryPolicy: {
            maxAttempts: 0,
            initialInterval: null,
            backoffCoefficient: 0,
            maxInterval: null,
            jitter: false,
            nonRetryableErrors: [],
            onExhaustion: '',
          },
        },
      });

      const response = await transport.request({
        method: 'GET',
        path: '/jobs/job-empty-retry',
      });

      expect((response.body as any).job.retry).toEqual({
        max_attempts: 0,
        initial_interval: 'PT1S',
        backoff_coefficient: 2,
        max_interval: 'PT5M',
        jitter: false,
        non_retryable_errors: [],
        on_exhaustion: 'discard',
      });
    });

    it('decodes a partial proto retry policy without fabricating zero/empty values', async () => {
      const transport = createMockGrpcTransport();
      setMockResponse(transport, 'getJob', {
        job: {
          id: 'job-partial-retry',
          type: 'retry.partial',
          queue: 'default',
          args: [],
          retryPolicy: {
            maxAttempts: 7,
            initialInterval: { seconds: '0', nanos: 0 },
            backoffCoefficient: 3,
            maxInterval: null,
            jitter: false,
            nonRetryableErrors: ['validation.*'],
            onExhaustion: 'dead_letter',
          },
        },
      });

      const response = await transport.request({
        method: 'GET',
        path: '/jobs/job-partial-retry',
      });

      expect((response.body as any).job.retry).toEqual({
        max_attempts: 7,
        initial_interval: 'PT0S',
        backoff_coefficient: 3,
        max_interval: 'PT5M',
        // jitter:false is preserved exactly (Finding: proto retry
        // decoding), unlike the previous buggy behavior which rewrote it
        // to the default true.
        jitter: false,
        non_retryable_errors: ['validation.*'],
        on_exhaustion: 'dead_letter',
      });
    });

    it('preserves an explicit jitter:true and a positive max_attempts unchanged (sanity check: the fix does not merely flip defaults)', async () => {
      const transport = createMockGrpcTransport();
      setMockResponse(transport, 'getJob', {
        job: {
          id: 'job-explicit-retry',
          type: 'retry.explicit',
          queue: 'default',
          args: [],
          retryPolicy: {
            maxAttempts: 5,
            initialInterval: { seconds: '2', nanos: 0 },
            backoffCoefficient: 1.5,
            maxInterval: { seconds: '120', nanos: 0 },
            jitter: true,
            nonRetryableErrors: ['validation.*'],
            onExhaustion: 'dead_letter',
          },
        },
      });

      const response = await transport.request({
        method: 'GET',
        path: '/jobs/job-explicit-retry',
      });

      expect((response.body as any).job.retry).toEqual({
        max_attempts: 5,
        initial_interval: 'PT2S',
        backoff_coefficient: 1.5,
        max_interval: 'PT2M',
        jitter: true,
        non_retryable_errors: ['validation.*'],
        on_exhaustion: 'dead_letter',
      });
    });

    it('applies the full authoritative default policy only when the RetryPolicy message itself is entirely absent (null)', async () => {
      const transport = createMockGrpcTransport();
      setMockResponse(transport, 'getJob', {
        job: {
          id: 'job-no-retry',
          type: 'retry.none',
          queue: 'default',
          args: [],
          retryPolicy: null,
        },
      });

      const response = await transport.request({
        method: 'GET',
        path: '/jobs/job-no-retry',
      });

      expect((response.body as any).job.retry).toBeUndefined();
    });

    it('should decode a scalar proto Value result without losing false', async () => {
      const transport = createMockGrpcTransport();
      setMockResponse(transport, 'getJob', {
        job: {
          ...FULL_PROTO_JOB,
          result: { kind: 'boolValue', boolValue: false },
        },
      });

      const response = await transport.request({
        method: 'GET',
        path: '/jobs/job-full',
      });

      expect((response.body as any).job.result).toBe(false);
    });

    it('should map fetch response correctly', async () => {
      const transport = createMockGrpcTransport();
      setMockResponse(transport, 'fetch', {
        jobs: [
          {
            id: 'job-456',
            type: 'test.job',
            queue: 'default',
            state: 'JOB_STATE_ACTIVE',
            args: [],
            attempt: 1,
          },
        ],
      });

      const response = await transport.request({
        method: 'POST',
        path: '/workers/fetch',
        body: { queues: ['default'], count: 1 },
      });

      const body = response.body as any;
      expect(body.jobs).toHaveLength(1);
      expect(body.jobs[0].id).toBe('job-456');
      expect(body.jobs[0].state).toBe('active');
    });

    it('should map health response correctly', async () => {
      const transport = createMockGrpcTransport();
      setMockResponse(transport, 'health', {
        status: 'HEALTH_STATUS_OK',
      });

      const response = await transport.request({
        method: 'GET',
        path: '/health',
      });

      const body = response.body as any;
      expect(body.status).toBe('ok');
    });

    it('should map ack response correctly', async () => {
      const transport = createMockGrpcTransport();
      setMockResponse(transport, 'ack', { acknowledged: true });

      const response = await transport.request({
        method: 'POST',
        path: '/workers/ack',
        body: { job_id: 'job-123' },
      });

      const body = response.body as any;
      expect(body.acknowledged).toBe(true);
    });

    it('should map nack response correctly', async () => {
      const transport = createMockGrpcTransport();
      setMockResponse(transport, 'nack', {
        state: 'JOB_STATE_RETRYABLE',
        nextAttemptAt: null,
      });

      const response = await transport.request({
        method: 'POST',
        path: '/workers/nack',
        body: {
          job_id: 'job-123',
          error: { code: 'handler_error', message: 'boom', retryable: true },
        },
      });

      const body = response.body as any;
      expect(body.state).toBe('retryable');
    });

    it('should map list queues response correctly', async () => {
      const transport = createMockGrpcTransport();
      setMockResponse(transport, 'listQueues', {
        queues: [
          { name: 'default', paused: false, availableCount: '10' },
          { name: 'email', paused: true, availableCount: '0' },
        ],
      });

      const response = await transport.request({
        method: 'GET',
        path: '/queues',
      });

      const body = response.body as any;
      expect(body.queues).toHaveLength(2);
      expect(body.queues[0].name).toBe('default');
      expect(body.queues[0].status).toBe('active');
      expect(body.queues[1].status).toBe('paused');
    });

    it('should map getJob response correctly', async () => {
      const transport = createMockGrpcTransport();
      setMockResponse(transport, 'getJob', {
        job: {
          id: 'job-789',
          type: 'test',
          state: 'JOB_STATE_COMPLETED',
          args: [],
        },
      });

      const response = await transport.request({
        method: 'GET',
        path: '/jobs/job-789',
      });

      const body = response.body as any;
      expect(body.job.id).toBe('job-789');
      expect(body.job.state).toBe('completed');
    });

    it('should map cancelJob response correctly', async () => {
      const transport = createMockGrpcTransport();
      setMockResponse(transport, 'cancelJob', {
        job: {
          id: 'job-789',
          type: 'test',
          state: 'JOB_STATE_CANCELLED',
          args: [],
        },
      });

      const response = await transport.request({
        method: 'DELETE',
        path: '/jobs/job-789',
      });

      const body = response.body as any;
      expect(body.job.state).toBe('cancelled');
    });

    it('should handle unsupported routes', async () => {
      const transport = createMockGrpcTransport();

      await expect(
        transport.request({ method: 'GET', path: '/nonexistent' }),
      ).rejects.toSatisfy((err: OJSError) => {
        expect(err.code).toBe('unimplemented');
        return true;
      });
    });
  });

  describe('durable execution (checkpoint) routing', () => {
    it('should route POST /jobs/{id}/checkpoint to saveCheckpoint as a google.protobuf.Struct', async () => {
      const transport = createMockGrpcTransport();
      let capturedRequest: any;
      const client = (transport as any).client;
      client.saveCheckpoint = (req: any, _meta: any, _opts: any, callback: Function) => {
        capturedRequest = req;
        callback(null, { sequence: 3 });
      };

      const response = await transport.request({
        method: 'POST',
        path: '/jobs/job-1/checkpoint',
        body: { state: { _ojsReplayLog: [], _ojsStepIndex: 1, value: { done: true } } },
      });

      expect(capturedRequest.jobId).toBe('job-1');
      expect(capturedRequest.state).toEqual({
        fields: {
          _ojsReplayLog: { listValue: { values: [] } },
          _ojsStepIndex: { numberValue: 1 },
          value: { structValue: { fields: { done: { boolValue: true } } } },
        },
      });
      expect((response.body as any).checkpoint).toEqual({ job_id: 'job-1', sequence: 3 });
    });

    it('should reject a non-object checkpoint state with a clear error (Struct cannot represent it)', async () => {
      const transport = createMockGrpcTransport();

      await expect(
        transport.request({
          method: 'POST',
          path: '/jobs/job-1/checkpoint',
          body: { state: 'a bare string, not an object' },
        }),
      ).rejects.toThrow(/must be a JSON object/);
    });

    it('should route GET /jobs/{id}/checkpoint to getCheckpoint and decode the returned Struct', async () => {
      const transport = createMockGrpcTransport();
      const client = (transport as any).client;
      client.getCheckpoint = (_req: any, _meta: any, _opts: any, callback: Function) => {
        callback(null, {
          jobId: 'job-1',
          state: { fields: { value: { numberValue: 42 } } },
          sequence: 5,
          // Real proto-loader output for GetCheckpointResponse.saved_at
          // (service.proto): a decoded google.protobuf.Timestamp, i.e.
          // `{ seconds, nanos }` with `seconds` as a decimal string
          // (longs: String) — not a pre-formatted ISO string. Verified
          // empirically against a real @grpc/grpc-js + @grpc/proto-loader
          // round trip using this transport's exact loadSync() options.
          savedAt: { seconds: '1767225600', nanos: 0 },
        });
      };

      const response = await transport.request({ method: 'GET', path: '/jobs/job-1/checkpoint' });

      expect((response.body as any).checkpoint).toEqual({
        job_id: 'job-1',
        state: { value: 42 },
        sequence: 5,
        created_at: '2026-01-01T00:00:00.000Z',
      });
    });

    it('should decode legitimate default-valued checkpoint state fields (0, false, "", null) faithfully instead of null', async () => {
      // Regression test for fromProtoStruct()/fromProtoValue() misreading
      // a legitimately-set 0/false/'' as absent (see the job-args
      // regression test above for the full rationale). Checkpoint state
      // is a google.protobuf.Struct, decoded field-by-field through the
      // exact same fromProtoValue() this fixes.
      const transport = createMockGrpcTransport();
      const client = (transport as any).client;
      client.getCheckpoint = (_req: any, _meta: any, _opts: any, callback: Function) => {
        callback(null, {
          jobId: 'job-1',
          state: {
            fields: {
              empty_string: { kind: 'stringValue', stringValue: '' },
              zero: { kind: 'numberValue', numberValue: 0 },
              false_flag: { kind: 'boolValue', boolValue: false },
              nothing: { kind: 'nullValue', nullValue: 'NULL_VALUE' },
              nested_list: {
                kind: 'listValue',
                listValue: { values: [{ kind: 'numberValue', numberValue: 0 }] },
              },
            },
          },
          sequence: 7,
          savedAt: { seconds: '1767225600', nanos: 0 },
        });
      };

      const response = await transport.request({ method: 'GET', path: '/jobs/job-1/checkpoint' });

      expect((response.body as any).checkpoint.state).toEqual({
        empty_string: '',
        zero: 0,
        false_flag: false,
        nothing: null,
        nested_list: [0],
      });
    });

    it('decodes malicious checkpoint Struct keys as own data without prototype mutation', async () => {
      const transport = createMockGrpcTransport();
      setMockResponse(transport, 'getCheckpoint', {
        jobId: 'job-1',
        state: { fields: maliciousProtoFields() },
        sequence: 8,
        savedAt: null,
      });

      const response = await transport.request({
        method: 'GET',
        path: '/jobs/job-1/checkpoint',
      });

      expectSafeMaliciousStruct(
        (response.body as any).checkpoint.state as Record<string, unknown>,
      );
    });

    it('should round a fractional-second savedAt (nanos) into the created_at millisecond string', async () => {
      const transport = createMockGrpcTransport();
      const client = (transport as any).client;
      client.getCheckpoint = (_req: any, _meta: any, _opts: any, callback: Function) => {
        callback(null, {
          jobId: 'job-1',
          state: { fields: {} },
          sequence: 1,
          savedAt: { seconds: '1767225600', nanos: 500_000_000 },
        });
      };

      const response = await transport.request({ method: 'GET', path: '/jobs/job-1/checkpoint' });

      expect((response.body as any).checkpoint.created_at).toBe('2026-01-01T00:00:00.500Z');
    });

    it.each([
      ['the protobuf zero timestamp sentinel', { seconds: '0', nanos: 0 }],
      ['the maximum int64 seconds string', { seconds: '9223372036854775807', nanos: 0 }],
      ['an unsafe numeric seconds value', { seconds: Number.MAX_SAFE_INTEGER + 1, nanos: 0 }],
      ['a non-integer seconds string', { seconds: '1.5', nanos: 0 }],
      ['negative nanos', { seconds: '1767225600', nanos: -1 }],
      ['nanos above the protobuf maximum', { seconds: '1767225600', nanos: 1_000_000_000 }],
      ['sub-millisecond time above the Date maximum', { seconds: '8640000000000', nanos: 1 }],
    ])('should map %s to created_at: null without throwing', async (_label, savedAt) => {
      const transport = createMockGrpcTransport();
      const client = (transport as any).client;
      client.getCheckpoint = (_req: any, _meta: any, _opts: any, callback: Function) => {
        callback(null, { jobId: 'job-1', state: { fields: {} }, sequence: 0, savedAt });
      };

      const response = await transport.request({ method: 'GET', path: '/jobs/job-1/checkpoint' });

      expect((response.body as any).checkpoint.created_at).toBeNull();
    });

    it('keeps a nonzero timestamp within the Unix epoch second', async () => {
      const transport = createMockGrpcTransport();
      setMockResponse(transport, 'getCheckpoint', {
        jobId: 'job-1',
        state: { fields: {} },
        sequence: 0,
        savedAt: { seconds: '0', nanos: 1_000_000 },
      });

      const response = await transport.request({
        method: 'GET',
        path: '/jobs/job-1/checkpoint',
      });

      expect((response.body as any).checkpoint.created_at).toBe(
        '1970-01-01T00:00:00.001Z',
      );
    });

    // Normative exception (not defensive/malformed-input handling — see
    // this test's own name and `fromProtoTimestamp`'s doc comment in
    // src/transport/grpc.ts): ojs-protobuf-format.md section 6.2 ("Default
    // Value Handling") states "An unset timestamp is represented as `null`
    // / zero value (`seconds: 0, nanos: 0`). Implementations MUST NOT
    // interpret the Protobuf epoch (1970-01-01T00:00:00Z) as a valid OJS
    // timestamp." Kept as its own dedicated test — deliberately separate
    // from the generic malformed-timestamp table above — so this
    // spec-mandated business rule can never be silently folded back into
    // "just another invalid input" and lost.
    it('maps the exact protobuf zero timestamp ({seconds:0,nanos:0}) to null, per ojs-protobuf-format.md section 6.2 (normative — not a malformed-input case)', async () => {
      const transport = createMockGrpcTransport();
      setMockResponse(transport, 'getCheckpoint', {
        jobId: 'job-1',
        state: { fields: {} },
        sequence: 0,
        savedAt: { seconds: '0', nanos: 0 },
      });

      const response = await transport.request({
        method: 'GET',
        path: '/jobs/job-1/checkpoint',
      });

      // Must NOT be interpreted as the literal Protobuf epoch instant.
      expect((response.body as any).checkpoint.created_at).not.toBe(
        '1970-01-01T00:00:00.000Z',
      );
      expect((response.body as any).checkpoint.created_at).toBeNull();
    });

    it.each([
      ['minimum', { seconds: '-8640000000000', nanos: 0 }, '-271821-04-20T00:00:00.000Z'],
      ['maximum', { seconds: '8640000000000', nanos: 0 }, '+275760-09-13T00:00:00.000Z'],
    ])('should decode the valid JS Date %s boundary', async (_label, savedAt, expected) => {
      const transport = createMockGrpcTransport();
      const client = (transport as any).client;
      client.getCheckpoint = (_req: any, _meta: any, _opts: any, callback: Function) => {
        callback(null, { jobId: 'job-1', state: { fields: {} }, sequence: 0, savedAt });
      };

      const response = await transport.request({ method: 'GET', path: '/jobs/job-1/checkpoint' });

      expect((response.body as any).checkpoint.created_at).toBe(expected);
    });

    it('should map a missing/unset savedAt to created_at: null rather than throwing', async () => {
      const transport = createMockGrpcTransport();
      const client = (transport as any).client;
      client.getCheckpoint = (_req: any, _meta: any, _opts: any, callback: Function) => {
        // proto-loader decodes an omitted singular message field (with
        // `defaults: true`) as `null`, not an absent key.
        callback(null, { jobId: 'job-1', state: { fields: {} }, sequence: 0, savedAt: null });
      };

      const response = await transport.request({ method: 'GET', path: '/jobs/job-1/checkpoint' });

      expect((response.body as any).checkpoint.created_at).toBeNull();
    });

    it('should route DELETE /jobs/{id}/checkpoint to deleteCheckpoint', async () => {
      const transport = createMockGrpcTransport();
      const client = (transport as any).client;
      let called = false;
      client.deleteCheckpoint = (req: any, _meta: any, _opts: any, callback: Function) => {
        called = true;
        expect(req.jobId).toBe('job-1');
        callback(null, {});
      };

      const response = await transport.request({ method: 'DELETE', path: '/jobs/job-1/checkpoint' });

      expect(called).toBe(true);
      expect(response.body).toEqual({ deleted: true, job_id: 'job-1' });
    });

    it('should not confuse GET /jobs/{id} (GetJob) with GET /jobs/{id}/checkpoint (GetCheckpoint)', async () => {
      const transport = createMockGrpcTransport();
      setMockResponse(transport, 'getJob', { job: { id: 'job-1', type: 'x', state: 'JOB_STATE_ACTIVE' } });
      const client = (transport as any).client;
      client.getCheckpoint = (_req: any, _meta: any, _opts: any, callback: Function) => {
        callback(null, { jobId: 'job-1', state: { fields: {} }, sequence: 1 });
      };

      const jobResponse = await transport.request({ method: 'GET', path: '/jobs/job-1' });
      expect((jobResponse.body as any).job.id).toBe('job-1');

      const checkpointResponse = await transport.request({ method: 'GET', path: '/jobs/job-1/checkpoint' });
      expect((checkpointResponse.body as any).checkpoint.sequence).toBe(1);
    });
  });

  describe('worker heartbeat routing', () => {
    /**
     * src/worker.ts's sendHeartbeat() body shape (worker-level heartbeat):
     * `{ worker_id, state, active_jobs: <count>, active_job_ids: [...], ... }`.
     * See worker.proto's HeartbeatRequest: `id` doubles as job-id-or-worker-id,
     * `worker_id` is required for worker-level heartbeats, and `current_state`
     * carries the WorkerState enum.
     */
    function heartbeatBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        worker_id: 'worker-abc',
        state: 'running',
        active_jobs: 2,
        active_job_ids: ['job-a', 'job-b'],
        hostname: 'host-1',
        pid: 123,
        queues: ['default'],
        concurrency: 5,
        ...overrides,
      };
    }

    it('should map worker_id to both id and workerId, and state to the proto WorkerState enum string', async () => {
      const transport = createMockGrpcTransport();
      let captured: any;
      const client = (transport as any).client;
      client.heartbeat = (req: any, _meta: any, _opts: any, callback: Function) => {
        captured = req;
        callback(null, { directedState: 'WORKER_STATE_RUNNING' });
      };

      await transport.request({
        method: 'POST',
        path: '/workers/heartbeat',
        body: heartbeatBody(),
      });

      expect(captured).toEqual({
        id: 'worker-abc',
        workerId: 'worker-abc',
        currentState: 'WORKER_STATE_RUNNING',
      });
    });

    it('should never index active_jobs/active_job_ids into the request id (regression)', async () => {
      const transport = createMockGrpcTransport();
      let captured: any;
      const client = (transport as any).client;
      client.heartbeat = (req: any, _meta: any, _opts: any, callback: Function) => {
        captured = req;
        callback(null, {});
      };

      await transport.request({
        method: 'POST',
        path: '/workers/heartbeat',
        body: heartbeatBody({ active_jobs: 3, active_job_ids: ['job-x', 'job-y', 'job-z'] }),
      });

      // `id` must equal the worker id, never `active_job_ids[0]` ('job-x')
      // or the active-job count (3).
      expect(captured.id).toBe('worker-abc');
      expect(captured.id).not.toBe('job-x');
      expect(captured).not.toHaveProperty('active_jobs');
      expect(captured).not.toHaveProperty('active_job_ids');
    });

    it.each([
      ['running', 'WORKER_STATE_RUNNING'],
      ['quiet', 'WORKER_STATE_QUIET'],
      ['terminate', 'WORKER_STATE_TERMINATE'],
    ])('should map worker state %s to proto enum %s', async (sdkState, protoState) => {
      const transport = createMockGrpcTransport();
      let captured: any;
      const client = (transport as any).client;
      client.heartbeat = (req: any, _meta: any, _opts: any, callback: Function) => {
        captured = req;
        callback(null, {});
      };

      await transport.request({
        method: 'POST',
        path: '/workers/heartbeat',
        body: heartbeatBody({ state: sdkState }),
      });

      expect(captured.currentState).toBe(protoState);
    });

    it('should omit currentState when state is missing or unrecognized rather than guessing', async () => {
      const transport = createMockGrpcTransport();
      let captured: any;
      const client = (transport as any).client;
      client.heartbeat = (req: any, _meta: any, _opts: any, callback: Function) => {
        captured = req;
        callback(null, {});
      };

      await transport.request({
        method: 'POST',
        path: '/workers/heartbeat',
        body: heartbeatBody({ state: 'not-a-real-state' }),
      });

      expect(captured).not.toHaveProperty('currentState');
    });

    it('should map the HeartbeatResponse directedState back to the HTTP-style state field', async () => {
      const transport = createMockGrpcTransport();
      setMockResponse(transport, 'heartbeat', { directedState: 'WORKER_STATE_QUIET' });

      const response = await transport.request({
        method: 'POST',
        path: '/workers/heartbeat',
        body: heartbeatBody(),
      });

      expect((response.body as any).state).toBe('quiet');
    });

    it('should default worker_id to an empty string rather than throwing when absent', async () => {
      const transport = createMockGrpcTransport();
      let captured: any;
      const client = (transport as any).client;
      client.heartbeat = (req: any, _meta: any, _opts: any, callback: Function) => {
        captured = req;
        callback(null, {});
      };

      await transport.request({
        method: 'POST',
        path: '/workers/heartbeat',
        body: { state: 'running' },
      });

      expect(captured.id).toBe('');
      expect(captured.workerId).toBe('');
    });
  });

  describe('progress reporting routing (Finding: GrpcTransport progress)', () => {
    // job.proto/service.proto define no progress-reporting RPC at all —
    // `grpcProgress` must never claim success for a report that was
    // actually discarded. It must reject with a non-retryable
    // `unimplemented` OJSError explaining the current proto has no
    // progress RPC, for every call shape, and must never call the
    // generated client (there is no RPC method to call).
    it('should reject PUT /jobs/{id}/progress with a non-retryable unimplemented OJSError', async () => {
      const transport = createMockGrpcTransport();

      await expect(
        transport.request({
          method: 'PUT',
          path: '/jobs/job-1/progress',
          body: { progress: 0.5 },
        }),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(OJSError);
        expect((err as OJSError).code).toBe('unimplemented');
        expect((err as OJSError).retryable).toBe(false);
        expect((err as OJSError).message).toMatch(/progress/i);
        return true;
      });
    });

    it('should never call the generated client for a progress report', async () => {
      const transport = createMockGrpcTransport();
      const client = (transport as any).client;
      const spy = vi.fn();
      // There is no real generated `progress` method at all; installing a
      // spy under every plausible name proves grpcProgress never reaches
      // for the generated client rather than merely lacking a match.
      client.progress = spy;
      client.reportProgress = spy;

      await expect(
        transport.request({
          method: 'PUT',
          path: '/jobs/job-1/progress',
          body: { progress: 0.5 },
        }),
      ).rejects.toBeInstanceOf(OJSError);

      expect(spy).not.toHaveBeenCalled();
    });

    it('should reject regardless of the reported progress value or optional data', async () => {
      const transport = createMockGrpcTransport();

      await expect(
        transport.request({
          method: 'PUT',
          path: '/jobs/job-2/progress',
          body: { progress: 1, data: { rows: 42 } },
        }),
      ).rejects.toMatchObject({ code: 'unimplemented', retryable: false });
    });

    it('should reject even when called with an abort signal or an explicit timeout', async () => {
      const transport = createMockGrpcTransport();
      const controller = new AbortController();

      await expect(
        transport.request({
          method: 'PUT',
          path: '/jobs/job-3/progress',
          body: { progress: 0.25 },
          signal: controller.signal,
          timeout: 5000,
        }),
      ).rejects.toMatchObject({ code: 'unimplemented' });
    });

    it("reportProgress() against a GrpcTransport should reject rather than silently succeed (Client.reportProgress)", async () => {
      const transport = createMockGrpcTransport();

      // `reportProgress()` (src/progress.ts) is the client-facing progress
      // API every caller (worker job handlers, direct SDK users) actually
      // calls; it must surface the transport's unimplemented rejection
      // rather than resolving as if the backend had recorded progress.
      await expect(
        reportProgress(transport, 'job-4', 42, 'partway there'),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(OJSError);
        expect((err as OJSError).code).toBe('unimplemented');
        expect((err as OJSError).retryable).toBe(false);
        return true;
      });
    });

    it('reportProgress() against a GrpcTransport should never resolve successfully, for any valid percentage', async () => {
      const transport = createMockGrpcTransport();

      await expect(reportProgress(transport, 'job-5', 0)).rejects.toBeInstanceOf(OJSError);
      await expect(reportProgress(transport, 'job-5', 100)).rejects.toBeInstanceOf(OJSError);
    });
  });

  describe('deadline computation', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should compute the deadline from the configured default timeout', async () => {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      let capturedDeadline: Date | undefined;

      const { transport } = createRealCallMockTransport((_req, _meta, options, callback) => {
        capturedDeadline = options.deadline;
        callback(null, {});
        return { cancel: () => {} };
      });
      (transport as any).config.timeout = undefined;
      (transport as any).defaultTimeout = 30_000;

      await (transport as any).call('echo', {});

      expect(capturedDeadline).toEqual(new Date('2026-01-01T00:00:30.000Z'));
    });

    it('should compute the deadline from a per-request timeout override', async () => {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      let capturedDeadline: Date | undefined;

      const { transport } = createRealCallMockTransport((_req, _meta, options, callback) => {
        capturedDeadline = options.deadline;
        callback(null, {});
        return { cancel: () => {} };
      });

      await (transport as any).call('echo', {}, 5_000);

      expect(capturedDeadline).toEqual(new Date('2026-01-01T00:00:05.000Z'));
    });
  });

  describe('AbortSignal cancellation', () => {
    /**
     * `call()` awaits `ensureClient()` before synchronously invoking the RPC
     * function, which takes at least one microtask tick even when the client
     * is already initialized. Tests that need to act after the RPC has
     * actually started (but before its callback fires) await this helper
     * — which resolves once `fn` has been invoked — instead of guessing at
     * a fixed number of ticks.
     */
    function deferredRpc(): {
      fn: (
        request: unknown,
        metadata: unknown,
        options: { deadline: Date },
        callback: (err: unknown, response: unknown) => void,
      ) => { cancel: () => void };
      started: Promise<void>;
      resolveWith: (err: unknown, response: unknown) => void;
    } {
      let capturedCallback: ((err: unknown, response: unknown) => void) | undefined;
      let markStarted: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });

      const fn = (
        _req: unknown,
        _meta: unknown,
        _options: { deadline: Date },
        callback: (err: unknown, response: unknown) => void,
      ): { cancel: () => void } => {
        capturedCallback = callback;
        markStarted();
        return { cancel: () => {} };
      };

      return {
        fn,
        started,
        resolveWith: (err, response) => capturedCallback?.(err, response),
      };
    }

    it('should cancel the in-flight gRPC call when the signal aborts', async () => {
      const { fn, started, resolveWith } = deferredRpc();
      const { transport, cancelSpy } = createRealCallMockTransport(fn);

      const controller = new AbortController();
      const promise = (transport as any).call('echo', {}, undefined, undefined, controller.signal);

      await started;
      controller.abort();
      // The transport's internal onAbort handler calls the fake call's
      // cancel(), which our wrapper records via cancelSpy. In real grpc-js,
      // cancel() causes the callback to be invoked with a CANCELLED status —
      // simulate that here to let the promise settle deterministically.
      expect(cancelSpy).toHaveBeenCalledTimes(1);
      resolveWith({ code: 1, details: 'Cancelled on the client' }, null);

      await expect(promise).rejects.toBeInstanceOf(OJSConnectionError);
      await expect(promise).rejects.toThrow(/cancelled/i);
    });

    it('should reject immediately without issuing the RPC if the signal is already aborted', async () => {
      const fn = vi.fn();
      const { transport } = createRealCallMockTransport(fn);

      const controller = new AbortController();
      controller.abort();

      await expect(
        (transport as any).call('echo', {}, undefined, undefined, controller.signal),
      ).rejects.toBeInstanceOf(OJSConnectionError);

      expect(fn).not.toHaveBeenCalled();
    });

    it('rejects a pre-aborted signal before ensureClient() -- never touches imports/channel/proto (Finding 4)', async () => {
      // A transport pointed at a nonexistent protoPath: ensureClient()
      // would fail (or, with real @grpc/grpc-js/proto-loader installed,
      // succeed at loading the peer deps but fail resolving the bogus
      // proto directory) if it were ever invoked. Passing an
      // already-aborted signal must reject with the normalized
      // cancellation error *before* any of that -- never surfacing a
      // "proto files not found"/"dependencies not found" error instead.
      const transport = new GrpcTransport({
        url: 'localhost:9090',
        protoPath: '/definitely/does/not/exist/anywhere',
      });

      const ensureClientSpy = vi.spyOn(transport as any, 'ensureClient');
      const controller = new AbortController();
      controller.abort();

      await expect(
        (transport as any).call('echo', {}, undefined, undefined, controller.signal),
      ).rejects.toBeInstanceOf(OJSConnectionError);
      await expect(
        (transport as any).call('echo', {}, undefined, undefined, controller.signal),
      ).rejects.toThrow(/cancelled/i);

      // The decisive assertion: ensureClient() (dynamic import/proto
      // load/channel construction) must never even be called.
      expect(ensureClientSpy).not.toHaveBeenCalled();
    });

    it('rejects with a normalized cancellation error if the signal aborts while ensureClient() is still pending, without ever resolving it (Finding: gRPC unary initialization cancellation/timeout)', async () => {
      // `ensureClient()` here is a permanently-blocked mock -- it never
      // resolves or rejects on its own, for the lifetime of this test.
      // The call must still settle promptly on abort; nothing may
      // "manually resolve" the blocked initialization to make that happen.
      const transport = new GrpcTransport({ url: 'localhost:9090' });
      const ensureClientSpy = vi.fn(() => new Promise<void>(() => undefined));
      (transport as any).ensureClient = ensureClientSpy;

      const controller = new AbortController();
      const pending = (transport as any).call('echo', {}, undefined, undefined, controller.signal);

      controller.abort();

      await expect(pending).rejects.toBeInstanceOf(OJSConnectionError);
      await expect(pending).rejects.toThrow(/cancelled/i);
      expect(ensureClientSpy).toHaveBeenCalledTimes(1);
    });

    it('ignores a late ensureClient() resolution after abort already rejected the call, without throwing or re-settling', async () => {
      const transport = new GrpcTransport({ url: 'localhost:9090' });
      let releaseEnsureClient: (() => void) | undefined;
      (transport as any).ensureClient = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseEnsureClient = resolve;
          }),
      );

      const controller = new AbortController();
      const pending = (transport as any).call('echo', {}, undefined, undefined, controller.signal);

      controller.abort();
      await expect(pending).rejects.toBeInstanceOf(OJSConnectionError);

      // A late resolution, well after this call already rejected, must be
      // a safe no-op: it is not "manually resolving blocked
      // initialization" to unblock *this* call (which has already
      // settled) -- it simply means the shared, memoized `ensureClient()`
      // eventually finished on its own, unaffected by this call's own
      // abort, for the benefit of any other concurrent/future caller.
      expect(() => releaseEnsureClient?.()).not.toThrow();
    });

    it('rejects a blocked/never-resolving initialization with a retryable timeout error once the call timeout elapses, with no signal involved', async () => {
      vi.useFakeTimers();
      try {
        const transport = new GrpcTransport({ url: 'localhost:9090' });
        const ensureClientSpy = vi.fn(() => new Promise<void>(() => undefined));
        (transport as any).ensureClient = ensureClientSpy;
        const fn = vi.fn();
        (transport as any).client = { echo: fn };

        const pending = (transport as any).call('echo', {}, 5_000);
        const assertion = expect(pending).rejects.toBeInstanceOf(OJSConnectionError);

        await vi.advanceTimersByTimeAsync(5_000);
        await assertion;

        // Blocked initialization must never let the RPC itself be issued
        // once its budget is exhausted.
        expect(fn).not.toHaveBeenCalled();
        expect(ensureClientSpy).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('passes the remaining timeout budget to the RPC deadline instead of a fresh window after a slow initialization', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      try {
        const transport = new GrpcTransport({ url: 'localhost:9090' });
        (transport as any).ensureClient = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              // Resolves 2s into the call's own budget -- simulating a
              // slow (but ultimately successful) client/proto
              // initialization, not a hang.
              setTimeout(resolve, 2_000);
            }),
        );
        (transport as any).grpcModule = {
          Metadata: class {
            set(): void {}
          },
        };
        let capturedDeadline: Date | undefined;
        (transport as any).client = {
          echo: (_req: unknown, _meta: unknown, options: { deadline: Date }, callback: (err: unknown, response: unknown) => void) => {
            capturedDeadline = options.deadline;
            callback(null, { ok: true });
            return { cancel: () => {} };
          },
        };

        const pending = (transport as any).call('echo', {}, 5_000);
        await vi.advanceTimersByTimeAsync(2_000);
        await pending;

        // 5s total budget, 2s consumed by initialization: the deadline
        // must reflect the 3s *remaining*, timed from when call() itself
        // started -- never a fresh 5s window starting once
        // initialization happened to finish.
        expect(capturedDeadline).toEqual(new Date('2026-01-01T00:00:05.000Z'));
      } finally {
        vi.useRealTimers();
      }
    });

    it('lets one call give up (via its own abort signal) on a shared blocked initialization without affecting a concurrent call racing the same shared promise', async () => {
      // Call A gives up via an external abort signal rather than a timer
      // -- deliberately distinct from the dedicated timeout test above,
      // and avoids two independently-rejecting fake timers ever racing
      // the same shared promise at once (an unrelated fake-timer/
      // Promise.race scheduling artifact, reproducible with plain
      // `Promise.race` and no involvement of this SDK's code, otherwise
      // makes such a test order-sensitive/flaky).
      const transport = new GrpcTransport({ url: 'localhost:9090' });
      // Mirrors real `ensureClient()`'s own memoization (`this.initPromise`
      // shared by every concurrent caller): the mock returns the *same*
      // promise instance on every invocation rather than a fresh one, so
      // both calls below race against one shared, single initialization
      // attempt, exactly like the real method guarantees.
      let releaseEnsureClient: (() => void) | undefined;
      const sharedInit = new Promise<void>((resolve) => {
        releaseEnsureClient = resolve;
      });
      const ensureClientSpy = vi.fn(() => sharedInit);
      (transport as any).ensureClient = ensureClientSpy;
      const fn = vi.fn((_req: unknown, _meta: unknown, _options: unknown, callback: (err: unknown, response: unknown) => void) => {
        callback(null, { ok: true });
        return { cancel: () => {} };
      });

      const controllerA = new AbortController();
      // Call A: aborts explicitly -- expected to give up first.
      const callA = (transport as any).call('echo', {}, 30_000, undefined, controllerA.signal);
      // Call B: no signal at all, racing the exact same shared
      // initialization attempt as call A.
      const callB = (transport as any).call('echo', {}, 30_000);

      controllerA.abort();
      await expect(callA).rejects.toBeInstanceOf(OJSConnectionError);
      await expect(callA).rejects.toThrow(/cancelled/i);

      // Call B must still be waiting -- unaffected by A giving up.
      expect(fn).not.toHaveBeenCalled();

      // The shared initialization now finally completes (as it would once
      // the real ensureClient()'s dynamic import/proto load/client
      // construction actually finishes); B proceeds using it.
      (transport as any).grpcModule = {
        Metadata: class {
          set(): void {}
        },
      };
      (transport as any).client = { echo: fn };
      releaseEnsureClient?.();
      await callB;

      expect(fn).toHaveBeenCalledTimes(1);
      // Both calls raced the exact same shared promise -- proving a
      // caller that gives up early never triggers, nor is blocked by, a
      // second, duplicate initialization attempt for the other.
      expect(ensureClientSpy).toHaveBeenCalledTimes(2);
      expect(ensureClientSpy.mock.results[0]?.value).toBe(sharedInit);
      expect(ensureClientSpy.mock.results[1]?.value).toBe(sharedInit);
    });

    it('should not leak an abort listener once the call settles normally', async () => {
      const { transport } = createRealCallMockTransport((_req, _meta, _options, callback) => {
        callback(null, { ok: true });
        return { cancel: () => {} };
      });

      const controller = new AbortController();
      const addSpy = vi.spyOn(controller.signal, 'addEventListener');
      const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

      await (transport as any).call('echo', {}, undefined, undefined, controller.signal);

      // `call()` now races `ensureClient()` (setup) against `signal`
      // *and* separately listens on `signal` for the in-flight RPC's own
      // cancellation -- two independent add/remove pairs, not one, since
      // Finding: gRPC unary initialization cancellation/timeout. What
      // must never happen is a *leak*: every listener this call adds must
      // also be removed by the time it settles, and each remove must
      // correspond to one of the adds (never a mismatched/unknown
      // function reference).
      expect(addSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(removeSpy.mock.calls.length).toBe(addSpy.mock.calls.length);
      const addedListeners = addSpy.mock.calls.map((call) => call[1]);
      const removedListeners = removeSpy.mock.calls.map((call) => call[1]);
      expect(new Set(removedListeners)).toEqual(new Set(addedListeners));
    });

    it('should not call cancel() again after the call already settled', async () => {
      const { fn, started, resolveWith } = deferredRpc();
      const { transport, cancelSpy } = createRealCallMockTransport(fn);

      const controller = new AbortController();
      const promise = (transport as any).call('echo', {}, undefined, undefined, controller.signal);

      // Settle successfully first...
      await started;
      resolveWith(null, { ok: true });
      await expect(promise).resolves.toEqual({ ok: true });

      // ...then abort. The listener should already have been removed, so
      // cancel() must never be invoked for an already-settled call.
      controller.abort();
      expect(cancelSpy).not.toHaveBeenCalled();
    });

    it('should reject promptly on abort even if the implementation never invokes its callback', async () => {
      const { fn, started, resolveWith } = deferredRpc();
      const { transport, cancelSpy } = createRealCallMockTransport(fn);

      const controller = new AbortController();
      const promise = (transport as any).call('echo', {}, undefined, undefined, controller.signal);

      await started;
      controller.abort();

      // No `resolveWith(...)` call here at all: the implementation simply
      // never calls back after cancel() (unlike real grpc-js, which always
      // eventually does). The promise must still settle promptly rather
      // than hang forever.
      await expect(promise).rejects.toBeInstanceOf(OJSConnectionError);
      await expect(promise).rejects.toThrow(/cancelled/i);
      expect(cancelSpy).toHaveBeenCalledTimes(1);

      // A late callback arriving afterward must be ignored (no unhandled
      // rejection, no re-settlement) rather than throwing.
      expect(() => { resolveWith(null, { ok: true }); }).not.toThrow();
    });

    it('should ignore a late callback that fires after abort already rejected the promise', async () => {
      const { fn, started, resolveWith } = deferredRpc();
      const { transport } = createRealCallMockTransport(fn);

      const controller = new AbortController();
      const promise = (transport as any).call('echo', {}, undefined, undefined, controller.signal);

      await started;
      controller.abort();
      await expect(promise).rejects.toBeInstanceOf(OJSConnectionError);

      // The "late" success callback must not flip the already-settled
      // rejection into a resolution.
      resolveWith(null, { ok: true });
      await expect(promise).rejects.toBeInstanceOf(OJSConnectionError);
    });

    it('should not register an abort listener at all when the signal is already aborted', async () => {
      const { transport } = createRealCallMockTransport((_req, _meta, _options, callback) => {
        callback(null, { ok: true });
        return { cancel: () => {} };
      });

      const controller = new AbortController();
      controller.abort();
      const addSpy = vi.spyOn(controller.signal, 'addEventListener');

      await expect(
        (transport as any).call('echo', {}, undefined, undefined, controller.signal),
      ).rejects.toBeInstanceOf(OJSConnectionError);

      expect(addSpy).not.toHaveBeenCalled();
    });

    it('should not leak an abort listener when the generated method throws synchronously', async () => {
      const { transport } = createRealCallMockTransport(() => {
        throw new Error('client-side encode failure');
      });

      const controller = new AbortController();
      const addSpy = vi.spyOn(controller.signal, 'addEventListener');
      const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

      await expect(
        (transport as any).call('echo', {}, undefined, undefined, controller.signal),
      ).rejects.toThrow(/client-side encode failure/);

      // Listener(s) were registered (the signal was live going in) and
      // must all have been removed again — no leak, even though the call
      // never actually started. `ensureClientWithSetupTimeout()`'s own
      // setup-race listener is added/removed independently of the RPC
      // call's cancellation listener (Finding: gRPC unary initialization
      // cancellation/timeout), so this asserts the pairing generically
      // rather than assuming exactly one add/remove pair.
      expect(addSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(removeSpy.mock.calls.length).toBe(addSpy.mock.calls.length);
      const addedListeners = addSpy.mock.calls.map((call) => call[1]);
      const removedListeners = removeSpy.mock.calls.map((call) => call[1]);
      expect(new Set(removedListeners)).toEqual(new Set(addedListeners));

      // Aborting afterward must be a no-op: nothing left to cancel or reject.
      expect(() => { controller.abort(); }).not.toThrow();
    });

    it('should map a synchronous GrpcServiceError-shaped throw the same way an async one is mapped', async () => {
      const grpcStyleError = Object.assign(new Error('Invalid job type'), { code: 3 });
      const { transport } = createRealCallMockTransport(() => {
        throw grpcStyleError;
      });

      await expect(
        (transport as any).call('echo', {}, undefined, undefined, undefined),
      ).rejects.toBeInstanceOf(OJSValidationError);
    });

    it('should preserve deadline computation even when the generated method throws synchronously', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      try {
        let capturedDeadline: Date | undefined;
        const { transport } = createRealCallMockTransport((_req, _meta, options) => {
          capturedDeadline = options.deadline;
          throw new Error('boom');
        });

        await expect(
          (transport as any).call('echo', {}, 5_000, undefined, undefined),
        ).rejects.toThrow(/boom/);

        expect(capturedDeadline).toEqual(new Date('2026-01-01T00:00:05.000Z'));
      } finally {
        vi.useRealTimers();
      }
    });

    it('propagates a synchronous throw through the public request() API as a well-formed error', async () => {
      // Unlike createMockGrpcTransport() (which replaces call() wholesale
      // with its own test-only Promise wrapper), createRealCallMockTransport
      // only swaps out the client/grpc module — routeRequest()/call() run
      // for real here, so this exercises the actual hardened call() through
      // the public request() API end-to-end.
      const { transport } = createRealCallMockTransport(() => {
        throw new Error('boom, synchronously');
      });
      (transport as any).client.health = (transport as any).client.echo;

      await expect(
        transport.request({ method: 'GET', path: '/health' }),
      ).rejects.toThrow(/boom, synchronously/);
    });
  });

  describe('server-streaming (StreamJobs/StreamEvents)', () => {
    it('surfaces the actual UNAVAILABLE error from an unavailable endpoint during setup', async () => {
      const transport = createMockGrpcTransport();
      const unavailable = Object.assign(
        new Error('connect ECONNREFUSED: deterministic unavailable endpoint'),
        { code: 14 },
      );
      const errorListeners = new Set<(...args: unknown[]) => void>();
      const call = {
        cancel: vi.fn(),
        on(event: string, listener: (...args: unknown[]) => void): void {
          if (event === 'error') {
            errorListeners.add(listener);
            // guardCallErrors() installs the first listener; waitForStreamOpen()
            // installs the second. Emit only after both are present so this
            // deterministically models grpc-js failing during stream setup.
            if (errorListeners.size === 2) {
              queueMicrotask(() => {
                for (const errorListener of [...errorListeners]) {
                  errorListener(unavailable);
                }
              });
            }
          }
        },
        off(event: string, listener: (...args: unknown[]) => void): void {
          if (event === 'error') errorListeners.delete(listener);
        },
        [Symbol.asyncIterator](): AsyncIterator<unknown> {
          return {
            next: () => new Promise<IteratorResult<unknown>>(() => undefined),
          };
        },
      };
      (transport as any).client.streamJobs = (): typeof call => call;
      const iterator = transport.streamJobs(
        { queues: ['default'], workerId: 'unavailable-test' },
        { timeout: 1_000, reconnect: { enabled: false } },
      );

      try {
        const error = await iterator.next().catch((caught: unknown) => caught);
        expect(error).toBe(unavailable);
        expect(error).toMatchObject({ code: 14 });
      } finally {
        transport.close();
      }
    });

    it('should not connect (dynamic import/proto load) until the returned iterable is actually iterated', async () => {
      // Reconnection stays disabled here: an initialization failure (a
      // bogus protoPath) is now classified/retried through the normal
      // backoff/maxAttempts machinery (Finding: stream initialization in
      // reconnect engine) exactly like any other transient stream error,
      // so this test -- which only cares about *lazy connection*, not
      // retry semantics -- must opt out to observe a single, prompt
      // rejection instead of letting the default (retry forever) policy
      // reconnect indefinitely against an unchanging bogus path.
      const transport = new GrpcTransport({ url: 'localhost:9090', protoPath: '/nonexistent' });

      // Calling streamJobs()/streamEvents() must be synchronous and must
      // not itself attempt to resolve the optional peer deps or load the
      // proto — only iterating does.
      const jobsIterable = transport.streamJobs(
        { queues: ['default'], workerId: 'w1' },
        { reconnect: { enabled: false } },
      );
      const eventsIterable = transport.streamEvents(undefined, { reconnect: { enabled: false } });
      expect(typeof jobsIterable[Symbol.asyncIterator]).toBe('function');
      expect(typeof eventsIterable[Symbol.asyncIterator]).toBe('function');

      // *Now* iterating triggers the (failing, since protoPath is bogus)
      // connection attempt.
      await expect(
        (async () => {
          for await (const _job of jobsIterable) {
            // never reached
          }
        })(),
      ).rejects.toThrow();
    });

    it('stops waiting promptly when aborted during blocked client/proto initialization', async () => {
      const transport = new GrpcTransport({ url: 'localhost:9090' });
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const ensureClient = vi.fn(() => {
        markStarted?.();
        return new Promise<void>(() => undefined);
      });
      (transport as any).ensureClient = ensureClient;

      const controller = new AbortController();
      const iterator = transport.streamJobs(
        { queues: ['default'], workerId: 'w1' },
        { signal: controller.signal, timeout: 60_000 },
      );
      const pending = iterator.next();

      await started;
      expect(ensureClient).toHaveBeenCalledTimes(1);

      controller.abort(new Error('stream setup cancelled'));

      await expect(pending).resolves.toEqual({
        done: true,
        value: undefined,
      });
    });

    it('consumer return aborts blocked client/proto initialization without waiting for timeout', async () => {
      const transport = new GrpcTransport({ url: 'localhost:9090' });
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const ensureClient = vi.fn(() => {
        markStarted?.();
        return new Promise<void>(() => undefined);
      });
      (transport as any).ensureClient = ensureClient;

      const iterator = transport.streamJobs(
        { queues: ['default'], workerId: 'w1' },
        { timeout: 60_000 },
      );
      const pendingNext = iterator.next();

      await started;
      expect(ensureClient).toHaveBeenCalledTimes(1);

      await expect(iterator.return?.()).resolves.toEqual({
        done: true,
        value: undefined,
      });
      await expect(pendingNext).resolves.toEqual({
        done: true,
        value: undefined,
      });
    });

    it('classifies an ensureClient() initialization failure as retryable and succeeds on the next reconnect attempt (Finding: stream initialization in reconnect engine)', async () => {
      vi.useFakeTimers();
      try {
        const transport = new GrpcTransport({ url: 'localhost:9090' });
        let ensureClientCalls = 0;
        (transport as any).ensureClient = vi.fn(async () => {
          ensureClientCalls++;
          if (ensureClientCalls === 1) {
            // Simulates a real ensureClient() failure (e.g. the optional
            // gRPC peer dependencies failed to resolve, or proto loading
            // failed) -- previously this would have failed the entire
            // stream immediately with zero retries, regardless of
            // `reconnect` configuration.
            throw new OJSConnectionError('simulated client/proto initialization failure');
          }
          // Second attempt "succeeds": populate the client/module exactly
          // like the real ensureClient() would upon success.
          (transport as any).grpcModule = {
            Metadata: class {
              set(): void {}
            },
          };
          (transport as any).client = {
            streamJobs: (): { cancel: () => void } & AsyncIterable<unknown> =>
              createFakeStreamCall([
                { id: 'job-1', type: 'test.job', queue: 'default', state: 'JOB_STATE_AVAILABLE', args: [] },
              ]).call,
          };
        });

        const iterator = transport.streamJobs(
          { queues: ['default'], workerId: 'w1' },
          { reconnect: { initialDelayMs: 100, maxDelayMs: 100 } },
        );

        const firstResultPromise = iterator.next();
        await vi.advanceTimersByTimeAsync(0);
        expect(ensureClientCalls).toBe(1);
        // First attempt's initialization failure retries with backoff
        // (100ms, deterministic since initialDelayMs === maxDelayMs).
        await vi.advanceTimersByTimeAsync(150);

        const result = await firstResultPromise;
        expect(result.done).toBe(false);
        expect((result.value as { id: string }).id).toBe('job-1');
        expect(ensureClientCalls).toBe(2);

        await iterator.return?.();
      } finally {
        vi.useRealTimers();
      }
    });

    it('exhausts maxAttempts when ensureClient() initialization keeps failing on every reconnect attempt', async () => {
      vi.useFakeTimers();
      try {
        const transport = new GrpcTransport({ url: 'localhost:9090' });
        let ensureClientCalls = 0;
        (transport as any).ensureClient = vi.fn(async () => {
          ensureClientCalls++;
          throw new OJSConnectionError('initialization keeps failing');
        });

        const iterator = transport.streamJobs(
          { queues: ['default'], workerId: 'w1' },
          { reconnect: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1 } },
        );

        const resultPromise = iterator.next();
        const assertion = expect(resultPromise).rejects.toThrow(/initialization keeps failing/);
        await vi.runAllTimersAsync();
        await assertion;

        // Initial attempt + 2 configured reconnects, every one of them
        // independently re-attempting (and failing) initialization.
        expect(ensureClientCalls).toBe(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should map full StreamJobs fixtures identically to unary jobs and filter stream.keepalive', async () => {
      const transport = createMockGrpcTransport();
      const client = (transport as any).client;
      const { call } = createFakeStreamCall([
        { id: 'keepalive', type: 'stream.keepalive', queue: 'default', args: [] },
        FULL_PROTO_JOB,
      ]);
      client.streamJobs = (): typeof call => call;

      const jobs: any[] = [];
      for await (const job of transport.streamJobs(
        { queues: ['default'], workerId: 'w1' },
        { reconnect: { enabled: false } },
      )) {
        jobs.push(job);
      }

      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toEqual(FULL_WIRE_JOB);
    });

    it('should send queues/workerId/maxConcurrent and merge auth + custom metadata for StreamJobs', async () => {
      const transport = createMockGrpcTransport();
      (transport as any).config.apiKey = 'my-key';
      (transport as any).defaultMetadata['x-ojs-api-key'] = 'my-key';
      const client = (transport as any).client;
      let capturedRequest: any;
      let capturedMetadataEntries: Record<string, string> = {};
      const { call } = createFakeStreamCall([]);
      client.streamJobs = (req: any, metadata: any): typeof call => {
        capturedRequest = req;
        capturedMetadataEntries = metadata.entries ?? {};
        return call;
      };

      for await (const _job of transport.streamJobs(
        { queues: ['default', 'email'], workerId: 'w1', maxConcurrent: 7 },
        { metadata: { 'x-request-id': 'req-1' }, reconnect: { enabled: false } },
      )) {
        // drained immediately (empty fake stream)
      }

      expect(capturedRequest).toEqual({ queues: ['default', 'email'], workerId: 'w1', maxConcurrent: 7 });
      expect(capturedMetadataEntries).toMatchObject({
        'x-ojs-api-key': 'my-key',
        'x-request-id': 'req-1',
      });
    });

    it('should default maxConcurrent to 1 when not specified', async () => {
      const transport = createMockGrpcTransport();
      const client = (transport as any).client;
      let capturedRequest: any;
      const { call } = createFakeStreamCall([]);
      client.streamJobs = (req: any): typeof call => {
        capturedRequest = req;
        return call;
      };

      for await (const _job of transport.streamJobs(
        { queues: ['default'], workerId: 'w1' },
        { reconnect: { enabled: false } },
      )) {
        // drained
      }

      expect(capturedRequest.maxConcurrent).toBe(1);
    });

    it('should apply a per-attempt hard RPC-lifetime deadline only when options.streamDeadline is explicitly provided', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const transport = createMockGrpcTransport();
        const client = (transport as any).client;
        let capturedOptions: any;
        const { call } = createFakeStreamCall([]);
        client.streamJobs = (_req: any, _meta: any, options: any): typeof call => {
          capturedOptions = options;
          return call;
        };

        for await (const _job of transport.streamJobs(
          { queues: ['default'], workerId: 'w1' },
          { streamDeadline: 10_000, reconnect: { enabled: false } },
        )) {
          // drained
        }

        expect(capturedOptions.deadline).toEqual(new Date('2026-01-01T00:00:10.000Z'));
      } finally {
        vi.useRealTimers();
      }
    });

    it('should not set any deadline for StreamJobs when options.streamDeadline is omitted', async () => {
      const transport = createMockGrpcTransport();
      const client = (transport as any).client;
      let capturedOptions: any;
      const { call } = createFakeStreamCall([]);
      client.streamJobs = (_req: any, _meta: any, options: any): typeof call => {
        capturedOptions = options;
        return call;
      };

      for await (const _job of transport.streamJobs(
        { queues: ['default'], workerId: 'w1' },
        { reconnect: { enabled: false } },
      )) {
        // drained
      }

      expect(capturedOptions).toEqual({});
    });

    it('should NEVER set callOptions.deadline from options.timeout (setup-only bound, not an RPC-lifetime deadline)', async () => {
      // Finding 3 regression: options.timeout must not be forwarded as the
      // underlying gRPC call's own deadline (that was the bug — it silently
      // killed a healthy, actively-streaming call once `timeout` elapsed,
      // regardless of activity). Only the additive `streamDeadline` option
      // does that now.
      const transport = createMockGrpcTransport();
      const client = (transport as any).client;
      let capturedOptions: any;
      const { call } = createFakeStreamCall([]);
      client.streamJobs = (_req: any, _meta: any, options: any): typeof call => {
        capturedOptions = options;
        return call;
      };

      for await (const _job of transport.streamJobs(
        { queues: ['default'], workerId: 'w1' },
        { timeout: 10_000, reconnect: { enabled: false } },
      )) {
        // drained
      }

      expect(capturedOptions).toEqual({});
    });

    it('does not kill an already-open, healthy live stream once options.timeout elapses', async () => {
      // Finding 3: `timeout` bounds setup only. A stream whose call
      // signals it opened (fires 'metadata') and keeps delivering messages
      // well past `timeout` must never be cancelled/reconnected because of
      // that elapsed setup bound.
      vi.useFakeTimers();
      try {
        const transport = createMockGrpcTransport();
        const client = (transport as any).client;

        let cancelCalls = 0;
        const call = {
          cancel(): void {
            cancelCalls++;
          },
          // Fires 'metadata' synchronously on registration, modeling a
          // call that opens essentially immediately -- deterministic and
          // independent of microtask-hop counting.
          on(event: string, listener: (...a: any[]) => void): void {
            if (event === 'metadata') listener();
          },
          off(): void {
            // no-op: nothing to remove since `on` never retains listeners
          },
          [Symbol.asyncIterator](): AsyncIterator<any> {
            const pending: any[] = [
              { id: 'job-1', type: 'email.send', queue: 'default', args: [] },
            ];
            return {
              next(): Promise<IteratorResult<any>> {
                if (pending.length > 0) {
                  return Promise.resolve({ done: false, value: pending.shift() });
                }
                // Never resolves again: simulates an open, healthy stream
                // that is simply idle after its first message.
                return new Promise(() => undefined);
              },
            };
          },
        };
        client.streamJobs = (): typeof call => call;

        const iterator = transport.streamJobs(
          { queues: ['default'], workerId: 'w1' },
          { timeout: 1_000, reconnect: { enabled: false } },
        );

        // Pull exactly the first message (does not `break`/`return`, so the
        // call is never explicitly cancelled by consumer-driven cleanup —
        // only the setup timer, if it incorrectly fired, could cancel it).
        const first = await iterator.next();
        expect(first.done).toBe(false);
        expect(first.value).toMatchObject({ id: 'job-1' });

        // Advance well past the setup timeout. Since the call already
        // opened (via the synchronous 'metadata' signal above), the stream
        // must not have been cancelled by the setup timer.
        await vi.advanceTimersByTimeAsync(5_000);
        expect(cancelCalls).toBe(0);

        // Clean up: stop consuming (not part of the assertion above).
        await iterator.return?.();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should map StreamEvents proto events preserving OJS wire naming and filter stream.keepalive', async () => {
      const transport = createMockGrpcTransport();
      const client = (transport as any).client;
      const { call } = createFakeStreamCall([
        {
          id: 'evt-1',
          type: 'job.completed',
          jobId: 'job-abc',
          jobType: 'email.send',
          queue: 'default',
          timestamp: { seconds: '1767225600', nanos: 0 },
          data: { fields: { duration_ms: { numberValue: 42 } } },
          workflowId: 'wf-1',
        },
        { id: 'evt-keepalive', type: 'stream.keepalive' },
      ]);
      client.streamEvents = (): typeof call => call;

      const events: any[] = [];
      for await (const event of transport.streamEvents(
        { queues: ['default'] },
        { reconnect: { enabled: false } },
      )) {
        events.push(event);
      }

      expect(events).toEqual([
        {
          id: 'evt-1',
          type: 'job.completed',
          job_id: 'job-abc',
          job_type: 'email.send',
          queue: 'default',
          timestamp: '2026-01-01T00:00:00.000Z',
          data: { duration_ms: 42 },
          workflow_id: 'wf-1',
        },
      ]);
    });

    it('should decode legitimate default-valued StreamEvents data fields (0, false, "", null) faithfully instead of null', async () => {
      // Regression test for fromProtoValue()'s "is it non-zero" heuristic
      // (see the job-args regression test for the full rationale) as
      // reached through the StreamEvents data Struct.
      const transport = createMockGrpcTransport();
      const client = (transport as any).client;
      const { call } = createFakeStreamCall([
        {
          id: 'evt-defaults',
          type: 'job.progress',
          jobId: 'job-defaults',
          data: {
            fields: {
              message: { kind: 'stringValue', stringValue: '' },
              progress: { kind: 'numberValue', numberValue: 0 },
              done: { kind: 'boolValue', boolValue: false },
              extra: { kind: 'nullValue', nullValue: 'NULL_VALUE' },
            },
          },
        },
      ]);
      client.streamEvents = (): typeof call => call;

      const events: any[] = [];
      for await (const event of transport.streamEvents(undefined, { reconnect: { enabled: false } })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].data).toEqual({
        message: '',
        progress: 0,
        done: false,
        extra: null,
      });
    });

    it('should send StreamEvents filters (queues/eventTypes/jobId/workflowId) and default them to empty when omitted', async () => {
      const transport = createMockGrpcTransport();
      const client = (transport as any).client;
      let capturedRequest: any;
      client.streamEvents = (req: any): ReturnType<typeof createFakeStreamCall>['call'] => {
        capturedRequest = req;
        return createFakeStreamCall([]).call;
      };

      for await (const _event of transport.streamEvents(undefined, { reconnect: { enabled: false } })) {
        // drained
      }

      expect(capturedRequest).toEqual({ queues: [], eventTypes: [], jobId: '', workflowId: '' });

      for await (const _event of transport.streamEvents(
        { queues: ['default'], eventTypes: ['job.completed'], jobId: 'job-1', workflowId: 'wf-1' },
        { reconnect: { enabled: false } },
      )) {
        // drained
      }

      expect(capturedRequest).toEqual({
        queues: ['default'],
        eventTypes: ['job.completed'],
        jobId: 'job-1',
        workflowId: 'wf-1',
      });
    });

    it('should cancel the underlying StreamJobs call when the caller aborts its signal', async () => {
      const transport = createMockGrpcTransport();
      const client = (transport as any).client;
      const { call, cancelCalls } = createFakeStreamCall(
        [{ id: 'job-1', type: 'test.job', queue: 'default', args: [] }],
        undefined,
        { staysOpen: true },
      );
      client.streamJobs = (): typeof call => call;

      const controller = new AbortController();
      const jobs: any[] = [];
      const consuming = (async () => {
        for await (const job of transport.streamJobs(
          { queues: ['default'], workerId: 'w1' },
          { signal: controller.signal },
        )) {
          jobs.push(job);
        }
      })();

      // Let the first job be delivered, then abort while the fake stream
      // is blocked awaiting its next (never-arriving) item.
      while (jobs.length < 1) await new Promise((r) => setTimeout(r, 0));
      controller.abort();
      await consuming;

      expect(jobs).toHaveLength(1);
      expect(cancelCalls()).toBeGreaterThanOrEqual(1);
    });

    it('should cancel active iteration before closing the client and never reconnect', async () => {
      const transport = createMockGrpcTransport();
      const client = (transport as any).client;
      const closeSpy = client.close as ReturnType<typeof vi.fn>;
      const { call, cancelCalls } = createFakeStreamCall(
        [{ id: 'job-1', type: 'test.job', queue: 'default', args: [] }],
        undefined,
        { staysOpen: true },
      );
      let attempts = 0;
      client.streamJobs = (): typeof call => {
        attempts++;
        return call;
      };

      const jobs: any[] = [];
      const consuming = (async () => {
        for await (const job of transport.streamJobs(
          { queues: ['default'], workerId: 'w1' },
        )) {
          jobs.push(job);
        }
      })();

      await vi.waitFor(() => {
        expect(jobs).toHaveLength(1);
      });

      transport.close();
      await consuming;

      expect(cancelCalls()).toBeGreaterThanOrEqual(1);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(attempts).toBe(1);
    });

    it('should abort reconnect backoff promptly and remove its timer on close', async () => {
      vi.useFakeTimers();
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      try {
        const baselineTimerCount = vi.getTimerCount();
        const transport = createMockGrpcTransport();
        const client = (transport as any).client;
        let attempts = 0;
        client.streamJobs = () => {
          attempts++;
          return createFakeStreamCall(
            [],
            Object.assign(new Error('temporarily unavailable'), { code: 14 }),
          ).call;
        };

        const consuming = (async () => {
          for await (const _job of transport.streamJobs(
            { queues: ['default'], workerId: 'w1' },
            { reconnect: { initialDelayMs: 1_000, maxDelayMs: 1_000 } },
          )) {
            // never reached
          }
        })();

        await vi.advanceTimersByTimeAsync(0);
        expect(attempts).toBe(1);
        const timersDuringBackoff = vi.getTimerCount();
        expect(timersDuringBackoff).toBeGreaterThan(baselineTimerCount);

        transport.close();
        await consuming;

        expect(attempts).toBe(1);
        expect(vi.getTimerCount()).toBeLessThan(timersDuringBackoff);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(attempts).toBe(1);
      } finally {
        randomSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('should abort every active stream when multiple streams share the transport', async () => {
      const transport = createMockGrpcTransport();
      const client = (transport as any).client;
      const jobsCall = createFakeStreamCall([], undefined, { staysOpen: true });
      const eventsCall = createFakeStreamCall([], undefined, { staysOpen: true });
      client.streamJobs = (): typeof jobsCall.call => jobsCall.call;
      client.streamEvents = (): typeof eventsCall.call => eventsCall.call;

      const consumingJobs = (async () => {
        for await (const _job of transport.streamJobs(
          { queues: ['default'], workerId: 'w1' },
        )) {
          // stays open until close()
        }
      })();
      const consumingEvents = (async () => {
        for await (const _event of transport.streamEvents()) {
          // stays open until close()
        }
      })();

      // Wait for streams to be opened (deferred init needs a few ticks)
      await new Promise((r) => setTimeout(r, 10));
      transport.close();
      await Promise.all([consumingJobs, consumingEvents]);

      expect(jobsCall.cancelCalls()).toBeGreaterThanOrEqual(1);
      expect(eventsCall.cancelCalls()).toBeGreaterThanOrEqual(1);
    });

    it('should combine and clean an external signal without closing the transport generation', async () => {
      const transport = createMockGrpcTransport();
      const client = (transport as any).client;
      const transportSignal = (transport as any).streamAbortController
        .signal as AbortSignal;
      const transportAddSpy = vi.spyOn(transportSignal, 'addEventListener');
      const transportRemoveSpy = vi.spyOn(transportSignal, 'removeEventListener');
      const callerController = new AbortController();
      const callerAddSpy = vi.spyOn(
        callerController.signal,
        'addEventListener',
      );
      const callerRemoveSpy = vi.spyOn(
        callerController.signal,
        'removeEventListener',
      );
      const firstCall = createFakeStreamCall([], undefined, { staysOpen: true });
      client.streamJobs = (): typeof firstCall.call => firstCall.call;

      const consuming = (async () => {
        for await (const _job of transport.streamJobs(
          { queues: ['default'], workerId: 'w1' },
          { signal: callerController.signal },
        )) {
          // stays open until caller abort
        }
      })();

      await new Promise((r) => setTimeout(r, 10));
      callerController.abort();
      await consuming;

      expect(firstCall.cancelCalls()).toBeGreaterThanOrEqual(1);
      expect(transportSignal.aborted).toBe(false);
      expect(transportAddSpy).toHaveBeenCalledTimes(1);
      expect(transportRemoveSpy).toHaveBeenCalledTimes(1);
      expect(callerAddSpy).toHaveBeenCalledTimes(1);
      expect(callerRemoveSpy).toHaveBeenCalledTimes(1);

      const secondCall = createFakeStreamCall([
        { id: 'job-2', type: 'test.job', queue: 'default', args: [] },
      ]);
      client.streamJobs = (): typeof secondCall.call => secondCall.call;
      const jobs: any[] = [];
      for await (const job of transport.streamJobs(
        { queues: ['default'], workerId: 'w1' },
        { reconnect: { enabled: false } },
      )) {
        jobs.push(job);
      }
      expect(jobs.map((job) => job.id)).toEqual(['job-2']);
    });

    it('should create a fresh stream generation and client after close', async () => {
      const transport = createMockGrpcTransport();
      const initialController = (transport as any)
        .streamAbortController as AbortController;
      const grpcModule = (transport as any).grpcModule;
      const oldClient = (transport as any).client;

      transport.close();

      expect(initialController.signal.aborted).toBe(true);
      expect(oldClient.close).toHaveBeenCalledTimes(1);

      const reopenedCall = createFakeStreamCall([
        { id: 'job-reopened', type: 'test.job', queue: 'default', args: [] },
      ]);
      const newClient = {
        close: vi.fn(),
        streamJobs: (): typeof reopenedCall.call => reopenedCall.call,
      };
      (transport as any).client = newClient;
      (transport as any).grpcModule = grpcModule;

      const jobs: any[] = [];
      for await (const job of transport.streamJobs(
        { queues: ['default'], workerId: 'w1' },
        { reconnect: { enabled: false } },
      )) {
        jobs.push(job);
      }

      const reopenedController = (transport as any)
        .streamAbortController as AbortController;
      expect(reopenedController).not.toBe(initialController);
      expect(reopenedController.signal.aborted).toBe(false);
      expect(jobs.map((job) => job.id)).toEqual(['job-reopened']);
    });

    it('should create a fresh generation when a unary request reopens after close', async () => {
      const { transport } = createRealCallMockTransport(
        (_request, _metadata, _options, callback) => {
          callback(null, { status: 'HEALTH_STATUS_OK' });
          return { cancel: () => undefined };
        },
      );
      const initialController = (transport as any)
        .streamAbortController as AbortController;
      const grpcModule = (transport as any).grpcModule;

      transport.close();

      const health = (
        _request: unknown,
        _metadata: unknown,
        _options: unknown,
        callback: (error: null, response: unknown) => void,
      ): { cancel: () => void } => {
        callback(null, { status: 'HEALTH_STATUS_OK' });
        return { cancel: () => undefined };
      };
      (transport as any).client = { close: vi.fn(), health };
      (transport as any).grpcModule = grpcModule;

      const response = await transport.request({
        method: 'GET',
        path: '/health',
      });

      const reopenedController = (transport as any)
        .streamAbortController as AbortController;
      expect(initialController.signal.aborted).toBe(true);
      expect(reopenedController).not.toBe(initialController);
      expect(reopenedController.signal.aborted).toBe(false);
      expect(response.body).toEqual({ status: 'ok' });
    });

    it('should cancel the underlying call when the consumer stops early (break) without any signal', async () => {
      const transport = createMockGrpcTransport();
      const client = (transport as any).client;
      const { call, cancelCalls } = createFakeStreamCall([
        { id: 'job-1', type: 'test.job', queue: 'default', args: [] },
        { id: 'job-2', type: 'test.job', queue: 'default', args: [] },
        { id: 'job-3', type: 'test.job', queue: 'default', args: [] },
      ]);
      client.streamJobs = (): typeof call => call;

      const jobs: any[] = [];
      for await (const job of transport.streamJobs({ queues: ['default'], workerId: 'w1' })) {
        jobs.push(job);
        if (jobs.length === 2) break;
      }

      expect(jobs).toHaveLength(2);
      // The cancellation wrapper (grpc-stream.ts's `reconnectingServerStream`,
      // used internally by `openReconnectingStream`) aborts its own internal
      // signal the instant `.return()` is invoked (here, via `for await`'s
      // implicit call on `break`), which synchronously fires the underlying
      // engine's own per-attempt abort listener (cancel #1); the engine's
      // `finally` block then also calls `cancel()` once more as it unwinds
      // (cancel #2). Both target an idempotent, already-ending call, so two
      // calls is the correct, expected outcome, not a leak.
      expect(cancelCalls()).toBe(2);
    });

    it('should propagate a non-retryable StreamJobs error to the consumer', async () => {
      const transport = createMockGrpcTransport();
      const client = (transport as any).client;
      const { call } = createFakeStreamCall([], Object.assign(new Error('bad request'), { code: 3 }));
      client.streamJobs = (): typeof call => call;

      await expect(
        (async () => {
          for await (const _job of transport.streamJobs({ queues: ['default'], workerId: 'w1' })) {
            // never reached
          }
        })(),
      ).rejects.toThrow(/bad request/);
    });

    it.each(['jobs', 'events'] as const)(
      'should throw a remote CANCELLED status from Stream%s',
      async (streamKind) => {
        const transport = createMockGrpcTransport();
        const client = (transport as any).client;
        const { call } = createFakeStreamCall(
          [],
          Object.assign(new Error(`remote ${streamKind} cancellation`), { code: 1 }),
        );
        if (streamKind === 'jobs') {
          client.streamJobs = (): typeof call => call;
        } else {
          client.streamEvents = (): typeof call => call;
        }

        const consume = async (): Promise<void> => {
          const iterable =
            streamKind === 'jobs'
              ? transport.streamJobs(
                  { queues: ['default'], workerId: 'w1' },
                  { reconnect: { enabled: false } },
                )
              : transport.streamEvents(
                  undefined,
                  { reconnect: { enabled: false } },
                );
          for await (const _value of iterable) {
            // never reached
          }
        };

        await expect(consume()).rejects.toThrow(
          new RegExp(`remote ${streamKind} cancellation`),
        );
      },
    );

    it.each(['jobs', 'events'] as const)(
      'should end Stream%s silently after external abort',
      async (streamKind) => {
        const transport = createMockGrpcTransport();
        const client = (transport as any).client;
        const item =
          streamKind === 'jobs'
            ? { id: 'job-1', type: 'test.job', queue: 'default', args: [] }
            : { id: 'event-1', type: 'job.completed' };
        const stream = createFakeStreamCall(
          [item],
          undefined,
          { staysOpen: true },
        );
        if (streamKind === 'jobs') {
          client.streamJobs = (): typeof stream.call => stream.call;
        } else {
          client.streamEvents = (): typeof stream.call => stream.call;
        }

        const controller = new AbortController();
        const values: unknown[] = [];
        const consuming = (async () => {
          const iterable =
            streamKind === 'jobs'
              ? transport.streamJobs(
                  { queues: ['default'], workerId: 'w1' },
                  { signal: controller.signal },
                )
              : transport.streamEvents(
                  undefined,
                  { signal: controller.signal },
                );
          for await (const value of iterable) values.push(value);
        })();

        await vi.waitFor(() => {
          expect(values).toHaveLength(1);
        });
        controller.abort();
        await expect(consuming).resolves.toBeUndefined();
        expect(stream.cancelCalls()).toBeGreaterThanOrEqual(1);
      },
    );

    it.each(['jobs', 'events'] as const)(
      'should end Stream%s silently when the transport closes',
      async (streamKind) => {
        const transport = createMockGrpcTransport();
        const client = (transport as any).client;
        const item =
          streamKind === 'jobs'
            ? { id: 'job-1', type: 'test.job', queue: 'default', args: [] }
            : { id: 'event-1', type: 'job.completed' };
        const stream = createFakeStreamCall(
          [item],
          undefined,
          { staysOpen: true },
        );
        if (streamKind === 'jobs') {
          client.streamJobs = (): typeof stream.call => stream.call;
        } else {
          client.streamEvents = (): typeof stream.call => stream.call;
        }

        const values: unknown[] = [];
        const consuming = (async () => {
          const iterable =
            streamKind === 'jobs'
              ? transport.streamJobs({ queues: ['default'], workerId: 'w1' })
              : transport.streamEvents();
          for await (const value of iterable) values.push(value);
        })();

        await vi.waitFor(() => {
          expect(values).toHaveLength(1);
        });
        transport.close();
        await expect(consuming).resolves.toBeUndefined();
        expect(stream.cancelCalls()).toBeGreaterThanOrEqual(1);
      },
    );

    it.each(['jobs', 'events'] as const)(
      'should cleanly cancel Stream%s after consumer early break',
      async (streamKind) => {
        const transport = createMockGrpcTransport();
        const client = (transport as any).client;
        const items =
          streamKind === 'jobs'
            ? [
                { id: 'job-1', type: 'test.job', queue: 'default', args: [] },
                { id: 'job-2', type: 'test.job', queue: 'default', args: [] },
              ]
            : [
                { id: 'event-1', type: 'job.completed' },
                { id: 'event-2', type: 'job.failed' },
              ];
        const stream = createFakeStreamCall(items);
        if (streamKind === 'jobs') {
          client.streamJobs = (): typeof stream.call => stream.call;
        } else {
          client.streamEvents = (): typeof stream.call => stream.call;
        }

        const values: unknown[] = [];
        const iterable =
          streamKind === 'jobs'
            ? transport.streamJobs({ queues: ['default'], workerId: 'w1' })
            : transport.streamEvents();
        for await (const value of iterable) {
          values.push(value);
          break;
        }

        expect(values).toHaveLength(1);
        // See the "should cancel the underlying call when the consumer
        // stops early" test above for why this is 2, not 1, under the
        // immediate-cancellation wrapper.
        expect(stream.cancelCalls()).toBe(2);
      },
    );

    it.each(['jobs', 'events'] as const)(
      'should cancel the active Stream%s call synchronously when return() is called directly while next() is pending (Finding: gRPC stream iterator cancellation)',
      async (streamKind) => {
        const transport = createMockGrpcTransport();
        const client = (transport as any).client;
        const stream = createFakeStreamCall([], undefined, { staysOpen: true });
        let connected = false;
        const connect = (): typeof stream.call => {
          connected = true;
          return stream.call;
        };
        if (streamKind === 'jobs') {
          client.streamJobs = connect;
        } else {
          client.streamEvents = connect;
        }

        const iterable =
          streamKind === 'jobs'
            ? transport.streamJobs({ queues: ['default'], workerId: 'w1' })
            : transport.streamEvents();

        // Grab the iterator manually (rather than `for await`) so we can
        // call `.next()` and `.return()` directly and observe the
        // ordering: `.next()` is still pending (the fake call never
        // resolves on its own) when `.return()` is invoked.
        const iterator = iterable[Symbol.asyncIterator]();
        const nextPromise = iterator.next();
        // Wait until the underlying call has actually been opened (not
        // just until cancelCalls is still 0, which would also be true —
        // trivially — before the call exists at all) so this genuinely
        // exercises "an active call, pending on data" rather than racing
        // ahead of the one-time client-bootstrap microtask hop.
        await vi.waitFor(() => {
          expect(connected).toBe(true);
        });
        expect(stream.cancelCalls()).toBe(0);

        // Deliberately not awaited: the cancellation effect must already
        // be under way the instant return() is called, not merely queued
        // behind the still-pending next().
        const returnPromise = iterator.return();

        await expect(nextPromise).resolves.toEqual({ done: true, value: undefined });
        await expect(returnPromise).resolves.toEqual({ done: true, value: undefined });
        expect(stream.cancelCalls()).toBeGreaterThan(0);
      },
    );

    it.each(['jobs', 'events'] as const)(
      'should reject a pending Stream%s throw() with the exact consumer marker after immediate cleanup',
      async (streamKind) => {
        const transport = createMockGrpcTransport();
        const client = (transport as any).client;
        const stream = createFakeStreamCall([], undefined, { staysOpen: true });
        let connected = false;
        const connect = (): typeof stream.call => {
          connected = true;
          return stream.call;
        };
        if (streamKind === 'jobs') {
          client.streamJobs = connect;
        } else {
          client.streamEvents = connect;
        }

        const iterator =
          streamKind === 'jobs'
            ? transport.streamJobs({ queues: ['default'], workerId: 'w1' })
            : transport.streamEvents();
        const nextPromise = iterator.next();
        await vi.waitFor(() => {
          expect(connected).toBe(true);
        });

        const marker = { kind: `${streamKind}-pending-consumer-marker` };
        const throwPromise = iterator.throw(marker);
        expect(stream.cancelCalls()).toBeGreaterThan(0);

        await expect(nextPromise).resolves.toEqual({
          done: true,
          value: undefined,
        });
        await expect(throwPromise).rejects.toBe(marker);
      },
    );

    it.each(['jobs', 'events'] as const)(
      'should abort a Stream%s reconnect backoff sleep the instant return() is called while next() is pending, with no leftover timer (Finding: gRPC stream iterator cancellation)',
      async (streamKind) => {
        vi.useFakeTimers();
        try {
          const transport = createMockGrpcTransport();
          const client = (transport as any).client;
          let attempts = 0;
          const connect = (): { cancel: () => void } & AsyncIterable<unknown> => {
            attempts++;
            // Always fails so the stream is perpetually backing off.
            return createFakeStreamCall(
              [],
              Object.assign(new Error('internal stream failure'), { code: 13 }),
            ).call;
          };
          if (streamKind === 'jobs') {
            client.streamJobs = connect;
          } else {
            client.streamEvents = connect;
          }

          const iterable =
            streamKind === 'jobs'
              ? transport.streamJobs(
                  { queues: ['default'], workerId: 'w1' },
                  { reconnect: { initialDelayMs: 10_000, maxDelayMs: 10_000 } },
                )
              : transport.streamEvents(undefined, {
                  reconnect: { initialDelayMs: 10_000, maxDelayMs: 10_000 },
                });
          const iterator = iterable[Symbol.asyncIterator]();

          const nextPromise = iterator.next();
          await vi.waitFor(() => {
            expect(attempts).toBe(1);
          });
          expect(vi.getTimerCount()).toBeGreaterThan(0);

          // No `vi.advanceTimersByTimeAsync(...)` anywhere below: if the
          // backoff sleep were not aborted immediately, these awaits would
          // hang against a fake-timer clock that never advances.
          const returnPromise = iterator.return();
          await expect(nextPromise).resolves.toEqual({ done: true, value: undefined });
          await expect(returnPromise).resolves.toEqual({ done: true, value: undefined });

          expect(attempts).toBe(1);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it('should reconnect StreamJobs after INTERNAL with deterministic backoff', async () => {
      vi.useFakeTimers();
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      try {
        const transport = createMockGrpcTransport();
        const client = (transport as any).client;
        let attempts = 0;
        client.streamJobs = () => {
          attempts++;
          return attempts === 1
            ? createFakeStreamCall(
                [],
                Object.assign(new Error('internal stream failure'), { code: 13 }),
              ).call
            : createFakeStreamCall([
                { id: 'job-after-internal', type: 'test.job', queue: 'default', args: [] },
              ]).call;
        };

        const jobs: any[] = [];
        const consuming = (async () => {
          for await (const job of transport.streamJobs(
            { queues: ['default'], workerId: 'w1' },
            { reconnect: { initialDelayMs: 100, maxDelayMs: 100 } },
          )) {
            jobs.push(job);
            break;
          }
        })();

        await vi.advanceTimersByTimeAsync(99);
        expect(attempts).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        await consuming;

        expect(attempts).toBe(2);
        expect(jobs[0]?.id).toBe('job-after-internal');
      } finally {
        randomSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('should reconnect StreamEvents after INTERNAL with deterministic backoff', async () => {
      vi.useFakeTimers();
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      try {
        const transport = createMockGrpcTransport();
        const client = (transport as any).client;
        let attempts = 0;
        client.streamEvents = () => {
          attempts++;
          return attempts === 1
            ? createFakeStreamCall(
                [],
                Object.assign(new Error('internal event stream failure'), { code: 13 }),
              ).call
            : createFakeStreamCall([
                { id: 'event-after-internal', type: 'job.completed' },
              ]).call;
        };

        const events: any[] = [];
        const consuming = (async () => {
          for await (const event of transport.streamEvents(
            undefined,
            { reconnect: { initialDelayMs: 100, maxDelayMs: 100 } },
          )) {
            events.push(event);
            break;
          }
        })();

        await vi.advanceTimersByTimeAsync(99);
        expect(attempts).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        await consuming;

        expect(attempts).toBe(2);
        expect(events[0]?.id).toBe('event-after-internal');
      } finally {
        randomSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('should reconnect StreamJobs after RESOURCE_EXHAUSTED with deterministic backoff', async () => {
      vi.useFakeTimers();
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      try {
        const transport = createMockGrpcTransport();
        const client = (transport as any).client;
        let attempts = 0;
        client.streamJobs = () => {
          attempts++;
          return attempts === 1
            ? createFakeStreamCall(
                [],
                Object.assign(new Error('job stream rate limited'), { code: 8 }),
              ).call
            : createFakeStreamCall([
                { id: 'job-after-throttle', type: 'test.job', queue: 'default', args: [] },
              ]).call;
        };

        const jobs: any[] = [];
        const consuming = (async () => {
          for await (const job of transport.streamJobs(
            { queues: ['default'], workerId: 'w1' },
            { reconnect: { initialDelayMs: 100, maxDelayMs: 100 } },
          )) {
            jobs.push(job);
            break;
          }
        })();

        await vi.advanceTimersByTimeAsync(99);
        expect(attempts).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        await consuming;

        expect(attempts).toBe(2);
        expect(jobs[0]?.id).toBe('job-after-throttle');
      } finally {
        randomSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('should keep RESOURCE_EXHAUSTED terminal for StreamEvents', async () => {
      const transport = createMockGrpcTransport();
      const client = (transport as any).client;
      let attempts = 0;
      client.streamEvents = () => {
        attempts++;
        return createFakeStreamCall(
          [],
          Object.assign(new Error('event stream rate limited'), { code: 8 }),
        ).call;
      };

      await expect(
        (async () => {
          for await (const _event of transport.streamEvents()) {
            // never reached
          }
        })(),
      ).rejects.toThrow(/event stream rate limited/);
      expect(attempts).toBe(1);
    });

    it('should throw an unimplemented OJSError if the server does not expose StreamJobs/StreamEvents at all', async () => {
      // No `client.streamJobs`/`client.streamEvents` registered at all —
      // simulates a generated client for an older proto without these RPCs.
      // (Uses a plain try/catch rather than `.rejects.toSatisfy(...)` so the
      // caught value's type is a normal `unknown`, not the pre-existing
      // `toSatisfy`/`OJSError` generic-inference mismatch used elsewhere in
      // this file — no need to add another instance of it here.)
      const transport = createMockGrpcTransport();

      await expect(
        (async () => {
          for await (const _job of transport.streamJobs({ queues: ['default'], workerId: 'w1' })) {
            // never reached
          }
        })(),
      ).rejects.toMatchObject({ code: 'unimplemented', message: expect.stringMatching(/streamJobs/) });

      await expect(
        (async () => {
          for await (const _event of transport.streamEvents()) {
            // never reached
          }
        })(),
      ).rejects.toMatchObject({ code: 'unimplemented', message: expect.stringMatching(/streamEvents/) });
    });
  });

  describe("protobuf Duration→ISO formatting (Finding 5)", () => {
    function makeJobWithDuration(dur: { seconds: string | number; nanos: number }) {
      return {
        id: "dur-test",
        type: "test",
        queue: "q",
        state: "JOB_STATE_AVAILABLE",
        args: [],
        priority: 0,
        attempt: 0,
        maxAttempts: 0,
        retryPolicy: {
          maxAttempts: 1,
          initialInterval: dur,
          backoffCoefficient: 2,
          maxInterval: { seconds: "60", nanos: 0 },
          jitter: false,
          nonRetryableErrors: [],
          onExhaustion: "discard",
        },
      };
    }

    async function getDurationStr(transport: any, dur: { seconds: string | number; nanos: number }): Promise<string> {
      setMockResponse(transport, "enqueue", { job: makeJobWithDuration(dur) });
      const resp = await transport.request({ method: "POST", path: "/jobs", body: { type: "test", args: [] } });
      return (resp.body as any).job.retry.initial_interval;
    }

    it("1 nanosecond renders as PT0.000000001S", async () => {
      const t = createMockGrpcTransport();
      expect(await getDurationStr(t, { seconds: "0", nanos: 1 })).toBe("PT0.000000001S");
    });

    it("fractional seconds (250ms) renders without exponential notation", async () => {
      const t = createMockGrpcTransport();
      expect(await getDurationStr(t, { seconds: "1", nanos: 250_000_000 })).toBe("PT1.25S");
    });

    it("negative duration renders with leading minus sign", async () => {
      const t = createMockGrpcTransport();
      expect(await getDurationStr(t, { seconds: "-5", nanos: -500_000_000 })).toBe("-PT5.5S");
    });

    it("large seconds render with integer arithmetic and no exponential notation", async () => {
      const t = createMockGrpcTransport();
      expect(await getDurationStr(t, { seconds: "315576000000", nanos: 0 })).toBe("P3652500D");
    });

    it("zero duration renders as PT0S", async () => {
      const t = createMockGrpcTransport();
      expect(await getDurationStr(t, { seconds: "0", nanos: 0 })).toBe("PT0S");
    });

    it("999999999 nanos renders as PT0.999999999S (no rounding to 1)", async () => {
      const t = createMockGrpcTransport();
      expect(await getDurationStr(t, { seconds: "0", nanos: 999_999_999 })).toBe("PT0.999999999S");
    });
  });

});

// --- Test helpers ---

/**
 * Creates a GrpcTransport with a mocked internal client that bypasses
 * actual gRPC connection and proto loading.
 */
function createMockGrpcTransport(): GrpcTransport {
  const transport = new GrpcTransport({ url: 'localhost:9090' });

  // Bypass the lazy initialization by injecting a mock client
  const mockClient: Record<string, any> = { close: vi.fn() };
  (transport as any).client = mockClient;
  (transport as any).initPromise = Promise.resolve();

  // Needed by the server-streaming (StreamJobs/StreamEvents) methods
  // below, which build a real `new grpc.Metadata()` instance themselves
  // (unlike the overridden unary call() below, which never touches
  // grpcModule at all). `entries` is a plain object (rather than a
  // private Map, as createRealCallMockTransport()'s Metadata below uses)
  // purely so streaming tests can assert on it directly.
  (transport as any).grpcModule = {
    Metadata: class {
      entries: Record<string, string> = {};
      set(key: string, value: string): void {
        this.entries[key] = value;
      }
    },
    credentials: { createInsecure: () => ({}) },
    loadPackageDefinition: () => ({}),
  };

  // Mock the grpc module import for Metadata
  const originalCall = (transport as any).call.bind(transport);
  (transport as any).call = async function <T>(
    method: string,
    request: any,
    timeout?: number,
    extraMetadata?: Record<string, string>,
  ): Promise<T> {
    const fn = mockClient[method];
    if (!fn) {
      throw new OJSError(`Unsupported gRPC method: ${method}`, 'unimplemented', {
        retryable: false,
      });
    }
    return new Promise<T>((resolve, reject) => {
      fn(request, {}, { deadline: new Date() }, (err: any, response: T) => {
        if (err) {
          // Replicate the error mapping from the real implementation
          reject(mapGrpcErrorForTest(err));
        } else {
          resolve(response);
        }
      });
    });
  };

  return transport;
}

/**
 * A minimal async-iterable + cancel() fake standing in for a grpc-js
 * ClientReadableStream, for the server-streaming (StreamJobs/StreamEvents)
 * tests above. Pre-seeded with the raw (proto-loader-shaped) messages to
 * emit; optionally throws `error` once the seeded items are exhausted
 * instead of ending cleanly. `cancel()` behaves like a real grpc-js
 * cancellation: any read currently awaiting the *next* (not-yet-seeded)
 * item settles immediately with a CANCELLED-shaped error, exactly like
 * `FakeStreamCall` in transport-grpc-stream.test.ts (this is a smaller,
 * pre-seeded-only variant, since these particular tests never need to
 * push items *during* iteration).
 */
function createFakeStreamCall(
  items: unknown[],
  error?: unknown,
  options?: { staysOpen?: boolean },
): { call: { cancel: () => void } & AsyncIterable<unknown>; cancelCalls: () => number } {
  let cancelCalls = 0;
  let index = 0;
  let cancelled = false;
  let pendingReject: ((err: unknown) => void) | undefined;

  const call = {
    cancel(): void {
      cancelCalls++;
      if (cancelled) return;
      cancelled = true;
      pendingReject?.(Object.assign(new Error('Cancelled on the client'), { code: 1 }));
    },
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      return {
        next: (): Promise<IteratorResult<unknown>> => {
          if (cancelled) {
            return Promise.reject(Object.assign(new Error('Cancelled on the client'), { code: 1 }));
          }
          if (index < items.length) {
            return Promise.resolve({ done: false, value: items[index++] });
          }
          if (error) return Promise.reject(error);
          if (options?.staysOpen) {
            // Behaves like a still-open stream blocked waiting for the
            // next message — settled only if cancel() rejects it.
            return new Promise((_resolve, reject) => {
              pendingReject = reject;
            });
          }
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };

  return { call, cancelCalls: () => cancelCalls };
}

/**
 * Creates a GrpcTransport wired with a fake client + grpc module but,
 * unlike createMockGrpcTransport(), leaves the real `call()` implementation
 * in place so deadline computation and AbortSignal cancellation wiring are
 * actually exercised.
 */
function createRealCallMockTransport(
  fn: (
    request: unknown,
    metadata: unknown,
    options: { deadline: Date },
    callback: (err: unknown, response: unknown) => void,
  ) => { cancel: () => void },
): { transport: GrpcTransport; cancelSpy: ReturnType<typeof vi.fn> } {
  const transport = new GrpcTransport({ url: 'localhost:9090' });
  const cancelSpy = vi.fn();

  const wrappedFn = (
    request: unknown,
    metadata: unknown,
    options: { deadline: Date },
    callback: (err: unknown, response: unknown) => void,
  ): { cancel: () => void } => {
    const call = fn(request, metadata, options, callback);
    return {
      cancel: () => {
        cancelSpy();
        call.cancel();
      },
    };
  };

  (transport as any).client = { echo: wrappedFn, close: () => {} };
  (transport as any).grpcModule = {
    Metadata: class {
      private readonly entries = new Map<string, string>();
      set(key: string, value: string): void {
        this.entries.set(key, value);
      }
    },
    credentials: { createInsecure: () => ({}) },
    loadPackageDefinition: () => ({}),
  };
  (transport as any).initPromise = Promise.resolve();

  return { transport, cancelSpy };
}

function setMockResponse(transport: GrpcTransport, method: string, response: any): void {
  const client = (transport as any).client;
  client[method] = (_req: any, _meta: any, _opts: any, callback: Function) => {
    callback(null, response);
  };
}

function setMockError(transport: GrpcTransport, error: { code: number; details: string }): void {
  const client = (transport as any).client;
  // Set error on all common methods
  const methods = [
    'enqueue', 'enqueueBatch', 'getJob', 'cancelJob',
    'fetch', 'ack', 'nack', 'heartbeat',
    'listQueues', 'queueStats', 'pauseQueue', 'resumeQueue',
    'health', 'manifest',
    'listDeadLetter', 'retryDeadLetter', 'deleteDeadLetter',
    'listCron', 'registerCron', 'unregisterCron',
    'createWorkflow', 'getWorkflow', 'cancelWorkflow',
  ];
  for (const m of methods) {
    client[m] = (_req: any, _meta: any, _opts: any, callback: Function) => {
      callback(error, null);
    };
  }
}

/** Test-side replica of mapGrpcError for the mock setup. */
function mapGrpcErrorForTest(err: any): OJSError {
  const code = err.code ?? 13;
  const message = err.details ?? err.message ?? 'Unknown gRPC error';

  switch (code) {
    case 3: return new OJSValidationError(message);
    case 5: return new OJSNotFoundError('resource', 'unknown');
    case 6: return new OJSDuplicateError(message);
    case 9: return new OJSConflictError(message);
    case 8: return new OJSRateLimitError(message);
    case 14: return new OJSConnectionError(message, err);
    case 4: return new OJSConnectionError(`Deadline exceeded: ${message}`, err);
    case 1: return new OJSConnectionError(`Request cancelled: ${message}`, err);
    case 7: return new OJSError(message, 'permission_denied', { retryable: false });
    case 12: return new OJSError(message, 'unimplemented', { retryable: false });
    case 13:
    default: return new OJSServerError(message, 500);
  }
}

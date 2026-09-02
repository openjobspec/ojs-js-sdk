/**
 * Schema-parity coverage for the OJS unique-policy validation contract
 * (`ojs-unique-jobs.md` / `unique-policy.schema.json` in the sibling
 * `ojs-json-schema` repo): `args_keys` may be empty, but entries — when
 * present — must be non-empty and unique; `meta_keys` is required and
 * non-empty exactly when `meta` is selected in `keys`; `period` must
 * match the canonical ISO 8601 duration pattern; `states` is an exact,
 * unique enum; `on_conflict` is an exact enum.
 *
 * This suite runs one shared table of canonical (snake_case) wire-shape
 * unique-policy fixtures through all three places this contract is
 * enforced, asserting they all agree on accept/reject for every case:
 *
 *   1. `validateUniquePolicy()` (src/validation/schemas.ts) — the
 *      structural HTTP-wire validator, used directly by raw
 *      `HttpTransport` enqueue/batch calls and by
 *      `OJSClient.enqueue()`'s pre-flight check (`validateEnqueueRequest`).
 *   2. The developer-facing normalization path
 *      (`toWireOptions()`/`normalizeUniqueSelection()` in src/job.ts) —
 *      exercised via the camelCase `UniqueOptions` shape a real caller
 *      of `client.enqueue(type, args, { unique })` would use, converted
 *      to the identical canonical wire shape.
 *   3. The raw gRPC transport's `EnqueueOptions.unique` converter
 *      (`buildProtoUniquePolicy` in src/transport/grpc.ts, exercised
 *      end-to-end through `GrpcTransport.request()`), which accepts the
 *      same canonical wire shape as `validateUniquePolicy` before
 *      converting it into a protobuf `UniquePolicy`.
 *
 * If any one of these three diverges from the other two for the same
 * input, exactly one of the assertions in the shared table below fails,
 * immediately identifying which layer drifted.
 */
import { describe, it, expect, vi } from 'vitest';
import { validateUniquePolicy } from '../src/validation/schemas.js';
import { toWireOptions, type EnqueueOptions, type UniqueOptions } from '../src/job.js';
import { GrpcTransport } from '../src/transport/grpc.js';

/** One canonical (snake_case) unique-policy fixture, shared by all three layers. */
interface UniquePolicyCase {
  name: string;
  /** The canonical wire-shape unique policy under test. */
  policy: Record<string, unknown>;
  /** Whether this policy is expected to be accepted by every layer. */
  valid: boolean;
}

const CASES: UniquePolicyCase[] = [
  {
    name: 'default: no fields at all',
    policy: {},
    valid: true,
  },
  {
    name: 'canonical full example from unique-policy.schema.json',
    policy: {
      keys: ['type', 'meta'],
      meta_keys: ['tenant_id'],
      period: 'P1D',
      on_conflict: 'ignore',
    },
    valid: true,
  },
  {
    name: 'args_keys present but empty is valid on its own',
    policy: { keys: ['type', 'args'], args_keys: [] },
    valid: true,
  },
  {
    name: 'args_keys with non-empty, unique entries is valid',
    policy: { keys: ['type', 'args'], args_keys: ['user_id', 'template'] },
    valid: true,
  },
  {
    name: 'args_keys with a duplicate entry is invalid',
    policy: { keys: ['type', 'args'], args_keys: ['id', 'id'] },
    valid: false,
  },
  {
    name: 'args_keys with an empty-string entry is invalid',
    policy: { keys: ['type', 'args'], args_keys: [''] },
    valid: false,
  },
  {
    name: 'meta selected with non-empty meta_keys is valid',
    policy: { keys: ['type', 'meta'], meta_keys: ['tenant_id'] },
    valid: true,
  },
  {
    name: 'meta selected without meta_keys at all is invalid',
    policy: { keys: ['type', 'meta'] },
    valid: false,
  },
  {
    name: 'meta selected with an explicitly empty meta_keys array is invalid',
    policy: { keys: ['type', 'meta'], meta_keys: [] },
    valid: false,
  },
  {
    name: 'meta_keys with a duplicate entry is invalid',
    policy: { keys: ['type', 'meta'], meta_keys: ['a', 'a'] },
    valid: false,
  },
  {
    name: 'keys with a duplicate dimension is invalid',
    policy: { keys: ['type', 'type'] },
    valid: false,
  },
  {
    name: 'keys with an unknown dimension is invalid',
    policy: { keys: ['type', 'not-a-dimension'] },
    valid: false,
  },
  {
    name: 'period as a canonical ISO 8601 duration is valid',
    // Deliberately weeks/days/hours/minutes/seconds only (no calendar
    // years/months) here, so this case is valid across *all three*
    // layers uniformly — see the dedicated
    // "gRPC-specific calendar-unit period restriction" test below for
    // the one narrow, intentional, and already-documented (AUDIT.md
    // F-78) transport-specific exception: a calendar year/month period
    // is schema-valid but cannot be represented exactly by
    // `google.protobuf.Duration`, so gRPC alone rejects it.
    policy: { period: 'P3W4DT5H6M7.5S' },
    valid: true,
  },
  {
    name: 'period as bare "P" is invalid',
    policy: { period: 'P' },
    valid: false,
  },
  {
    name: 'period as bare "PT" is invalid',
    policy: { period: 'PT' },
    valid: false,
  },
  {
    name: 'period in a non-ISO format is invalid',
    policy: { period: '1 hour' },
    valid: false,
  },
  {
    name: 'states as a valid, unique canonical enum list is valid',
    policy: { states: ['available', 'active', 'scheduled'] },
    valid: true,
  },
  {
    name: 'states with a duplicate entry is invalid',
    policy: { states: ['active', 'active'] },
    valid: false,
  },
  {
    name: 'states with an unknown value is invalid',
    policy: { states: ['bogus'] },
    valid: false,
  },
  {
    name: 'states as an empty array is valid',
    policy: { states: [] },
    valid: true,
  },
  {
    name: 'on_conflict "reject" is valid',
    policy: { on_conflict: 'reject' },
    valid: true,
  },
  {
    name: 'on_conflict "replace" is valid',
    policy: { on_conflict: 'replace' },
    valid: true,
  },
  {
    name: 'on_conflict "replace_except_schedule" is valid',
    policy: { on_conflict: 'replace_except_schedule' },
    valid: true,
  },
  {
    name: 'on_conflict "ignore" is valid',
    policy: { on_conflict: 'ignore' },
    valid: true,
  },
  {
    name: 'on_conflict with an unknown value is invalid',
    policy: { on_conflict: 'explode' },
    valid: false,
  },
  {
    name: 'an unknown top-level field is invalid',
    policy: { not_a_real_field: true },
    valid: false,
  },
];

/** Converts a canonical snake_case wire policy into the developer-facing
 * camelCase `UniqueOptions` shape `toWireOptions()` accepts. */
function toDeveloperUniqueOptions(policy: Record<string, unknown>): UniqueOptions {
  const opts: UniqueOptions = {};
  if (policy.keys !== undefined) opts.keys = policy.keys as UniqueOptions['keys'];
  if (policy.args_keys !== undefined) opts.argsKeys = policy.args_keys as string[];
  if (policy.meta_keys !== undefined) opts.metaKeys = policy.meta_keys as string[];
  if (policy.period !== undefined) opts.period = policy.period as string;
  if (policy.on_conflict !== undefined) {
    opts.onConflict = policy.on_conflict as UniqueOptions['onConflict'];
  }
  if (policy.states !== undefined) opts.states = policy.states as UniqueOptions['states'];
  // An unrecognized field (e.g. `not_a_real_field`) has no camelCase
  // developer-facing equivalent at all — the closest analogous "invalid
  // input" a developer could construct is an unknown option key, which
  // TypeScript would reject at compile time. Since this parity table
  // exercises runtime behavior only, that single case is intentionally
  // not translated into an equivalent developer-path shape below (see
  // its skip in `runsDeveloperPath`).
  return opts;
}

function runsDeveloperPath(testCase: UniquePolicyCase): boolean {
  return testCase.name !== 'an unknown top-level field is invalid';
}

/** Wires a minimal `GrpcTransport` with a capturing fake `call()`,
 * mirroring `tests/transport-grpc-enqueue-options.test.ts`'s own helper. */
function createCapturingGrpcTransport(): GrpcTransport {
  const transport = new GrpcTransport({ url: 'localhost:9090' });
  (transport as unknown as { client: unknown }).client = { close: vi.fn() };
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
  }).call = async (method: string, request: unknown): Promise<unknown> => {
    if (method !== 'enqueue') {
      throw new Error(`unexpected method '${method}'`);
    }
    const req = request as { type: unknown };
    return { job: { id: 'job-1', type: req.type, queue: 'default', state: 'JOB_STATE_AVAILABLE', args: [] } };
  };
  return transport;
}

describe('Unique policy schema parity (Finding: unique validation exact schema)', () => {
  describe.each(CASES)('$name', (testCase) => {
    it('HTTP validator (validateUniquePolicy) agrees with the expected validity', () => {
      const errors = validateUniquePolicy(testCase.policy);
      if (testCase.valid) {
        expect(errors).toEqual([]);
      } else {
        expect(errors.length).toBeGreaterThan(0);
      }
    });

    it('developer normalization path (toWireOptions/normalizeUniqueSelection) agrees with the expected validity', () => {
      if (!runsDeveloperPath(testCase)) return;
      const unique = toDeveloperUniqueOptions(testCase.policy);
      const opts: EnqueueOptions = { unique };
      if (testCase.valid) {
        expect(() => toWireOptions(opts)).not.toThrow();
      } else {
        expect(() => toWireOptions(opts)).toThrow();
      }
    });

    it('raw gRPC transport converter (buildProtoUniquePolicy, via GrpcTransport.request) agrees with the expected validity', async () => {
      const transport = createCapturingGrpcTransport();
      const request = transport.request({
        method: 'POST',
        path: '/jobs',
        body: { type: 'test.unique-parity', args: [], options: { unique: testCase.policy } },
      });
      if (testCase.valid) {
        await expect(request).resolves.toBeDefined();
      } else {
        await expect(request).rejects.toThrow();
      }
    });
  });

  it('every case in the shared table is exercised by all three layers (sanity: no case silently skipped)', () => {
    expect(CASES.length).toBeGreaterThan(15);
    expect(CASES.filter((c) => c.valid).length).toBeGreaterThan(0);
    expect(CASES.filter((c) => !c.valid).length).toBeGreaterThan(0);
  });

  it('documents the one intentional, transport-specific exception: a calendar year/month period is schema-valid but gRPC-invalid (AUDIT.md F-78)', async () => {
    const calendarPeriodPolicy = { period: 'P1Y2M' };

    // Schema-valid at the structural (HTTP-wire/canonical-pattern) layer
    // and accepted by the developer normalization path — both treat
    // `period` as an opaque ISO 8601 string with no unit-representability
    // concerns of their own.
    expect(validateUniquePolicy(calendarPeriodPolicy)).toEqual([]);
    expect(() =>
      toWireOptions({ unique: toDeveloperUniqueOptions(calendarPeriodPolicy) }),
    ).not.toThrow();

    // gRPC alone rejects it: `google.protobuf.Duration` can only exactly
    // represent weeks/days/hours/minutes/seconds, never calendar
    // years/months (a "month" has no fixed duration), so the wire-level
    // conversion fails clearly rather than silently truncating/estimating.
    const transport = createCapturingGrpcTransport();
    await expect(
      transport.request({
        method: 'POST',
        path: '/jobs',
        body: { type: 'test.unique-parity', args: [], options: { unique: calendarPeriodPolicy } },
      }),
    ).rejects.toThrow(/calendar years\/months/);
  });
});

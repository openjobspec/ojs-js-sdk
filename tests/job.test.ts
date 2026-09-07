import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalizeArgs, toWireOptions, toWireEnvelopeFields, createEnqueueEnvelope, toWireEnqueueRequest, TERMINAL_STATES } from '../src/job.js';
import { OJSValidationError } from '../src/errors.js';
import type {
  EnqueueOptions,
  UniqueKeyDimension,
  UniqueOptions,
  UniquePolicy,
} from '../src/job.js';

describe('normalizeArgs', () => {
  it('returns array as-is', () => {
    const args = [1, 'hello', { key: 'value' }];
    expect(normalizeArgs(args)).toBe(args);
  });

  it('wraps a string in array', () => {
    expect(normalizeArgs('hello')).toEqual(['hello']);
  });

  it('wraps a number in array', () => {
    expect(normalizeArgs(42)).toEqual([42]);
  });

  it('wraps a boolean in array', () => {
    expect(normalizeArgs(true)).toEqual([true]);
  });

  it('wraps null in array', () => {
    expect(normalizeArgs(null)).toEqual([null]);
  });

  it('wraps an object in array', () => {
    const obj = { to: 'test@test.com' };
    expect(normalizeArgs(obj)).toEqual([obj]);
  });

  it('returns empty array as-is', () => {
    expect(normalizeArgs([])).toEqual([]);
  });
});

describe('TERMINAL_STATES', () => {
  it('contains completed, cancelled, and discarded', () => {
    expect(TERMINAL_STATES.has('completed')).toBe(true);
    expect(TERMINAL_STATES.has('cancelled')).toBe(true);
    expect(TERMINAL_STATES.has('discarded')).toBe(true);
  });

  it('does not contain non-terminal states', () => {
    expect(TERMINAL_STATES.has('scheduled')).toBe(false);
    expect(TERMINAL_STATES.has('available')).toBe(false);
    expect(TERMINAL_STATES.has('pending')).toBe(false);
    expect(TERMINAL_STATES.has('active')).toBe(false);
    expect(TERMINAL_STATES.has('retryable')).toBe(false);
  });
});

describe('toWireOptions', () => {
  it('returns undefined for undefined input', () => {
    expect(toWireOptions(undefined)).toBeUndefined();
  });

  it('returns undefined for empty options', () => {
    expect(toWireOptions({})).toBeUndefined();
  });

  it('maps queue directly', () => {
    const result = toWireOptions({ queue: 'high-priority' });
    expect(result).toEqual({ queue: 'high-priority' });
  });

  it('maps priority directly', () => {
    const result = toWireOptions({ priority: 10 });
    expect(result).toEqual({ priority: 10 });
  });

  it('maps timeout to timeout_ms', () => {
    const result = toWireOptions({ timeout: 30000 });
    expect(result).toEqual({ timeout_ms: 30000 });
  });

  it('maps tags directly', () => {
    const result = toWireOptions({ tags: ['urgent', 'billing'] });
    expect(result).toEqual({ tags: ['urgent', 'billing'] });
  });

  it('maps visibilityTimeout to visibility_timeout_ms', () => {
    const result = toWireOptions({ visibilityTimeout: 60000 });
    expect(result).toEqual({ visibility_timeout_ms: 60000 });
  });

  it('maps expiresAt to expires_at', () => {
    const result = toWireOptions({ expiresAt: '2024-12-31T23:59:59Z' });
    expect(result).toEqual({ expires_at: '2024-12-31T23:59:59Z' });
  });

  describe('delay parsing', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-06-15T12:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('parses seconds shorthand', () => {
      const result = toWireOptions({ delay: '30s' });
      expect(result!.delay_until).toBe('2024-06-15T12:00:30.000Z');
    });

    it('parses minutes shorthand', () => {
      const result = toWireOptions({ delay: '5m' });
      expect(result!.delay_until).toBe('2024-06-15T12:05:00.000Z');
    });

    it('parses hours shorthand', () => {
      const result = toWireOptions({ delay: '1h' });
      expect(result!.delay_until).toBe('2024-06-15T13:00:00.000Z');
    });

    it('parses days shorthand', () => {
      const result = toWireOptions({ delay: '1d' });
      expect(result!.delay_until).toBe('2024-06-16T12:00:00.000Z');
    });

    it('parses milliseconds shorthand', () => {
      const result = toWireOptions({ delay: '500ms' });
      expect(result!.delay_until).toBe('2024-06-15T12:00:00.500Z');
    });

    it('passes ISO 8601 strings through unchanged', () => {
      const result = toWireOptions({ delay: '2024-12-31T00:00:00Z' });
      expect(result!.delay_until).toBe('2024-12-31T00:00:00Z');
    });
  });

  describe('retry options', () => {
    it('maps camelCase retry to snake_case wire format', () => {
      const opts: EnqueueOptions = {
        retry: {
          maxAttempts: 5,
          backoffCoefficient: 2.0,
          initialInterval: 'PT1S',
          maxInterval: 'PT10M',
          jitter: true,
          nonRetryableErrors: ['auth.*'],
          onExhaustion: 'dead_letter',
        },
      };
      const result = toWireOptions(opts);
      expect(result!.retry).toEqual({
        max_attempts: 5,
        backoff_coefficient: 2.0,
        initial_interval: 'PT1S',
        max_interval: 'PT10M',
        jitter: true,
        non_retryable_errors: ['auth.*'],
        on_exhaustion: 'dead_letter',
      });
    });

    it('handles partial retry options', () => {
      const result = toWireOptions({ retry: { maxAttempts: 3 } });
      expect(result!.retry).toEqual({ max_attempts: 3 });
    });
  });

  describe('unique options', () => {
    it('maps canonical camelCase unique fields to canonical snake_case wire fields', () => {
      const opts: EnqueueOptions = {
        unique: {
          keys: ['type', 'args', 'meta'],
          argsKeys: ['id'],
          metaKeys: ['tenant_id'],
          period: 'PT1H',
          onConflict: 'replace_except_schedule',
          states: ['available', 'active'],
        },
      };
      const result = toWireOptions(opts);
      expect(result!.unique).toEqual({
        keys: ['type', 'args', 'meta'],
        args_keys: ['id'],
        meta_keys: ['tenant_id'],
        period: 'PT1H',
        on_conflict: 'replace_except_schedule',
        states: ['available', 'active'],
      });
      expect(result!.unique).not.toHaveProperty('key');
    });

    it('handles partial unique options', () => {
      const result = toWireOptions({ unique: { onConflict: 'ignore' } });
      expect(result!.unique).toEqual({ on_conflict: 'ignore' });
    });

    it('accepts schema-valid empty argsKeys and selectors without matching dimensions', () => {
      expect(toWireOptions({
        unique: {
          keys: ['type'],
          argsKeys: [],
          metaKeys: ['tenant_id'],
        },
      })!.unique).toEqual({
        keys: ['type'],
        args_keys: [],
        meta_keys: ['tenant_id'],
      });
    });

    it.each([
      {
        name: 'selectors named like dimensions',
        key: ['type', 'queue', 'args'],
        expected: {
          keys: ['args'],
          args_keys: ['type', 'queue', 'args'],
        },
      },
      {
        name: 'args selectors',
        key: ['id', 'tenant_id'],
        expected: {
          keys: ['args'],
          args_keys: ['id', 'tenant_id'],
        },
      },
      {
        name: 'mixed ordinary and dimension-named selectors',
        key: ['type', 'id', 'queue'],
        expected: {
          keys: ['args'],
          args_keys: ['type', 'id', 'queue'],
        },
      },
    ])('normalizes deprecated key values containing $name', ({ key, expected }) => {
      const result = toWireOptions({ unique: { key } });
      expect(result!.unique).toEqual(expected);
      expect(result!.unique).not.toHaveProperty('key');
    });

    it('merges canonical fields before deprecated key additions predictably', () => {
      const result = toWireOptions({
        unique: {
          keys: ['type'],
          argsKeys: ['canonical_id', 'type'],
          key: ['queue', 'legacy_id', 'type', 'canonical_id'],
        },
      });

      expect(result!.unique).toEqual({
        keys: ['type', 'args'],
        args_keys: ['canonical_id', 'type', 'queue', 'legacy_id'],
      });
    });

    it('does not mutate canonical or legacy selector arrays', () => {
      const keys: UniqueKeyDimension[] = ['type'];
      const argsKeys = ['canonical_id'];
      const key = ['queue', 'legacy_id'];
      const states = ['available', 'active'] as const;
      const options: UniqueOptions = {
        keys,
        argsKeys,
        key,
        states: [...states],
      };
      const snapshot = JSON.parse(JSON.stringify(options));

      toWireOptions({ unique: options });

      expect(options).toEqual(snapshot);
    });

    it.each([
      {
        name: 'meta dimension without metaKeys',
        unique: { keys: ['type', 'meta'] },
      },
      {
        name: 'empty args selector',
        unique: { keys: ['args'], argsKeys: [''] },
      },
      {
        name: 'empty metaKeys array',
        unique: { keys: ['meta'], metaKeys: [] },
      },
      { name: 'duplicate dimensions', unique: { keys: ['type', 'type'] } },
      { name: 'duplicate args selectors', unique: { argsKeys: ['id', 'id'] } },
      { name: 'duplicate states', unique: { states: ['active', 'active'] } },
      { name: 'invalid period', unique: { period: '1 hour' } },
      { name: 'invalid conflict action', unique: { onConflict: 'explode' } },
    ])('rejects invalid unique configuration: $name', ({ unique }) => {
      expect(() =>
        toWireOptions({ unique: unique as UniqueOptions }),
      ).toThrow(/Unique policy/);
    });

    it('keeps canonical wire and deprecated read-alias fields type compatible', () => {
      const canonical = {
        keys: ['type', 'args'],
        args_keys: ['id'],
      } satisfies UniquePolicy;
      const legacyResponse = { key: ['type', 'args'] } satisfies UniquePolicy;

      expect(canonical.keys).toEqual(['type', 'args']);
      expect(legacyResponse.key).toEqual(['type', 'args']);
    });
  });

  it('combines multiple options', () => {
    const result = toWireOptions({
      queue: 'critical',
      priority: 100,
      timeout: 5000,
      tags: ['urgent'],
    });
    expect(result).toEqual({
      queue: 'critical',
      priority: 100,
      timeout_ms: 5000,
      tags: ['urgent'],
    });
  });

  describe('meta / schema placement', () => {
    // Regression coverage: meta/schema are job-envelope-level wire fields
    // (ojs-core.md section 5.2; enqueue-request.schema.json), not part of
    // job-options.schema.json (which is additionalProperties:false and
    // does not define either). toWireOptions() must never place them
    // inside the returned options object — see toWireEnvelopeFields() for
    // where they actually belong.
    it('never includes meta in the options object', () => {
      const result = toWireOptions({ meta: { trace_id: 'abc' } });
      expect(result).toBeUndefined();
    });

    it('never includes schema in the options object', () => {
      const result = toWireOptions({ schema: 'urn:ojs:schema:email.send:v1' });
      expect(result).toBeUndefined();
    });

    it('excludes meta/schema even when combined with real options fields', () => {
      const result = toWireOptions({
        queue: 'email',
        meta: { trace_id: 'abc' },
        schema: 'urn:ojs:schema:email.send:v1',
      });
      expect(result).toEqual({ queue: 'email' });
      expect(result).not.toHaveProperty('meta');
      expect(result).not.toHaveProperty('schema');
    });
  });
});

describe('toWireEnvelopeFields', () => {
  it('returns an empty object for undefined input', () => {
    expect(toWireEnvelopeFields(undefined)).toEqual({});
  });

  it('returns an empty object when neither meta nor schema is set', () => {
    expect(toWireEnvelopeFields({})).toEqual({});
    expect(toWireEnvelopeFields({ queue: 'default' })).toEqual({});
  });

  it('maps meta directly', () => {
    expect(toWireEnvelopeFields({ meta: { trace_id: 'abc' } })).toEqual({
      meta: { trace_id: 'abc' },
    });
  });

  it('maps schema directly', () => {
    expect(toWireEnvelopeFields({ schema: 'urn:ojs:schema:email.send:v1' })).toEqual({
      schema: 'urn:ojs:schema:email.send:v1',
    });
  });

  it('maps both meta and schema together', () => {
    expect(
      toWireEnvelopeFields({
        meta: { trace_id: 'abc' },
        schema: 'urn:ojs:schema:email.send:v1',
      }),
    ).toEqual({
      meta: { trace_id: 'abc' },
      schema: 'urn:ojs:schema:email.send:v1',
    });
  });

  it('preserves an explicitly-set empty meta object rather than dropping it', () => {
    expect(toWireEnvelopeFields({ meta: {} })).toEqual({ meta: {} });
  });

  it('preserves an explicitly-set empty schema string rather than dropping it', () => {
    expect(toWireEnvelopeFields({ schema: '' })).toEqual({ schema: '' });
  });

  it('preserves deeply nested meta values exactly, without flattening or reshaping them', () => {
    const nested = {
      user: { id: 42, roles: ['admin', 'billing'] },
      trace: { span_ids: [1, 2, 3], attrs: { retries: 0, ok: false } },
      tags: [{ k: 'env', v: 'prod' }],
    };
    expect(toWireEnvelopeFields({ meta: nested })).toEqual({ meta: nested });
  });

  it('does not mutate the input options object or its meta value', () => {
    const meta = Object.freeze({ trace_id: 'abc', nested: Object.freeze({ a: 1 }) });
    const opts = Object.freeze({ meta, schema: 'urn:ojs:schema:x:v1' });

    expect(() => toWireEnvelopeFields(opts)).not.toThrow();
    const result = toWireEnvelopeFields(opts);

    // The same frozen references are returned, not mutated copies —
    // Object.freeze() above would throw synchronously on any attempted
    // mutation in strict mode (ES modules are always strict), so reaching
    // this point already proves no mutation occurred; this also confirms
    // the returned value really is the same (not a cloned) reference.
    expect(result.meta).toBe(meta);
    expect(opts.meta).toEqual({ trace_id: 'abc', nested: { a: 1 } });
  });

  it('does not include options-shaped fields (queue, retry, etc.)', () => {
    const result = toWireEnvelopeFields({
      queue: 'email',
      priority: 5,
      retry: { maxAttempts: 3 },
      meta: { trace_id: 'abc' },
    });
    expect(result).toEqual({ meta: { trace_id: 'abc' } });
  });
});

describe('JSON-semantic cloning (createEnqueueEnvelope / toWireEnqueueRequest)', () => {
  it('invokes toJSON for Date args and normalizes to an ISO string', () => {
    const date = new Date('2024-06-15T12:00:00.000Z');
    const env = createEnqueueEnvelope('t', [{ when: date } as unknown as Record<string, never>]);
    expect(env.args).toEqual([{ when: '2024-06-15T12:00:00.000Z' }]);
    // Original caller object is not mutated.
    expect(date instanceof Date).toBe(true);
  });

  it('invokes toJSON for URL args (href string)', () => {
    const url = new URL('https://example.com/x?y=1');
    const env = createEnqueueEnvelope('t', [url as unknown as Record<string, never>]);
    expect(env.args).toEqual(['https://example.com/x?y=1']);
  });

  it('invokes a custom toJSON on nested values', () => {
    class Money {
      constructor(private cents: number) {}
      toJSON(): unknown {
        return { amount: this.cents / 100, currency: 'USD' };
      }
    }
    const env = createEnqueueEnvelope('t', [{ price: new Money(1050) } as unknown as Record<string, never>]);
    expect(env.args).toEqual([{ price: { amount: 10.5, currency: 'USD' } }]);
  });

  it('turns undefined array elements into null but omits undefined object properties', () => {
    const env = createEnqueueEnvelope(
      't',
      [[1, undefined, 3] as unknown as Record<string, never>, { a: 1, b: undefined } as unknown as Record<string, never>],
    );
    expect(env.args).toEqual([[1, null, 3], { a: 1 }]);
  });

  it('omits functions and symbols from objects', () => {
    const env = createEnqueueEnvelope(
      't',
      [{ keep: 1, fn: () => 1, sym: Symbol('s') } as unknown as Record<string, never>],
    );
    expect(env.args).toEqual([{ keep: 1 }]);
  });

  it('preserves finite numbers, strings, booleans, and null', () => {
    const env = createEnqueueEnvelope('t', [{ n: 42, s: 'x', b: false, z: null }]);
    expect(env.args).toEqual([{ n: 42, s: 'x', b: false, z: null }]);
  });

  it('rejects non-finite numbers with OJSValidationError', () => {
    expect(() =>
      createEnqueueEnvelope('t', [{ n: Number.POSITIVE_INFINITY } as unknown as Record<string, never>]),
    ).toThrow(OJSValidationError);
    expect(() =>
      createEnqueueEnvelope('t', [{ n: NaN } as unknown as Record<string, never>]),
    ).toThrow(/non-finite/);
  });

  it('rejects BigInt with OJSValidationError', () => {
    expect(() =>
      createEnqueueEnvelope('t', [{ big: 1n } as unknown as Record<string, never>]),
    ).toThrow(OJSValidationError);
    expect(() =>
      createEnqueueEnvelope('t', [{ big: 1n } as unknown as Record<string, never>]),
    ).toThrow(/BigInt/);
  });

  it('rejects circular references with OJSValidationError', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() =>
      createEnqueueEnvelope('t', [cyclic as Record<string, never>]),
    ).toThrow(/circular/);
  });

  it('allows a diamond (same value referenced twice as siblings)', () => {
    const shared = { x: 1 };
    const env = createEnqueueEnvelope('t', [{ a: shared, b: shared } as unknown as Record<string, never>]);
    expect(env.args).toEqual([{ a: { x: 1 }, b: { x: 1 } }]);
  });

  it('preserves __proto__ / constructor / prototype as ordinary data without polluting prototypes', () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1, "prototype": 2}');
    const env = createEnqueueEnvelope('t', [hostile as Record<string, never>]);
    const cloned = env.args[0] as Record<string, unknown>;
    expect(Object.getOwnPropertyNames(cloned).sort()).toEqual(['__proto__', 'constructor', 'prototype'].sort());
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(cloned)).toBeNull();
  });

  it('does not mutate the caller args or meta objects', () => {
    const args = [{ a: 1, nested: { b: 2 } }];
    const meta = { m: 1 };
    createEnqueueEnvelope('t', args, { meta });
    expect(args).toEqual([{ a: 1, nested: { b: 2 } }]);
    expect(meta).toEqual({ m: 1 });
  });

  it('normalizes meta the same way via createEnqueueEnvelope', () => {
    const env = createEnqueueEnvelope('t', [], { meta: { when: new Date('2024-06-15T12:00:00.000Z') } as unknown as Record<string, never> });
    expect(env.meta).toEqual({ when: '2024-06-15T12:00:00.000Z' });
  });

  it('normalizes middleware mutations before terminal validation', () => {
    const env = createEnqueueEnvelope('t', []);
    env.args = [{
      when: new Date('2024-06-15T12:00:00.000Z'),
      omitted: undefined,
    }] as unknown as typeof env.args;
    env.meta = {
      custom: {
        toJSON: () => ({ enabled: true, omitted: undefined }),
      },
    } as unknown as typeof env.meta;

    expect(toWireEnqueueRequest(env)).toMatchObject({
      args: [{ when: '2024-06-15T12:00:00.000Z' }],
      meta: { custom: { enabled: true } },
    });
  });

  it('rejects metadata whose root toJSON result is not an object', () => {
    expect(() =>
      createEnqueueEnvelope('t', [], {
        meta: {
          toJSON: () => 'not-an-object',
        } as unknown as Record<string, never>,
      }),
    ).toThrow(/metadata must serialize to a JSON object/i);
  });
});

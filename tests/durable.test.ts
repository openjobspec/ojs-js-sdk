import { describe, it, expect } from 'vitest';
import { DurableContext } from '../src/durable.js';
import {
  OJSNotFoundError,
  OJSMethodNotAllowedError,
  OJSConnectionError,
  OJSServerError,
  OJSError,
  OJSCheckpointLoadError,
  ReplayIntegrityError,
} from '../src/errors.js';
import { GrpcTransport } from '../src/transport/grpc.js';
import type { Transport, TransportResponse, TransportRequestOptions } from '../src/transport/types.js';

const CHECKPOINT_PATH_RE = /^\/jobs\/[^/]+\/checkpoint$/;
const LEGACY_CHECKPOINT_PATH_RE = /^\/checkpoints\/[^/]+\/resume$/;

function createMockTransport(checkpointState?: unknown): Transport {
  return {
    async request<T>(options: TransportRequestOptions): Promise<TransportResponse<T>> {
      if (options.method === 'GET' && CHECKPOINT_PATH_RE.test(options.path)) {
        if (checkpointState === undefined) {
          // Per ojs-durable-execution.md section 4.3: no checkpoint -> 404.
          throw new OJSNotFoundError('checkpoint', 'unknown');
        }
        return {
          body: {
            job_id: 'job-id',
            state: checkpointState,
            sequence: 1,
            created_at: new Date().toISOString(),
          } as T,
          status: 200,
          headers: {},
        };
      }
      if (options.method === 'GET' && LEGACY_CHECKPOINT_PATH_RE.test(options.path)) {
        throw new OJSNotFoundError('checkpoint', 'unknown');
      }
      return { body: {} as T, status: 200, headers: {} };
    },
  };
}

describe('DurableContext', () => {
  it('creates in record mode when no checkpoint exists (404)', async () => {
    const transport = createMockTransport();
    const dc = await DurableContext.create(transport, 'job-1', 1);

    expect(dc.isReplaying()).toBe(false);
  });

  it('records and returns current time via now()', async () => {
    const transport = createMockTransport();
    const dc = await DurableContext.create(transport, 'job-2', 1);

    const t = dc.now();
    expect(t).toBeInstanceOf(Date);
    expect(t.getTime()).toBeGreaterThan(0);
  });

  it('records and returns random hex via random()', async () => {
    const transport = createMockTransport();
    const dc = await DurableContext.create(transport, 'job-3', 1);

    const hex = dc.random(16);
    expect(hex).toHaveLength(32); // 16 bytes = 32 hex chars
    expect(hex).toMatch(/^[0-9a-f]+$/);
  });

  it('records and returns side effect result', async () => {
    const transport = createMockTransport();
    const dc = await DurableContext.create(transport, 'job-4', 1);

    let callCount = 0;
    const result = await dc.sideEffect('compute', async () => {
      callCount++;
      return { value: 42 };
    });

    expect(result).toEqual({ value: 42 });
    expect(callCount).toBe(1);
  });

  it('replays entries from an HTTP-flat checkpoint response', async () => {
    // Mirrors the shape DurableContext itself writes via checkpoint():
    // an opaque `state` JSON value wrapping the SDK's replay log, since the
    // checkpoint wire contract (ojs-json-schema checkpoint.schema.json) has
    // no dedicated metadata field — only state/sequence/job_id/created_at.
    const wireState = {
      _ojsReplayLog: [
        { seq: 0, type: 'time', key: 'now', result: '2026-01-15T10:00:00.000Z' },
        { seq: 1, type: 'random', result: 'deadbeef01234567' },
        { seq: 2, type: 'call', key: 'api-call', result: { price: 99.99 } },
      ],
      _ojsStepIndex: 3,
      _ojsAttempt: 1,
      value: { previousStep: 'transform' },
    };

    const transport = createMockTransport(wireState);

    const dc = await DurableContext.create(transport, 'job-replay', 2);
    expect(dc.isReplaying()).toBe(true);

    // Replay time
    const t = dc.now();
    expect(t.getFullYear()).toBe(2026);
    expect(t.getMonth()).toBe(0); // January

    // Replay random
    const r = dc.random(8);
    expect(r).toBe('deadbeef01234567');

    // Replay side effect — should NOT call fn
    const result = await dc.sideEffect('api-call', async () => {
      throw new Error('should not be called during replay');
    });
    expect(result).toEqual({ price: 99.99 });

    // After exhausting replay, should exit replay mode
    expect(dc.isReplaying()).toBe(false);
  });

  it('records a sideEffect that resolves undefined as a JSON-compatible entry with no result key', async () => {
    const requests: TransportRequestOptions[] = [];
    let savedState: Record<string, unknown> | undefined;
    const transport: Transport = {
      async request<T>(options: TransportRequestOptions): Promise<TransportResponse<T>> {
        requests.push(options);
        if (options.method === 'GET' && CHECKPOINT_PATH_RE.test(options.path)) {
          throw new OJSNotFoundError('checkpoint', 'job-void');
        }
        if (options.method === 'POST' && CHECKPOINT_PATH_RE.test(options.path)) {
          savedState = (options.body as { state: Record<string, unknown> }).state;
          return { status: 200, headers: {}, body: {} as T };
        }
        throw new Error(`Unexpected request: ${options.method} ${options.path}`);
      },
    };

    const dc = await DurableContext.create(transport, 'job-void', 1);
    const value = await dc.sideEffect<undefined>('noop', async () => undefined);
    expect(value).toBeUndefined();
    await dc.checkpoint(1, { done: true });

    // The saved state, once JSON-serialized (as it is on the wire), drops the
    // undefined `result` key entirely — proving it is JSON-compatible.
    const serialized = JSON.parse(JSON.stringify(savedState)) as {
      _ojsReplayLog: Array<Record<string, unknown>>;
    };
    const entry = serialized._ojsReplayLog[0];
    expect(entry).toEqual({ seq: 0, type: 'call', key: 'noop' });
    expect(Object.prototype.hasOwnProperty.call(entry, 'result')).toBe(false);
  });

  it('replays an undefined call result from a serialized current-format checkpoint without invoking fn', async () => {
    // Build the current wrapper with an explicit undefined result, then JSON
    // round-trip it so the `result` key is dropped exactly as it is on the wire.
    const wireState = JSON.parse(
      JSON.stringify({
        _ojsReplayLog: [
          { seq: 0, type: 'call', key: 'noop', result: undefined },
          { seq: 1, type: 'call', key: 'fetch', result: { ok: true } },
        ],
        _ojsStepIndex: 2,
        _ojsAttempt: 1,
        value: null,
      }),
    ) as unknown;
    // Confirm the fixture really has no `result` key for the void entry.
    expect(
      Object.prototype.hasOwnProperty.call(
        (wireState as { _ojsReplayLog: Array<Record<string, unknown>> })._ojsReplayLog[0],
        'result',
      ),
    ).toBe(false);

    const dc = await DurableContext.create(createMockTransport(wireState), 'job-void-replay', 2);
    expect(dc.isReplaying()).toBe(true);

    let calls = 0;
    const first = await dc.sideEffect('noop', async () => {
      calls++;
      return 'live';
    });
    expect(first).toBeUndefined();
    expect(calls).toBe(0);

    const second = await dc.sideEffect('fetch', async () => {
      calls++;
      return { ok: false };
    });
    expect(second).toEqual({ ok: true });
    expect(calls).toBe(0);
    expect(dc.isReplaying()).toBe(false);
  });

  it('replays an undefined call result from a serialized legacy checkpoint without invoking fn', async () => {
    const replayLog = JSON.parse(
      JSON.stringify([{ seq: 0, type: 'call', key: 'legacy-noop', result: undefined }]),
    ) as unknown[];
    expect(
      Object.prototype.hasOwnProperty.call(replayLog[0] as Record<string, unknown>, 'result'),
    ).toBe(false);

    const transport: Transport = {
      supportsLegacyCheckpointResume: true,
      async request<T>(options: TransportRequestOptions): Promise<TransportResponse<T>> {
        if (options.method === 'GET' && CHECKPOINT_PATH_RE.test(options.path)) {
          throw new OJSNotFoundError('checkpoint', 'job-legacy-void');
        }
        if (options.method === 'GET' && LEGACY_CHECKPOINT_PATH_RE.test(options.path)) {
          return {
            status: 200,
            headers: {},
            body: {
              has_checkpoint: true,
              checkpoint: {
                step_index: 1,
                state: { phase: 'legacy' },
                metadata: { _replay_log: JSON.stringify(replayLog) },
              },
            } as T,
          };
        }
        if (options.method === 'POST' && CHECKPOINT_PATH_RE.test(options.path)) {
          return { status: 200, headers: {}, body: {} as T };
        }
        throw new Error(`Unexpected request: ${options.method} ${options.path}`);
      },
    };

    const dc = await DurableContext.create(transport, 'job-legacy-void', 2);
    let calls = 0;
    const value = await dc.sideEffect('legacy-noop', async () => {
      calls++;
      return 'live';
    });
    expect(value).toBeUndefined();
    expect(calls).toBe(0);
  });

  it('replays and migrates a canonical wrapped gRPC checkpoint', async () => {
    let savedRequest: Record<string, unknown> | undefined;
    const transport = new GrpcTransport({ url: 'localhost:9090' });

    (transport as unknown as {
      call: (method: string, request: Record<string, unknown>) => Promise<unknown>;
    }).call = async (method, request) => {
      if (method === 'getCheckpoint') {
        return {
          jobId: 'job-grpc-replay',
          state: {
            fields: {
              _ojsReplayLog: {
                listValue: {
                  values: [
                    {
                      structValue: {
                        fields: {
                          seq: { numberValue: 0 },
                          type: { stringValue: 'call' },
                          key: { stringValue: 'cached' },
                          result: {
                            structValue: {
                              fields: {
                                value: { numberValue: 42 },
                              },
                            },
                          },
                        },
                      },
                    },
                  ],
                },
              },
              _ojsStepIndex: { numberValue: 1 },
              _ojsAttempt: { numberValue: 1 },
              value: {
                structValue: {
                  fields: {
                    phase: { stringValue: 'before-retry' },
                  },
                },
              },
            },
          },
          sequence: 1,
          savedAt: { seconds: '1767225600', nanos: 0 },
        };
      }
      if (method === 'saveCheckpoint') {
        savedRequest = request;
        return { sequence: 2 };
      }
      throw new Error(`Unexpected gRPC method: ${method}`);
    };

    const dc = await DurableContext.create(transport, 'job-grpc-replay', 2);
    expect(dc.isReplaying()).toBe(true);

    let cachedCalls = 0;
    await expect(dc.sideEffect('cached', async () => {
      cachedCalls++;
      return { value: -1 };
    })).resolves.toEqual({ value: 42 });
    expect(cachedCalls).toBe(0);
    expect(dc.isReplaying()).toBe(false);

    await expect(dc.sideEffect('fresh', async () => ({ value: 99 }))).resolves.toEqual({
      value: 99,
    });
    await dc.checkpoint(2, { phase: 'after-retry' });

    expect(savedRequest?.jobId).toBe('job-grpc-replay');
    const fields = (
      savedRequest?.state as {
        fields: Record<string, {
          numberValue?: number;
          structValue?: { fields: Record<string, unknown> };
          listValue?: { values: Array<{ structValue: { fields: Record<string, unknown> } }> };
        }>;
      }
    ).fields;
    expect(fields._ojsAttempt?.numberValue).toBe(2);
    expect(fields._ojsStepIndex?.numberValue).toBe(2);
    expect(fields.value?.structValue?.fields).toEqual({
      phase: { stringValue: 'after-retry' },
    });

    const migratedEntries = fields._ojsReplayLog?.listValue?.values;
    expect(migratedEntries).toHaveLength(2);
    expect(migratedEntries?.[0]?.structValue.fields.key).toEqual({
      stringValue: 'cached',
    });
    expect(migratedEntries?.[1]?.structValue.fields.key).toEqual({
      stringValue: 'fresh',
    });
  });

  it('starts fresh after a canonical gRPC 404 without attempting the HTTP-only legacy route', async () => {
    const transport = new GrpcTransport({ url: 'localhost:9090' });
    const callCount = { value: 0 };

    (transport as unknown as {
      call: (method: string) => Promise<unknown>;
    }).call = async (method) => {
      callCount.value++;
      expect(method).toBe('getCheckpoint');
      throw new OJSNotFoundError('checkpoint', 'job-grpc-first-run');
    };

    const dc = await DurableContext.create(transport, 'job-grpc-first-run', 1);
    expect(dc.isReplaying()).toBe(false);
    expect(callCount.value).toBe(1);
  });

  it('accepts an empty but valid canonical replay log without inventing replay entries', async () => {
    const transport = createMockTransport({
      _ojsReplayLog: [],
      _ojsStepIndex: 0,
      _ojsAttempt: 1,
      value: null,
    });

    const dc = await DurableContext.create(transport, 'job-empty-log', 2);
    expect(dc.isReplaying()).toBe(false);

    let sideEffectCalls = 0;
    await expect(dc.sideEffect('first-call', async () => {
      sideEffectCalls++;
      return { ok: true };
    })).resolves.toEqual({ ok: true });
    expect(sideEffectCalls).toBe(1);
  });

  it.each([
    ['now()', 'random', () => undefined],
    ['random()', 'time', () => undefined],
    ['sideEffect()', 'time', async (dc: DurableContext) => {
      let calls = 0;
      await expect(dc.sideEffect('fetch', async () => {
        calls++;
        return 'live';
      })).rejects.toBeInstanceOf(ReplayIntegrityError);
      expect(calls).toBe(0);
    }],
  ])('fails closed when %s is out of order with the replay log', async (operation, entryType, invoke) => {
    const entry = entryType === 'random'
      ? { seq: 0, type: 'random', result: 'c0ffee' }
      : { seq: 0, type: 'time', key: 'now', result: '2026-01-15T10:00:00.000Z' };
    const dc = await DurableContext.create(createMockTransport({
      _ojsReplayLog: [entry],
      _ojsStepIndex: 1,
      _ojsAttempt: 1,
      value: null,
    }), `job-order-${operation}`, 2);

    if (operation === 'now()') {
      expect(() => dc.now()).toThrow(ReplayIntegrityError);
    } else if (operation === 'random()') {
      expect(() => dc.random(3)).toThrow(ReplayIntegrityError);
    } else {
      await invoke(dc);
    }

    expect(dc.isReplaying()).toBe(true);
  });

  it('rejects a side-effect key mismatch without executing live code or consuming replay', async () => {
    const dc = await DurableContext.create(createMockTransport({
      _ojsReplayLog: [
        { seq: 0, type: 'call', key: 'charge-card', result: { receipt: 'saved' } },
      ],
      _ojsStepIndex: 1,
      _ojsAttempt: 1,
      value: null,
    }), 'job-key-mismatch', 2);
    let calls = 0;

    let caught: unknown;
    try {
      await dc.sideEffect('send-email', async () => {
        calls++;
        return { delivered: true };
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ReplayIntegrityError);
    expect(caught).toMatchObject({
      position: 0,
      expectedType: 'call',
      actualType: 'call',
      expectedKey: 'send-email',
      actualKey: 'charge-card',
      retryable: false,
    });
    expect(calls).toBe(0);
    expect(dc.isReplaying()).toBe(true);

    await expect(dc.sideEffect('charge-card', async () => {
      calls++;
      return { receipt: 'live' };
    })).resolves.toEqual({ receipt: 'saved' });
    expect(calls).toBe(0);
    expect(dc.isReplaying()).toBe(false);
  });

  async function expectRejectedCanonicalState(
    state: unknown,
    expectedMessage: string,
  ): Promise<void> {
    const requests: TransportRequestOptions[] = [];
    const transport: Transport = {
      // Even on an HTTP-capable transport, a successful canonical lookup
      // with foreign/corrupt state must not fall back to legacy or write a
      // migration checkpoint.
      supportsLegacyCheckpointResume: true,
      async request<T>(options: TransportRequestOptions): Promise<TransportResponse<T>> {
        requests.push(options);
        if (options.method === 'GET' && CHECKPOINT_PATH_RE.test(options.path)) {
          return {
            status: 200,
            headers: {},
            body: {
              job_id: 'job-invalid-state',
              state,
              sequence: 1,
              created_at: null,
            } as T,
          };
        }
        throw new Error(`Unexpected side-effecting/fallback request: ${options.method} ${options.path}`);
      },
    };

    let caught: unknown;
    try {
      await DurableContext.create(transport, 'job-invalid-state', 2);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OJSCheckpointLoadError);
    expect(((caught as OJSCheckpointLoadError).cause as Error).message).toContain(expectedMessage);
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /jobs/job-invalid-state/checkpoint',
    ]);
  }

  it('rejects foreign canonical state instead of silently entering record mode', async () => {
    await expectRejectedCanonicalState('foreign checkpoint state', 'wrapper object');
  });

  it('rejects canonical state that is missing the _ojsReplayLog wrapper', async () => {
    await expectRejectedCanonicalState(
      { _ojsStepIndex: 1, _ojsAttempt: 1, value: { foreign: true } },
      'missing _ojsReplayLog',
    );
  });

  it('rejects a canonical _ojsReplayLog with the wrong type', async () => {
    await expectRejectedCanonicalState(
      {
        _ojsReplayLog: { entries: [] },
        _ojsStepIndex: 1,
        _ojsAttempt: 1,
        value: null,
      },
      'expected an array',
    );
  });

  it.each([
    ['step index', { _ojsReplayLog: [], _ojsStepIndex: '1', _ojsAttempt: 1, value: null }, '_ojsStepIndex'],
    ['attempt', { _ojsReplayLog: [], _ojsStepIndex: 1, _ojsAttempt: 0, value: null }, '_ojsAttempt'],
    ['caller state', { _ojsReplayLog: [], _ojsStepIndex: 1, _ojsAttempt: 1 }, 'missing value'],
  ])('rejects a canonical wrapper with an invalid %s field', async (_field, state, message) => {
    await expectRejectedCanonicalState(state, message);
  });

  it('falls back to and migrates a legacy checkpoint only after a canonical 404', async () => {
    const requests: TransportRequestOptions[] = [];
    let migratedState: Record<string, unknown> | undefined;
    const replayLog = [
      { seq: 0, type: 'call', key: 'legacy-call', result: { value: 42 } },
    ];
    const transport: Transport = {
      supportsLegacyCheckpointResume: true,
      async request<T>(options: TransportRequestOptions): Promise<TransportResponse<T>> {
        requests.push(options);
        if (options.method === 'GET' && CHECKPOINT_PATH_RE.test(options.path)) {
          throw new OJSNotFoundError('checkpoint', 'job-legacy');
        }
        if (options.method === 'GET' && LEGACY_CHECKPOINT_PATH_RE.test(options.path)) {
          return {
            status: 200,
            headers: {},
            body: {
              has_checkpoint: true,
              checkpoint: {
                step_index: 2,
                state: { phase: 'legacy' },
                metadata: { _replay_log: JSON.stringify(replayLog) },
              },
            } as T,
          };
        }
        if (options.method === 'POST' && CHECKPOINT_PATH_RE.test(options.path)) {
          migratedState = (options.body as { state: Record<string, unknown> }).state;
          return { status: 200, headers: {}, body: {} as T };
        }
        throw new Error(`Unexpected request: ${options.method} ${options.path}`);
      },
    };

    const dc = await DurableContext.create(transport, 'job-legacy', 3);
    let sideEffectCalls = 0;
    await expect(dc.sideEffect('legacy-call', async () => {
      sideEffectCalls++;
      return { value: -1 };
    })).resolves.toEqual({ value: 42 });

    expect(sideEffectCalls).toBe(0);
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /jobs/job-legacy/checkpoint',
      'GET /checkpoints/job-legacy/resume',
      'POST /jobs/job-legacy/checkpoint',
    ]);
    expect(migratedState?._ojsReplayLog).toEqual(replayLog);
    expect(migratedState?._ojsStepIndex).toBe(2);
    expect(migratedState?.value).toEqual({ phase: 'legacy' });
    expect(dc.migrationError()).toBeUndefined();
  });

  it.each([
    ['404 Not Found', new OJSNotFoundError('checkpoint', 'job-legacy-unavailable')],
    ['405 Method Not Allowed', new OJSMethodNotAllowedError()],
  ])('treats legacy %s as unsupported and starts first execution', async (_label, legacyError) => {
    const requests: string[] = [];
    const transport: Transport = {
      supportsLegacyCheckpointResume: true,
      async request<T>(options: TransportRequestOptions): Promise<TransportResponse<T>> {
        requests.push(`${options.method} ${options.path}`);
        if (CHECKPOINT_PATH_RE.test(options.path)) {
          throw new OJSNotFoundError('checkpoint', 'job-legacy-unavailable');
        }
        if (LEGACY_CHECKPOINT_PATH_RE.test(options.path)) {
          throw legacyError;
        }
        throw new Error(`Unexpected request: ${options.method} ${options.path}`);
      },
    };

    const dc = await DurableContext.create(transport, 'job-legacy-unavailable', 1);
    let calls = 0;
    await expect(dc.sideEffect('first-run', async () => {
      calls++;
      return 'live';
    })).resolves.toBe('live');

    expect(calls).toBe(1);
    expect(dc.isReplaying()).toBe(false);
    expect(requests).toEqual([
      'GET /jobs/job-legacy-unavailable/checkpoint',
      'GET /checkpoints/job-legacy-unavailable/resume',
    ]);
  });

  it('treats an explicit legacy has_checkpoint:false response as first execution', async () => {
    const requests: string[] = [];
    const transport: Transport = {
      supportsLegacyCheckpointResume: true,
      async request<T>(options: TransportRequestOptions): Promise<TransportResponse<T>> {
        requests.push(`${options.method} ${options.path}`);
        if (CHECKPOINT_PATH_RE.test(options.path)) {
          throw new OJSNotFoundError('checkpoint', 'job-legacy-none');
        }
        if (LEGACY_CHECKPOINT_PATH_RE.test(options.path)) {
          return {
            status: 200,
            headers: {},
            body: { has_checkpoint: false } as T,
          };
        }
        throw new Error(`Unexpected request: ${options.method} ${options.path}`);
      },
    };

    const dc = await DurableContext.create(transport, 'job-legacy-none', 1);
    let calls = 0;
    await expect(
      dc.sideEffect('first-run', async () => {
        calls++;
        return 'live';
      }),
    ).resolves.toBe('live');

    expect(calls).toBe(1);
    expect(dc.isReplaying()).toBe(false);
    expect(requests).toEqual([
      'GET /jobs/job-legacy-none/checkpoint',
      'GET /checkpoints/job-legacy-none/resume',
    ]);
  });

  it('reports but does not block replay when legacy migration fails', async () => {
    const transport: Transport = {
      supportsLegacyCheckpointResume: true,
      async request<T>(options: TransportRequestOptions): Promise<TransportResponse<T>> {
        if (options.method === 'GET' && CHECKPOINT_PATH_RE.test(options.path)) {
          throw new OJSNotFoundError('checkpoint', 'job-legacy');
        }
        if (options.method === 'GET' && LEGACY_CHECKPOINT_PATH_RE.test(options.path)) {
          return {
            status: 200,
            headers: {},
            body: {
              has_checkpoint: true,
              checkpoint: {
                metadata: {
                  _replay_log: JSON.stringify([
                    { seq: 0, type: 'random', result: 'c0ffee' },
                  ]),
                },
              },
            } as T,
          };
        }
        if (options.method === 'POST') {
          throw new OJSServerError('migration unavailable', 503);
        }
        throw new Error(`Unexpected request: ${options.method} ${options.path}`);
      },
    };

    const dc = await DurableContext.create(transport, 'job-legacy', 2);
    expect(dc.random(3)).toBe('c0ffee');
    expect(dc.migrationError()).toBeInstanceOf(OJSServerError);
  });

  it('sends a checkpoint request to the spec-correct path with a wrapped state', async () => {
    let savedBody: { state?: Record<string, unknown> } | undefined;
    let savedPath: string | undefined;
    let savedMethod: string | undefined;

    const transport: Transport = {
      async request<T>(options: TransportRequestOptions): Promise<TransportResponse<T>> {
        if (options.method === 'POST' && CHECKPOINT_PATH_RE.test(options.path)) {
          savedBody = options.body as { state?: Record<string, unknown> };
          savedPath = options.path;
          savedMethod = options.method;
        }
        if (options.method === 'GET' && CHECKPOINT_PATH_RE.test(options.path)) {
          throw new OJSNotFoundError('checkpoint', 'unknown');
        }
        if (options.method === 'GET' && LEGACY_CHECKPOINT_PATH_RE.test(options.path)) {
          throw new OJSNotFoundError('checkpoint', 'unknown');
        }
        return { body: {} as T, status: 200, headers: {} };
      },
    };

    const dc = await DurableContext.create(transport, 'job-cp', 1);
    dc.now();
    dc.random(8);

    await dc.checkpoint(2, { step: 'transform' });

    expect(savedMethod).toBe('POST');
    expect(savedPath).toBe('/jobs/job-cp/checkpoint');
    expect(savedBody).toBeDefined();
    // The request body has *only* `state` (and optionally `sequence`) per
    // the checkpoint.schema.json request definition (additionalProperties:
    // false) — no top-level step_index/metadata siblings.
    expect(Object.keys(savedBody!)).toEqual(['state']);

    const state = savedBody!.state as Record<string, unknown>;
    expect(state.value).toEqual({ step: 'transform' });
    expect(state._ojsStepIndex).toBe(2);
    expect(state._ojsAttempt).toBe(1);
    expect(Array.isArray(state._ojsReplayLog)).toBe(true);
    expect((state._ojsReplayLog as unknown[]).length).toBe(2); // now() + random()
  });

  it('URL-encodes the job ID in the checkpoint path', async () => {
    let savedPath: string | undefined;
    const transport: Transport = {
      async request<T>(options: TransportRequestOptions): Promise<TransportResponse<T>> {
        if (options.method === 'POST') savedPath = options.path;
        if (options.method === 'GET') throw new OJSNotFoundError('checkpoint', 'unknown');
        return { body: {} as T, status: 200, headers: {} };
      },
    };

    const dc = await DurableContext.create(transport, 'job/needs-encoding', 1);
    await dc.checkpoint(1, {});

    expect(savedPath).toBe('/jobs/job%2Fneeds-encoding/checkpoint');
  });

  it('sends DELETE to the spec-correct path on complete()', async () => {
    let deletesCalled = 0;
    let deletePath: string | undefined;
    const transport: Transport = {
      async request<T>(options: TransportRequestOptions): Promise<TransportResponse<T>> {
        if (options.method === 'DELETE') {
          deletesCalled++;
          deletePath = options.path;
        }
        if (options.method === 'GET') throw new OJSNotFoundError('checkpoint', 'unknown');
        return { body: {} as T, status: 200, headers: {} };
      },
    };

    const dc = await DurableContext.create(transport, 'job-done', 1);
    await dc.complete();

    expect(deletesCalled).toBe(1);
    expect(deletePath).toBe('/jobs/job-done/checkpoint');
  });

  describe('checkpoint-load failure propagation (non-404 errors)', () => {
    // Per the design: only a true OJSNotFoundError (no checkpoint has ever
    // been saved for this job) is treated as "start in record mode". Any
    // other failure means the SDK genuinely does not know whether a
    // checkpoint exists, so silently starting fresh would risk
    // re-executing already-recorded side effects. `create()` must
    // therefore reject with a contextual `OJSCheckpointLoadError` (never
    // resolve to a fresh, record-mode context) for each of these cases.

    async function expectPropagatedCheckpointError(
      transport: Transport,
      jobId: string,
      attempt: number,
      originalError: unknown,
    ): Promise<OJSCheckpointLoadError> {
      let caught: unknown;
      try {
        await DurableContext.create(transport, jobId, attempt);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(OJSCheckpointLoadError);
      const err = caught as OJSCheckpointLoadError;
      expect(err.jobId).toBe(jobId);
      expect(err.attempt).toBe(attempt);
      expect(err.cause).toBe(originalError);
      expect(err.message).toContain(jobId);
      return err;
    }

    it('propagates a connection/network failure instead of silently starting fresh', async () => {
      const connErr = new OJSConnectionError('connection refused');
      const requestedPaths: string[] = [];
      const transport: Transport = {
        async request<T>(options: TransportRequestOptions): Promise<TransportResponse<T>> {
          requestedPaths.push(options.path);
          if (options.method === 'GET') throw connErr;
          return { body: {} as T, status: 200, headers: {} };
        },
      };

      const err = await expectPropagatedCheckpointError(transport, 'job-conn-fail', 1, connErr);
      // OJSConnectionError is retryable — the wrapper should carry that
      // classification through rather than discarding it.
      expect(err.retryable).toBe(true);
      expect(requestedPaths).toEqual(['/jobs/job-conn-fail/checkpoint']);
    });

    it('propagates an auth/authorization failure instead of silently starting fresh', async () => {
      // No dedicated OJSAuthError class exists in this SDK; a 401/403
      // response surfaces as a generic OJSError with a non-retryable
      // classification (see parseErrorResponse's default branch).
      const authErr = new OJSError('Unauthorized', 'unauthorized', { retryable: false });
      const transport: Transport = {
        async request<T>(options: TransportRequestOptions): Promise<TransportResponse<T>> {
          if (options.method === 'GET') throw authErr;
          return { body: {} as T, status: 200, headers: {} };
        },
      };

      const err = await expectPropagatedCheckpointError(transport, 'job-auth-fail', 1, authErr);
      expect(err.retryable).toBe(false);
    });

    it('propagates an HTTP 500 server error instead of silently starting fresh', async () => {
      const serverErr = new OJSServerError('Internal Server Error', 500);
      const transport: Transport = {
        async request<T>(options: TransportRequestOptions): Promise<TransportResponse<T>> {
          if (options.method === 'GET') throw serverErr;
          return { body: {} as T, status: 200, headers: {} };
        },
      };

      const err = await expectPropagatedCheckpointError(transport, 'job-500-fail', 1, serverErr);
      expect(err.retryable).toBe(true);
    });

    it('propagates a malformed/undecodable checkpoint response instead of silently starting fresh', async () => {
      // Mirrors what HttpTransport itself throws when response.json() fails
      // to parse (see src/transport/http.ts): a non-404 OJSConnectionError.
      const decodeErr = new OJSConnectionError('Invalid JSON response (status 200)');
      const transport: Transport = {
        async request<T>(options: TransportRequestOptions): Promise<TransportResponse<T>> {
          if (options.method === 'GET') throw decodeErr;
          return { body: {} as T, status: 200, headers: {} };
        },
      };

      const err = await expectPropagatedCheckpointError(transport, 'job-decode-fail', 1, decodeErr);
      expect(err.retryable).toBe(true);
    });

    it('rejects a decoded but structurally invalid canonical checkpoint without trying legacy', async () => {
      const requestedPaths: string[] = [];
      const transport: Transport = {
        async request<T>(options: TransportRequestOptions): Promise<TransportResponse<T>> {
          requestedPaths.push(options.path);
          return { body: {} as T, status: 200, headers: {} };
        },
      };

      let caught: unknown;
      try {
        await DurableContext.create(transport, 'job-invalid-response', 2);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(OJSCheckpointLoadError);
      expect(((caught as OJSCheckpointLoadError).cause as Error).message).toContain(
        'Invalid checkpoint response',
      );
      expect(requestedPaths).toEqual(['/jobs/job-invalid-response/checkpoint']);
    });

    it('propagates a legacy lookup failure after a canonical 404', async () => {
      const legacyError = new OJSConnectionError('legacy endpoint unavailable');
      const requestedPaths: string[] = [];
      const transport: Transport = {
        supportsLegacyCheckpointResume: true,
        async request<T>(options: TransportRequestOptions): Promise<TransportResponse<T>> {
          requestedPaths.push(options.path);
          if (CHECKPOINT_PATH_RE.test(options.path)) {
            throw new OJSNotFoundError('checkpoint', 'job-legacy-fail');
          }
          throw legacyError;
        },
      };

      let caught: unknown;
      try {
        await DurableContext.create(transport, 'job-legacy-fail', 2);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(OJSCheckpointLoadError);
      expect((caught as OJSCheckpointLoadError).cause).toBe(legacyError);
      expect((caught as OJSCheckpointLoadError).retryable).toBe(true);
      expect((caught as OJSCheckpointLoadError).message).toContain('legacy checkpoint');
      expect(requestedPaths).toEqual([
        '/jobs/job-legacy-fail/checkpoint',
        '/checkpoints/job-legacy-fail/resume',
      ]);
    });

    it.each([
      ['checkpoint data', undefined],
      ['metadata', {}],
      ['metadata._replay_log', { metadata: { unrelated: true } }],
    ])(
      'rejects has_checkpoint:true with missing %s as legacy corruption',
      async (_missing, checkpoint) => {
      const transport: Transport = {
        supportsLegacyCheckpointResume: true,
        async request<T>(options: TransportRequestOptions): Promise<TransportResponse<T>> {
          if (CHECKPOINT_PATH_RE.test(options.path)) {
            throw new OJSNotFoundError('checkpoint', 'job-legacy-corrupt');
          }
          return {
            status: 200,
            headers: {},
            body: {
              has_checkpoint: true,
              ...(checkpoint === undefined ? {} : { checkpoint }),
            } as T,
          };
        },
      };

      let caught: unknown;
      try {
        await DurableContext.create(transport, 'job-legacy-corrupt', 2);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(OJSCheckpointLoadError);
      const checkpointError = caught as OJSCheckpointLoadError;
      expect(checkpointError).toMatchObject({
        code: 'checkpoint_load_failed',
        details: {
          job_id: 'job-legacy-corrupt',
          attempt: 2,
          checkpoint_source: 'legacy',
        },
      });
      expect((checkpointError.cause as Error).message).toMatch(
        /missing checkpoint data|metadata\._replay_log is missing/,
      );
    },
    );

    it('never resolves to a usable DurableContext when checkpoint loading fails this way', async () => {
      // Guards against a regression where create() might catch the thrown
      // OJSCheckpointLoadError somewhere and still return a fresh context.
      const transport: Transport = {
        async request<T>(options: TransportRequestOptions): Promise<TransportResponse<T>> {
          if (options.method === 'GET') throw new OJSConnectionError('connection refused');
          return { body: {} as T, status: 200, headers: {} };
        },
      };

      await expect(DurableContext.create(transport, 'job-never-resolves', 1)).rejects.toBeInstanceOf(
        OJSCheckpointLoadError,
      );
    });
  });

  it('still starts in record mode on a true 404 (no checkpoint yet) — first execution', async () => {
    // Retained/re-verified alongside the non-404 propagation tests above:
    // a 404 remains the *only* condition treated as "first run".
    const transport = createMockTransport();
    const dc = await DurableContext.create(transport, 'job-first-run', 1);

    expect(dc.isReplaying()).toBe(false);

    // Should work in record mode
    const t = dc.now();
    expect(t).toBeInstanceOf(Date);
  });
});

/**
 * Worker-level regression coverage for Finding 1
 * (`src/transport/grpc.ts`'s `grpcAck`): a job handler that returns a
 * bare scalar/array result — which `google.protobuf.Struct` (AckRequest
 * .result's wire type) cannot represent — must still be acknowledged
 * exactly once through a real `OJSWorker` run, with:
 *
 *   - no `nack` call (the handler succeeded; this must never be
 *     misreported as a failure),
 *   - no redelivery/duplicate processing (the ack must not be skipped
 *     or fail silently, which would strand the job for the visibility
 *     timeout to expire and redeliver it), and
 *   - exactly one protocol warning via `onWarning`.
 *
 * This exercises the real `GrpcTransport` (with its generated-client call
 * stubbed, as in the other grpc test files) wired into a real `OJSWorker`,
 * not just a direct `transport.request()` call — see
 * `tests/transport-grpc-workflow-cron-ack.test.ts` for the lower-level
 * direct-transport coverage of the same fix.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OJSWorker } from '../src/worker.js';
import { GrpcTransport, type GrpcProtocolWarning } from '../src/transport/grpc.js';

interface CapturedCall {
  method: string;
  request: Record<string, unknown>;
}

/** A minimal proto-shaped Job (see `fromProtoJob` in src/transport/grpc.ts
 * — every field not set here is defaulted safely). */
function protoJob(id: string): Record<string, unknown> {
  return { id, type: 'report.generate', queue: 'default', state: 'JOB_STATE_ACTIVE', attempt: 1 };
}

/**
 * Wires a real `GrpcTransport` the same way the other grpc test files do
 * — bypassing lazy init and overriding the private `call()` — so a real
 * `OJSWorker` can fetch/ack/nack/heartbeat through it without any actual
 * network I/O. `jobsToFetch` is returned on the *first* fetch only (every
 * later poll gets an empty list, so the worker naturally idles rather
 * than looping/re-fetching the same job).
 */
function createCapturingWorkerGrpcTransport(
  jobsToFetch: Record<string, unknown>[],
  onWarning: (warning: GrpcProtocolWarning) => void,
): { transport: GrpcTransport; calls: CapturedCall[] } {
  const transport = new GrpcTransport({ url: 'localhost:9090', onWarning });
  const calls: CapturedCall[] = [];
  let fetchCount = 0;

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
  }).call = async (method: string, request: unknown): Promise<unknown> => {
    calls.push({ method, request: request as Record<string, unknown> });
    switch (method) {
      case 'fetch':
        fetchCount++;
        return { jobs: fetchCount === 1 ? jobsToFetch : [] };
      case 'ack':
        return { acknowledged: true };
      case 'nack':
        return { state: 'JOB_STATE_RETRYABLE', nextAttemptAt: null };
      case 'heartbeat':
        return { directedState: null };
      default:
        throw new Error(`unexpected method '${method}'`);
    }
  };

  return { transport, calls };
}

describe('OJSWorker ack over GrpcTransport: unrepresentable result', () => {
  let worker: OJSWorker | undefined;

  afterEach(async () => {
    if (worker && worker.currentState !== 'terminated') {
      await worker.stop();
    }
    worker = undefined;
  });

  it('acks a scalar handler result exactly once, never nacks, and warns exactly once', async () => {
    vi.useFakeTimers();
    try {
      const warnings: GrpcProtocolWarning[] = [];
      const { transport, calls } = createCapturingWorkerGrpcTransport(
        [protoJob('job-1')],
        (w) => warnings.push(w),
      );

      const handlerCalls: unknown[] = [];
      worker = new OJSWorker({
        url: 'unused',
        queues: ['default'],
        concurrency: 1,
        pollInterval: 20,
        heartbeatInterval: 60_000,
        handleSignals: false,
        transport,
      });
      worker.register('report.generate', async (ctx) => {
        handlerCalls.push(ctx.job.id);
        // A bare number result: google.protobuf.Struct cannot represent
        // it at all.
        return 42;
      });

      await worker.start();
      await vi.advanceTimersByTimeAsync(200);
      await worker.stop();

      // The handler ran exactly once — no redelivery/duplicate processing.
      expect(handlerCalls).toEqual(['job-1']);

      const ackCalls = calls.filter((c) => c.method === 'ack');
      const nackCalls = calls.filter((c) => c.method === 'nack');
      expect(ackCalls).toHaveLength(1);
      expect(nackCalls).toHaveLength(0);
      expect(ackCalls[0]!.request.jobId).toBe('job-1');
      // The unrepresentable scalar result is never sent on the wire.
      expect('result' in ackCalls[0]!.request).toBe(false);

      // Exactly one protocol warning was surfaced for the whole run.
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.code).toBe('ack_result_unrepresentable');
      expect(warnings[0]!.originalResultType).toBe('number');
    } finally {
      vi.useRealTimers();
    }
  });

  it('acks an array handler result exactly once with exactly one warning', async () => {
    vi.useFakeTimers();
    try {
      const warnings: GrpcProtocolWarning[] = [];
      const { transport, calls } = createCapturingWorkerGrpcTransport(
        [protoJob('job-2')],
        (w) => warnings.push(w),
      );

      worker = new OJSWorker({
        url: 'unused',
        queues: ['default'],
        concurrency: 1,
        pollInterval: 20,
        heartbeatInterval: 60_000,
        handleSignals: false,
        transport,
      });
      worker.register('report.generate', async () => ['a', 'b', 'c']);

      await worker.start();
      await vi.advanceTimersByTimeAsync(200);
      await worker.stop();

      expect(calls.filter((c) => c.method === 'ack')).toHaveLength(1);
      expect(calls.filter((c) => c.method === 'nack')).toHaveLength(0);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.originalResultType).toBe('array');
    } finally {
      vi.useRealTimers();
    }
  });

  it('acks a valid object handler result with no warning at all', async () => {
    vi.useFakeTimers();
    try {
      const warnings: GrpcProtocolWarning[] = [];
      const { transport, calls } = createCapturingWorkerGrpcTransport(
        [protoJob('job-3')],
        (w) => warnings.push(w),
      );

      worker = new OJSWorker({
        url: 'unused',
        queues: ['default'],
        concurrency: 1,
        pollInterval: 20,
        heartbeatInterval: 60_000,
        handleSignals: false,
        transport,
      });
      worker.register('report.generate', async () => ({ ok: true }));

      await worker.start();
      await vi.advanceTimersByTimeAsync(200);
      await worker.stop();

      const ackCalls = calls.filter((c) => c.method === 'ack');
      expect(ackCalls).toHaveLength(1);
      expect(ackCalls[0]!.request.result).toEqual({ fields: { ok: { boolValue: true } } });
      expect(calls.filter((c) => c.method === 'nack')).toHaveLength(0);
      expect(warnings).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('acks an omitted (undefined) handler result with no warning', async () => {
    vi.useFakeTimers();
    try {
      const warnings: GrpcProtocolWarning[] = [];
      const { transport, calls } = createCapturingWorkerGrpcTransport(
        [protoJob('job-4')],
        (w) => warnings.push(w),
      );

      worker = new OJSWorker({
        url: 'unused',
        queues: ['default'],
        concurrency: 1,
        pollInterval: 20,
        heartbeatInterval: 60_000,
        handleSignals: false,
        transport,
      });
      worker.register('report.generate', async () => undefined);

      await worker.start();
      await vi.advanceTimersByTimeAsync(200);
      await worker.stop();

      const ackCalls = calls.filter((c) => c.method === 'ack');
      expect(ackCalls).toHaveLength(1);
      expect('result' in ackCalls[0]!.request).toBe(false);
      expect(calls.filter((c) => c.method === 'nack')).toHaveLength(0);
      expect(warnings).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

import { describe, expect, it, vi } from 'vitest';
import { GrpcTransport } from '../src/transport/grpc.js';

interface MockStreamState {
  openCalls(): number;
  maxConcurrentNextCalls(): number;
  transportSignal: AbortSignal;
}

function injectMockClient(
  transport: GrpcTransport,
  streamMessages: unknown[],
): MockStreamState {
  let opened = 0;
  let activeNextCalls = 0;
  let maximumNextCalls = 0;

  const mockStream = {
    [Symbol.asyncIterator]() {
      return this;
    },
    index: 0,
    cancelled: false,
    async next() {
      activeNextCalls += 1;
      maximumNextCalls = Math.max(maximumNextCalls, activeNextCalls);
      try {
        await Promise.resolve();
        if (this.cancelled || this.index >= streamMessages.length) {
          return { done: true, value: undefined };
        }
        const value = streamMessages[this.index];
        this.index += 1;
        return { done: false, value };
      } finally {
        activeNextCalls -= 1;
      }
    },
    async return() {
      this.cancelled = true;
      return { done: true, value: undefined };
    },
    async throw() {
      this.cancelled = true;
      return { done: true, value: undefined };
    },
    on() {
      return this;
    },
    removeAllListeners() {
      return this;
    },
    cancel() {
      this.cancelled = true;
    },
  };

  const mockGrpcModule = {
    Metadata: class {
      set() {}
    },
    status: {
      OK: 0,
      CANCELLED: 1,
      RESOURCE_EXHAUSTED: 8,
      INTERNAL: 13,
      UNAVAILABLE: 14,
      UNIMPLEMENTED: 12,
    },
  };
  const mockClient = new Proxy(
    { close: vi.fn() },
    {
      get(target, property) {
        if (property === 'close') return target.close;
        if (property === 'streamJobs' || property === 'streamEvents') {
          return () => {
            opened += 1;
            return mockStream;
          };
        }
        return undefined;
      },
    },
  );

  const internals = transport as unknown as Record<string, unknown>;
  internals.grpcModule = mockGrpcModule;
  internals.client = mockClient;
  internals.initPromise = null;

  return {
    openCalls: () => opened,
    maxConcurrentNextCalls: () => maximumNextCalls,
    transportSignal: (
      internals.streamAbortController as AbortController
    ).signal,
  };
}

function job(id: string): Record<string, unknown> {
  return {
    id,
    type: 'test.job',
    args: [],
    queue: 'default',
    state: 'active',
    specversion: '1.0',
  };
}

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe('gRPC stream iterator deferred initialization', () => {
  it('keeps unused iterators listener-free and invalid after transport close', async () => {
    const transport = new GrpcTransport({ url: 'localhost:9090' });
    const state = injectMockClient(transport, [job('job-1')]);
    const caller = new AbortController();
    const transportAdd = vi.spyOn(state.transportSignal, 'addEventListener');
    const callerAdd = vi.spyOn(caller.signal, 'addEventListener');

    const iterator = transport.streamJobs(
      { queues: ['default'] },
      { signal: caller.signal },
    );

    expect(transportAdd).not.toHaveBeenCalled();
    expect(callerAdd).not.toHaveBeenCalled();
    expect(state.openCalls()).toBe(0);

    transport.close();

    expect(transportAdd).not.toHaveBeenCalled();
    expect(callerAdd).not.toHaveBeenCalled();
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(state.openCalls()).toBe(0);
  });

  it('opens one RPC and serializes concurrent initial next calls', async () => {
    const transport = new GrpcTransport({ url: 'localhost:9090' });
    const state = injectMockClient(transport, [
      job('job-1'),
      job('job-2'),
      job('job-3'),
    ]);
    const iterator = transport.streamJobs({ queues: ['default'] });

    const results = await Promise.all([
      iterator.next(),
      iterator.next(),
      iterator.next(),
    ]);

    expect(state.openCalls()).toBe(1);
    expect(state.maxConcurrentNextCalls()).toBe(1);
    expect(results.map((result) => result.value?.id)).toEqual([
      'job-1',
      'job-2',
      'job-3',
    ]);

    await iterator.return?.();
    transport.close();
  });

  it('return before initialization installs no listeners and opens no RPC', async () => {
    const transport = new GrpcTransport({ url: 'localhost:9090' });
    const state = injectMockClient(transport, [job('job-1')]);
    const caller = new AbortController();
    const transportAdd = vi.spyOn(state.transportSignal, 'addEventListener');
    const callerAdd = vi.spyOn(caller.signal, 'addEventListener');
    const iterator = transport.streamJobs(
      { queues: ['default'] },
      { signal: caller.signal },
    );

    await expect(iterator.return?.()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(state.openCalls()).toBe(0);
    expect(transportAdd).not.toHaveBeenCalled();
    expect(callerAdd).not.toHaveBeenCalled();

    transport.close();
  });

  it('return during shared initialization prevents the RPC and cleans listeners', async () => {
    const transport = new GrpcTransport({ url: 'localhost:9090' });
    const state = injectMockClient(transport, [job('job-1')]);
    const caller = new AbortController();
    const transportAdd = vi.spyOn(state.transportSignal, 'addEventListener');
    const transportRemove = vi.spyOn(state.transportSignal, 'removeEventListener');
    const callerAdd = vi.spyOn(caller.signal, 'addEventListener');
    const callerRemove = vi.spyOn(caller.signal, 'removeEventListener');
    const initialization = deferred();
    const ensureClient = vi.fn(() => initialization.promise);
    (transport as unknown as Record<string, unknown>).ensureClient = ensureClient;

    const iterator = transport.streamJobs(
      { queues: ['default'] },
      { signal: caller.signal },
    );
    const pendingNext = iterator.next();
    await vi.waitFor(() => expect(ensureClient).toHaveBeenCalledTimes(1));

    await expect(iterator.return?.()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    initialization.resolve();

    await expect(pendingNext).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(state.openCalls()).toBe(0);
    expect(transportAdd).toHaveBeenCalledTimes(1);
    expect(transportRemove).toHaveBeenCalledTimes(1);
    expect(callerAdd).toHaveBeenCalledTimes(1);
    expect(callerRemove).toHaveBeenCalledTimes(1);

    transport.close();
  });

  it('close during shared initialization prevents the RPC and cleans listeners', async () => {
    const transport = new GrpcTransport({ url: 'localhost:9090' });
    const state = injectMockClient(transport, [job('job-1')]);
    const caller = new AbortController();
    const transportRemove = vi.spyOn(state.transportSignal, 'removeEventListener');
    const callerRemove = vi.spyOn(caller.signal, 'removeEventListener');
    const initialization = deferred();
    const ensureClient = vi.fn(() => initialization.promise);
    (transport as unknown as Record<string, unknown>).ensureClient = ensureClient;

    const iterator = transport.streamJobs(
      { queues: ['default'] },
      { signal: caller.signal },
    );
    const pendingNext = iterator.next();
    await vi.waitFor(() => expect(ensureClient).toHaveBeenCalledTimes(1));

    transport.close();
    initialization.resolve();

    await expect(pendingNext).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(state.openCalls()).toBe(0);
    expect(transportRemove).toHaveBeenCalledTimes(1);
    expect(callerRemove).toHaveBeenCalledTimes(1);
  });

  it('throw during shared initialization prevents the RPC and cleans listeners', async () => {
    const transport = new GrpcTransport({ url: 'localhost:9090' });
    const state = injectMockClient(transport, [job('job-1')]);
    const caller = new AbortController();
    const transportRemove = vi.spyOn(state.transportSignal, 'removeEventListener');
    const callerRemove = vi.spyOn(caller.signal, 'removeEventListener');
    const initialization = deferred();
    const ensureClient = vi.fn(() => initialization.promise);
    (transport as unknown as Record<string, unknown>).ensureClient = ensureClient;

    const iterator = transport.streamJobs(
      { queues: ['default'] },
      { signal: caller.signal },
    );
    const pendingNext = iterator.next();
    await vi.waitFor(() => expect(ensureClient).toHaveBeenCalledTimes(1));

    await expect(iterator.throw?.(new Error('cancelled'))).rejects.toThrow(
      'cancelled',
    );
    initialization.resolve();

    await expect(pendingNext).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(state.openCalls()).toBe(0);
    expect(transportRemove).toHaveBeenCalledTimes(1);
    expect(callerRemove).toHaveBeenCalledTimes(1);

    transport.close();
  });

  it('throw before initialization rejects without opening an RPC', async () => {
    const transport = new GrpcTransport({ url: 'localhost:9090' });
    const state = injectMockClient(transport, []);
    const iterator = transport.streamJobs({ queues: ['default'] });

    await expect(iterator.throw?.(new Error('cancelled'))).rejects.toThrow(
      'cancelled',
    );
    expect(state.openCalls()).toBe(0);

    transport.close();
  });

  it('throw after the stream is connected rejects with the exact consumer marker even though the inner unwinds cleanly', async () => {
    // The mock stream's throw() resolves { done: true } (a clean unwind), and
    // the inner reconnecting iterator likewise returns cleanly once its
    // signal aborts. The GrpcTransport wrapper must still honor the consumer's
    // throw contract and reject with the provided error.
    const transport = new GrpcTransport({ url: 'localhost:9090' });
    injectMockClient(transport, [job('job-1'), job('job-2')]);
    const iterator = transport.streamJobs({ queues: ['default'] });

    const first = await iterator.next();
    expect(first.value?.id).toBe('job-1');

    const marker = { kind: 'post-yield-consumer-marker' };
    await expect(iterator.throw?.(marker)).rejects.toBe(marker);

    // After a thrown cancellation, further pulls report completion.
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });

    transport.close();
  });
});

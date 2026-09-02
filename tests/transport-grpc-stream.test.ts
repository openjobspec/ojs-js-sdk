import { describe, it, expect, vi } from 'vitest';
import {
  reconnectingServerStream,
  computeStreamBackoffMs,
  type GrpcServerStreamCall,
} from '../src/transport/grpc-stream.js';
import { OJSConnectionError } from '../src/errors.js';

/**
 * A fully deterministic, in-memory fake of a grpc-js server-streaming
 * call: an async-iterable queue that can be fed values/errors/end
 * synchronously (before the consumer ever starts reading), so tests never
 * need to guess at microtask timing to get messages delivered — only the
 * *reconnect backoff delay* (a real, fake-timer-controlled `setTimeout`
 * inside `reconnectingServerStream`) ever needs explicit timer advancement.
 */
class FakeStreamCall<T> implements GrpcServerStreamCall<T> {
  private readonly entries: Array<{ value: T } | { error: unknown } | { end: true }> = [];
  private waiting: ((entry: { value: T } | { error: unknown } | { end: true }) => void) | undefined;
  cancelCalls = 0;
  private cancelled = false;
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  private opened = false;

  /**
   * Test-only structural EventEmitter surface for the setup-open signal.
   * "Replays" an already-fired 'metadata' event to a listener registered
   * afterward, so `emitOpen()` can be called at any point relative to
   * `waitForStreamOpen()`'s own (internal, timing-dependent) listener
   * registration without the test needing to guess microtask ordering.
   */
  on(event: string, listener: (...args: unknown[]) => void): this {
    if (event === 'metadata' && this.opened) {
      listener();
      return this;
    }
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  /** Fires 'metadata' to every registered listener, simulating the call
   * reaching the server (the earliest "open" signal). */
  emitOpen(): void {
    this.opened = true;
    for (const listener of this.listeners.get('metadata') ?? []) listener();
  }

  emitStatus(): void {
    for (const listener of this.listeners.get('status') ?? []) listener();
  }

  emitErrorEvent(error: unknown): void {
    for (const listener of this.listeners.get('error') ?? []) listener(error);
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  /** Queues a value to be delivered on the next iterator pull. */
  emit(value: T): this {
    this.deliver({ value });
    return this;
  }

  /** Queues an error to be thrown on the next iterator pull. */
  fail(error: unknown): this {
    this.deliver({ error });
    return this;
  }

  /** Queues a clean end (no more values) on the next iterator pull. */
  end(): this {
    this.deliver({ end: true });
    return this;
  }

  cancel(): void {
    this.cancelCalls++;
    if (this.cancelled) return;
    this.cancelled = true;
    this.fail(cancelledError());
  }

  private deliver(entry: { value: T } | { error: unknown } | { end: true }): void {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve(entry);
    } else {
      this.entries.push(entry);
    }
  }

  private next(): Promise<{ value: T } | { error: unknown } | { end: true }> {
    const queued = this.entries.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        const entry = await this.next();
        if ('end' in entry) return { done: true, value: undefined };
        if ('error' in entry) throw entry.error;
        return { done: false, value: entry.value };
      },
    };
  }
}

/** A structural gRPC service error, matching the shape `grpcCodeOf` checks. */
function grpcError(code: number, message = 'error'): Error {
  return Object.assign(new Error(message), { code });
}

function cancelledError(): Error {
  return grpcError(1, 'Cancelled on the client');
}

/**
 * Drains the microtask queue a fixed, generous number of times. Safe to
 * use with `vi.useFakeTimers()`: this only waits on Promise microtasks
 * (unaffected by fake timers, which fake macrotask scheduling like
 * `setTimeout`), so it is fully deterministic — not a real-time wait —
 * even though the exact number of hops needed to settle a chain of
 * `await`s inside `FakeStreamCall`/`reconnectingServerStream` isn't worth
 * computing precisely for each call site.
 */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

const UNAVAILABLE = 14;
const DEADLINE_EXCEEDED = 4;
const INVALID_ARGUMENT = 3;

describe('computeStreamBackoffMs', () => {
  it('computes the exact ±25% jitter bounds for the first attempt', () => {
    expect(computeStreamBackoffMs(1, undefined, () => 0)).toBe(75); // 100 * 0.75
    expect(computeStreamBackoffMs(1, undefined, () => 1)).toBe(125); // 100 * 1.25
    expect(computeStreamBackoffMs(1, undefined, () => 0.5)).toBe(100); // 100 * 1.0
  });

  it('doubles the delay for each subsequent attempt', () => {
    expect(computeStreamBackoffMs(2, undefined, () => 0.5)).toBe(200);
    expect(computeStreamBackoffMs(3, undefined, () => 0.5)).toBe(400);
    expect(computeStreamBackoffMs(4, undefined, () => 0.5)).toBe(800);
  });

  it('caps the delay at maxDelayMs even with maximal jitter', () => {
    // 2^15 * 100ms would be enormous; the cap must win even after ±25%.
    const capped = computeStreamBackoffMs(16, undefined, () => 1);
    expect(capped).toBe(30_000);
  });

  it('respects custom initialDelayMs/maxDelayMs', () => {
    expect(computeStreamBackoffMs(1, { initialDelayMs: 10 }, () => 0.5)).toBe(10);
    expect(computeStreamBackoffMs(5, { maxDelayMs: 500 }, () => 1)).toBe(500);
  });

  it('never returns a negative delay for pathological random() implementations', () => {
    expect(computeStreamBackoffMs(1, undefined, () => -10)).toBeGreaterThanOrEqual(0);
  });
});

describe('reconnectingServerStream — connectTimeoutMs (Finding 3: setup-only bound)', () => {
  it('never applies any setup bound when connectTimeoutMs is left undefined', async () => {
    const call = new FakeStreamCall<number>();
    call.emit(1);
    call.end();
    // Never fires emitOpen(): if a bound were incorrectly applied by
    // default, this would either hang or reject instead of yielding.
    const results: number[] = [];
    for await (const v of reconnectingServerStream({
      connect: () => call,
      map: (v: number) => v,
      reconnect: { enabled: false },
    })) {
      results.push(v);
    }
    expect(results).toEqual([1]);
    // The per-attempt `finally` always calls `cancel()` once as a
    // best-effort safety net even after a clean end (a documented no-op
    // on an already-ended real grpc-js call) -- unrelated to the setup
    // bound under test here, which never applied since connectTimeoutMs
    // was left undefined.
    expect(call.cancelCalls).toBe(1);
  });

  it('treats a call without the optional on()/off() surface as immediately open (no bound possible)', async () => {
    // A minimal structural implementation (like many pre-existing test
    // fakes and mocks elsewhere) without on()/off() must remain a valid
    // GrpcServerStreamCall: the setup bound simply cannot observe such a
    // call's open state, so it never fires for it.
    vi.useFakeTimers();
    try {
      const minimalCall: GrpcServerStreamCall<number> = {
        cancel: vi.fn(),
        [Symbol.asyncIterator](): AsyncIterator<number> {
          let done = false;
          return {
            next: (): Promise<IteratorResult<number>> => {
              if (done) return new Promise(() => undefined); // stays open
              done = true;
              return Promise.resolve({ done: false, value: 1 });
            },
          };
        },
      };

      const iterator = reconnectingServerStream({
        connect: () => minimalCall,
        map: (v: number) => v,
        connectTimeoutMs: 1_000,
        reconnect: { enabled: false },
      });

      const first = await iterator.next();
      expect(first).toEqual({ done: false, value: 1 });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(minimalCall.cancel).not.toHaveBeenCalled();
      await iterator.return?.();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels and reconnects a blocked setup (never opens) exactly like a transient DEADLINE_EXCEEDED, honoring backoff/maxAttempts', async () => {
    vi.useFakeTimers();
    try {
      const calls: FakeStreamCall<number>[] = [];
      let attempt = 0;
      const connect = (): FakeStreamCall<number> => {
        attempt++;
        const call = new FakeStreamCall<number>();
        calls.push(call);
        if (attempt >= 2) {
          call.emitOpen();
          call.emit(7);
          // Deliberately left open (no end()) so the consumer's single
          // `break` below -- not a further reconnect -- ends the test.
        }
        // attempt 1: never calls emitOpen() -- simulates a setup that
        // never reaches the server; must be bounded by connectTimeoutMs.
        return call;
      };

      const results: number[] = [];
      const done = (async () => {
        for await (const v of reconnectingServerStream({
          connect,
          map: (v: number) => v,
          connectTimeoutMs: 1_000,
          reconnect: { initialDelayMs: 50, maxDelayMs: 50 },
        })) {
          results.push(v);
          break;
        }
      })();

      // Let the first (blocked) attempt register its listeners/timer.
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.cancelCalls).toBe(0);

      // Exceed the setup timeout: the first attempt must be cancelled and
      // treated as a retryable connectivity failure.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls[0]!.cancelCalls).toBeGreaterThanOrEqual(1);

      // Advance past the reconnect backoff so the second (successful)
      // attempt opens and delivers its message.
      await vi.advanceTimersByTimeAsync(50);

      await done;
      expect(results).toEqual([7]);
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects promptly with a retryable-shaped error when setup never opens and reconnect is disabled', async () => {
    vi.useFakeTimers();
    try {
      const call = new FakeStreamCall<number>();
      // Never calls emitOpen() -- setup blocked forever.

      const iterator = reconnectingServerStream({
        connect: () => call,
        map: (v: number) => v,
        connectTimeoutMs: 1_000,
        reconnect: { enabled: false },
      });

      const pending = iterator.next();
      // Attach a handler in the same tick the promise is created so a
      // fake-timer-driven rejection later never has an observably
      // "unhandled" window, purely to keep this deterministic test quiet
      // — the real assertion below still awaits the same promise.
      pending.catch(() => undefined);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(1_000);

      const error = await pending.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(OJSConnectionError);
      expect(error).toMatchObject({ code: 'connection_error', retryable: true });
      expect(error).not.toHaveProperty('code', DEADLINE_EXCEEDED);
      expect(error).toHaveProperty('grpcStatusCode', DEADLINE_EXCEEDED);
      expect((error as OJSConnectionError).toJSON()).not.toHaveProperty(
        'grpcStatusCode',
      );
      expect(call.cancelCalls).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects setup with the actual initial service error instead of treating error as open', async () => {
    const call = new FakeStreamCall<number>();
    const serviceError = grpcError(UNAVAILABLE, 'endpoint unavailable');
    const iterator = reconnectingServerStream({
      connect: () => call,
      map: (v: number) => v,
      connectTimeoutMs: 10_000,
      reconnect: { enabled: false },
    });

    const pending = iterator.next();
    await flushMicrotasks();
    call.emitErrorEvent(serviceError);

    await expect(pending).rejects.toBe(serviceError);
  });

  it('retries an initial UNAVAILABLE setup error using the actual service status', async () => {
    vi.useFakeTimers();
    try {
      const calls: FakeStreamCall<number>[] = [];
      const iterator = reconnectingServerStream({
        connect: () => {
          const call = new FakeStreamCall<number>();
          calls.push(call);
          if (calls.length === 2) {
            call.emitOpen();
            call.emit(9);
          }
          return call;
        },
        map: (v: number) => v,
        connectTimeoutMs: 10_000,
        reconnect: { initialDelayMs: 25, maxDelayMs: 25 },
        random: () => 0.5,
      });

      const pending = iterator.next();
      await flushMicrotasks();
      const serviceError = grpcError(UNAVAILABLE, 'endpoint unavailable');
      calls[0]!.emitErrorEvent(serviceError);
      await vi.advanceTimersByTimeAsync(25);

      await expect(pending).resolves.toEqual({ done: false, value: 9 });
      expect(calls).toHaveLength(2);
      await iterator.return?.();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a passive error listener through timeout cancellation and removes it at status', async () => {
    vi.useFakeTimers();
    try {
      const call = new FakeStreamCall<number>();
      const iterator = reconnectingServerStream({
        connect: () => call,
        map: (v: number) => v,
        connectTimeoutMs: 1_000,
        reconnect: { enabled: false },
      });

      const pending = iterator.next();
      pending.catch(() => undefined);
      await flushMicrotasks();
      expect(call.listenerCount('error')).toBeGreaterThan(0);

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).rejects.toBeInstanceOf(OJSConnectionError);

      // The setup listener is gone, but the lifetime guard remains so a
      // grpc-js CANCELLED emitted after cancel() cannot be unhandled.
      expect(call.listenerCount('error')).toBe(1);
      expect(() => call.emitErrorEvent(cancelledError())).not.toThrow();

      call.emitStatus();
      expect(call.listenerCount('error')).toBe(0);
      expect(call.listenerCount('status')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['metadata', 'status'] as const)(
    'treats initial %s as a successful open signal',
    async (event) => {
      const call = new FakeStreamCall<number>();
      const iterator = reconnectingServerStream({
        connect: () => call,
        map: (v: number) => v,
        connectTimeoutMs: 1_000,
        reconnect: { enabled: false },
      });

      const pending = iterator.next();
      await flushMicrotasks();
      if (event === 'metadata') call.emitOpen();
      else call.emitStatus();
      call.emit(3);

      await expect(pending).resolves.toEqual({ done: false, value: 3 });
      await iterator.return?.();
    },
  );

  it('does not kill an already-open, healthy stream once connectTimeoutMs elapses, even while it keeps delivering', async () => {
    vi.useFakeTimers();
    try {
      const call = new FakeStreamCall<number>();
      const connect = (): FakeStreamCall<number> => call;

      const iterator = reconnectingServerStream({
        connect,
        map: (v: number) => v,
        connectTimeoutMs: 1_000,
        reconnect: { enabled: false },
      });

      const pendingFirst = iterator.next();
      await flushMicrotasks();
      call.emitOpen();
      call.emit(1);
      const first = await pendingFirst;
      expect(first).toEqual({ done: false, value: 1 });

      // Advance well past the setup timeout while the stream stays open
      // (no `end()`/`fail()` yet) and keeps delivering.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(call.cancelCalls).toBe(0);

      const pendingSecond = iterator.next();
      call.emit(2);
      const second = await pendingSecond;
      expect(second).toEqual({ done: false, value: 2 });
      expect(call.cancelCalls).toBe(0);

      await iterator.return?.();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reconnectingServerStream', () => {
  it('yields mapped values and filters out values the mapper returns undefined for', async () => {
    const call = new FakeStreamCall<{ v: number }>();
    call.emit({ v: 1 });
    call.emit({ v: 2 }); // filtered (even)
    call.emit({ v: 3 });
    call.end();

    const results: number[] = [];
    for await (const v of reconnectingServerStream({
      connect: () => call,
      map: (raw) => (raw.v % 2 === 0 ? undefined : raw.v),
      reconnect: { enabled: false },
    })) {
      results.push(v);
    }

    expect(results).toEqual([1, 3]);
  });

  it('never calls connect() until the returned generator is actually iterated (lazy)', () => {
    const connect = vi.fn(() => new FakeStreamCall<number>());
    reconnectingServerStream({ connect, map: (v: number) => v });
    expect(connect).not.toHaveBeenCalled();
  });

  it('reconnects after a retryable (UNAVAILABLE) error with the exact computed backoff delay', async () => {
    vi.useFakeTimers();
    try {
      const calls: FakeStreamCall<number>[] = [];
      let attempt = 0;
      const connect = (): FakeStreamCall<number> => {
        const call = new FakeStreamCall<number>();
        calls.push(call);
        attempt++;
        if (attempt === 1) {
          call.fail(grpcError(UNAVAILABLE));
        } else {
          call.emit(42);
          call.emit(43);
        }
        return call;
      };

      const results: number[] = [];
      const done = (async () => {
        for await (const v of reconnectingServerStream({
          connect,
          map: (v: number) => v,
          random: () => 0.5, // deterministic: multiplier exactly 1.0
        })) {
          results.push(v);
          if (results.length === 2) break;
        }
      })();

      // Let the first connect() + synchronous fail() propagate through the
      // for-await (pure microtask work, no timers involved yet).
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(1);

      // Backoff for attempt 1 with random()=0.5 is exactly 100ms (see
      // computeStreamBackoffMs tests above) — advancing by anything less
      // must not reconnect yet.
      await vi.advanceTimersByTimeAsync(99);
      expect(calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(2);

      await done;
      expect(results).toEqual([42, 43]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets the backoff after a stream delivers at least one message', async () => {
    vi.useFakeTimers();
    try {
      const calls: FakeStreamCall<number>[] = [];
      let attempt = 0;
      const connect = (): FakeStreamCall<number> => {
        const call = new FakeStreamCall<number>();
        calls.push(call);
        attempt++;
        if (attempt === 1) {
          // Fails immediately without delivering anything: attempt counter
          // becomes 1, next backoff should be the *first* delay (100ms).
          call.fail(grpcError(UNAVAILABLE));
        } else if (attempt === 2) {
          // Delivers one message (resets attempt to 0) then fails again:
          // the *next* backoff should be the first delay again (100ms),
          // not the second (200ms), because of the reset.
          call.emit(1);
          call.fail(grpcError(UNAVAILABLE));
        } else {
          call.emit(2);
        }
        return call;
      };

      const results: number[] = [];
      const done = (async () => {
        for await (const v of reconnectingServerStream({
          connect,
          map: (v: number) => v,
          random: () => 0.5,
        })) {
          results.push(v);
          if (results.length === 2) break;
        }
      })();

      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(1);

      // First reconnect: 100ms (attempt=1).
      await vi.advanceTimersByTimeAsync(100);
      expect(calls).toHaveLength(2);

      // Second connection delivers one value then fails again. Because it
      // delivered a value, the backoff resets — the next delay must be
      // 100ms again (not 200ms, which is what attempt=2 would compute).
      await vi.advanceTimersByTimeAsync(99);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(3);

      await done;
      expect(results).toEqual([1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconnects on DEADLINE_EXCEEDED the same way as UNAVAILABLE', async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      const connect = (): FakeStreamCall<number> => {
        attempt++;
        const call = new FakeStreamCall<number>();
        if (attempt === 1) call.fail(grpcError(DEADLINE_EXCEEDED));
        else call.emit(1);
        return call;
      };

      const results: number[] = [];
      const done = (async () => {
        for await (const v of reconnectingServerStream({ connect, map: (v: number) => v, random: () => 0.5 })) {
          results.push(v);
          if (results.length === 1) break;
        }
      })();

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(100);
      await done;
      expect(results).toEqual([1]);
      expect(attempt).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws immediately on a non-retryable error without reconnecting', async () => {
    const connect = vi.fn(() => {
      const call = new FakeStreamCall<number>();
      call.fail(grpcError(INVALID_ARGUMENT, 'bad request'));
      return call;
    });

    const consume = async (): Promise<number[]> => {
      const results: number[] = [];
      for await (const v of reconnectingServerStream({ connect, map: (v: number) => v })) {
        results.push(v);
      }
      return results;
    };

    await expect(consume()).rejects.toThrow(/bad request/);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('throws a remote CANCELLED status when no local signal was aborted', async () => {
    const connect = vi.fn(() => {
      const call = new FakeStreamCall<number>();
      call.fail(grpcError(1, 'cancelled by server'));
      return call;
    });

    const consume = async (): Promise<void> => {
      for await (const _v of reconnectingServerStream({
        connect,
        map: (v: number) => v,
      })) {
        // never reached
      }
    };

    await expect(consume()).rejects.toThrow(/cancelled by server/);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('throws the last error once maxAttempts reconnect attempts are exhausted', async () => {
    vi.useFakeTimers();
    try {
      const connect = vi.fn(() => {
        const call = new FakeStreamCall<number>();
        call.fail(grpcError(UNAVAILABLE, 'still down'));
        return call;
      });

      const consume = async (): Promise<number[]> => {
        const results: number[] = [];
        for await (const v of reconnectingServerStream({
          connect,
          map: (v: number) => v,
          reconnect: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1 },
          random: () => 0.5,
        })) {
          results.push(v);
        }
        return results;
      };

      const resultPromise = consume();
      const assertion = expect(resultPromise).rejects.toThrow(/still down/);

      // Drain all scheduled backoff timers (2 reconnect attempts at 1ms
      // each, then throws on the 3rd connect() without a further delay).
      await vi.runAllTimersAsync();
      await assertion;

      expect(connect).toHaveBeenCalledTimes(3); // initial + 2 reconnects
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reset the reconnect attempt counter on filtered keepalive messages', async () => {
    vi.useFakeTimers();
    try {
      // Each attempt delivers only a keepalive sentinel (map() filters it to
      // undefined) and then fails transiently. Keepalives must not reset the
      // attempt counter, so maxAttempts=2 is still honored (initial + 2
      // reconnects, then throw) rather than looping forever.
      const connect = vi.fn(() => {
        const call = new FakeStreamCall<number>();
        call.emit(-1); // keepalive sentinel filtered out by map()
        call.fail(grpcError(UNAVAILABLE, 'still down'));
        return call;
      });

      const consume = async (): Promise<number[]> => {
        const results: number[] = [];
        for await (const v of reconnectingServerStream({
          connect,
          map: (v: number) => (v === -1 ? undefined : v),
          reconnect: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1 },
          random: () => 0.5,
        })) {
          results.push(v);
        }
        return results;
      };

      const resultPromise = consume();
      const assertion = expect(resultPromise).rejects.toThrow(/still down/);
      await vi.runAllTimersAsync();
      await assertion;

      // If keepalives had reset the counter, connect() would be called
      // unboundedly; the fix caps it at initial + maxAttempts reconnects.
      expect(connect).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does reset the attempt counter once a caller-visible message is delivered after keepalives', async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      const connect = vi.fn(() => {
        attempt++;
        const call = new FakeStreamCall<number>();
        if (attempt <= 2) {
          // Two failing attempts that only send keepalives.
          call.emit(-1);
          call.fail(grpcError(UNAVAILABLE, 'down'));
        } else {
          // Third attempt delivers a real message (resets attempt to 0) then
          // fails again — with a fresh budget it may keep retrying, so we
          // stop the test by disabling further reconnect after the delivery.
          call.emit(7);
          call.end();
        }
        return call;
      });

      const results: number[] = [];
      const done = (async () => {
        for await (const v of reconnectingServerStream({
          connect,
          map: (v: number) => (v === -1 ? undefined : v),
          reconnect: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1, enabled: true },
          random: () => 0.5,
        })) {
          results.push(v);
          break; // stop after the first real delivery
        }
      })();

      await vi.runAllTimersAsync();
      await done;

      expect(results).toEqual([7]);
      expect(connect).toHaveBeenCalledTimes(3); // initial + 2 reconnects, then delivered
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects with the exact consumer marker from a pending .throw() even when the inner generator unwinds cleanly', async () => {
    // The inner reconnecting generator returns *cleanly* (done) once its
    // internal signal aborts, so .throw() must still reject with the
    // consumer's error rather than resolving silently.
    const call = new FakeStreamCall<number>(); // never emits — the pull blocks
    const iterator = reconnectingServerStream({
      connect: () => call,
      map: (v: number) => v,
    });

    const pending = iterator.next(); // blocks waiting for the first message
    await flushMicrotasks();

    const marker = { kind: 'pending-consumer-marker' };
    const thrown = iterator.throw!(marker);

    await expect(thrown).rejects.toBe(marker);
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(call.cancelCalls).toBeGreaterThan(0);
  });

  it('rejects a post-yield .throw() with the exact consumer marker', async () => {
    const call = new FakeStreamCall<number>();
    call.emit(1);
    const iterator = reconnectingServerStream({
      connect: () => call,
      map: (v: number) => v,
    });

    const first = await iterator.next();
    expect(first).toEqual({ done: false, value: 1 });

    const marker = { kind: 'post-yield-consumer-marker' };
    await expect(iterator.throw!(marker)).rejects.toBe(marker);
  });


  it('reconnects after a clean end (no error) when reconnect stays enabled (default)', async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      const connect = (): FakeStreamCall<number> => {
        attempt++;
        const call = new FakeStreamCall<number>();
        call.emit(attempt);
        call.end(); // clean end every time — ephemeral-stream semantics
        return call;
      };

      const results: number[] = [];
      const done = (async () => {
        for await (const v of reconnectingServerStream({
          connect,
          map: (v: number) => v,
          random: () => 0.5,
        })) {
          results.push(v);
          if (results.length === 3) break;
        }
      })();

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(100); // reconnect 1
      await vi.advanceTimersByTimeAsync(100); // reconnect 2 (backoff reset after each delivery)
      await done;

      expect(results).toEqual([1, 2, 3]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops silently (no throw) after a clean end when reconnect is disabled', async () => {
    const call = new FakeStreamCall<number>();
    call.emit(1);
    call.end();

    const results: number[] = [];
    for await (const v of reconnectingServerStream({
      connect: () => call,
      map: (v: number) => v,
      reconnect: { enabled: false },
    })) {
      results.push(v);
    }

    expect(results).toEqual([1]);
  });

  it('stops silently (no throw) when the signal is already aborted before the first connect', async () => {
    const connect = vi.fn(() => new FakeStreamCall<number>());
    const controller = new AbortController();
    controller.abort();

    const results: number[] = [];
    for await (const v of reconnectingServerStream({
      connect,
      map: (v: number) => v,
      signal: controller.signal,
    })) {
      results.push(v);
    }

    expect(results).toEqual([]);
    expect(connect).not.toHaveBeenCalled();
  });

  it('cancels the current call and stops (no throw, no reconnect) when the signal aborts mid-stream', async () => {
    const call = new FakeStreamCall<number>();
    const controller = new AbortController();

    const results: number[] = [];
    const done = (async () => {
      for await (const v of reconnectingServerStream({
        connect: () => call,
        map: (v: number) => v,
        signal: controller.signal,
      })) {
        results.push(v);
      }
    })();

    call.emit(1);
    await flushMicrotasks();
    expect(results).toEqual([1]);

    controller.abort();
    await done;

    // cancel() is called both from the onAbort handler and defensively
    // from the per-attempt `finally` block; real grpc-js documents
    // `.cancel()` as an idempotent no-op once a call has ended, so calling
    // it more than once is expected and harmless — what matters is that it
    // was called at least once (the call was genuinely cancelled).
    expect(call.cancelCalls).toBeGreaterThanOrEqual(1);
    expect(results).toEqual([1]);
  });

  it('cancels the underlying call when the consumer returns early (break) without any signal', async () => {
    const call = new FakeStreamCall<number>();
    call.emit(1);
    call.emit(2);
    call.emit(3);

    const results: number[] = [];
    for await (const v of reconnectingServerStream({ connect: () => call, map: (v: number) => v })) {
      results.push(v);
      if (results.length === 2) break;
    }

    expect(results).toEqual([1, 2]);
    // The consumer-cancellation wrapper (see grpc-stream.ts's exported
    // `reconnectingServerStream`) aborts its own internal signal the
    // instant `.return()` is invoked (here, via `for await`'s implicit
    // call on `break`), which synchronously fires the inner engine's own
    // per-attempt abort listener (cancel #1); the inner engine's `finally`
    // block then also calls `cancel()` once more as it unwinds (cancel
    // #2). Both calls target an idempotent, already-ending call — see
    // "tolerates cancel() throwing" below — so two calls is the correct,
    // expected outcome here, not a leak.
    expect(call.cancelCalls).toBe(2);
  });

  it('cancels the underlying call when the consumer throws out of the loop body', async () => {
    const call = new FakeStreamCall<number>();
    call.emit(1);

    const consume = async (): Promise<void> => {
      for await (const _v of reconnectingServerStream({ connect: () => call, map: (v: number) => v })) {
        throw new Error('consumer logic failed');
      }
    };

    await expect(consume()).rejects.toThrow('consumer logic failed');
    // Same double-cancel accounting as above: the wrapper's immediate
    // internal-signal abort (triggered by the implicit `.throw()` call
    // `for await` makes when the loop body throws) plus the inner
    // engine's own `finally` cleanup.
    expect(call.cancelCalls).toBe(2);
  });

  it('attaches exactly one add/remove pair to the caller-supplied signal for the whole stream lifetime (not per attempt)', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const addSpy = vi.spyOn(controller.signal, 'addEventListener');
      const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

      let attempt = 0;
      const connect = (): FakeStreamCall<number> => {
        attempt++;
        const call = new FakeStreamCall<number>();
        if (attempt === 1) call.fail(grpcError(UNAVAILABLE));
        else call.emit(1);
        return call;
      };

      const results: number[] = [];
      const done = (async () => {
        for await (const v of reconnectingServerStream({
          connect,
          map: (v: number) => v,
          signal: controller.signal,
          random: () => 0.5,
        })) {
          results.push(v);
          if (results.length === 1) break;
        }
      })();

      await vi.advanceTimersByTimeAsync(100);
      await done;

      // The public `reconnectingServerStream` wrapper links the
      // caller-supplied signal into its own internally-owned
      // `AbortController` exactly once, for the entire lifetime of the
      // stream (see `linkExternalAbort` in grpc-stream.ts) — not per
      // reconnect attempt. The per-attempt/backoff-sleep abort listeners
      // the underlying engine registers attach to that *internal* signal
      // instead, so they never show up on the caller's own signal at all.
      // Exactly one add, paired with exactly one remove once the stream
      // finishes (via the consumer's `break` here) — nothing is left
      // dangling on `controller.signal`.
      expect(addSpy).toHaveBeenCalledTimes(1);
      expect(removeSpy).toHaveBeenCalledTimes(1);
      const addedListeners = addSpy.mock.calls.map((call) => call[1]);
      const removedListeners = removeSpy.mock.calls.map((call) => call[1]);
      expect(addedListeners).toEqual(removedListeners);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not treat its own CANCELLED status (from cancel()) as a reconnect-worthy error', async () => {
    const call = new FakeStreamCall<number>();
    call.emit(1);

    const results: number[] = [];
    for await (const v of reconnectingServerStream({ connect: () => call, map: (v: number) => v })) {
      results.push(v);
      break; // triggers the wrapper's immediate cancel + finally -> call.cancel() -> CANCELLED -> must stop, not reconnect
    }

    expect(results).toEqual([1]);
    // See the "cancels the underlying call when the consumer returns early"
    // test above for why this is 2, not 1, under the cancellation wrapper.
    expect(call.cancelCalls).toBe(2);
  });

  it('propagates a synchronous throw from connect() through the same retry/non-retry decision logic', async () => {
    const connect = vi.fn(() => {
      throw grpcError(INVALID_ARGUMENT, 'malformed request');
    });

    const consume = async (): Promise<void> => {
      for await (const _v of reconnectingServerStream({ connect, map: (v: number) => v })) {
        // never reached
      }
    };

    await expect(consume()).rejects.toThrow(/malformed request/);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('stops promptly (no throw) when the signal aborts while waiting out the backoff delay itself', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let attempt = 0;
      const connect = (): FakeStreamCall<number> => {
        attempt++;
        const call = new FakeStreamCall<number>();
        call.fail(grpcError(UNAVAILABLE));
        return call;
      };

      const results: number[] = [];
      const done = (async () => {
        for await (const v of reconnectingServerStream({
          connect,
          map: (v: number) => v,
          signal: controller.signal,
          random: () => 0.5,
        })) {
          results.push(v);
        }
      })();

      await flushMicrotasks();
      expect(attempt).toBe(1);

      // Abort partway through the 100ms backoff wait (attempt 1, random
      // 0.5 => exactly 100ms) rather than before or after it.
      await vi.advanceTimersByTimeAsync(50);
      controller.abort();
      await done;

      // The abort must unblock the sleep immediately rather than waiting
      // out the remaining 50ms, and must not trigger a second connect().
      expect(attempt).toBe(1);
      expect(results).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tolerates cancel() throwing from the onAbort handler without crashing or leaving the promise unsettled', async () => {
    const controller = new AbortController();
    const call = new FakeStreamCall<number>();
    // Preserve the real cancel() behavior (which unblocks the pending
    // read with a CANCELLED error) but *also* throw afterward, simulating
    // a cancel() whose bookkeeping fails after it has already initiated
    // cancellation — a still-plausible pathological case, unlike a
    // cancel() that throws *without* ever unblocking the stream (which no
    // real grpc-js implementation does).
    const originalCancel = call.cancel.bind(call);
    call.cancel = (): void => {
      originalCancel();
      throw new Error('cancel() blew up');
    };

    const results: number[] = [];
    const done = (async () => {
      for await (const v of reconnectingServerStream({
        connect: () => call,
        map: (v: number) => v,
        signal: controller.signal,
      })) {
        results.push(v);
      }
    })();

    call.emit(1);
    await flushMicrotasks();
    expect(results).toEqual([1]);

    expect(() => { controller.abort(); }).not.toThrow();
    await done;
  });

  it('tolerates cancel() throwing from the per-attempt finally cleanup (consumer early-return, no signal)', async () => {
    const call = new FakeStreamCall<number>();
    call.cancel = (): void => {
      throw new Error('cancel() blew up');
    };
    call.emit(1);
    call.emit(2);

    const results: number[] = [];
    for await (const v of reconnectingServerStream({ connect: () => call, map: (v: number) => v })) {
      results.push(v);
      break;
    }

    expect(results).toEqual([1]);
  });

  it('throws a reconnect-exhausted error once maxAttempts is reached via repeated clean ends (no underlying error)', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const connect = (): FakeStreamCall<number> => {
        attempts++;
        const call = new FakeStreamCall<number>();
        call.end(); // ends cleanly immediately, every time
        return call;
      };

      const consume = async (): Promise<number[]> => {
        const results: number[] = [];
        for await (const v of reconnectingServerStream({
          connect,
          map: (v: number) => v,
          reconnect: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1 },
          random: () => 0.5,
        })) {
          results.push(v);
        }
        return results;
      };

      const resultPromise = consume();
      const assertion = expect(resultPromise).rejects.toThrow(/reconnect attempts exhausted/);

      await vi.runAllTimersAsync();
      await assertion;

      expect(attempts).toBe(3); // initial + 2 reconnects
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconnects when connect() itself throws a retryable-shaped error', async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      const connect = (): FakeStreamCall<number> => {
        attempt++;
        if (attempt === 1) {
          throw grpcError(UNAVAILABLE, 'connect failed');
        }
        const call = new FakeStreamCall<number>();
        call.emit(1);
        return call;
      };

      const results: number[] = [];
      const done = (async () => {
        for await (const v of reconnectingServerStream({
          connect,
          map: (v: number) => v,
          random: () => 0.5,
        })) {
          results.push(v);
          if (results.length === 1) break;
        }
      })();

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(100);
      await done;

      expect(results).toEqual([1]);
      expect(attempt).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reconnectingServerStream — async connect() (Finding: stream initialization in reconnect engine)', () => {
  it('classifies and retries an async connect() that rejects (simulating a blocked/failed client/proto initialization) then succeeds', async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      const connect = async (): Promise<FakeStreamCall<number>> => {
        attempt++;
        if (attempt === 1) {
          // Simulates a real GrpcTransport.connectAttempt(): initialization
          // failed asynchronously (e.g. ensureClient() rejected) before any
          // call object was ever created.
          await Promise.resolve();
          throw grpcError(UNAVAILABLE, 'client/proto initialization failed');
        }
        const call = new FakeStreamCall<number>();
        call.emit(42);
        return call;
      };

      const results: number[] = [];
      const done = (async () => {
        for await (const v of reconnectingServerStream({
          connect,
          map: (v: number) => v,
          random: () => 0.5,
        })) {
          results.push(v);
          if (results.length === 1) break;
        }
      })();

      await vi.advanceTimersByTimeAsync(0);
      // Initial attempt's async rejection classified as retryable ->
      // backoff (100ms at attempt 1, random 0.5) -> second attempt succeeds.
      await vi.advanceTimersByTimeAsync(100);
      await done;

      expect(results).toEqual([42]);
      expect(attempt).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exhausts maxAttempts when an async connect() keeps rejecting (persistent async initialization failure)', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const connect = async (): Promise<FakeStreamCall<number>> => {
        attempts++;
        await Promise.resolve();
        throw grpcError(UNAVAILABLE, 'initialization keeps failing');
      };

      const consume = async (): Promise<number[]> => {
        const results: number[] = [];
        for await (const v of reconnectingServerStream({
          connect,
          map: (v: number) => v,
          reconnect: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1 },
          random: () => 0.5,
        })) {
          results.push(v);
        }
        return results;
      };

      const resultPromise = consume();
      const assertion = expect(resultPromise).rejects.toThrow(/initialization keeps failing/);

      await vi.runAllTimersAsync();
      await assertion;

      expect(attempts).toBe(3); // initial + 2 reconnects, all via async connect()
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels an in-flight async connect() promptly when the signal aborts, without waiting for it to settle or connecting again', async () => {
    const controller = new AbortController();
    let resolveConnect: ((call: FakeStreamCall<number>) => void) | undefined;
    let attempts = 0;
    const connect = (): Promise<FakeStreamCall<number>> => {
      attempts++;
      return new Promise<FakeStreamCall<number>>((resolve) => {
        resolveConnect = resolve;
      });
    };

    const results: number[] = [];
    const done = (async () => {
      for await (const v of reconnectingServerStream({
        connect,
        map: (v: number) => v,
        signal: controller.signal,
      })) {
        results.push(v);
      }
    })();

    await flushMicrotasks();
    expect(attempts).toBe(1);

    controller.abort();
    await done;

    expect(results).toEqual([]);
    expect(attempts).toBe(1);

    // A late resolution of the abandoned connect() must not cause a
    // second stream/attempt or an unhandled rejection.
    expect(() => resolveConnect?.(new FakeStreamCall<number>())).not.toThrow();
  });
});

describe('reconnectingServerStream — immediate cancellation while next() is pending (Finding: gRPC stream iterator cancellation)', () => {
  it('cancels the active call synchronously the instant return() is called, even while next() is still pending', async () => {
    const call = new FakeStreamCall<number>();
    const iterator = reconnectingServerStream({ connect: () => call, map: (v: number) => v });

    // No value queued: this next() call connects and then blocks forever
    // waiting on the call's async iterator, exactly like a real stream
    // with no traffic yet.
    const nextPromise = iterator.next();
    await flushMicrotasks();
    expect(call.cancelCalls).toBe(0);

    // Deliberately not awaited yet: the guarantee under test is that the
    // cancellation effect (call.cancel()) happens synchronously as part of
    // *calling* return(), not merely "eventually" once some queued
    // generator step gets around to it.
    const returnPromise = iterator.return();
    expect(call.cancelCalls).toBeGreaterThan(0);

    await expect(nextPromise).resolves.toEqual({ done: true, value: undefined });
    await expect(returnPromise).resolves.toEqual({ done: true, value: undefined });
  });

  it('cancels the active call synchronously the instant throw() is called, even while next() is still pending', async () => {
    const call = new FakeStreamCall<number>();
    const iterator = reconnectingServerStream({ connect: () => call, map: (v: number) => v });

    const nextPromise = iterator.next();
    await flushMicrotasks();
    expect(call.cancelCalls).toBe(0);

    const consumerError = new Error('consumer logic threw while next() was pending');
    const throwPromise = iterator.throw(consumerError);
    // Same immediacy guarantee as return(): the cancel() effect happens
    // synchronously as part of calling throw(), before anything is awaited.
    expect(call.cancelCalls).toBeGreaterThan(0);

    // The already-in-flight next() call observes the cancellation (a
    // locally-triggered CANCELLED status with an aborted internal signal)
    // and settles cleanly, since that is exactly what a local
    // caller-driven abort always does per `runReconnectingServerStream`'s
    // documented cancellation contract.
    await expect(nextPromise).resolves.toEqual({ done: true, value: undefined });
    // The throw() call itself still surfaces the consumer's own error to
    // whoever called it (e.g. a `for await` body that threw).
    await expect(throwPromise).rejects.toBe(consumerError);
  });

  it('aborts an in-progress reconnect backoff sleep immediately when return() is called while next() is pending, leaving no timer behind', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const connect = (): FakeStreamCall<number> => {
        attempts++;
        const call = new FakeStreamCall<number>();
        call.fail(grpcError(UNAVAILABLE)); // always fails -> always backs off before reconnecting
        return call;
      };

      const iterator = reconnectingServerStream({
        connect,
        map: (v: number) => v,
        random: () => 0.5,
      });

      const nextPromise = iterator.next();
      await flushMicrotasks();

      // The first attempt failed and the engine is now asleep in its
      // backoff delay (a real pending setTimeout), not yet reconnected.
      expect(attempts).toBe(1);
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      const returnPromise = iterator.return();

      // Crucially, no `vi.advanceTimersByTimeAsync(...)` is used anywhere
      // in this test: if cancellation were not immediate, this next()
      // would still be waiting out the backoff delay and this assertion
      // would hang/timeout instead of resolving.
      await expect(nextPromise).resolves.toEqual({ done: true, value: undefined });
      await expect(returnPromise).resolves.toEqual({ done: true, value: undefined });

      // No further reconnect attempt was made, and the backoff timer was
      // actually cleared rather than merely made irrelevant.
      expect(attempts).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts an in-progress reconnect backoff sleep immediately when throw() is called while next() is pending, leaving no timer behind', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const connect = (): FakeStreamCall<number> => {
        attempts++;
        const call = new FakeStreamCall<number>();
        call.fail(grpcError(UNAVAILABLE));
        return call;
      };

      const iterator = reconnectingServerStream({
        connect,
        map: (v: number) => v,
        random: () => 0.5,
      });

      const nextPromise = iterator.next();
      await flushMicrotasks();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      const consumerError = new Error('consumer threw during backoff');
      const throwPromise = iterator.throw(consumerError);

      await expect(nextPromise).resolves.toEqual({ done: true, value: undefined });
      await expect(throwPromise).rejects.toBe(consumerError);

      expect(attempts).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never leaks the external signal listener across many sequential streams (return path)', async () => {
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, 'addEventListener');
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    for (let i = 0; i < 5; i++) {
      const call = new FakeStreamCall<number>();
      const iterator = reconnectingServerStream({
        connect: () => call,
        map: (v: number) => v,
        signal: controller.signal,
      });
      const nextPromise = iterator.next();
      await flushMicrotasks();
      await iterator.return();
      await nextPromise.catch(() => undefined);
    }

    expect(addSpy).toHaveBeenCalledTimes(5);
    expect(removeSpy).toHaveBeenCalledTimes(5);
    expect(controller.signal.aborted).toBe(false); // caller's own signal is never mutated
  });
});

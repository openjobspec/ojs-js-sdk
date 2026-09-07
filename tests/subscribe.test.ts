import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SSEConnectionError,
  subscribe,
  subscribeJob,
  subscribeQueue,
} from '../src/subscribe.js';
import type { SSEEvent } from '../src/subscribe.js';

// Helper: create a ReadableStream from SSE text chunks
function makeSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]!));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

/** A stream that never closes and never emits — simulates a long-lived idle connection. */
function makeIdleStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull() {
      // Never enqueues or closes — read() just never resolves.
    },
  });
}

function makeFailingSSEStream(chunk: string, error: Error): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let delivered = false;
  return new ReadableStream({
    pull(controller) {
      if (!delivered) {
        delivered = true;
        controller.enqueue(encoder.encode(chunk));
      } else {
        controller.error(error);
      }
    },
  });
}

/**
 * Delivers a zero-length chunk (decodes to no complete SSE line at all —
 * not even a heartbeat comment) before erroring. Used to prove that a
 * no-op read from the underlying transport is not, by itself, treated as
 * proof of a live connection (see `onActivity` in subscribe.ts): only an
 * actual complete SSE line (a heartbeat comment or a parsed event) resets
 * the reconnect-backoff counter.
 */
function makeEmptyChunkThenFailStream(error: Error): ReadableStream<Uint8Array> {
  let delivered = false;
  return new ReadableStream({
    pull(controller) {
      if (!delivered) {
        delivered = true;
        controller.enqueue(new Uint8Array(0));
      } else {
        controller.error(error);
      }
    },
  });
}

describe('SSE subscribe', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('parses a single SSE event', async () => {
    const events: SSEEvent[] = [];
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      body: makeSSEStream([
        'event: job.completed\nid: evt-1\ndata: {"job_id":"j1","state":"completed"}\n\n',
      ]),
    });

    const sub = subscribe(
      { url: 'http://localhost:8080', channel: 'job:j1', reconnect: false },
      (event) => events.push(event),
    );

    // Wait for stream to complete
    await new Promise((r) => setTimeout(r, 50));
    sub.unsubscribe();

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('job.completed');
    expect(events[0]!.id).toBe('evt-1');
    expect(events[0]!.data).toEqual({ job_id: 'j1', state: 'completed' });
  });

  it('handles multiline data by concatenating', async () => {
    const events: SSEEvent[] = [];
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      body: makeSSEStream([
        'event: job.completed\ndata: {"part1":\ndata: "value"}\n\n',
      ]),
    });

    const sub = subscribe(
      { url: 'http://localhost:8080', channel: 'job:j1', reconnect: false },
      (event) => events.push(event),
    );

    await new Promise((r) => setTimeout(r, 50));
    sub.unsubscribe();

    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ part1: 'value' });
  });

  it('handles SSE fields without space after colon', async () => {
    const events: SSEEvent[] = [];
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      body: makeSSEStream([
        'event:job.failed\nid:evt-2\ndata:{"state":"failed"}\n\n',
      ]),
    });

    const sub = subscribe(
      { url: 'http://localhost:8080', channel: 'job:j1', reconnect: false },
      (event) => events.push(event),
    );

    await new Promise((r) => setTimeout(r, 50));
    sub.unsubscribe();

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('job.failed');
    expect(events[0]!.id).toBe('evt-2');
    expect(events[0]!.data).toEqual({ state: 'failed' });
  });

  it('parses multiple events in one chunk', async () => {
    const events: SSEEvent[] = [];
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      body: makeSSEStream([
        'event: job.active\ndata: {"n":1}\n\nevent: job.completed\ndata: {"n":2}\n\n',
      ]),
    });

    const sub = subscribe(
      { url: 'http://localhost:8080', channel: 'queue:default', reconnect: false },
      (event) => events.push(event),
    );

    await new Promise((r) => setTimeout(r, 50));
    sub.unsubscribe();

    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('job.active');
    expect(events[1]!.type).toBe('job.completed');
  });

  it('handles events split across chunks', async () => {
    const events: SSEEvent[] = [];
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      body: makeSSEStream([
        'event: job.com',
        'pleted\ndata: {"ok":true}\n\n',
      ]),
    });

    const sub = subscribe(
      { url: 'http://localhost:8080', channel: 'queue:default', reconnect: false },
      (event) => events.push(event),
    );

    await new Promise((r) => setTimeout(r, 50));
    sub.unsubscribe();

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('job.completed');
  });

  it('parses CRLF events when delimiters and blank boundaries are fragmented across chunks', async () => {
    const events: SSEEvent[] = [];
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      body: makeSSEStream([
        'event: job.completed\r',
        '\nid: evt-crlf\r\ndata: {"ok":true}\r',
        '\n\r',
        '\n',
      ]),
    });

    const sub = subscribe(
      { url: 'http://localhost:8080', channel: 'queue:default', reconnect: false },
      (event) => events.push(event),
    );

    await new Promise((r) => setTimeout(r, 50));
    sub.unsubscribe();

    expect(events).toEqual([{
      id: 'evt-crlf',
      type: 'job.completed',
      data: { ok: true },
    }]);
  });

  it('parses mixed LF/CRLF lines and removes only the delimiter carriage return', async () => {
    const events: SSEEvent[] = [];
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      body: makeSSEStream([
        'event: message\r\nid: mixed-id\n',
        'data:  leading space and content carriage return\r\r\n\n',
      ]),
    });

    const sub = subscribe(
      { url: 'http://localhost:8080', channel: 'queue:default', reconnect: false },
      (event) => events.push(event),
    );

    await new Promise((r) => setTimeout(r, 50));
    sub.unsubscribe();

    expect(events).toEqual([{
      id: 'mixed-id',
      type: 'message',
      data: { raw: ' leading space and content carriage return\r' },
    }]);
  });

  it('falls back to raw data on invalid JSON', async () => {
    const events: SSEEvent[] = [];
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      body: makeSSEStream([
        'data: not-valid-json\n\n',
      ]),
    });

    const sub = subscribe(
      { url: 'http://localhost:8080', channel: 'queue:default', reconnect: false },
      (event) => events.push(event),
    );

    await new Promise((r) => setTimeout(r, 50));
    sub.unsubscribe();

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('message');
    expect(events[0]!.data).toEqual({ raw: 'not-valid-json' });
  });

  it('invokes a synchronously throwing handler exactly once with parsed data', async () => {
    const handlerError = new Error('sync handler failed');
    const seenData: Record<string, unknown>[] = [];
    const onError = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      body: makeSSEStream(['event: job.completed\ndata: {"ok":true}\n\n']),
    });

    vi.useFakeTimers();
    const sub = subscribe(
      {
        url: 'http://localhost:8080',
        channel: 'queue:default',
        reconnect: false,
        onError,
      },
      (event) => {
        seenData.push(event.data);
        throw handlerError;
      },
    );

    await vi.advanceTimersByTimeAsync(0);

    expect(seenData).toEqual([{ ok: true }]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(handlerError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    sub.unsubscribe();
  });

  it('awaits an asynchronously rejecting handler once and stops without reconnecting', async () => {
    const handlerError = new Error('async handler failed');
    const seenData: Record<string, unknown>[] = [];
    const onError = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      body: makeSSEStream(['event: job.completed\ndata: {"ok":true}\n\n']),
    });

    vi.useFakeTimers();
    const sub = subscribe(
      {
        url: 'http://localhost:8080',
        channel: 'queue:default',
        onError,
      },
      async (event) => {
        seenData.push(event.data);
        await Promise.resolve();
        throw handlerError;
      },
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(seenData).toEqual([{ ok: true }]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(handlerError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(seenData).toEqual([{ ok: true }]);
    sub.unsubscribe();
  });

  it('uses default message type when no event field', async () => {
    const events: SSEEvent[] = [];
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      body: makeSSEStream([
        'data: {"ping":true}\n\n',
      ]),
    });

    const sub = subscribe(
      { url: 'http://localhost:8080', channel: 'queue:default', reconnect: false },
      (event) => events.push(event),
    );

    await new Promise((r) => setTimeout(r, 50));
    sub.unsubscribe();

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('message');
  });

  it('subscribeJob hits GET /ojs/v1/jobs/{id}/events per the SSE binding', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      body: makeSSEStream([]),
    });

    const sub = subscribeJob({ url: 'http://localhost:8080' }, 'job-123', () => {});
    await new Promise((r) => setTimeout(r, 20));
    sub.unsubscribe();

    const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe('http://localhost:8080/ojs/v1/jobs/job-123/events');
  });

  it('subscribeQueue hits GET /ojs/v1/queues/{name}/events per the SSE binding', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      body: makeSSEStream([]),
    });

    const sub = subscribeQueue({ url: 'http://localhost:8080' }, 'email', () => {});
    await new Promise((r) => setTimeout(r, 20));
    sub.unsubscribe();

    const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe('http://localhost:8080/ojs/v1/queues/email/events');
  });

  it('sends auth header when provided', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      body: makeSSEStream([]),
    });

    const sub = subscribe(
      { url: 'http://localhost:8080', auth: 'my-token', channel: 'queue:default' },
      () => {},
    );
    await new Promise((r) => setTimeout(r, 20));
    sub.unsubscribe();

    const calledHeaders = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(calledHeaders['Authorization']).toBe('Bearer my-token');
  });

  it('ignores empty data events', async () => {
    const events: SSEEvent[] = [];
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      body: makeSSEStream([
        'event: heartbeat\n\n',
        'event: job.completed\ndata: {"ok":true}\n\n',
      ]),
    });

    const sub = subscribe(
      { url: 'http://localhost:8080', channel: 'queue:default', reconnect: false },
      (event) => events.push(event),
    );

    await new Promise((r) => setTimeout(r, 50));
    sub.unsubscribe();

    // Heartbeat with no data should be skipped
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('job.completed');
  });

  describe('channel validation', () => {
    it('terminates and cleans up an unsupported channel without retrying', async () => {
      vi.useFakeTimers();
      const onError = vi.fn();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const addSpy = vi.spyOn(AbortSignal.prototype, 'addEventListener');
      const removeSpy = vi.spyOn(AbortSignal.prototype, 'removeEventListener');
      const external = new AbortController();
      const sub = subscribe(
        {
          url: 'http://localhost:8080',
          channel: 'not-a-valid-channel',
          onError,
          signal: external.signal,
        },
        () => {},
      );

      const added = addSpy.mock.calls.map((call, index) => ({
        target: addSpy.mock.contexts[index],
        listener: call[1],
      }));

      await vi.advanceTimersByTimeAsync(60_000);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledOnce();
      expect((onError.mock.calls[0]![0] as Error).message).toContain('Unsupported SSE channel');
      const removed = removeSpy.mock.calls.map((call, index) => ({
        target: removeSpy.mock.contexts[index],
        listener: call[1],
      }));
      expect(added).toHaveLength(2);
      expect(removed).toEqual(expect.arrayContaining(added));

      sub.unsubscribe();
      expect(removeSpy).toHaveBeenCalledTimes(2);
    });
  });
  describe('Node 18 compatibility (no AbortSignal.any dependency)', () => {
    it('composes an external signal without using the real AbortSignal.any', async () => {
      // Simulate Node 18, which lacks AbortSignal.any (added in Node 20.3).
      const realAny = AbortSignal.any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (AbortSignal as any).any = undefined;

      try {
        fetchSpy.mockResolvedValueOnce({ ok: true, body: makeSSEStream([]) });
        const external = new AbortController();

        expect(() =>
          subscribe(
            { url: 'http://localhost:8080', channel: 'queue:default', signal: external.signal },
            () => {},
          ),
        ).not.toThrow();

        await new Promise((r) => setTimeout(r, 10));
      } finally {
        AbortSignal.any = realAny;
      }
    });

    it('aborts the fetch when the external signal fires (composed manually)', async () => {
      let capturedSignal: AbortSignal | undefined;
      fetchSpy.mockImplementation((_url: string, init: { signal: AbortSignal }) => {
        capturedSignal = init.signal;
        return Promise.resolve({ ok: true, body: makeIdleStream() });
      });

      const external = new AbortController();
      subscribe(
        { url: 'http://localhost:8080', channel: 'queue:default', signal: external.signal, reconnect: false },
        () => {},
      );

      await new Promise((r) => setTimeout(r, 10));
      expect(capturedSignal?.aborted).toBe(false);

      external.abort('external cancel');
      expect(capturedSignal?.aborted).toBe(true);
    });

    it('removes both composition listeners after every repeated unsubscribe', () => {
      fetchSpy.mockImplementation(() => new Promise(() => {
        // Keep each connection pending so only unsubscribe drives cleanup.
      }));
      const addSpy = vi.spyOn(AbortSignal.prototype, 'addEventListener');
      const removeSpy = vi.spyOn(AbortSignal.prototype, 'removeEventListener');
      const external = new AbortController();

      for (let i = 0; i < 5; i++) {
        const sub = subscribe(
          {
            url: 'http://localhost:8080',
            channel: 'queue:default',
            signal: external.signal,
            reconnect: false,
          },
          () => {},
        );
        sub.unsubscribe();
      }

      const added = addSpy.mock.calls.map((call, index) => ({
        target: addSpy.mock.contexts[index],
        listener: call[1],
      }));
      const removed = removeSpy.mock.calls.map((call, index) => ({
        target: removeSpy.mock.contexts[index],
        listener: call[1],
      }));

      expect(added).toHaveLength(10);
      expect(removed).toHaveLength(10);
      for (const registration of added) {
        expect(removed).toContainEqual(registration);
      }
    });

    it('removes both composition listeners immediately on external abort', () => {
      fetchSpy.mockImplementation(() => new Promise(() => {
        // Keep the connection pending; external abort must still clean up.
      }));
      const addSpy = vi.spyOn(AbortSignal.prototype, 'addEventListener');
      const removeSpy = vi.spyOn(AbortSignal.prototype, 'removeEventListener');
      const external = new AbortController();
      const sub = subscribe(
        {
          url: 'http://localhost:8080',
          channel: 'queue:default',
          signal: external.signal,
          reconnect: false,
        },
        () => {},
      );

      external.abort(new Error('stop subscription'));

      const added = addSpy.mock.calls.map((call, index) => ({
        target: addSpy.mock.contexts[index],
        listener: call[1],
      }));
      const removed = removeSpy.mock.calls.map((call, index) => ({
        target: removeSpy.mock.contexts[index],
        listener: call[1],
      }));
      expect(added).toHaveLength(2);
      expect(removed).toHaveLength(2);
      expect(removed).toEqual(expect.arrayContaining(added));

      sub.unsubscribe();
      expect(removeSpy).toHaveBeenCalledTimes(2);
    });

    it('clears a pending reconnect timer immediately on external abort', async () => {
      vi.useFakeTimers();
      fetchSpy.mockRejectedValue(new TypeError('network down'));
      const addSpy = vi.spyOn(AbortSignal.prototype, 'addEventListener');
      const removeSpy = vi.spyOn(AbortSignal.prototype, 'removeEventListener');
      const external = new AbortController();

      subscribe(
        {
          url: 'http://localhost:8080',
          channel: 'queue:default',
          signal: external.signal,
        },
        () => {},
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      external.abort(new Error('process shutting down'));

      expect(vi.getTimerCount()).toBe(0);
      expect(removeSpy.mock.calls.length).toBe(addSpy.mock.calls.length);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('reconnection (ojs-realtime.md section 9.3)', () => {
    it.each([400, 401, 403, 404, 422])(
      'terminates and cleans up permanent HTTP %s responses',
      async (status) => {
        vi.useFakeTimers();
        const external = new AbortController();
        const addSpy = vi.spyOn(AbortSignal.prototype, 'addEventListener');
        const removeSpy = vi.spyOn(AbortSignal.prototype, 'removeEventListener');
        const onError = vi.fn();
        fetchSpy.mockResolvedValue(
          new Response(null, { status }),
        );

        subscribe(
          {
            url: 'http://localhost:8080',
            channel: 'job:j1',
            signal: external.signal,
            onError,
          },
          () => {},
        );

        await vi.advanceTimersByTimeAsync(60_000);

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'SSEConnectionError',
            status,
            retryable: false,
          }),
        );
        expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(SSEConnectionError);
        expect(removeSpy.mock.calls.length).toBe(addSpy.mock.calls.length);
      },
    );

    it.each([408, 425, 429, 500])(
      'retries transient HTTP %s responses and honors Retry-After',
      async (status) => {
        vi.useFakeTimers();
        const onError = vi.fn();
        fetchSpy
          .mockResolvedValueOnce(
            new Response(null, {
              status,
              headers: { 'Retry-After': '1' },
            }),
          )
          .mockResolvedValueOnce({
            ok: true,
            body: makeIdleStream(),
          });

        const sub = subscribe(
          {
            url: 'http://localhost:8080',
            channel: 'job:j1',
            maxReconnectAttempts: 1,
            onError,
          },
          () => {},
        );

        await vi.advanceTimersByTimeAsync(0);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({
            status,
            retryAfterMs: 1000,
            retryable: true,
          }),
        );

        await vi.advanceTimersByTimeAsync(999);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetchSpy).toHaveBeenCalledTimes(2);

        sub.unsubscribe();
      },
    );

    it('reconnects with Last-Event-ID after the stream ends', async () => {
      fetchSpy
        .mockResolvedValueOnce({
          ok: true,
          body: makeSSEStream(['event: job.progress\nid: evt-1\ndata: {"n":1}\n\n']),
        })
        .mockResolvedValueOnce({
          ok: true,
          body: makeSSEStream(['event: job.progress\nid: evt-2\ndata: {"n":2}\n\n']),
        })
        .mockResolvedValue({ ok: true, body: makeIdleStream() });

      vi.useFakeTimers();
      const events: SSEEvent[] = [];
      const sub = subscribe(
        { url: 'http://localhost:8080', channel: 'job:j1' },
        (event) => events.push(event),
      );

      // First connection completes synchronously (stream closes immediately).
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toHaveLength(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect((fetchSpy.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers['Last-Event-ID']).toBeUndefined();

      // Reconnect fires after the default 3s backoff, carrying Last-Event-ID.
      await vi.advanceTimersByTimeAsync(3000);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect((fetchSpy.mock.calls[1]?.[1] as { headers: Record<string, string> }).headers['Last-Event-ID']).toBe('evt-1');
      expect(events).toHaveLength(2);

      sub.unsubscribe();
    });

    it('applies exponential backoff across repeated connection failures', async () => {
      fetchSpy.mockRejectedValue(new TypeError('network down'));

      vi.useFakeTimers();
      const onError = vi.fn();
      const sub = subscribe(
        { url: 'http://localhost:8080', channel: 'job:j1', onError },
        () => {},
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3000); // 3000 * 2^0
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(6000); // 3000 * 2^1
      expect(fetchSpy).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(12000); // 3000 * 2^2
      expect(fetchSpy).toHaveBeenCalledTimes(4);

      expect(onError).toHaveBeenCalledTimes(4);

      sub.unsubscribe();
    });

    it('caps the backoff delay at 30 seconds', async () => {
      fetchSpy.mockRejectedValue(new TypeError('network down'));

      vi.useFakeTimers();
      const sub = subscribe(
        { url: 'http://localhost:8080', channel: 'job:j1' },
        () => {},
      );

      await vi.advanceTimersByTimeAsync(0); // attempt 1
      await vi.advanceTimersByTimeAsync(3000); // attempt 2 (3000ms)
      await vi.advanceTimersByTimeAsync(6000); // attempt 3 (6000ms)
      await vi.advanceTimersByTimeAsync(12000); // attempt 4 (12000ms)
      await vi.advanceTimersByTimeAsync(24000); // attempt 5 (24000ms) — would be 24000
      expect(fetchSpy).toHaveBeenCalledTimes(5);

      // Next backoff would be 48000ms uncapped; capped to 30000ms.
      await vi.advanceTimersByTimeAsync(29999);
      expect(fetchSpy).toHaveBeenCalledTimes(5);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchSpy).toHaveBeenCalledTimes(6);

      sub.unsubscribe();
    });

    it('stops retrying after maxReconnectAttempts and logs instead of throwing', async () => {
      fetchSpy.mockRejectedValue(new TypeError('network down'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      vi.useFakeTimers();
      const sub = subscribe(
        { url: 'http://localhost:8080', channel: 'job:j1', maxReconnectAttempts: 2 },
        () => {},
      );

      await vi.advanceTimersByTimeAsync(0); // attempt 1 (initial, not a "reconnect")
      await vi.advanceTimersByTimeAsync(3000); // reconnect attempt 1
      await vi.advanceTimersByTimeAsync(6000); // reconnect attempt 2
      expect(fetchSpy).toHaveBeenCalledTimes(3);

      // No further attempts should be scheduled.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('will not be retried'),
        expect.any(String),
      );

      sub.unsubscribe();
      warnSpy.mockRestore();
    });

    it('resets max-attempt accounting after the first event on a connection', async () => {
      fetchSpy
        .mockRejectedValueOnce(new TypeError('initial connection failed'))
        .mockResolvedValueOnce({
          ok: true,
          body: makeFailingSSEStream(
            'event: job.progress\nid: evt-1\ndata: {"n":1}\n\n',
            new TypeError('connection dropped after event'),
          ),
        })
        .mockResolvedValue({ ok: true, body: makeIdleStream() });

      vi.useFakeTimers();
      const events: SSEEvent[] = [];
      const sub = subscribe(
        {
          url: 'http://localhost:8080',
          channel: 'job:j1',
          maxReconnectAttempts: 1,
        },
        (event) => events.push(event),
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3000);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(events).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(2999);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchSpy).toHaveBeenCalledTimes(3);

      sub.unsubscribe();
    });

    it('resets reconnect backoff after a heartbeat comment alone (no parsed event), before the next drop (Finding: SSE heartbeat/live reset)', async () => {
      fetchSpy
        .mockRejectedValueOnce(new TypeError('initial connection failed'))
        .mockResolvedValueOnce({
          ok: true,
          body: makeFailingSSEStream(':heartbeat\n\n', new TypeError('dropped after heartbeat')),
        })
        .mockResolvedValue({ ok: true, body: makeIdleStream() });

      vi.useFakeTimers();
      const sub = subscribe(
        { url: 'http://localhost:8080', channel: 'job:j1' },
        () => {},
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // First failure -> reconnect after the base delay (3000ms; this is
      // reconnect attempt 1).
      await vi.advanceTimersByTimeAsync(2999);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      // The second connection delivers only a heartbeat comment (no
      // parsed event at all) before dropping. If the heartbeat did not
      // reset the reconnect-attempt counter, the next reconnect would
      // have to wait the doubled 6000ms delay (attempt 2); because a
      // heartbeat *does* count as live activity, it resets the counter,
      // so the next reconnect uses the base 3000ms delay again, exactly
      // as if this were attempt 1 all over again.
      await vi.advanceTimersByTimeAsync(2999);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchSpy).toHaveBeenCalledTimes(3);

      sub.unsubscribe();
    });

    it('does not reset reconnect backoff on an empty chunk with no complete SSE line, and still honors maxReconnectAttempts (Finding: SSE heartbeat/live reset)', async () => {
      fetchSpy
        .mockRejectedValueOnce(new TypeError('initial connection failed'))
        .mockResolvedValueOnce({
          ok: true,
          body: makeEmptyChunkThenFailStream(new TypeError('dropped after empty chunk')),
        })
        .mockRejectedValue(new TypeError('final failure'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      vi.useFakeTimers();
      const sub = subscribe(
        { url: 'http://localhost:8080', channel: 'job:j1', maxReconnectAttempts: 2 },
        () => {},
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Attempt 1 failed outright -> reconnect attempt 1, delay 3000ms.
      await vi.advanceTimersByTimeAsync(3000);
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      // This connection only ever delivers a zero-length chunk (no
      // complete SSE line — not even a heartbeat) before dropping. This
      // must NOT reset the reconnect-attempt counter, so the next
      // reconnect delay is still the *doubled* 6000ms (attempt 2), not
      // reset back to the 3000ms base.
      await vi.advanceTimersByTimeAsync(5999);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchSpy).toHaveBeenCalledTimes(3);

      // maxReconnectAttempts=2 has now been reached (two reconnects both
      // failed), so no further attempt is made — proving the empty chunk
      // never granted the stream extra reconnect budget by resetting the
      // counter.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('will not be retried'),
        expect.any(String),
      );

      sub.unsubscribe();
      warnSpy.mockRestore();
    });

    it('does not reconnect after unsubscribe(), even if a reconnect was already scheduled', async () => {
      fetchSpy.mockRejectedValue(new TypeError('network down'));

      vi.useFakeTimers();
      const sub = subscribe(
        { url: 'http://localhost:8080', channel: 'job:j1' },
        () => {},
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      sub.unsubscribe();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('honors a server-provided retry: hint as the next reconnect delay', async () => {
      fetchSpy
        .mockResolvedValueOnce({
          ok: true,
          body: makeSSEStream(['retry: 500\n\nevent: job.progress\nid: evt-1\ndata: {"n":1}\n\n']),
        })
        .mockResolvedValue({ ok: true, body: makeIdleStream() });

      vi.useFakeTimers();
      const sub = subscribe(
        { url: 'http://localhost:8080', channel: 'job:j1' },
        () => {},
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Without the retry: hint this would wait the 3000ms default.
      await vi.advanceTimersByTimeAsync(499);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      sub.unsubscribe();
    });

    it('does not reconnect when reconnect: false is set', async () => {
      fetchSpy.mockResolvedValue({ ok: true, body: makeSSEStream([]) });

      vi.useFakeTimers();
      const sub = subscribe(
        { url: 'http://localhost:8080', channel: 'job:j1', reconnect: false },
        () => {},
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      sub.unsubscribe();
    });

    describe('HTTP Retry-After is a one-shot override, not a persistent base (Finding: SSE HTTP Retry-After)', () => {
      it.each([
        {
          label: '0 seconds, then heartbeat + clean close uses the persistent SSE retry hint',
          retryAfter: () => '0',
          retryAfterMs: 0,
          activityStream: () => makeSSEStream(['retry: 700\n\n:heartbeat\n\n']),
          laterDelayMs: 700,
        },
        {
          label: 'delta seconds, then live event + error drop uses the default base',
          retryAfter: () => '2',
          retryAfterMs: 2000,
          activityStream: () =>
            makeFailingSSEStream(
              'event: job.progress\nid: evt-1\ndata: {"n":1}\n\n',
              new TypeError('dropped after event'),
            ),
          laterDelayMs: 3000,
        },
        {
          label: 'HTTP date, then live event + clean close uses the default base',
          retryAfter: (nowMs: number) => new Date(nowMs + 5000).toUTCString(),
          retryAfterMs: 5000,
          activityStream: () =>
            makeSSEStream([
              'event: job.progress\nid: evt-1\ndata: {"n":1}\n\n',
            ]),
          laterDelayMs: 3000,
        },
      ])(
        'honors exact 429 Retry-After $label without leaking it or creating a tight loop',
        async ({ retryAfter, retryAfterMs, activityStream, laterDelayMs }) => {
          const base = new Date('2024-01-01T00:00:00.000Z');
          vi.useFakeTimers();
          vi.setSystemTime(base);

          fetchSpy
            .mockResolvedValueOnce(
              new Response(null, {
                status: 429,
                headers: { 'Retry-After': retryAfter(base.getTime()) },
              }),
            )
            .mockResolvedValueOnce({ ok: true, body: activityStream() })
            .mockResolvedValue({ ok: true, body: makeIdleStream() });

          const onError = vi.fn();
          const sub = subscribe(
            { url: 'http://localhost:8080', channel: 'job:j1', onError },
            () => {},
          );

          await vi.advanceTimersByTimeAsync(0);
          expect(fetchSpy).toHaveBeenCalledTimes(retryAfterMs === 0 ? 2 : 1);
          expect(onError).toHaveBeenCalledWith(
            expect.objectContaining({
              status: 429,
              retryAfterMs,
              retryable: true,
            }),
          );

          if (retryAfterMs > 0) {
            await vi.advanceTimersByTimeAsync(retryAfterMs - 1);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);
            expect(fetchSpy).toHaveBeenCalledTimes(2);
          }

          // Successful event/heartbeat activity on the reconnected stream
          // resets the attempt counter. Its later clean/error drop must use
          // the persistent SSE retry hint (when present) or the 3000ms
          // default base — never the consumed HTTP Retry-After value.
          await vi.advanceTimersByTimeAsync(laterDelayMs - 1);
          expect(fetchSpy).toHaveBeenCalledTimes(2);
          await vi.advanceTimersByTimeAsync(1);
          expect(fetchSpy).toHaveBeenCalledTimes(3);

          // The third connection stays open, proving Retry-After: 0 and
          // every other variant scheduled finite reconnects rather than a
          // synchronous or timer-driven tight loop.
          await vi.advanceTimersByTimeAsync(60_000);
          expect(fetchSpy).toHaveBeenCalledTimes(3);

          sub.unsubscribe();
        },
      );

      it('still consumes reconnect-attempt budget when a Retry-After override is applied', async () => {
        fetchSpy
          .mockResolvedValueOnce(
            new Response(null, { status: 429, headers: { 'Retry-After': '1' } }),
          )
          .mockRejectedValue(new TypeError('final failure'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        vi.useFakeTimers();
        const sub = subscribe(
          { url: 'http://localhost:8080', channel: 'job:j1', maxReconnectAttempts: 1 },
          () => {},
        );

        await vi.advanceTimersByTimeAsync(0);
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        // The one Retry-After-driven reconnect consumes the only budgeted
        // attempt (maxReconnectAttempts: 1) — no further reconnect is ever
        // scheduled, proving the override still counts against the budget.
        await vi.advanceTimersByTimeAsync(1000);
        expect(fetchSpy).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(60_000);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('will not be retried'),
          expect.any(String),
        );

        sub.unsubscribe();
        warnSpy.mockRestore();
      });

      it('never lets a one-time Retry-After leak into base backoff for a later plain error drop (no SSE retry: hint involved)', async () => {
        fetchSpy
          .mockResolvedValueOnce(
            new Response(null, { status: 429, headers: { 'Retry-After': '10' } }),
          )
          // The Retry-After-driven reconnect fails outright (no activity at
          // all), so reconnectAttempt is NOT reset — but the delay for
          // *this* failure must come from the persistent base (3000ms *
          // 2^(attempt-1)) alone, never from the stale 10s Retry-After.
          .mockRejectedValue(new TypeError('network down'));

        vi.useFakeTimers();
        const sub = subscribe(
          { url: 'http://localhost:8080', channel: 'job:j1' },
          () => {},
        );

        await vi.advanceTimersByTimeAsync(0);
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(10_000);
        expect(fetchSpy).toHaveBeenCalledTimes(2);

        // reconnectAttempt is now 2 (Retry-After override consumed attempt
        // 1's slot); the next delay is base(3000) * 2^(2-1) = 6000ms, not
        // driven by the old 10s value in any way.
        await vi.advanceTimersByTimeAsync(5999);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetchSpy).toHaveBeenCalledTimes(3);

        sub.unsubscribe();
      });

      it.each([
        { label: '120 seconds (above the 30s local backoff cap)', seconds: 120, ms: 120_000 },
        { label: '3600 seconds (a full hour)', seconds: 3600, ms: 3_600_000 },
      ])(
        'honors an explicit server Retry-After of $label exactly, uncapped by the local exponential-backoff ceiling (Finding: SSE Retry-After)',
        async ({ seconds, ms }) => {
          fetchSpy
            .mockResolvedValueOnce(
              new Response(null, { status: 429, headers: { 'Retry-After': String(seconds) } }),
            )
            .mockResolvedValue({ ok: true, body: makeIdleStream() });

          vi.useFakeTimers();
          const onError = vi.fn();
          const sub = subscribe(
            { url: 'http://localhost:8080', channel: 'job:j1', onError },
            () => {},
          );

          await vi.advanceTimersByTimeAsync(0);
          expect(fetchSpy).toHaveBeenCalledTimes(1);
          expect(onError).toHaveBeenCalledWith(
            expect.objectContaining({ status: 429, retryAfterMs: ms, retryable: true }),
          );

          // Exactly one millisecond short of the full server-provided
          // delay: must not reconnect (never capped down to 30s, MAX_
          // RECONNECT_DELAY_MS's local exponential-backoff ceiling).
          await vi.advanceTimersByTimeAsync(ms - 1);
          expect(fetchSpy).toHaveBeenCalledTimes(1);

          // The exact instant the server-provided delay elapses.
          await vi.advanceTimersByTimeAsync(1);
          expect(fetchSpy).toHaveBeenCalledTimes(2);

          sub.unsubscribe();
        },
      );

      it('caps only the local exponential backoff, never a concurrently-relevant explicit Retry-After, across mixed successive failures', async () => {
        // First failure: no Retry-After at all, uses the local
        // exponential base (default 3000ms), unaffected by anything
        // Retry-After-related.
        fetchSpy
          .mockRejectedValueOnce(new TypeError('network down'))
          // Second failure: an explicit 3600s Retry-After -- must be
          // honored exactly, not capped to MAX_RECONNECT_DELAY_MS (30s).
          .mockResolvedValueOnce(
            new Response(null, { status: 503, headers: { 'Retry-After': '3600' } }),
          )
          .mockResolvedValue({ ok: true, body: makeIdleStream() });

        vi.useFakeTimers();
        const sub = subscribe(
          { url: 'http://localhost:8080', channel: 'job:j1' },
          () => {},
        );

        await vi.advanceTimersByTimeAsync(0);
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        // First reconnect: local base backoff (3000ms), correctly capped
        // logic applies here (irrelevant since 3000 < 30_000 anyway).
        await vi.advanceTimersByTimeAsync(2999);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetchSpy).toHaveBeenCalledTimes(2);

        // Second reconnect: explicit Retry-After of 3600s -- must not be
        // capped down to 30s.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(3_600_000 - 30_000 - 1);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetchSpy).toHaveBeenCalledTimes(3);

        sub.unsubscribe();
      });
    });
  });

  describe('terminal job state detection (ojs-realtime.md section 2.1)', () => {
    it('does not reconnect after a job.state_changed event with a terminal state (completed) and clean close', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        body: makeSSEStream([
          'event: job.state_changed\nid: evt-1\ndata: {"job_id":"j1","from":"active","to":"completed"}\n\n',
        ]),
      });

      vi.useFakeTimers();
      const events: SSEEvent[] = [];
      const sub = subscribe(
        { url: 'http://localhost:8080', channel: 'job:j1' },
        (event) => events.push(event),
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(events).toHaveLength(1);

      // Even well past the default 3s reconnect delay (and much further),
      // no reconnect should ever be attempted.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Cleanup assertion: unsubscribe() after the subscription has
      // already self-completed must be a harmless, idempotent no-op.
      expect(() => sub.unsubscribe()).not.toThrow();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it.each(['completed', 'cancelled', 'discarded'] as const)(
      'treats "%s" as terminal and stops reconnecting',
      async (terminalState) => {
        fetchSpy.mockResolvedValueOnce({
          ok: true,
          body: makeSSEStream([
            `event: job.state_changed\nid: evt-1\ndata: {"job_id":"j1","from":"active","to":"${terminalState}"}\n\n`,
          ]),
        });

        vi.useFakeTimers();
        const sub = subscribe(
          { url: 'http://localhost:8080', channel: 'job:j1' },
          () => {},
        );

        await vi.advanceTimersByTimeAsync(0);
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(60_000);
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        sub.unsubscribe();
      },
    );

    it('cancels a non-closing job stream immediately and skips a later event in the same chunk', async () => {
      const encoder = new TextEncoder();
      const cancelReasons: unknown[] = [];
      let delivered = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (delivered) return;
          delivered = true;
          controller.enqueue(encoder.encode(
            'event: job.state_changed\nid: terminal\ndata: {"job_id":"j1","to":"completed"}\n\n' +
              'event: job.progress\nid: too-late\ndata: {"job_id":"j1","progress":100}\n\n',
          ));
          // Deliberately never close: terminal handling must cancel rather
          // than wait for another read or EOF.
        },
        cancel(reason) {
          cancelReasons.push(reason);
        },
      });
      let capturedSignal: AbortSignal | undefined;
      fetchSpy.mockImplementationOnce((_url: string, init: { signal: AbortSignal }) => {
        capturedSignal = init.signal;
        return Promise.resolve({ ok: true, body });
      });

      vi.useFakeTimers();
      const events: SSEEvent[] = [];
      const sub = subscribe(
        { url: 'http://localhost:8080', channel: 'job:j1' },
        (event) => events.push(event),
      );

      await vi.advanceTimersByTimeAsync(0);

      expect(events.map((event) => event.id)).toEqual(['terminal']);
      expect(cancelReasons).toHaveLength(1);
      expect(cancelReasons[0]).toEqual(expect.any(Error));
      expect(capturedSignal?.aborted).toBe(true);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchSpy).toHaveBeenCalledOnce();
      sub.unsubscribe();
    });

    it('dispatches events after a terminal job event in the same chunk on a queue channel', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        body: makeSSEStream([
          'event: job.state_changed\nid: terminal\ndata: {"job_id":"j1","to":"completed"}\n\n' +
            'event: job.available\nid: next-job\ndata: {"job_id":"j2"}\n\n',
        ]),
      });

      vi.useFakeTimers();
      const events: SSEEvent[] = [];
      const sub = subscribe(
        {
          url: 'http://localhost:8080',
          channel: 'queue:default',
          reconnect: false,
        },
        (event) => events.push(event),
      );

      await vi.advanceTimersByTimeAsync(0);

      expect(events.map((event) => event.id)).toEqual(['terminal', 'next-job']);
      expect(events.map((event) => event.type)).toEqual([
        'job.state_changed',
        'job.available',
      ]);
      sub.unsubscribe();
    });

    it('reports a terminal handler failure once, cancels, and skips buffered follow-up events', async () => {
      const handlerError = new Error('terminal delivery failed');
      const encoder = new TextEncoder();
      const cancelReasons: unknown[] = [];
      let delivered = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (delivered) return;
          delivered = true;
          controller.enqueue(encoder.encode(
            'event: job.state_changed\nid: terminal\ndata: {"job_id":"j1","to":"discarded"}\n\n' +
              'event: job.progress\nid: too-late\ndata: {"job_id":"j1","progress":100}\n\n',
          ));
        },
        cancel(reason) {
          cancelReasons.push(reason);
        },
      });
      fetchSpy.mockResolvedValueOnce({ ok: true, body });
      const onError = vi.fn();
      const handler = vi.fn(() => {
        throw handlerError;
      });
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      vi.useFakeTimers();
      const sub = subscribe(
        {
          url: 'http://localhost:8080',
          channel: 'job:j1',
          onError,
        },
        handler,
      );

      await vi.advanceTimersByTimeAsync(0);

      expect(handler).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(handlerError);
      expect(cancelReasons).toEqual([handlerError]);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledOnce();
      sub.unsubscribe();
    });

    it('releases the reader and stays stopped when terminal cancellation fails', async () => {
      const encoder = new TextEncoder();
      const cancelError = new Error('terminal cancel failed');
      const calls: string[] = [];
      const reader = {
        read: vi.fn(async () => {
          calls.push('read');
          return {
            done: false,
            value: encoder.encode(
              'event: job.state_changed\nid: terminal\ndata: {"job_id":"j1","to":"cancelled"}\n\n' +
                'event: job.progress\nid: too-late\ndata: {"job_id":"j1","progress":100}\n\n',
            ),
          };
        }),
        cancel: vi.fn(async () => {
          calls.push('cancel');
          throw cancelError;
        }),
        releaseLock: vi.fn(() => {
          calls.push('releaseLock');
        }),
      };
      let capturedSignal: AbortSignal | undefined;
      fetchSpy.mockImplementationOnce((_url: string, init: { signal: AbortSignal }) => {
        capturedSignal = init.signal;
        return Promise.resolve({
          ok: true,
          body: { getReader: () => reader },
        });
      });
      const onError = vi.fn();

      vi.useFakeTimers();
      const events: SSEEvent[] = [];
      const sub = subscribe(
        {
          url: 'http://localhost:8080',
          channel: 'job:j1',
          onError,
        },
        (event) => events.push(event),
      );

      await vi.advanceTimersByTimeAsync(0);

      expect(events.map((event) => event.id)).toEqual(['terminal']);
      expect(reader.cancel).toHaveBeenCalledOnce();
      expect(reader.releaseLock).toHaveBeenCalledOnce();
      expect(calls.indexOf('releaseLock')).toBeGreaterThan(calls.indexOf('cancel'));
      expect(capturedSignal?.aborted).toBe(true);
      expect(onError).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(reader.read).toHaveBeenCalledOnce();
      sub.unsubscribe();
    });

    it('stops and cleans listener registrations when a terminal handler throws synchronously', async () => {
      const handlerError = new Error('terminal handler failed');
      const addSpy = vi.spyOn(AbortSignal.prototype, 'addEventListener');
      const removeSpy = vi.spyOn(AbortSignal.prototype, 'removeEventListener');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const external = new AbortController();
      const onError = vi.fn(() => {
        throw new Error('onError failed');
      });
      const handler = vi.fn(() => {
        throw handlerError;
      });
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        body: makeSSEStream([
          'event: job.state_changed\nid: evt-1\ndata: {"job_id":"j1","from":"active","to":"completed"}\n\n',
        ]),
      });

      vi.useFakeTimers();
      const sub = subscribe(
        {
          url: 'http://localhost:8080',
          channel: 'job:j1',
          signal: external.signal,
          onError,
        },
        handler,
      );
      const added = addSpy.mock.calls.map((call, index) => ({
        target: addSpy.mock.contexts[index],
        listener: call[1],
      }));

      await vi.advanceTimersByTimeAsync(0);

      const removed = removeSpy.mock.calls.map((call, index) => ({
        target: removeSpy.mock.contexts[index],
        listener: call[1],
      }));
      expect(handler).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(handlerError);
      expect(added).toHaveLength(2);
      expect(removed).toEqual(expect.arrayContaining(added));
      expect(warnSpy).toHaveBeenCalledWith(
        '[ojs-subscribe] onError callback threw:',
        expect.any(Error),
      );

      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchSpy).toHaveBeenCalledOnce();

      sub.unsubscribe();
      // 2 from the internal/external signal composition (removed once by
      // stop()) + 1 from connectOnce()'s own per-event handler-settlement
      // race (Finding: SSE unsubscribe during async handler), which adds
      // and immediately removes its own listener on the composed signal
      // while racing this terminal handler's rejection -- well before
      // `unsubscribe()` is ever called. No listener is ever left behind.
      expect(removeSpy).toHaveBeenCalledTimes(3);
    });

    it('stops after a terminal handler rejects asynchronously without another fetch', async () => {
      const handlerError = new Error('terminal handler rejected');
      const onError = vi.fn(async () => {
        throw new Error('async onError failed');
      });
      const handler = vi.fn(async () => {
        await Promise.resolve();
        throw handlerError;
      });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        body: makeSSEStream([
          'event: job.state_changed\nid: evt-1\ndata: {"job_id":"j1","from":"active","to":"discarded"}\n\n',
        ]),
      });

      vi.useFakeTimers();
      const sub = subscribe(
        {
          url: 'http://localhost:8080',
          channel: 'job:j1',
          onError,
        },
        handler,
      );

      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(handlerError);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchSpy).toHaveBeenCalledOnce();

      sub.unsubscribe();
    });

    it('does not treat a non-terminal job.state_changed event (e.g. "active") as a reason to stop reconnecting', async () => {
      fetchSpy
        .mockResolvedValueOnce({
          ok: true,
          body: makeSSEStream([
            'event: job.state_changed\nid: evt-1\ndata: {"job_id":"j1","from":"available","to":"active"}\n\n',
          ]),
        })
        .mockResolvedValue({ ok: true, body: makeIdleStream() });

      vi.useFakeTimers();
      const sub = subscribe(
        { url: 'http://localhost:8080', channel: 'job:j1' },
        () => {},
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3000);
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      sub.unsubscribe();
    });

    it('retains reconnect-on-clean-close for a queue subscription even after a job.state_changed event with a terminal state', async () => {
      // Queue/general subscriptions must NOT stop reconnecting just
      // because one of the many jobs flowing through the queue happened
      // to reach a terminal state.
      fetchSpy
        .mockResolvedValueOnce({
          ok: true,
          body: makeSSEStream([
            'event: job.state_changed\nid: evt-1\ndata: {"job_id":"j1","from":"active","to":"completed"}\n\n',
          ]),
        })
        .mockResolvedValue({ ok: true, body: makeIdleStream() });

      vi.useFakeTimers();
      const sub = subscribe(
        { url: 'http://localhost:8080', channel: 'queue:default' },
        () => {},
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3000);
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      sub.unsubscribe();
    });

    it('detects a terminal job.state_changed event even when fragmented across single-character chunk boundaries', async () => {
      const payload =
        'event: job.state_changed\nid: evt-1\ndata: {"job_id":"j1","from":"active","to":"discarded"}\n\n';
      // Split into single-character chunks to exercise the SSE parser's
      // line-buffering logic as aggressively as possible.
      const chunks = payload.split('');

      fetchSpy.mockResolvedValueOnce({ ok: true, body: makeSSEStream(chunks) });

      vi.useFakeTimers();
      const events: SSEEvent[] = [];
      const sub = subscribe(
        { url: 'http://localhost:8080', channel: 'job:j1' },
        (event) => events.push(event),
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(events).toHaveLength(1);
      expect(events[0]!.data.to).toBe('discarded');
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      sub.unsubscribe();
    });

    it('does not suppress reconnection when a job.state_changed event carries malformed (non-JSON) data', async () => {
      fetchSpy
        .mockResolvedValueOnce({
          ok: true,
          body: makeSSEStream(['event: job.state_changed\nid: evt-1\ndata: not-valid-json\n\n']),
        })
        .mockResolvedValue({ ok: true, body: makeIdleStream() });

      vi.useFakeTimers();
      const events: SSEEvent[] = [];
      const sub = subscribe(
        { url: 'http://localhost:8080', channel: 'job:j1' },
        (event) => events.push(event),
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(events).toHaveLength(1);
      expect(events[0]!.data).toEqual({ raw: 'not-valid-json' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Malformed data can't confirm terminality — normal
      // reconnect-on-clean-close must still apply (fail-safe default).
      await vi.advanceTimersByTimeAsync(3000);
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      sub.unsubscribe();
    });

    it.each([
      ['null data', 'null'],
      ['array data', '[1,2,3]'],
      ['number data', '42'],
      ['object with a non-string `to`', '{"to":42}'],
      ['object with no `to` field at all', '{"job_id":"j1"}'],
    ])('does not crash and does not suppress reconnection for %s', async (_label, dataJson) => {
      fetchSpy
        .mockResolvedValueOnce({
          ok: true,
          body: makeSSEStream([`event: job.state_changed\nid: evt-1\ndata: ${dataJson}\n\n`]),
        })
        .mockResolvedValue({ ok: true, body: makeIdleStream() });

      vi.useFakeTimers();
      const sub = subscribe(
        { url: 'http://localhost:8080', channel: 'job:j1' },
        () => {},
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3000);
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      sub.unsubscribe();
    });

    it('aborts the internal controller when completing terminally (reader/controller cleanup)', async () => {
      let capturedSignal: AbortSignal | undefined;
      fetchSpy.mockImplementationOnce((_url: string, init: { signal: AbortSignal }) => {
        capturedSignal = init.signal;
        return Promise.resolve({
          ok: true,
          body: makeSSEStream([
            'event: job.state_changed\nid: evt-1\ndata: {"job_id":"j1","from":"active","to":"completed"}\n\n',
          ]),
        });
      });

      vi.useFakeTimers();
      const sub = subscribe(
        { url: 'http://localhost:8080', channel: 'job:j1' },
        () => {},
      );

      await vi.advanceTimersByTimeAsync(0);

      expect(capturedSignal?.aborted).toBe(true);
      expect(() => sub.unsubscribe()).not.toThrow();
    });

    it('does not break backpressure: still reads one chunk at a time up to and including the terminal event', async () => {
      const pulls: number[] = [];
      const encoder = new TextEncoder();
      const parts = [
        'event: job.state_changed\nid: evt-1\ndata: ',
        '{"job_id":"j1","from":"active","to":"completed"}\n\n',
      ];
      let index = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls.push(index);
          if (index < parts.length) {
            controller.enqueue(encoder.encode(parts[index]!));
            index++;
          } else {
            controller.close();
          }
        },
      });

      fetchSpy.mockResolvedValueOnce({ ok: true, body });

      vi.useFakeTimers();
      const events: SSEEvent[] = [];
      const sub = subscribe(
        { url: 'http://localhost:8080', channel: 'job:j1' },
        (event) => events.push(event),
      );

      await vi.advanceTimersByTimeAsync(0);

      // Pulled exactly once per chunk (plus the final close) — no
      // speculative/bulk reads ahead of what has actually been processed.
      expect(pulls).toEqual([0, 1, 2]);
      expect(events).toHaveLength(1);

      sub.unsubscribe();
    });
  });
});

describe('SSE clean closure reconnect budget', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('maxReconnectAttempts=0 never reconnects on clean closure', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      body: makeSSEStream([]),
    });

    vi.useFakeTimers();
    const sub = subscribe(
      { url: 'http://localhost:8080', channel: 'queue:default', maxReconnectAttempts: 0 },
      () => {},
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    sub.unsubscribe();
  });

  it('uses the exact capped exponential delay sequence for repeated clean closures', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      body: makeSSEStream([]),
    });

    vi.useFakeTimers();
    const sub = subscribe(
      { url: 'http://localhost:8080', channel: 'queue:default', maxReconnectAttempts: 6 },
      () => {},
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const expectedDelays = [3000, 6000, 12000, 24000, 30000, 30000];
    for (const [index, delay] of expectedDelays.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(fetchSpy).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchSpy).toHaveBeenCalledTimes(index + 2);
    }

    // Budget exhausted — no more reconnects
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(7);

    sub.unsubscribe();
  });

  it('resets reconnect counter on first delivered event', async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: true, body: makeSSEStream([]) }) // empty close
      .mockResolvedValueOnce({
        ok: true,
        body: makeSSEStream(['event: ping\ndata: {}\n\n']), // delivers event then closes
      })
      .mockResolvedValue({ ok: true, body: makeSSEStream([]) });

    vi.useFakeTimers();
    const sub = subscribe(
      { url: 'http://localhost:8080', channel: 'queue:default', maxReconnectAttempts: 1 },
      () => {},
    );

    await vi.advanceTimersByTimeAsync(0); // 1st connect (empty)
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3000); // reconnect (delivers event, resets counter)
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // The delivered event resets the budget, so its subsequent clean drop
    // schedules attempt 1 again rather than attempt 2's 6000ms delay.
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    sub.unsubscribe();
  });

  it('uses a retry hint as the exponential base across clean closures', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      body: makeSSEStream(['retry: 500\n\n']),
    });

    vi.useFakeTimers();
    const sub = subscribe(
      { url: 'http://localhost:8080', channel: 'queue:default', maxReconnectAttempts: 2 },
      () => {},
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(499);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    sub.unsubscribe();
  });
});

describe('SSE permanent termination cleanup (Finding 3)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('removes composition listeners on error completion', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const addSpy = vi.spyOn(AbortSignal.prototype, 'addEventListener');
    const removeSpy = vi.spyOn(AbortSignal.prototype, 'removeEventListener');
    const externalController = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    fetchSpy.mockImplementation((_url: string, init: { signal: AbortSignal }) => {
      capturedSignal = init.signal;
      return Promise.reject(new Error('network'));
    });

    const sub = subscribe(
      { url: 'http://localhost:8080', channel: 'queue:default', maxReconnectAttempts: 0, signal: externalController.signal },
      () => {},
    );

    const added = addSpy.mock.calls.map((call, index) => ({
      target: addSpy.mock.contexts[index],
      listener: call[1],
    }));
    await vi.advanceTimersByTimeAsync(0);

    const removed = removeSpy.mock.calls.map((call, index) => ({
      target: removeSpy.mock.contexts[index],
      listener: call[1],
    }));
    expect(capturedSignal?.aborted).toBe(true);
    expect(added).toHaveLength(2);
    expect(removed).toEqual(expect.arrayContaining(added));

    sub.unsubscribe();
    expect(removeSpy).toHaveBeenCalledTimes(2);
  });

  it('removes composition listeners on clean completion', async () => {
    const addSpy = vi.spyOn(AbortSignal.prototype, 'addEventListener');
    const removeSpy = vi.spyOn(AbortSignal.prototype, 'removeEventListener');
    const externalController = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    fetchSpy.mockImplementation((_url: string, init: { signal: AbortSignal }) => {
      capturedSignal = init.signal;
      return Promise.resolve({ ok: true, body: makeSSEStream([]) });
    });

    vi.useFakeTimers();
    const sub = subscribe(
      {
        url: 'http://localhost:8080',
        channel: 'queue:default',
        reconnect: false,
        signal: externalController.signal,
      },
      () => {},
    );

    const added = addSpy.mock.calls.map((call, index) => ({
      target: addSpy.mock.contexts[index],
      listener: call[1],
    }));
    await vi.advanceTimersByTimeAsync(0);

    const removed = removeSpy.mock.calls.map((call, index) => ({
      target: removeSpy.mock.contexts[index],
      listener: call[1],
    }));
    expect(capturedSignal?.aborted).toBe(true);
    expect(added).toHaveLength(2);
    expect(removed).toEqual(expect.arrayContaining(added));

    sub.unsubscribe();
    expect(removeSpy).toHaveBeenCalledTimes(2);
  });
});

describe('SSE onError callback isolation (Finding 4)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('rejected async onError does not cause unhandled rejection or prevent termination', async () => {
    fetchSpy.mockRejectedValue(new Error('network'));

    vi.useFakeTimers();
    const unhandled = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.on('unhandledRejection', unhandled);

    try {
      const sub = subscribe(
        {
          url: 'http://localhost:8080',
          channel: 'queue:default',
          maxReconnectAttempts: 0,
          onError: async () => { throw new Error('callback boom'); },
        },
        () => {},
      );

      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();

      expect(unhandled).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledOnce();
      sub.unsubscribe();
    } finally {
      process.removeListener('unhandledRejection', unhandled);
    }
  });

  it('onError exception still allows reconnect to proceed', async () => {
    let callCount = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchSpy.mockImplementation(() => {
      callCount++;
      return Promise.reject(new Error('network'));
    });

    vi.useFakeTimers();
    const sub = subscribe(
      {
        url: 'http://localhost:8080',
        channel: 'queue:default',
        maxReconnectAttempts: 2,
        onError: () => { throw new Error('callback boom'); },
      },
      () => {},
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(callCount).toBe(2);

    sub.unsubscribe();
  });
});

describe('SSE reader cancellation on abnormal exit (connectOnce)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /**
   * A ReadableStream whose underlying source records every `cancel()`
   * call (with its reason) it receives, so tests can assert the *real*
   * `ReadableStreamDefaultReader.cancel()` contract was exercised — this
   * is what actually tears down the stream's underlying resource (here,
   * standing in for the fetch response body's socket) — rather than
   * merely spying on a hand-rolled fake reader object.
   */
  function makeCancelTrackingSSEStream(
    chunks: string[],
    options: { failAfterChunks?: Error; closeWhenExhausted?: boolean } = {},
  ): { stream: ReadableStream<Uint8Array>; cancelReasons: unknown[] } {
    const encoder = new TextEncoder();
    let index = 0;
    const cancelReasons: unknown[] = [];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(encoder.encode(chunks[index]!));
          index++;
        } else if (options.failAfterChunks) {
          controller.error(options.failAfterChunks);
        } else if (options.closeWhenExhausted) {
          controller.close();
        }
        // Otherwise stay open indefinitely, like a live idle SSE
        // connection. Real ReadableStream implementations proactively
        // re-invoke `pull()` to refill the queue as soon as it empties
        // (independent of when the consumer calls `read()` again); if
        // this branch closed the stream by default, that proactive
        // re-pull could race the abnormal-exit path below and close the
        // stream (making `cancel()` a spec-mandated no-op) before the
        // test ever gets to observe a cancellation.
      },
      cancel(reason) {
        cancelReasons.push(reason);
      },
    });
    return { stream, cancelReasons };
  }

  /**
   * A fully-controllable fake reader (not backed by a real
   * ReadableStream) used for the two scenarios a real stream can't
   * easily express: asserting call *order* (`cancel()` strictly before
   * `releaseLock()`) and a `cancel()` that itself fails.
   */
  function makeFakeReader(overrides: {
    read: () => Promise<{ done: boolean; value?: Uint8Array }>;
    cancel?: (reason?: unknown) => Promise<void>;
  }): {
    reader: {
      read: () => Promise<{ done: boolean; value?: Uint8Array }>;
      cancel: (reason?: unknown) => Promise<void>;
      releaseLock: () => void;
    };
    calls: string[];
    cancelReasons: unknown[];
  } {
    const calls: string[] = [];
    const cancelReasons: unknown[] = [];
    const reader = {
      read: async () => {
        calls.push('read');
        return overrides.read();
      },
      cancel: async (reason?: unknown) => {
        calls.push('cancel');
        cancelReasons.push(reason);
        if (overrides.cancel) return overrides.cancel(reason);
      },
      releaseLock: () => {
        calls.push('releaseLock');
      },
    };
    return { reader, calls, cancelReasons };
  }

  it('cancels the reader with the thrown error before releasing the lock for a synchronously throwing handler', async () => {
    const handlerError = new Error('sync handler failed');
    const onError = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { stream, cancelReasons } = makeCancelTrackingSSEStream([
      'event: job.completed\ndata: {"ok":true}\n\n',
    ]);
    fetchSpy.mockResolvedValueOnce({ ok: true, body: stream });

    const sub = subscribe(
      { url: 'http://localhost:8080', channel: 'queue:default', reconnect: false, onError },
      () => {
        throw handlerError;
      },
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(onError).toHaveBeenCalledWith(handlerError);
    expect(cancelReasons).toEqual([handlerError]);
    sub.unsubscribe();
  });

  it('cancels the reader with the rejection reason for an asynchronously rejecting handler', async () => {
    const handlerError = new Error('async handler failed');
    const onError = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { stream, cancelReasons } = makeCancelTrackingSSEStream([
      'event: job.completed\ndata: {"ok":true}\n\n',
    ]);
    fetchSpy.mockResolvedValueOnce({ ok: true, body: stream });

    const sub = subscribe(
      { url: 'http://localhost:8080', channel: 'queue:default', reconnect: false, onError },
      async () => {
        await Promise.resolve();
        throw handlerError;
      },
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(onError).toHaveBeenCalledWith(handlerError);
    expect(cancelReasons).toEqual([handlerError]);
    sub.unsubscribe();
  });

  it('cancels the reader with the original error when reader.read() itself fails', async () => {
    // Uses the fully-controllable fake reader rather than a real
    // ReadableStream: once a real stream has already errored (as
    // `reader.read()` rejecting implies), cancelling it is a spec-defined
    // no-op that never re-invokes the underlying source's `cancel()` —
    // there would be nothing left to observe there even with the fix
    // applied. What must actually be verified here is that `connectOnce`
    // still calls `reader.cancel()` (best-effort) with the original read
    // failure as its reason before releasing the lock, which a fake
    // reader can assert on directly.
    const readError = new Error('stream read failed');
    const onError = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let readCount = 0;
    const encoder = new TextEncoder();
    const { reader, calls, cancelReasons } = makeFakeReader({
      read: async () => {
        readCount++;
        if (readCount === 1) {
          return {
            done: false,
            value: encoder.encode('event: job.progress\ndata: {"ok":true}\n\n'),
          };
        }
        throw readError;
      },
    });
    fetchSpy.mockResolvedValueOnce({ ok: true, body: { getReader: () => reader } });

    const sub = subscribe(
      { url: 'http://localhost:8080', channel: 'queue:default', reconnect: false, onError },
      () => {},
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(onError).toHaveBeenCalledWith(readError);
    expect(cancelReasons).toEqual([readError]);
    expect(calls).toContain('releaseLock');
    sub.unsubscribe();
  });

  it('calls cancel() strictly before releaseLock() on abnormal exit', async () => {
    const handlerError = new Error('boom');
    const onError = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let readCount = 0;
    const encoder = new TextEncoder();
    const { reader, calls } = makeFakeReader({
      read: async () => {
        readCount++;
        if (readCount === 1) {
          return {
            done: false,
            value: encoder.encode('event: job.completed\ndata: {"ok":true}\n\n'),
          };
        }
        return { done: true };
      },
    });
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      body: { getReader: () => reader },
    });

    vi.useFakeTimers();
    const sub = subscribe(
      { url: 'http://localhost:8080', channel: 'queue:default', reconnect: false, onError },
      () => {
        throw handlerError;
      },
    );

    await vi.advanceTimersByTimeAsync(0);

    expect(onError).toHaveBeenCalledWith(handlerError);
    const cancelIndex = calls.indexOf('cancel');
    const releaseLockIndex = calls.indexOf('releaseLock');
    expect(cancelIndex).toBeGreaterThanOrEqual(0);
    expect(releaseLockIndex).toBeGreaterThan(cancelIndex);
    sub.unsubscribe();
  });

  it('does not let a reader.cancel() failure replace or suppress the original error', async () => {
    const handlerError = new Error('original handler failure');
    const cancelError = new Error('cancel() itself failed');
    const onError = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let readCount = 0;
    const encoder = new TextEncoder();
    const { reader, calls } = makeFakeReader({
      read: async () => {
        readCount++;
        if (readCount === 1) {
          return {
            done: false,
            value: encoder.encode('event: job.completed\ndata: {"ok":true}\n\n'),
          };
        }
        return { done: true };
      },
      cancel: async () => {
        throw cancelError;
      },
    });
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      body: { getReader: () => reader },
    });

    vi.useFakeTimers();
    const sub = subscribe(
      { url: 'http://localhost:8080', channel: 'queue:default', reconnect: false, onError },
      () => {
        throw handlerError;
      },
    );

    await vi.advanceTimersByTimeAsync(0);

    // The original handler error reaches onError, never the cancel()
    // failure, and releaseLock() still runs despite cancel() rejecting.
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(handlerError);
    expect(calls).toContain('releaseLock');
    sub.unsubscribe();
  });

  it('does not cancel the reader on a clean EOF close (no connection to tear down)', async () => {
    const { stream, cancelReasons } = makeCancelTrackingSSEStream([], { closeWhenExhausted: true });
    fetchSpy.mockResolvedValueOnce({ ok: true, body: stream });

    const sub = subscribe(
      { url: 'http://localhost:8080', channel: 'queue:default', reconnect: false },
      () => {},
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(cancelReasons).toEqual([]);
    sub.unsubscribe();
  });

  it('cancels the real underlying stream source on abnormal exit (connection-leak regression)', async () => {
    // Uses a genuine ReadableStream (not a fake reader) so that this test
    // exercises the actual `ReadableStreamDefaultReader.cancel()` -> the
    // underlying source's `cancel(reason)` callback path. If `connectOnce`
    // only called `releaseLock()` (the pre-fix behavior), the underlying
    // source's `cancel()` would never fire and, against a real fetch
    // response body, the network connection could be left open instead of
    // torn down.
    const handlerError = new Error('leak check failure');
    const onError = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { stream, cancelReasons } = makeCancelTrackingSSEStream([
      'event: job.completed\ndata: {"ok":true}\n\n',
    ]);
    fetchSpy.mockResolvedValueOnce({ ok: true, body: stream });

    const sub = subscribe(
      { url: 'http://localhost:8080', channel: 'queue:default', reconnect: false, onError },
      () => {
        throw handlerError;
      },
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(cancelReasons).toHaveLength(1);
    expect(cancelReasons[0]).toBe(handlerError);
    sub.unsubscribe();
  });
});

describe('SSE unsubscribe during async handler (Finding: SSE unsubscribe during async handler)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /**
   * As `makeCancelTrackingSSEStream` above, duplicated locally (this
   * describe block runs independently of the other one) so a real
   * `ReadableStreamDefaultReader.cancel()` call can be observed rather
   * than merely inferred.
   */
  function makeCancelTrackingSSEStream(
    chunks: string[],
  ): { stream: ReadableStream<Uint8Array>; cancelReasons: unknown[] } {
    const encoder = new TextEncoder();
    let index = 0;
    const cancelReasons: unknown[] = [];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(encoder.encode(chunks[index]!));
          index++;
        }
        // Otherwise stays open indefinitely, like a live idle connection.
      },
      cancel(reason) {
        cancelReasons.push(reason);
      },
    });
    return { stream, cancelReasons };
  }

  it('unsubscribe() cancels/releases the reader immediately when the handler never settles at all', async () => {
    const { stream, cancelReasons } = makeCancelTrackingSSEStream([
      'event: job.progress\ndata: {"n":1}\n\n',
    ]);
    fetchSpy.mockResolvedValueOnce({ ok: true, body: stream });

    let handlerInvoked: () => void;
    const handlerInvokedPromise = new Promise<void>((resolve) => {
      handlerInvoked = resolve;
    });

    const sub = subscribe(
      { url: 'http://localhost:8080', channel: 'queue:default' },
      () => {
        handlerInvoked();
        // Never resolves or rejects, ever -- simulates a handler awaiting
        // some unrelated external resource that never completes.
        return new Promise<void>(() => undefined);
      },
    );

    await handlerInvokedPromise;
    // The handler is now permanently pending. unsubscribe() must still
    // settle promptly rather than waiting on it forever.
    sub.unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(cancelReasons).toHaveLength(1);
  });

  it('a later handler resolution (after unsubscribe()) is safely consumed without reconnecting, dispatching further events, or throwing', async () => {
    const { stream, cancelReasons } = makeCancelTrackingSSEStream([
      'event: job.progress\ndata: {"n":1}\n\n',
    ]);
    fetchSpy.mockResolvedValueOnce({ ok: true, body: stream });

    const handlerCalls: unknown[] = [];
    let resolveHandler: (() => void) | undefined;
    let markInvoked: () => void = () => undefined;
    const invoked = new Promise<void>((resolve) => {
      markInvoked = resolve;
    });

    const sub = subscribe(
      { url: 'http://localhost:8080', channel: 'queue:default' },
      (event) => {
        handlerCalls.push(event);
        markInvoked();
        return new Promise<void>((resolve) => {
          resolveHandler = resolve;
        });
      },
    );

    await invoked;
    sub.unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cancelReasons).toHaveLength(1);
    expect(handlerCalls).toHaveLength(1);

    // The handler finally resolves well after the subscription stopped.
    // Must not throw, dispatch again, or reconnect.
    expect(() => resolveHandler?.()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(handlerCalls).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('a later handler rejection (after unsubscribe()) never surfaces as an unhandled promise rejection', async () => {
    const { stream, cancelReasons } = makeCancelTrackingSSEStream([
      'event: job.progress\ndata: {"n":1}\n\n',
    ]);
    fetchSpy.mockResolvedValueOnce({ ok: true, body: stream });

    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    try {
      let rejectHandler: ((error: unknown) => void) | undefined;
      let markInvoked: () => void = () => undefined;
      const invoked = new Promise<void>((resolve) => {
        markInvoked = resolve;
      });

      const sub = subscribe(
        { url: 'http://localhost:8080', channel: 'queue:default' },
        () => {
          markInvoked();
          return new Promise<void>((_resolve, reject) => {
            rejectHandler = reject;
          });
        },
      );

      await invoked;
      sub.unsubscribe();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(cancelReasons).toHaveLength(1);

      // The handler finally rejects well after the subscription stopped.
      // This must never surface as an unhandled promise rejection.
      expect(() => rejectHandler?.(new Error('late handler failure'))).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener('unhandledRejection', unhandled);
    }
  });

  it('an already-aborted signal skips invoking the handler entirely for any further buffered lines in the same chunk', async () => {
    // Two events land in the same chunk. The first event's handler never
    // settles; unsubscribe() fires while it's pending. The second event
    // (buffered in the same chunk) must never reach the handler at all.
    const { stream, cancelReasons } = makeCancelTrackingSSEStream([
      'event: job.progress\ndata: {"n":1}\n\nevent: job.progress\ndata: {"n":2}\n\n',
    ]);
    fetchSpy.mockResolvedValueOnce({ ok: true, body: stream });

    const handlerCalls: unknown[] = [];
    let markInvoked: () => void = () => undefined;
    const invoked = new Promise<void>((resolve) => {
      markInvoked = resolve;
    });

    const sub = subscribe(
      { url: 'http://localhost:8080', channel: 'queue:default' },
      (event) => {
        handlerCalls.push(event);
        markInvoked();
        return new Promise<void>(() => undefined);
      },
    );

    await invoked;
    sub.unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(cancelReasons).toHaveLength(1);
    // Only the first event was ever dispatched -- the second, already
    // buffered in the same chunk, is never delivered once aborted.
    expect(handlerCalls).toHaveLength(1);
  });
});

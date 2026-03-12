import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { subscribe, subscribeJob, subscribeQueue } from '../src/subscribe.js';
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

describe('SSE subscribe', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
      { url: 'http://localhost:8080', channel: 'job:j1' },
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
      { url: 'http://localhost:8080', channel: 'job:j1' },
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
      { url: 'http://localhost:8080', channel: 'job:j1' },
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
      { url: 'http://localhost:8080', channel: 'all' },
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
      { url: 'http://localhost:8080', channel: 'all' },
      (event) => events.push(event),
    );

    await new Promise((r) => setTimeout(r, 50));
    sub.unsubscribe();

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('job.completed');
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
      { url: 'http://localhost:8080', channel: 'all' },
      (event) => events.push(event),
    );

    await new Promise((r) => setTimeout(r, 50));
    sub.unsubscribe();

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('message');
    expect(events[0]!.data).toEqual({ raw: 'not-valid-json' });
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
      { url: 'http://localhost:8080', channel: 'all' },
      (event) => events.push(event),
    );

    await new Promise((r) => setTimeout(r, 50));
    sub.unsubscribe();

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('message');
  });

  it('subscribeJob constructs correct channel', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      body: makeSSEStream([]),
    });

    const sub = subscribeJob({ url: 'http://localhost:8080' }, 'job-123', () => {});
    await new Promise((r) => setTimeout(r, 20));
    sub.unsubscribe();

    const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('channel=job%3Ajob-123');
  });

  it('subscribeQueue constructs correct channel', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      body: makeSSEStream([]),
    });

    const sub = subscribeQueue({ url: 'http://localhost:8080' }, 'email', () => {});
    await new Promise((r) => setTimeout(r, 20));
    sub.unsubscribe();

    const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('channel=queue%3Aemail');
  });

  it('sends auth header when provided', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      body: makeSSEStream([]),
    });

    const sub = subscribe(
      { url: 'http://localhost:8080', auth: 'my-token', channel: 'all' },
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
      { url: 'http://localhost:8080', channel: 'all' },
      (event) => events.push(event),
    );

    await new Promise((r) => setTimeout(r, 50));
    sub.unsubscribe();

    // Heartbeat with no data should be skipped
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('job.completed');
  });
});

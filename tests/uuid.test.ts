import { afterEach, describe, expect, it, vi } from 'vitest';
import { OJSEventEmitter } from '../src/events.js';
import { HttpTransport } from '../src/transport/http.js';
import { generateUuidV4 } from '../src/uuid.js';
import { OJSWorker } from '../src/worker.js';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('generateUuidV4()', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns a well-formed RFC 4122 version-4 UUID using the ambient runtime crypto', () => {
    const id = generateUuidV4();
    expect(id).toMatch(UUID_V4_RE);
  });

  it('generates unique values across many calls', () => {
    const ids = new Set<string>();
    const count = 10_000;
    for (let i = 0; i < count; i++) {
      ids.add(generateUuidV4());
    }
    expect(ids.size).toBe(count);
  });

  it('generates worker, event, and request IDs with the existing wire shapes', async () => {
    const worker = new OJSWorker({ url: 'https://example.test', handleSignals: false });
    const event = OJSEventEmitter.createEvent(
      'worker.started',
      'ojs://test',
      { worker_id: 'worker-test', queues: ['default'], concurrency: 1 },
    );

    let requestId: string | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestId = (init?.headers as Record<string, string> | undefined)?.['X-Request-ID'];
      return new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    await new HttpTransport({ url: 'https://example.test' }).request({
      method: 'GET',
      path: '/jobs',
    });

    expect(worker.workerId).toMatch(new RegExp(`^worker_${UUID_V4_RE.source.slice(1, -1)}$`, 'i'));
    expect(event.id).toMatch(new RegExp(`^evt_${UUID_V4_RE.source.slice(1, -1)}$`, 'i'));
    expect(requestId).toMatch(UUID_V4_RE);
  });
});

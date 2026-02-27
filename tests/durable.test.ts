import { describe, it, expect, vi } from 'vitest';
import { DurableContext } from '../src/durable.js';
import type { Transport, TransportResponse, TransportRequestOptions } from '../src/transport/types.js';

function createMockTransport(responses: Record<string, unknown> = {}): Transport {
  return {
    async request<T>(options: TransportRequestOptions): Promise<TransportResponse<T>> {
      const key = `${options.method} ${options.path}`;

      // Default: no checkpoint
      if (options.path?.includes('/resume') && !responses['resume']) {
        return { body: { has_checkpoint: false } as T, status: 200, headers: {} };
      }

      if (responses['resume'] && options.path?.includes('/resume')) {
        return { body: responses['resume'] as T, status: 200, headers: {} };
      }

      return { body: {} as T, status: 200, headers: {} };
    },
  };
}

describe('DurableContext', () => {
  it('creates in record mode when no checkpoint exists', async () => {
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

  it('replays entries from checkpoint', async () => {
    const replayLog = JSON.stringify([
      { seq: 0, type: 'time', key: 'now', result: '2026-01-15T10:00:00.000Z' },
      { seq: 1, type: 'random', result: 'deadbeef01234567' },
      { seq: 2, type: 'call', key: 'api-call', result: { price: 99.99 } },
    ]);

    const transport = createMockTransport({
      resume: {
        has_checkpoint: true,
        checkpoint: {
          metadata: { _replay_log: replayLog },
        },
      },
    });

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

  it('sends checkpoint to server', async () => {
    let savedBody: unknown = null;
    const transport: Transport = {
      async request<T>(options: TransportRequestOptions): Promise<TransportResponse<T>> {
        if (options.method === 'POST' && options.path?.includes('/checkpoints/')) {
          savedBody = options.body;
        }
        if (options.path?.includes('/resume')) {
          return { body: { has_checkpoint: false } as T, status: 200, headers: {} };
        }
        return { body: {} as T, status: 200, headers: {} };
      },
    };

    const dc = await DurableContext.create(transport, 'job-cp', 1);
    dc.now();
    dc.random(8);

    await dc.checkpoint(2, { step: 'transform' });
    expect(savedBody).toBeDefined();
    expect((savedBody as Record<string, unknown>).step_index).toBe(2);
  });

  it('sends DELETE on complete()', async () => {
    let deletesCalled = 0;
    const transport: Transport = {
      async request<T>(options: TransportRequestOptions): Promise<TransportResponse<T>> {
        if (options.method === 'DELETE') {
          deletesCalled++;
        }
        if (options.path?.includes('/resume')) {
          return { body: { has_checkpoint: false } as T, status: 200, headers: {} };
        }
        return { body: {} as T, status: 200, headers: {} };
      },
    };

    const dc = await DurableContext.create(transport, 'job-done', 1);
    await dc.complete();
    expect(deletesCalled).toBe(1);
  });

  it('handles checkpoint server unavailability gracefully', async () => {
    const transport: Transport = {
      async request<T>(options: TransportRequestOptions): Promise<TransportResponse<T>> {
        if (options.path?.includes('/resume')) {
          throw new Error('connection refused');
        }
        return { body: {} as T, status: 200, headers: {} };
      },
    };

    const dc = await DurableContext.create(transport, 'job-no-cp', 1);
    expect(dc.isReplaying()).toBe(false);

    // Should work in record mode
    const t = dc.now();
    expect(t).toBeInstanceOf(Date);
  });
});

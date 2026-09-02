import { describe, it, expect, vi } from 'vitest';
import { OJSEventEmitter, type OJSEvent } from '../src/events.js';

function createTestEvent(
  type: string,
  data: Record<string, unknown> = {},
): OJSEvent {
  return OJSEventEmitter.createEvent(
    type as 'job.completed',
    'ojs://test',
    data as { job_type: string; queue: string; duration_ms: number; attempt: number },
  );
}

describe('OJSEventEmitter', () => {
  describe('on()', () => {
    it('calls listener when matching event is emitted', async () => {
      const emitter = new OJSEventEmitter();
      const listener = vi.fn();
      emitter.on('job.completed', listener);

      const event = createTestEvent('job.completed', { job_type: 'test' });
      await emitter.emit(event);

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(event);
    });

    it('does not call listener for non-matching events', async () => {
      const emitter = new OJSEventEmitter();
      const listener = vi.fn();
      emitter.on('job.completed', listener);

      await emitter.emit(createTestEvent('job.failed'));
      expect(listener).not.toHaveBeenCalled();
    });

    it('supports multiple listeners for same event', async () => {
      const emitter = new OJSEventEmitter();
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      emitter.on('job.completed', listener1);
      emitter.on('job.completed', listener2);

      await emitter.emit(createTestEvent('job.completed'));

      expect(listener1).toHaveBeenCalledOnce();
      expect(listener2).toHaveBeenCalledOnce();
    });

    it('returns unsubscribe function', async () => {
      const emitter = new OJSEventEmitter();
      const listener = vi.fn();
      const unsubscribe = emitter.on('job.completed', listener);

      await emitter.emit(createTestEvent('job.completed'));
      expect(listener).toHaveBeenCalledOnce();

      unsubscribe();

      await emitter.emit(createTestEvent('job.completed'));
      expect(listener).toHaveBeenCalledOnce(); // Not called again
    });
  });

  describe('onAny()', () => {
    it('receives events of all types', async () => {
      const emitter = new OJSEventEmitter();
      const listener = vi.fn();
      emitter.onAny(listener);

      await emitter.emit(createTestEvent('job.completed'));
      await emitter.emit(createTestEvent('job.failed'));
      await emitter.emit(createTestEvent('worker.started'));

      expect(listener).toHaveBeenCalledTimes(3);
    });

    it('returns unsubscribe function', async () => {
      const emitter = new OJSEventEmitter();
      const listener = vi.fn();
      const unsubscribe = emitter.onAny(listener);

      await emitter.emit(createTestEvent('job.completed'));
      expect(listener).toHaveBeenCalledOnce();

      unsubscribe();

      await emitter.emit(createTestEvent('job.failed'));
      expect(listener).toHaveBeenCalledOnce();
    });
  });

  describe('emit()', () => {
    it('calls both type-specific and wildcard listeners', async () => {
      const emitter = new OJSEventEmitter();
      const specificListener = vi.fn();
      const anyListener = vi.fn();

      emitter.on('job.completed', specificListener);
      emitter.onAny(anyListener);

      const event = createTestEvent('job.completed');
      await emitter.emit(event);

      expect(specificListener).toHaveBeenCalledWith(event);
      expect(anyListener).toHaveBeenCalledWith(event);
    });

    it('waits for async listeners', async () => {
      const emitter = new OJSEventEmitter();
      const order: number[] = [];

      emitter.on('job.completed', async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(1);
      });

      await emitter.emit(createTestEvent('job.completed'));
      order.push(2);

      expect(order).toEqual([1, 2]);
    });

    it('does nothing when no listeners registered', async () => {
      const emitter = new OJSEventEmitter();
      // Should not throw
      await emitter.emit(createTestEvent('job.completed'));
    });

    it('does not reject when a listener throws synchronously', async () => {
      const emitter = new OJSEventEmitter();
      const goodListener = vi.fn();
      emitter.on('job.completed', () => {
        throw new Error('synchronous boom');
      });
      emitter.on('job.completed', goodListener);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(emitter.emit(createTestEvent('job.completed'))).resolves.toBeUndefined();

      // The broken listener must not prevent the other listener from running.
      expect(goodListener).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("listener for 'job.completed' threw"),
        expect.stringContaining('synchronous boom'),
      );
      warnSpy.mockRestore();
    });

    it('does not reject when a listener rejects asynchronously', async () => {
      const emitter = new OJSEventEmitter();
      const goodListener = vi.fn();
      emitter.on('job.completed', async () => {
        throw new Error('async boom');
      });
      emitter.on('job.completed', goodListener);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(emitter.emit(createTestEvent('job.completed'))).resolves.toBeUndefined();

      expect(goodListener).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("listener for 'job.completed' threw"),
        expect.stringContaining('async boom'),
      );
      warnSpy.mockRestore();
    });

    it('isolates a throwing wildcard listener from a passing type-specific listener', async () => {
      const emitter = new OJSEventEmitter();
      const typeListener = vi.fn();
      emitter.onAny(() => {
        throw new Error('wildcard boom');
      });
      emitter.on('job.completed', typeListener);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(emitter.emit(createTestEvent('job.completed'))).resolves.toBeUndefined();
      expect(typeListener).toHaveBeenCalledOnce();
      warnSpy.mockRestore();
    });

    it('runs multiple async listeners concurrently, not sequentially', async () => {
      // Regression guard: emit() must start all listeners immediately and
      // await them together, not await each one before starting the next —
      // otherwise N slow listeners take N times as long as they should.
      const emitter = new OJSEventEmitter();
      const active = { count: 0, maxConcurrent: 0 };

      // Distinct closures: OJSEventEmitter stores listeners in a Set, which
      // would dedupe the *same* function reference registered multiple
      // times, defeating the point of this concurrency check.
      const makeSlowListener = () => async (): Promise<void> => {
        active.count++;
        active.maxConcurrent = Math.max(active.maxConcurrent, active.count);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active.count--;
      };

      emitter.on('job.completed', makeSlowListener());
      emitter.on('job.completed', makeSlowListener());
      emitter.on('job.completed', makeSlowListener());

      await emitter.emit(createTestEvent('job.completed'));

      expect(active.maxConcurrent).toBe(3);
    });
  });

  describe('removeAllListeners()', () => {
    it('removes all registered listeners', async () => {
      const emitter = new OJSEventEmitter();
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const anyListener = vi.fn();

      emitter.on('job.completed', listener1);
      emitter.on('job.failed', listener2);
      emitter.onAny(anyListener);

      emitter.removeAllListeners();

      await emitter.emit(createTestEvent('job.completed'));
      await emitter.emit(createTestEvent('job.failed'));

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).not.toHaveBeenCalled();
      expect(anyListener).not.toHaveBeenCalled();
    });
  });

  describe('createEvent()', () => {
    it('creates event with proper envelope', () => {
      const event = OJSEventEmitter.createEvent(
        'worker.started',
        'ojs://sdk/workers/w1',
        { worker_id: 'w1', queues: ['default'], concurrency: 10 },
      );

      expect(event.specversion).toBe('1.0');
      expect(event.id).toMatch(/^evt_/);
      expect(event.type).toBe('worker.started');
      expect(event.source).toBe('ojs://sdk/workers/w1');
      expect(event.time).toBeDefined();
      expect(event.data.worker_id).toBe('w1');
      expect(event.data.queues).toEqual(['default']);
    });

    it('includes subject when provided', () => {
      const event = OJSEventEmitter.createEvent(
        'job.completed',
        'ojs://test',
        { job_type: 'test', queue: 'default', duration_ms: 100, attempt: 1 },
        'job-123',
      );

      expect(event.subject).toBe('job-123');
    });

    it('omits subject when not provided', () => {
      const event = OJSEventEmitter.createEvent(
        'job.completed',
        'ojs://test',
        { job_type: 'test', queue: 'default', duration_ms: 100, attempt: 1 },
      );

      expect(event.subject).toBeUndefined();
    });

    it('generates unique IDs for each event', () => {
      const event1 = OJSEventEmitter.createEvent(
        'job.completed',
        'ojs://test',
        { job_type: 'test', queue: 'default', duration_ms: 100, attempt: 1 },
      );
      const event2 = OJSEventEmitter.createEvent(
        'job.completed',
        'ojs://test',
        { job_type: 'test', queue: 'default', duration_ms: 100, attempt: 1 },
      );

      expect(event1.id).not.toBe(event2.id);
    });
  });
});

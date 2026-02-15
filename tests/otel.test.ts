import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openTelemetryMiddleware } from '../src/otel.js';
import type { JobContext } from '../src/middleware.js';
import type { Job } from '../src/job.js';

function createTestContext(overrides: Partial<Job> = {}): JobContext {
  return {
    job: {
      specversion: '1.0',
      id: 'job_123',
      type: 'email.send',
      queue: 'default',
      args: [{ to: 'user@example.com' }],
      attempt: 1,
      ...overrides,
    },
    attempt: 1,
    queue: 'default',
    workerId: 'worker_test',
    metadata: new Map(),
    signal: new AbortController().signal,
  };
}

describe('openTelemetryMiddleware', () => {
  describe('without tracer (metrics only)', () => {
    it('should call next and record duration on success', async () => {
      const recordCalls: Array<{ value: number; attrs: Record<string, string> }> = [];
      const addCalls: Array<{ value: number; attrs: Record<string, string> }> = [];

      const middleware = openTelemetryMiddleware({
        meterProvider: {
          getMeter: () => ({
            createCounter: (name: string) => ({
              add: (value: number, attrs?: Record<string, string>) => {
                addCalls.push({ value, attrs: attrs ?? {} });
              },
            }),
            createHistogram: () => ({
              record: (value: number, attrs?: Record<string, string>) => {
                recordCalls.push({ value, attrs: attrs ?? {} });
              },
            }),
          }),
        },
      });

      const ctx = createTestContext();
      const result = await middleware(ctx, async () => 'done');

      expect(result).toBe('done');
      expect(recordCalls).toHaveLength(1);
      expect(recordCalls[0].attrs['ojs.job.type']).toBe('email.send');
      // Should have incremented completed counter
      const completedAdd = addCalls.find((c) => c.attrs['ojs.job.type'] === 'email.send');
      expect(completedAdd).toBeDefined();
    });

    it('should record duration and increment failed counter on error', async () => {
      const addCalls: Array<{ value: number; attrs: Record<string, string> }> = [];
      let durationRecorded = false;

      const middleware = openTelemetryMiddleware({
        meterProvider: {
          getMeter: () => ({
            createCounter: () => ({
              add: (value: number, attrs?: Record<string, string>) => {
                addCalls.push({ value, attrs: attrs ?? {} });
              },
            }),
            createHistogram: () => ({
              record: () => { durationRecorded = true; },
            }),
          }),
        },
      });

      const ctx = createTestContext();

      await expect(
        middleware(ctx, async () => { throw new Error('handler failed'); }),
      ).rejects.toThrow('handler failed');

      expect(durationRecorded).toBe(true);
      expect(addCalls).toHaveLength(1); // failed counter
    });
  });

  describe('without any providers', () => {
    it('should pass through to next without metrics', async () => {
      const middleware = openTelemetryMiddleware();
      const ctx = createTestContext();
      const result = await middleware(ctx, async () => 'pass-through');
      expect(result).toBe('pass-through');
    });

    it('should re-throw errors without metrics', async () => {
      const middleware = openTelemetryMiddleware();
      const ctx = createTestContext();
      await expect(
        middleware(ctx, async () => { throw new Error('fail'); }),
      ).rejects.toThrow('fail');
    });
  });

  describe('with tracer', () => {
    it('should create a span and record success', async () => {
      const spanCalls: string[] = [];

      const middleware = openTelemetryMiddleware({
        tracerProvider: {
          getTracer: () => ({
            startActiveSpan: <T>(_name: string, _options: Record<string, unknown>, fn: (span: unknown) => T): T => {
              const span = {
                setAttribute: () => { spanCalls.push('setAttribute'); },
                setStatus: (s: { code: number }) => { spanCalls.push(`setStatus:${s.code}`); },
                recordException: () => { spanCalls.push('recordException'); },
                end: () => { spanCalls.push('end'); },
              };
              return fn(span);
            },
          }),
        },
      });

      const ctx = createTestContext();
      const result = await middleware(ctx, async () => 'traced');

      expect(result).toBe('traced');
      expect(spanCalls).toContain('setStatus:1'); // OK
      expect(spanCalls).toContain('end');
      expect(spanCalls).not.toContain('recordException');
    });

    it('should record exception and error status on failure', async () => {
      const spanCalls: string[] = [];

      const middleware = openTelemetryMiddleware({
        tracerProvider: {
          getTracer: () => ({
            startActiveSpan: <T>(_name: string, _options: Record<string, unknown>, fn: (span: unknown) => T): T => {
              const span = {
                setAttribute: () => {},
                setStatus: (s: { code: number }) => { spanCalls.push(`setStatus:${s.code}`); },
                recordException: () => { spanCalls.push('recordException'); },
                end: () => { spanCalls.push('end'); },
              };
              return fn(span);
            },
          }),
        },
      });

      const ctx = createTestContext();

      await expect(
        middleware(ctx, async () => { throw new Error('span error'); }),
      ).rejects.toThrow('span error');

      expect(spanCalls).toContain('recordException');
      expect(spanCalls).toContain('setStatus:2'); // ERROR
      expect(spanCalls).toContain('end');
    });

    it('should record non-Error exceptions', async () => {
      let recordedValue: unknown = null;

      const middleware = openTelemetryMiddleware({
        tracerProvider: {
          getTracer: () => ({
            startActiveSpan: <T>(_name: string, _options: Record<string, unknown>, fn: (span: unknown) => T): T => {
              const span = {
                setAttribute: () => {},
                setStatus: () => {},
                recordException: (e: unknown) => { recordedValue = e; },
                end: () => {},
              };
              return fn(span);
            },
          }),
        },
      });

      const ctx = createTestContext();

      await expect(
        middleware(ctx, async () => { throw 'string error'; }),
      ).rejects.toBe('string error');

      expect(recordedValue).toBeInstanceOf(Error);
      expect((recordedValue as Error).message).toBe('string error');
    });

    it('should work with both tracer and meter', async () => {
      const addCalls: number[] = [];
      const recordCalls: number[] = [];

      const middleware = openTelemetryMiddleware({
        tracerProvider: {
          getTracer: () => ({
            startActiveSpan: <T>(_name: string, _options: Record<string, unknown>, fn: (span: unknown) => T): T => {
              const span = {
                setAttribute: () => {},
                setStatus: () => {},
                recordException: () => {},
                end: () => {},
              };
              return fn(span);
            },
          }),
        },
        meterProvider: {
          getMeter: () => ({
            createCounter: () => ({
              add: (v: number) => { addCalls.push(v); },
            }),
            createHistogram: () => ({
              record: (v: number) => { recordCalls.push(v); },
            }),
          }),
        },
      });

      const ctx = createTestContext();
      await middleware(ctx, async () => 'both');

      expect(addCalls).toHaveLength(1);
      expect(recordCalls).toHaveLength(1);
    });
  });
});

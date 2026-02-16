import { describe, it, expect, vi } from 'vitest';
import { logging } from '../src/middleware/logging.js';
import { timeout, TimeoutError } from '../src/middleware/timeout.js';
import { retry } from '../src/middleware/retry.js';
import { metrics, type MetricsRecorder } from '../src/middleware/metrics.js';
import type { JobContext } from '../src/middleware.js';

function createTestContext(overrides: Partial<JobContext> = {}): JobContext {
  return {
    job: {
      specversion: '1.0',
      id: 'test-id',
      type: 'test.job',
      queue: 'default',
      args: [],
    },
    attempt: 1,
    queue: 'default',
    workerId: 'test-worker',
    metadata: new Map(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('logging middleware', () => {
  it('should log completion on success', async () => {
    const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const mw = logging({ logger });
    const ctx = createTestContext();

    await mw(ctx, async () => 'ok');

    expect(logger.log).toHaveBeenCalledOnce();
    expect(logger.log.mock.calls[0][0]).toContain('Job completed');
  });

  it('should log error on failure', async () => {
    const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const mw = logging({ logger });
    const ctx = createTestContext();

    await expect(
      mw(ctx, async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');

    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0][0]).toContain('Job failed');
  });

  it('should log debug messages when level is debug', async () => {
    const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const mw = logging({ logger, level: 'debug' });
    const ctx = createTestContext();

    await mw(ctx, async () => 'ok');

    expect(logger.debug).toHaveBeenCalledOnce();
    expect(logger.debug.mock.calls[0][0]).toContain('Job started');
  });
});

describe('timeout middleware', () => {
  it('should pass through if job completes within timeout', async () => {
    const mw = timeout({ timeoutMs: 1000 });
    const ctx = createTestContext();

    const result = await mw(ctx, async () => 'ok');
    expect(result).toBe('ok');
  });

  it('should throw TimeoutError if job exceeds timeout', async () => {
    const mw = timeout({ timeoutMs: 10 });
    const ctx = createTestContext();

    await expect(
      mw(ctx, () => new Promise((resolve) => setTimeout(resolve, 200))),
    ).rejects.toThrow(TimeoutError);
  });
});

describe('retry middleware', () => {
  it('should pass through on success', async () => {
    const mw = retry({ maxRetries: 3, baseDelayMs: 1 });
    const ctx = createTestContext();

    const result = await mw(ctx, async () => 'ok');
    expect(result).toBe('ok');
  });

  it('should retry on failure and succeed', async () => {
    const mw = retry({ maxRetries: 3, baseDelayMs: 1, jitter: false });
    const ctx = createTestContext();

    let calls = 0;
    const result = await mw(ctx, async () => {
      calls++;
      if (calls < 3) throw new Error('fail');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('should throw after exhausting retries', async () => {
    const mw = retry({ maxRetries: 2, baseDelayMs: 1, jitter: false });
    const ctx = createTestContext();

    await expect(
      mw(ctx, async () => { throw new Error('always fails'); }),
    ).rejects.toThrow('always fails');
  });
});

describe('metrics middleware', () => {
  it('should record completion on success', async () => {
    const recorder: MetricsRecorder = {
      jobStarted: vi.fn(),
      jobCompleted: vi.fn(),
      jobFailed: vi.fn(),
    };
    const mw = metrics({ recorder });
    const ctx = createTestContext();

    await mw(ctx, async () => 'ok');

    expect(recorder.jobStarted).toHaveBeenCalledWith('test.job', 'default');
    expect(recorder.jobCompleted).toHaveBeenCalledOnce();
    expect(recorder.jobFailed).not.toHaveBeenCalled();
  });

  it('should record failure on error', async () => {
    const recorder: MetricsRecorder = {
      jobStarted: vi.fn(),
      jobCompleted: vi.fn(),
      jobFailed: vi.fn(),
    };
    const mw = metrics({ recorder });
    const ctx = createTestContext();

    await expect(
      mw(ctx, async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');

    expect(recorder.jobStarted).toHaveBeenCalledOnce();
    expect(recorder.jobFailed).toHaveBeenCalledOnce();
    expect(recorder.jobCompleted).not.toHaveBeenCalled();
  });
});

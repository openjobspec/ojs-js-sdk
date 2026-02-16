/**
 * Metrics recording middleware for OJS job processing.
 *
 * Provides a pluggable interface for recording job execution metrics
 * (duration, counts, errors) to any metrics backend.
 *
 * @example
 * ```typescript
 * import { OJSWorker } from '@openjobspec/sdk';
 * import { metrics, type MetricsRecorder } from '@openjobspec/sdk/middleware';
 *
 * const recorder: MetricsRecorder = {
 *   jobStarted(jobType, queue) { console.log('started', jobType); },
 *   jobCompleted(jobType, queue, durationMs) { console.log('done', durationMs); },
 *   jobFailed(jobType, queue, durationMs, error) { console.error('fail', error); },
 * };
 *
 * const worker = new OJSWorker({ url: 'http://localhost:8080', queues: ['default'] });
 * worker.use(metrics({ recorder }));
 * ```
 *
 * @module
 */

import type { ExecutionMiddleware, JobContext, NextFunction } from '../middleware.js';

/** Interface for recording job execution metrics. */
export interface MetricsRecorder {
  /** Called when a job starts processing. */
  jobStarted(jobType: string, queue: string): void;
  /** Called when a job completes successfully. */
  jobCompleted(jobType: string, queue: string, durationMs: number): void;
  /** Called when a job fails. */
  jobFailed(jobType: string, queue: string, durationMs: number, error: unknown): void;
}

/** Options for the metrics middleware. */
export interface MetricsOptions {
  /** The metrics recorder to use. */
  recorder: MetricsRecorder;
}

/**
 * Creates execution middleware that records job metrics via a
 * {@link MetricsRecorder} interface.
 *
 * @param options - metrics configuration
 * @returns execution middleware function
 */
export function metrics(options: MetricsOptions): ExecutionMiddleware {
  const { recorder } = options;

  return async (ctx: JobContext, next: NextFunction): Promise<unknown> => {
    const jobType = ctx.job.type;
    const queue = ctx.queue;
    const start = performance.now();

    recorder.jobStarted(jobType, queue);

    try {
      const result = await next();
      const durationMs = performance.now() - start;
      recorder.jobCompleted(jobType, queue, durationMs);
      return result;
    } catch (error) {
      const durationMs = performance.now() - start;
      recorder.jobFailed(jobType, queue, durationMs, error);
      throw error;
    }
  };
}

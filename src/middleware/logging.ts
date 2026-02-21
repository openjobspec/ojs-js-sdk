/**
 * Structured logging middleware for OJS job processing.
 *
 * Logs job start, completion, and failure events with timing information.
 *
 * @example
 * ```typescript
 * import { OJSWorker } from '@openjobspec/sdk';
 * import { logging } from '@openjobspec/sdk/middleware';
 *
 * const worker = new OJSWorker({ url: 'http://localhost:8080', queues: ['default'] });
 * worker.use(logging({ level: 'debug' }));
 * ```
 *
 * @module
 */

import type { ExecutionMiddleware, JobContext, NextFunction } from '../middleware.js';

/** Options for the logging middleware. */
export interface LoggingOptions {
  /** Logger instance. Defaults to `console`. */
  logger?: Pick<Console, 'log' | 'error' | 'debug'>;
  /** Minimum log level. Defaults to `'info'`. */
  level?: 'debug' | 'info' | 'error';
}

/**
 * Creates execution middleware that logs job start, completion, and failure.
 *
 * @param options - logging configuration
 * @returns execution middleware function
 */
export function logging(options?: LoggingOptions): ExecutionMiddleware {
  const logger = options?.logger ?? console;
  const level = options?.level ?? 'info';

  return async (ctx: JobContext, next: NextFunction): Promise<unknown> => {
    const start = performance.now();

    if (level === 'debug') {
      logger.debug(
        `[ojs] Job started: ${ctx.job.type} (id=${ctx.job.id}, attempt=${ctx.attempt})`,
      );
    }

    try {
      const result = await next();
      const duration = (performance.now() - start).toFixed(2);

      if (level !== 'error') {
        logger.log(
          `[ojs] Job completed: ${ctx.job.type} (id=${ctx.job.id}, ${duration}ms)`,
        );
      }

      return result;
    } catch (error) {
      const duration = (performance.now() - start).toFixed(2);
      logger.error(
        `[ojs] Job failed: ${ctx.job.type} (id=${ctx.job.id}, ${duration}ms)`,
        error,
      );
      throw error;
    }
  };
}


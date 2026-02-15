/**
 * OpenTelemetry middleware for the OJS JavaScript/TypeScript SDK.
 *
 * Provides execution middleware that instruments job processing with
 * OpenTelemetry traces and metrics, following the OJS Observability spec.
 *
 * @example
 * ```typescript
 * import { OJSWorker } from '@openjobspec/sdk';
 * import { openTelemetryMiddleware } from '@openjobspec/sdk/otel';
 * import { trace, metrics } from '@opentelemetry/api';
 *
 * const worker = new OJSWorker({ url: 'http://localhost:8080', queues: ['default'] });
 * worker.use(openTelemetryMiddleware({
 *   tracerProvider: trace.getTracerProvider(),
 *   meterProvider: metrics.getMeterProvider(),
 * }));
 * ```
 *
 * @see spec/ojs-observability.md
 * @module
 */

import type { ExecutionMiddleware, NextFunction, JobContext } from './middleware';

/**
 * OpenTelemetry API interfaces (peer dependency).
 * Users must install `@opentelemetry/api` separately.
 */
interface OTelTracer {
  startActiveSpan<T>(name: string, options: Record<string, unknown>, fn: (span: OTelSpan) => T): T;
}

interface OTelSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
  recordException(error: Error | string): void;
  end(): void;
}

interface OTelCounter {
  add(value: number, attributes?: Record<string, string>): void;
}

interface OTelHistogram {
  record(value: number, attributes?: Record<string, string>): void;
}

interface OTelTracerProvider {
  getTracer(name: string, version?: string): OTelTracer;
}

interface OTelMeterProvider {
  getMeter(name: string, version?: string): {
    createCounter(name: string, options?: Record<string, string>): OTelCounter;
    createHistogram(name: string, options?: Record<string, string>): OTelHistogram;
  };
}

/** Configuration for OpenTelemetry middleware. */
export interface OpenTelemetryConfig {
  /** OpenTelemetry tracer provider. If omitted, uses global provider. */
  tracerProvider?: OTelTracerProvider;
  /** OpenTelemetry meter provider. If omitted, uses global provider. */
  meterProvider?: OTelMeterProvider;
}

const INSTRUMENTATION_NAME = '@openjobspec/sdk';

/**
 * Creates execution middleware that instruments job processing with
 * OpenTelemetry traces and metrics.
 *
 * Creates a CONSUMER span for each job and records:
 * - `ojs.job.completed` (counter)
 * - `ojs.job.failed` (counter)
 * - `ojs.job.duration` (histogram, seconds)
 */
export function openTelemetryMiddleware(config: OpenTelemetryConfig = {}): ExecutionMiddleware {
  const tracer = config.tracerProvider?.getTracer(INSTRUMENTATION_NAME);
  const meter = config.meterProvider?.getMeter(INSTRUMENTATION_NAME);

  const jobsCompleted = meter?.createCounter('ojs.job.completed', { description: 'Jobs completed successfully' });
  const jobsFailed = meter?.createCounter('ojs.job.failed', { description: 'Jobs that failed' });
  const jobDuration = meter?.createHistogram('ojs.job.duration', { description: 'Job execution duration in seconds' });

  return async (ctx: JobContext, next: NextFunction): Promise<unknown> => {
    const metricAttrs = {
      'ojs.job.type': ctx.job.type,
      'ojs.job.queue': ctx.job.queue,
    };

    if (!tracer) {
      const start = performance.now();
      try {
        const result = await next();
        const duration = (performance.now() - start) / 1000;
        jobDuration?.record(duration, metricAttrs);
        jobsCompleted?.add(1, metricAttrs);
        return result;
      } catch (error) {
        const duration = (performance.now() - start) / 1000;
        jobDuration?.record(duration, metricAttrs);
        jobsFailed?.add(1, metricAttrs);
        throw error;
      }
    }

    return tracer.startActiveSpan(
      `process ${ctx.job.type}`,
      {
        kind: 4, // SpanKind.CONSUMER
        attributes: {
          'messaging.system': 'ojs',
          'messaging.operation': 'process',
          'ojs.job.type': ctx.job.type,
          'ojs.job.id': ctx.job.id,
          'ojs.job.queue': ctx.job.queue,
          'ojs.job.attempt': ctx.job.attempt,
        },
      },
      async (span: OTelSpan) => {
        const start = performance.now();
        try {
          const result = await next();
          const duration = (performance.now() - start) / 1000;

          span.setStatus({ code: 1 }); // SpanStatusCode.OK
          jobDuration?.record(duration, metricAttrs);
          jobsCompleted?.add(1, metricAttrs);
          span.end();
          return result;
        } catch (error) {
          const duration = (performance.now() - start) / 1000;

          span.recordException(error instanceof Error ? error : String(error));
          span.setStatus({ code: 2, message: String(error) }); // SpanStatusCode.ERROR
          jobDuration?.record(duration, metricAttrs);
          jobsFailed?.add(1, metricAttrs);
          span.end();
          throw error;
        }
      },
    );
  };
}

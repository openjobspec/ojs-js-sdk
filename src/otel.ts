/**
 * OpenTelemetry middleware for the OJS JavaScript/TypeScript SDK.
 *
 * Provides execution middleware that instruments job processing with
 * OpenTelemetry traces and metrics, following the OJS Observability spec.
 *
 * Requires `@opentelemetry/api` as an optional peer dependency.
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

import type { ExecutionMiddleware, NextFunction, JobContext } from './middleware.js';
import type {
  Tracer,
  Span,
  TracerProvider,
  Counter,
  Histogram,
} from '@opentelemetry/api';

// Re-export MeterProvider-related types locally since @opentelemetry/api
// splits meter types across modules.
interface MeterProvider {
  getMeter(name: string, version?: string): {
    createCounter(name: string, options?: Record<string, string>): Counter;
    createHistogram(name: string, options?: Record<string, string>): Histogram;
  };
}

/** Configuration for OpenTelemetry middleware. */
export interface OpenTelemetryConfig {
  /** OpenTelemetry tracer provider. If omitted, tracing is disabled. */
  tracerProvider?: TracerProvider;
  /** OpenTelemetry meter provider. If omitted, metrics are disabled. */
  meterProvider?: MeterProvider;
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
  const tracer: Tracer | undefined = config.tracerProvider?.getTracer(INSTRUMENTATION_NAME);
  const meter = config.meterProvider?.getMeter(INSTRUMENTATION_NAME);

  const jobsCompleted: Counter | undefined = meter?.createCounter('ojs.job.completed', { description: 'Jobs completed successfully' });
  const jobsFailed: Counter | undefined = meter?.createCounter('ojs.job.failed', { description: 'Jobs that failed' });
  const jobDuration: Histogram | undefined = meter?.createHistogram('ojs.job.duration', { description: 'Job execution duration in seconds' });

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
          'ojs.job.attempt': ctx.job.attempt ?? 1,
        },
      },
      (span: Span) => {
        const start = performance.now();

        const finish = (error?: Error) => {
          const duration = (performance.now() - start) / 1000;
          jobDuration?.record(duration, metricAttrs);

          if (error) {
            span.recordException(error);
            span.setStatus({ code: 2, message: String(error) }); // SpanStatusCode.ERROR
            jobsFailed?.add(1, metricAttrs);
          } else {
            span.setStatus({ code: 1 }); // SpanStatusCode.OK
            jobsCompleted?.add(1, metricAttrs);
          }
          span.end();
        };

        return next()
          .then((result) => {
            finish();
            return result;
          })
          .catch((error) => {
            finish(error instanceof Error ? error : new Error(String(error)));
            throw error;
          });
      },
    );
  };
}

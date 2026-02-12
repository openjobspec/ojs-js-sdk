/**
 * Example: Middleware usage for both client (enqueue) and worker (execution).
 *
 * Demonstrates the composable middleware pattern with next().
 */

import { OJSClient, OJSWorker } from '@openjobspec/sdk';
import type { JobContext, NextFunction, Job, EnqueueMiddleware } from '@openjobspec/sdk';

// ---- Client-side enqueue middleware ----

const client = new OJSClient({ url: 'http://localhost:8080' });

// Inject trace context into every enqueued job
client.useEnqueue('trace-context', async (job, next) => {
  job.meta = {
    ...job.meta,
    trace_id: `trace_${crypto.randomUUID()}`,
    enqueued_by: 'my-service',
    enqueued_at_node: process.env.HOSTNAME ?? 'unknown',
  };
  return next(job);
});

// Log every enqueue operation
client.useEnqueue('logging', async (job, next) => {
  console.log(`[enqueue] Submitting ${job.type} to queue '${job.queue}'`);
  const result = await next(job);
  if (result) {
    console.log(`[enqueue] Enqueued ${job.type} as ${result.id}`);
  } else {
    console.log(`[enqueue] Job ${job.type} was dropped by middleware`);
  }
  return result;
});

// Enqueue with middleware active
const job = await client.enqueue('email.send', { to: 'user@example.com' });
console.log(`Job meta:`, job.meta);

// ---- Worker-side execution middleware ----

const worker = new OJSWorker({
  url: 'http://localhost:8080',
  queues: ['default'],
});

// Logging middleware (outermost — first added, wraps everything)
worker.use('logging', async (ctx: JobContext, next: NextFunction) => {
  console.log(
    `[worker] Starting ${ctx.job.type} (attempt ${ctx.attempt})`,
  );
  const start = Date.now();
  try {
    const result = await next();
    console.log(
      `[worker] Completed ${ctx.job.type} in ${Date.now() - start}ms`,
    );
    return result;
  } catch (error) {
    console.error(
      `[worker] Failed ${ctx.job.type} after ${Date.now() - start}ms:`,
      (error as Error).message,
    );
    throw error;
  }
});

// Metrics middleware
worker.use('metrics', async (ctx: JobContext, next: NextFunction) => {
  const start = Date.now();
  try {
    const result = await next();
    // Record success metric
    console.log(`[metrics] ojs.jobs.completed type=${ctx.job.type} duration=${Date.now() - start}ms`);
    return result;
  } catch (error) {
    // Record failure metric
    console.log(`[metrics] ojs.jobs.failed type=${ctx.job.type} duration=${Date.now() - start}ms`);
    throw error;
  }
});

// Trace context restoration middleware
worker.use('trace-restore', async (ctx: JobContext, next: NextFunction) => {
  const traceId = ctx.job.meta?.trace_id;
  if (traceId) {
    // In a real app, restore the distributed trace context here
    console.log(`[trace] Restoring trace context: ${traceId}`);
  }
  return next();
});

// Register a handler
worker.register('email.send', async (ctx) => {
  const { to } = ctx.job.args[0] as { to: string };
  console.log(`Sending email to ${to}`);
  return { messageId: `msg_${Date.now()}` };
});

await worker.start();

process.on('SIGTERM', () => worker.stop());

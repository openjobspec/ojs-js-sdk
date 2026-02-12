/**
 * Example: Worker processing jobs with OJSWorker.
 *
 * Demonstrates handler registration, starting, and graceful shutdown.
 */

import { OJSWorker } from '@openjobspec/sdk';

const worker = new OJSWorker({
  url: 'http://localhost:8080',
  queues: ['default', 'email'],
  concurrency: 10,
});

// Register handlers for different job types
worker.register('email.send', async (ctx) => {
  const { to, template } = ctx.job.args[0] as {
    to: string;
    template: string;
  };
  console.log(`Sending email to ${to} with template ${template}`);

  // Simulate email sending
  await new Promise((resolve) => setTimeout(resolve, 100));

  return { messageId: `msg_${Date.now()}`, delivered: true };
});

worker.register('report.generate', async (ctx) => {
  const { id, format } = ctx.job.args[0] as {
    id: number;
    format: string;
  };
  console.log(`Generating ${format} report for id=${id}`);

  // Check for cancellation during long work
  if (ctx.signal.aborted) {
    throw new Error('Job was cancelled');
  }

  await new Promise((resolve) => setTimeout(resolve, 500));

  return { path: `/reports/${id}.${format}`, size: 1024 };
});

// Subscribe to events
worker.events.on('job.completed', (event) => {
  console.log(`[event] Job completed: ${event.subject} in ${event.data.duration_ms}ms`);
});

worker.events.on('job.failed', (event) => {
  console.log(`[event] Job failed: ${event.subject} — ${event.data.error.message}`);
});

// Start processing
await worker.start();
console.log(`Worker ${worker.workerId} started on queues: ${['default', 'email'].join(', ')}`);

// Graceful shutdown on SIGTERM
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  await worker.stop();
  console.log(`Worker stopped. Completed ${worker.activeJobCount} remaining jobs.`);
  process.exit(0);
});

// Also handle SIGINT (Ctrl+C)
process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down...');
  await worker.stop();
  process.exit(0);
});

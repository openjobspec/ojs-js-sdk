/**
 * Example: Basic job enqueueing with OJSClient.
 *
 * Demonstrates simple enqueue, enqueue with options, and batch enqueue.
 */

import { OJSClient } from '@openjobspec/sdk';

const client = new OJSClient({ url: 'http://localhost:8080' });

// --- Simple enqueue ---
const job = await client.enqueue('email.send', { to: 'user@example.com' });
console.log(`Enqueued job: ${job.id} (state: ${job.state})`);

// --- Enqueue with options ---
const reportJob = await client.enqueue(
  'report.generate',
  { id: 42, format: 'pdf' },
  {
    queue: 'reports',
    delay: '5m',
    retry: { maxAttempts: 5, backoff: 'exponential' },
    unique: { key: ['id'], period: 'PT1H' },
    tags: ['analytics', 'monthly'],
  },
);
console.log(`Scheduled report job: ${reportJob.id}`);

// --- Batch enqueue ---
const jobs = await client.enqueueBatch([
  { type: 'email.send', args: { to: 'alice@example.com' } },
  { type: 'email.send', args: { to: 'bob@example.com' } },
  { type: 'email.send', args: { to: 'carol@example.com' } },
]);
console.log(`Enqueued ${jobs.length} jobs`);

// --- Get job details ---
const info = await client.getJob(job.id);
console.log(`Job ${info.id}: state=${info.state}, attempt=${info.attempt}`);

// --- Cancel a job ---
const cancelled = await client.cancelJob(reportJob.id);
console.log(`Cancelled: ${cancelled.state}`);

// --- Health check ---
const health = await client.health();
console.log(`Server: ${health.status} (${health.version})`);

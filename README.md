# @openjobspec/sdk

[![CI](https://github.com/openjobspec/ojs-js-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/openjobspec/ojs-js-sdk/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@openjobspec/sdk.svg)](https://www.npmjs.com/package/@openjobspec/sdk)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

The official [Open Job Spec (OJS)](https://openjobspec.org) SDK for JavaScript and TypeScript -- a vendor-neutral, language-agnostic specification for background job processing.

> **🚀 Try it now:** [Open in Playground](https://playground.openjobspec.org?lang=typescript) · [Run on CodeSandbox](https://codesandbox.io/p/sandbox/openjobspec-typescript-quickstart) · [Docker Quickstart](https://github.com/openjobspec/openjobspec/blob/main/docker-compose.quickstart.yml)

## Features

- **Zero dependencies**: Uses built-in `fetch` -- no third-party runtime deps
- **TypeScript-first**: Full type safety with `.d.ts` declarations and generic-typed enqueue
- **Dual format**: Ships both ESM and CommonJS builds
- **Client**: Enqueue jobs, batch operations, workflow management, queue control, cron scheduling
- **Worker**: Process jobs with configurable concurrency, middleware, and graceful shutdown
- **Workflows**: Chain (sequential), Group (parallel), Batch (parallel with callbacks)
- **Middleware**: Composable middleware chain with named operations (add, remove, insertBefore, insertAfter)
- **Structured errors**: Error class hierarchy with codes, retryable flags, and rate-limit metadata
- **Events**: CloudEvents-inspired typed event emitter for observability
- **Serverless**: First-class adapters for Cloudflare Workers and Vercel Edge Functions
- **OpenTelemetry**: Optional tracing and metrics middleware (peer dependency)
- **Testing**: Built-in fake mode and assertion helpers for unit tests
- **Cross-runtime**: Works in Node.js 18+, Deno, and Bun

## Architecture

### Client / Server / Worker Flow

```
┌──────────────┐         HTTP          ┌──────────────┐         HTTP          ┌──────────────┐
│              │  POST /ojs/v1/jobs     │              │  POST /workers/fetch  │              │
│  Application ├───────────────────────>│  OJS Server  │<─────────────────────┤    Worker    │
│  (Producer)  │   enqueue / batch      │  (Redis /    │   fetch / ack / nack  │  (Consumer)  │
│              │<───────────────────────┤   Postgres)  ├─────────────────────>│              │
│  OJSClient   │   201 Created {job}    │              │   {jobs} / heartbeat  │  OJSWorker   │
└──────────────┘                        └──────────────┘                       └──────────────┘
        │                                                                             │
        │  .enqueue()                                                   .register()   │
        │  .enqueueBatch()                                              .use()        │
        │  .workflow()                                                  .start()      │
        │  .cancelJob()                                                 .stop()       │
        │  .getJob()                                                                  │
        │  .queues.*                                                                  │
        │  .cron.*                                                                    │
        └─────────────────────────────────────────────────────────────────────────────┘
```

### Worker Lifecycle

```
             start()
  ┌──────────┐     ┌─────────┐  Server directive   ┌───────────┐
  │terminated├────>│ running ├────────────────────>│   quiet   │
  └──────────┘     └────┬────┘                      └─────┬─────┘
       ^                │                                  │
       │                │ stop() / ctx.Done()              │ stop() / server directive
       │                v                                  v
       │           ┌─────────────┐                    ┌─────────────┐
       └───────────┤  terminate  │<───────────────────┤  terminate  │
                   └─────────────┘  grace period      └─────────────┘
```

### Middleware Chain (Onion Model)

```
  Job Fetched ──> [ Middleware 1 before ] ──> [ Middleware 2 before ] ──> [ Handler ]
                  [ Middleware 1 after  ] <── [ Middleware 2 after  ] <── [ return  ]
  ACK / NACK <──
```

## Installation

```bash
npm install @openjobspec/sdk
```

```bash
# yarn
yarn add @openjobspec/sdk

# pnpm
pnpm add @openjobspec/sdk
```

## Quick Start

### Enqueue a Job

```ts
import { OJSClient } from '@openjobspec/sdk';

const client = new OJSClient({ url: 'http://localhost:8080' });

// Simple enqueue
const job = await client.enqueue('email.send', { to: 'user@example.com' });
console.log(`Enqueued: ${job.id}`);

// Enqueue with options
const delayedJob = await client.enqueue('report.generate', { id: 42 }, {
  queue: 'reports',
  delay: '5m',
  retry: { maxAttempts: 5, backoff: 'exponential' },
  unique: { key: ['id'], period: 'PT1H' },
});
```

### Process Jobs

```ts
import { OJSWorker } from '@openjobspec/sdk';

const worker = new OJSWorker({
  url: 'http://localhost:8080',
  queues: ['default', 'email'],
  concurrency: 10,
});

worker.register('email.send', async (ctx) => {
  const { to, subject } = ctx.job.args[0] as { to: string; subject: string };
  await sendEmail(to, subject);
  return { sent: true };
});

// Add middleware
worker.use(async (ctx, next) => {
  console.log(`Processing ${ctx.job.type}`);
  const start = Date.now();
  await next();
  console.log(`Done in ${Date.now() - start}ms`);
});

await worker.start();

// Graceful shutdown
process.on('SIGTERM', () => worker.stop());
```

### Typed Enqueue (Generics)

Use the generic parameter on `enqueue<T>()` for compile-time argument safety:

```ts
interface EmailPayload {
  to: string;
  subject: string;
  body: string;
}

const job = await client.enqueue<EmailPayload>('email.send', {
  to: 'user@example.com',
  subject: 'Welcome',
  body: 'Hello!',
});
```

## Client API Reference

### OJSClient

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `enqueue` | `enqueue<T>(type, args, options?)` | `Promise<Job>` | Enqueue a single job |
| `enqueueBatch` | `enqueueBatch(specs)` | `Promise<Job[]>` | Enqueue multiple jobs atomically |
| `getJob` | `getJob(jobId)` | `Promise<Job>` | Get job details by ID |
| `cancelJob` | `cancelJob(jobId)` | `Promise<Job>` | Cancel a job by ID |
| `workflow` | `workflow(definition)` | `Promise<WorkflowStatus>` | Create and start a workflow |
| `getWorkflow` | `getWorkflow(workflowId)` | `Promise<WorkflowStatus>` | Get workflow status |
| `cancelWorkflow` | `cancelWorkflow(workflowId)` | `Promise<void>` | Cancel a workflow |
| `health` | `health()` | `Promise<{status, version, backend?}>` | Check server health |
| `manifest` | `manifest()` | `Promise<Record<string, unknown>>` | Fetch conformance manifest |
| `useEnqueue` | `useEnqueue(name, fn)` | `this` | Add enqueue middleware |

### Sub-Modules on OJSClient

| Property | Type | Description |
|----------|------|-------------|
| `client.queues` | `QueueOperations` | Queue management (list, stats, pause, resume, dead letter) |
| `client.cron` | `CronOperations` | Cron job management (list, register, unregister) |
| `client.schemas` | `SchemaOperations` | Schema management (list, register, delete) |
| `client.events` | `OJSEventEmitter` | Client-side event emitter |
| `client.middleware` | `MiddlewareChain` | Fine-grained enqueue middleware chain access |

### Queue Operations

```ts
// List all queues
const queues = await client.queues.list();

// Get queue statistics
const stats = await client.queues.stats('email');

// Pause / resume a queue
await client.queues.pause('email');
await client.queues.resume('email');

// Dead letter management
const deadJobs = await client.queues.listDeadLetter();
await client.queues.retryDeadLetter(deadJobs[0].id);
await client.queues.discardDeadLetter(deadJobs[1].id);
```

### Cron Operations

```ts
// Register a cron job
await client.cron.register({
  name: 'daily-report',
  cron: '0 9 * * *',
  timezone: 'America/New_York',
  type: 'report.generate',
  args: { format: 'pdf' },
  options: { queue: 'reports' },
});

// List cron jobs (with pagination)
const { cron_jobs, pagination } = await client.cron.list({ page: 1, per_page: 20 });

// Unregister a cron job
await client.cron.unregister('daily-report');
```

### Batch Enqueue

```ts
const jobs = await client.enqueueBatch([
  { type: 'email.send', args: { to: 'a@example.com' } },
  { type: 'email.send', args: { to: 'b@example.com' } },
  { type: 'sms.send', args: { phone: '+15551234567' }, options: { queue: 'sms' } },
]);
```

## Worker API Reference

### OJSWorker

| Method / Property | Signature | Returns | Description |
|-------------------|-----------|---------|-------------|
| `register` | `register(type, handler)` | `this` | Register a handler for a job type |
| `use` | `use(fn)` / `use(name, fn)` | `this` | Add execution middleware |
| `start` | `start()` | `Promise<void>` | Start polling for jobs |
| `stop` | `stop()` | `Promise<void>` | Graceful shutdown |
| `currentState` | getter | `WorkerState` | Current lifecycle state (`running` / `quiet` / `terminate` / `terminated`) |
| `activeJobCount` | getter | `number` | Number of in-flight jobs |
| `workerId` | readonly | `string` | Unique worker instance ID |
| `events` | readonly | `OJSEventEmitter` | Worker-side event emitter |
| `middleware` | getter | `MiddlewareChain` | Fine-grained execution middleware chain access |

### JobContext

The context object passed to every handler and middleware:

| Property | Type | Description |
|----------|------|-------------|
| `job` | `Job` | The full job envelope |
| `attempt` | `number` | Current attempt number (1-indexed) |
| `queue` | `string` | The queue the job was fetched from |
| `workerId` | `string` | The worker ID that claimed this job |
| `workflowId` | `string?` | Workflow ID if part of a workflow |
| `parentResults` | `Record<string, JsonValue>?` | Upstream workflow step results |
| `metadata` | `Map<string, unknown>` | Mutable metadata store scoped to this execution |
| `signal` | `AbortSignal` | Signal for cooperative cancellation / timeout |

## Workflows

Three workflow primitives are available, matching the OJS Workflow Specification:

### Chain (Sequential Execution)

Jobs execute one after another. The result of step N feeds step N+1.

```ts
import { OJSClient, chain } from '@openjobspec/sdk';

const client = new OJSClient({ url: 'http://localhost:8080' });

const workflow = await client.workflow(
  chain(
    { type: 'data.fetch', args: { url: 'https://api.example.com/data' } },
    { type: 'data.transform', args: { format: 'csv' } },
    { type: 'data.load', args: { dest: 'warehouse' } },
  )
);

console.log(`Workflow ${workflow.id} state: ${workflow.state}`);
```

### Group (Parallel Execution)

All jobs execute concurrently and independently.

```ts
import { group } from '@openjobspec/sdk';

const workflow = await client.workflow(
  group(
    { type: 'export.csv', args: { reportId: 'rpt_456' } },
    { type: 'export.pdf', args: { reportId: 'rpt_456' } },
    { type: 'export.xlsx', args: { reportId: 'rpt_456' } },
  )
);
```

### Batch (Parallel with Callbacks)

Like a group, but fires callback jobs based on the collective outcome.

```ts
import { batch } from '@openjobspec/sdk';

const workflow = await client.workflow(
  batch(
    [
      { type: 'email.send', args: { to: 'user1@example.com' } },
      { type: 'email.send', args: { to: 'user2@example.com' } },
      { type: 'email.send', args: { to: 'user3@example.com' } },
    ],
    {
      on_complete: { type: 'batch.report', args: { notify: 'admin' } },
      on_success: { type: 'batch.celebrate', args: {} },
      on_failure: { type: 'batch.alert', args: { channel: '#ops' } },
    },
  )
);
```

### Nested Workflows

Chain, group, and batch can be nested:

```ts
const workflow = await client.workflow(
  chain(
    { type: 'data.fetch', args: { source: 'api' } },
    group(
      { type: 'transform.csv', args: {} },
      { type: 'transform.json', args: {} },
    ),
    { type: 'data.merge', args: {} },
  )
);
```

### Workflow Management

```ts
// Check workflow status
const status = await client.getWorkflow(workflow.id);
console.log(`${status.metadata.completed_count}/${status.metadata.job_count} jobs done`);

// Cancel a running workflow
await client.cancelWorkflow(workflow.id);
```

## Middleware

The SDK uses an onion-model middleware chain for both worker execution and client enqueue operations. Each middleware wraps the next using the `(ctx, next) => ...` pattern.

### Writing Custom Middleware

```ts
// Execution middleware (worker-side)
worker.use(async (ctx, next) => {
  const start = Date.now();
  console.log(`[${ctx.job.type}] Starting attempt ${ctx.attempt}`);

  try {
    await next();
    console.log(`[${ctx.job.type}] Completed in ${Date.now() - start}ms`);
  } catch (error) {
    console.error(`[${ctx.job.type}] Failed after ${Date.now() - start}ms`, error);
    throw error;  // Re-throw to trigger NACK
  }
});

// Enqueue middleware (client-side)
client.useEnqueue('add-trace-id', async (job, next) => {
  job.meta = { ...job.meta, traceId: crypto.randomUUID() };
  return next(job);
});
```

### Named Middleware Operations

All middleware entries are named, enabling fine-grained chain manipulation:

```ts
// Add named middleware
worker.use('logging', async (ctx, next) => {
  console.log(`Processing ${ctx.job.type}`);
  await next();
});

worker.use('metrics', async (ctx, next) => {
  const start = performance.now();
  await next();
  recordDuration(ctx.job.type, performance.now() - start);
});

// Insert relative to existing middleware
worker.middleware.insertBefore('metrics', 'auth', async (ctx, next) => {
  verifyJobOrigin(ctx.job);
  await next();
});

worker.middleware.insertAfter('logging', 'tracing', async (ctx, next) => {
  const span = tracer.startSpan(`process ${ctx.job.type}`);
  try {
    await next();
  } finally {
    span.end();
  }
});

// Remove middleware by name
worker.middleware.remove('logging');

// Prepend to the beginning of the chain
worker.middleware.prepend('error-boundary', async (ctx, next) => {
  try { await next(); } catch (e) { reportToSentry(e); throw e; }
});

// Check if middleware exists
if (worker.middleware.has('metrics')) { /* ... */ }
```

### MiddlewareChain API

| Method | Signature | Description |
|--------|-----------|-------------|
| `add` | `add(name, fn)` | Append middleware to the end |
| `prepend` | `prepend(name, fn)` | Insert at the beginning |
| `insertBefore` | `insertBefore(existingName, name, fn)` | Insert before a named middleware |
| `insertAfter` | `insertAfter(existingName, name, fn)` | Insert after a named middleware |
| `remove` | `remove(name)` | Remove middleware by name |
| `has` | `has(name)` | Check if a named middleware exists |
| `entries` | `entries()` | Get the ordered middleware list |
| `clear` | `clear()` | Remove all middleware |
| `length` | getter | Number of middleware entries |

## Error Handling

The SDK provides a structured error hierarchy. All errors extend `OJSError` and include a machine-readable `code`, a `retryable` flag, and optional `details`.

### Error Class Hierarchy

| Class | Code | HTTP Status | Retryable | Description |
|-------|------|-------------|-----------|-------------|
| `OJSError` | (varies) | -- | -- | Base class for all OJS errors |
| `OJSValidationError` | `invalid_request` | 400 | No | Request validation failed |
| `OJSNotFoundError` | `not_found` | 404 | No | Job or resource not found |
| `OJSDuplicateError` | `duplicate` | 409 | No | Unique constraint conflict |
| `OJSConflictError` | `conflict` | 409 | No | State conflict |
| `OJSRateLimitError` | `rate_limited` | 429 | Yes | Rate limit exceeded |
| `OJSServerError` | `server_error` | 5xx | Yes | Internal server error |
| `OJSConnectionError` | `connection_error` | -- | Yes | Network / connection failure |
| `OJSTimeoutError` | `timeout` | -- | Yes | Job handler exceeded timeout |

### Error Handling Example

```ts
import {
  OJSError,
  OJSValidationError,
  OJSDuplicateError,
  OJSNotFoundError,
  OJSRateLimitError,
  OJSConnectionError,
} from '@openjobspec/sdk';

try {
  const job = await client.enqueue('email.send', { to: 'user@example.com' });
} catch (error) {
  if (error instanceof OJSDuplicateError) {
    console.log(`Job already exists: ${error.existingJobId}`);
  } else if (error instanceof OJSNotFoundError) {
    console.log('Resource not found');
  } else if (error instanceof OJSRateLimitError) {
    console.log(`Rate limited. Retry after ${error.retryAfter}s`);
    console.log(`Remaining: ${error.rateLimit?.remaining}/${error.rateLimit?.limit}`);
  } else if (error instanceof OJSValidationError) {
    console.log(`Validation failed: ${error.message}`);
    console.log('Details:', error.details);
  } else if (error instanceof OJSConnectionError) {
    console.log('Server unreachable, will retry...');
  } else if (error instanceof OJSError) {
    console.log(`OJS error [${error.code}]: ${error.message}`);
    console.log(`Retryable: ${error.retryable}`);
    console.log(`Request ID: ${error.requestId}`);
  }
}
```

### Non-Retryable Handler Errors

By default, handler errors are retryable. When a handler encounters a permanent failure, it should communicate this through the error's structure so the server can discard the job rather than retrying it:

```ts
worker.register('email.send', async (ctx) => {
  const { to } = ctx.job.args[0] as { to: string };

  if (!isValidEmail(to)) {
    // Throw a structured error -- the worker will NACK with retryable: false
    const err = new Error(`Invalid email address: ${to}`);
    (err as any).retryable = false;
    throw err;
  }

  await sendEmail(to);
});
```

## Events

Both `OJSClient` and `OJSWorker` expose a typed `OJSEventEmitter` following the CloudEvents-inspired OJS event vocabulary.

### Subscribing to Events

```ts
// Type-safe event subscription
const unsubscribe = worker.events.on('job.completed', (event) => {
  console.log(`Job ${event.subject} completed in ${event.data.duration_ms}ms`);
  console.log(`Queue: ${event.data.queue}, Attempt: ${event.data.attempt}`);
});

worker.events.on('job.failed', (event) => {
  console.error(`Job ${event.subject} failed: ${event.data.error.message}`);
});

worker.events.on('worker.started', (event) => {
  console.log(`Worker ${event.data.worker_id} started on queues: ${event.data.queues}`);
});

worker.events.on('worker.stopped', (event) => {
  console.log(`Worker stopped. Processed ${event.data.jobs_completed} jobs in ${event.data.uptime_ms}ms`);
});

// Subscribe to all events
worker.events.onAny((event) => {
  metricsCollector.record(event.type, event.data);
});

// Unsubscribe when done
unsubscribe();

// Remove all listeners
worker.events.removeAllListeners();
```

### Event Types

| Event Type | Data Fields | Description |
|------------|-------------|-------------|
| `job.enqueued` | `job_type`, `queue`, `priority?`, `scheduled_at?` | A job was enqueued |
| `job.started` | `job_type`, `queue`, `worker_id`, `attempt` | A job started processing |
| `job.completed` | `job_type`, `queue`, `duration_ms`, `attempt`, `result?` | A job completed successfully |
| `job.failed` | `job_type`, `queue`, `attempt`, `error` | A job handler failed |
| `job.retrying` | `job_type`, `queue`, `attempt`, `max_attempts`, `next_retry_at` | A job is scheduled for retry |
| `job.cancelled` | -- | A job was cancelled |
| `job.discarded` | -- | A job was discarded (exhausted retries) |
| `worker.started` | `worker_id`, `queues`, `concurrency` | Worker started polling |
| `worker.stopped` | `worker_id`, `reason`, `jobs_completed`, `uptime_ms` | Worker stopped |

## Testing

The SDK includes a built-in testing module that intercepts enqueue calls and stores jobs in memory, so you can write unit tests without a running OJS server.

### Fake Mode

```ts
import { OJSClient, testing } from '@openjobspec/sdk';

// Activate before each test
beforeEach(() => testing.fake());
afterEach(() => testing.restore());

test('signup enqueues a welcome email', async () => {
  const client = new OJSClient({ url: 'http://localhost:8080' });

  // This enqueue goes to the in-memory store, not the network
  await client.enqueue('email.send', { to: 'newuser@example.com', template: 'welcome' });

  // Assert the job was enqueued
  testing.assertEnqueued('email.send', {
    args: [{ to: 'newuser@example.com', template: 'welcome' }],
  });

  // Assert specific count
  testing.assertEnqueued('email.send', { count: 1 });

  // Assert no unexpected jobs
  testing.refuteEnqueued('sms.send');
});
```

### Inline Mode

Inline mode executes handlers synchronously at enqueue time, useful for integration-style tests:

```ts
beforeEach(() => {
  testing.inline();
  testing.registerHandler('email.send', async (job) => {
    // Handler runs immediately when enqueued
    console.log(`Would send email to ${job.args[0]}`);
  });
});

test('signup flow completes end-to-end', async () => {
  const client = new OJSClient({ url: 'http://localhost:8080' });
  await client.enqueue('email.send', { to: 'user@example.com' });

  testing.assertPerformed('email.send');
  testing.assertCompleted('email.send');
});
```

### Drain (Process Pending Jobs)

In fake mode, use `drain()` to process all pending jobs with registered handlers:

```ts
testing.fake();
testing.registerHandler('email.send', async (job) => {
  // process job
});

const client = new OJSClient({ url: 'http://localhost:8080' });
await client.enqueue('email.send', { to: 'user@example.com' });

// Process all pending jobs
await testing.drain();
testing.assertCompleted('email.send');

// Or limit how many jobs to drain
await testing.drain({ maxJobs: 5 });
```

### Testing API

| Function | Description |
|----------|-------------|
| `testing.fake()` | Activate fake mode (jobs stored in memory) |
| `testing.inline()` | Activate inline mode (handlers run at enqueue time) |
| `testing.restore()` | Restore real mode and clear all state |
| `testing.registerHandler(type, fn)` | Register handler for inline mode |
| `testing.assertEnqueued(type, opts?)` | Assert job(s) were enqueued |
| `testing.refuteEnqueued(type, opts?)` | Assert no jobs of type were enqueued |
| `testing.assertPerformed(type, opts?)` | Assert job was performed (inline mode) |
| `testing.assertCompleted(type)` | Assert job completed successfully |
| `testing.assertFailed(type)` | Assert job failed |
| `testing.allEnqueued(filter?)` | Get all enqueued jobs |
| `testing.drain(opts?)` | Process all pending jobs using registered handlers |
| `testing.clearAll()` | Clear all enqueued and performed jobs |

## OpenTelemetry

The SDK provides optional OpenTelemetry middleware for distributed tracing and metrics. Install `@opentelemetry/api` as a peer dependency:

```bash
npm install @opentelemetry/api
```

```ts
import { OJSWorker, openTelemetryMiddleware } from '@openjobspec/sdk';
import { trace, metrics } from '@opentelemetry/api';

const worker = new OJSWorker({
  url: 'http://localhost:8080',
  queues: ['default'],
});

worker.use('otel', openTelemetryMiddleware({
  tracerProvider: trace.getTracerProvider(),
  meterProvider: metrics.getMeterProvider(),
}));

await worker.start();
```

### What Gets Instrumented

**Traces** -- One `CONSUMER` span per job with attributes:

| Attribute | Value |
|-----------|-------|
| `messaging.system` | `ojs` |
| `messaging.operation` | `process` |
| `ojs.job.type` | Job type (e.g., `email.send`) |
| `ojs.job.id` | UUIDv7 job ID |
| `ojs.job.queue` | Queue name |
| `ojs.job.attempt` | Attempt number |

**Metrics** -- Three instruments:

| Metric | Type | Description |
|--------|------|-------------|
| `ojs.job.completed` | Counter | Jobs completed successfully |
| `ojs.job.failed` | Counter | Jobs that failed |
| `ojs.job.duration` | Histogram | Execution duration in seconds |

All metrics are tagged with `ojs.job.type` and `ojs.job.queue`.

## Serverless

The SDK ships with first-class adapters for serverless platforms that process jobs via HTTP webhooks from the OJS server.

### Cloudflare Workers

```ts
import { createWorkerHandler } from '@openjobspec/sdk/serverless/cloudflare';

const handler = createWorkerHandler({
  url: 'https://ojs.example.com',
  apiKey: 'your-api-key',
});

handler.register('email.send', async (ctx) => {
  const { to, subject } = ctx.job.args[0] as { to: string; subject: string };
  await sendEmail(to, subject);
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handler.handleRequest(request);
  },
};
```

### Vercel Edge Functions

```ts
// app/api/ojs/route.ts (Next.js App Router)
import { createEdgeHandler } from '@openjobspec/sdk/serverless/vercel';

const handler = createEdgeHandler({
  url: process.env.OJS_URL!,
  apiKey: process.env.OJS_API_KEY,
});

handler.register('notification.send', async (ctx) => {
  const payload = ctx.job.args[0] as { userId: string; message: string };
  await sendNotification(payload.userId, payload.message);
});

export const POST = handler.handleRequest;
export const runtime = 'edge';
```

Both adapters automatically ACK on success and NACK on failure by calling back to the OJS server.

## Configuration Reference

### OJSClientConfig

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | `string` | -- (required) | Base URL of the OJS server |
| `auth` | `string?` | -- | Authorization header value (e.g., `'Bearer <token>'`) |
| `headers` | `Record<string, string>?` | -- | Custom headers for every request |
| `timeout` | `number?` | -- | Default request timeout in milliseconds |
| `transport` | `Transport?` | `HttpTransport` | Custom transport implementation (for testing) |

### EnqueueOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `queue` | `string?` | `'default'` | Target queue |
| `priority` | `number?` | -- | Job priority |
| `timeout` | `number?` | -- | Execution timeout in milliseconds |
| `delay` | `string?` | -- | Delay before execution (`'5m'`, `'30s'`, `'1h'`, or ISO 8601) |
| `expiresAt` | `string?` | -- | Expiration timestamp (RFC 3339) |
| `retry` | `RetryOptions?` | -- | Custom retry policy |
| `unique` | `UniqueOptions?` | -- | Deduplication policy |
| `tags` | `string[]?` | -- | Tags for filtering |
| `meta` | `Record<string, JsonValue>?` | -- | Metadata key-value pairs |
| `schema` | `string?` | -- | JSON Schema name for args validation |
| `visibilityTimeout` | `number?` | -- | Visibility timeout in milliseconds |

### RetryOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxAttempts` | `number?` | -- | Maximum number of retry attempts |
| `backoff` | `'none' \| 'linear' \| 'exponential' \| 'polynomial'?` | -- | Backoff strategy |
| `backoffCoefficient` | `number?` | -- | Multiplier for backoff intervals |
| `initialInterval` | `string?` | -- | Initial retry interval (ISO 8601 duration) |
| `maxInterval` | `string?` | -- | Maximum retry interval (ISO 8601 duration) |
| `jitter` | `boolean?` | -- | Add random jitter to backoff |
| `nonRetryableErrors` | `string[]?` | -- | Error codes that should not be retried |
| `onExhaustion` | `'discard' \| 'dead_letter'?` | -- | Action when retries are exhausted |

### UniqueOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `key` | `string[]?` | -- | Fields from args to use as uniqueness key |
| `period` | `string?` | -- | Uniqueness window (ISO 8601 duration) |
| `onConflict` | `'reject' \| 'replace' \| 'ignore'?` | -- | Conflict resolution strategy |
| `states` | `JobState[]?` | -- | Job states to check for duplicates |

### OJSWorkerConfig

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | `string` | -- (required) | Base URL of the OJS server |
| `queues` | `string[]?` | `['default']` | Queues to poll (priority order) |
| `concurrency` | `number?` | `10` | Maximum parallel jobs |
| `pollInterval` | `number?` | `1000` | Poll interval in ms when idle |
| `heartbeatInterval` | `number?` | `5000` | Heartbeat interval in ms |
| `shutdownTimeout` | `number?` | `25000` | Grace period for shutdown in ms |
| `visibilityTimeout` | `number?` | `30000` | Visibility timeout per fetch in ms |
| `auth` | `string?` | -- | Authorization header value |
| `headers` | `Record<string, string>?` | -- | Custom headers |
| `transport` | `Transport?` | `HttpTransport` | Custom transport (for testing) |
| `labels` | `string[]?` | `[]` | Worker labels for filtering and grouping |

## OJS Spec Conformance

This SDK implements the [Open Job Spec v1.0](https://openjobspec.org) specification:

- **Layer 1 (Core)**: Job envelope, 8-state lifecycle, retry policies, unique jobs, workflows, middleware chains
- **Layer 2 (Wire Format)**: JSON encoding with `application/openjobspec+json` content type
- **Layer 3 (HTTP Binding)**: Full HTTP REST protocol binding (PUSH, FETCH, ACK, NACK, BEAT, CANCEL, INFO)
- **Worker Protocol**: Four-state lifecycle (`running` / `quiet` / `terminate` / `terminated`), heartbeat, server-directed state changes, graceful shutdown

## Contributing

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Watch mode
npm run test:watch

# Type check
npm run lint

# Generate docs
npm run docs
```

Please read [CONTRIBUTING.md](CONTRIBUTING.md) for details on the contribution process and coding conventions.

## License

Apache-2.0 -- see [LICENSE](LICENSE).



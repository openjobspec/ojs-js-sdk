# @openjobspec/sdk

The official **Open Job Spec** SDK for JavaScript and TypeScript.

- Zero dependencies (uses built-in `fetch`)
- TypeScript-first with full type safety
- Ships `.d.ts` declaration files
- Works in Node.js 18+, Deno, and Bun

## Install

```bash
npm install @openjobspec/sdk
```

## Quick Start

### Client (Producer)

```ts
import { OJSClient } from '@openjobspec/sdk';

const client = new OJSClient({ url: 'http://localhost:8080' });

// Simple enqueue
const job = await client.enqueue('email.send', { to: 'user@example.com' });

// Enqueue with options
const job = await client.enqueue('report.generate', { id: 42 }, {
  queue: 'reports',
  delay: '5m',
  retry: { maxAttempts: 5, backoff: 'exponential' },
  unique: { key: ['id'], period: 'PT1H' },
});

// Batch enqueue
const jobs = await client.enqueueBatch([
  { type: 'email.send', args: { to: 'a@example.com' } },
  { type: 'email.send', args: { to: 'b@example.com' } },
]);
```

### Worker (Consumer)

```ts
import { OJSWorker } from '@openjobspec/sdk';

const worker = new OJSWorker({
  url: 'http://localhost:8080',
  queues: ['default', 'email'],
  concurrency: 10,
});

worker.register('email.send', async (ctx) => {
  const { to, template } = ctx.job.args[0] as { to: string; template: string };
  await sendEmail(to, template);
  return { messageId: '...' };
});

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

### Workflows

```ts
import { OJSClient, chain, group, batch } from '@openjobspec/sdk';

const client = new OJSClient({ url: 'http://localhost:8080' });

// Sequential pipeline
await client.workflow(
  chain(
    { type: 'data.fetch', args: { url: '...' } },
    { type: 'data.transform', args: { format: 'csv' } },
    { type: 'data.load', args: { dest: 'warehouse' } },
  )
);

// Parallel execution
await client.workflow(
  group(
    { type: 'export.csv', args: { reportId: 'rpt_456' } },
    { type: 'export.pdf', args: { reportId: 'rpt_456' } },
  )
);

// Parallel with callbacks
await client.workflow(
  batch(
    [
      { type: 'email.send', args: ['user1@example.com'] },
      { type: 'email.send', args: ['user2@example.com'] },
    ],
    {
      on_complete: { type: 'batch.report', args: [] },
      on_failure: { type: 'batch.alert', args: [] },
    },
  )
);
```

## API Reference

### OJSClient

| Method | Description |
|--------|-------------|
| `enqueue(type, args, options?)` | Enqueue a single job |
| `enqueueBatch(specs)` | Enqueue multiple jobs atomically |
| `getJob(jobId)` | Get job details by ID |
| `cancelJob(jobId)` | Cancel a job |
| `workflow(definition)` | Create and start a workflow |
| `health()` | Check server health |
| `useEnqueue(name, fn)` | Add enqueue middleware |

### OJSWorker

| Method | Description |
|--------|-------------|
| `register(type, handler)` | Register a handler for a job type |
| `use(fn)` / `use(name, fn)` | Add execution middleware |
| `start()` | Start polling for jobs |
| `stop()` | Graceful shutdown |

### Workflow Builders

| Function | Description |
|----------|-------------|
| `chain(...steps)` | Sequential execution |
| `group(...jobs)` | Parallel execution |
| `batch(jobs, callbacks)` | Parallel with callbacks |

## Spec Conformance

This SDK implements the [Open Job Spec v1.0.0-rc.1](https://openjobspec.org) HTTP binding:

- **Layer 1**: Core job envelope, lifecycle states, operations
- **Layer 2**: JSON wire format with `application/openjobspec+json`
- **Layer 3**: HTTP/REST protocol binding (`/ojs/v1/*`)

## License

Apache-2.0

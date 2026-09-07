# @openjobspec/sdk
[![Stability: stable](https://img.shields.io/badge/stability-stable-brightgreen.svg)](https://openjobspec.org/governance/stability/)

[![CI](https://github.com/openjobspec/ojs-js-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/openjobspec/ojs-js-sdk/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@openjobspec/sdk.svg)](https://www.npmjs.com/package/@openjobspec/sdk)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

The official [Open Job Spec (OJS)](https://openjobspec.org) SDK for JavaScript and TypeScript -- a vendor-neutral, language-agnostic specification for background job processing.

> **🚀 Try it now:** [Open in Playground](https://play.openjobspec.org?lang=typescript) · [Run on CodeSandbox](https://codesandbox.io/p/sandbox/openjobspec-typescript-quickstart) · [Docker Quickstart](https://github.com/openjobspec/examples/tree/main/full-stack-demo)

## Features

- **Minimal dependencies**: Uses built-in `fetch` plus one small audited runtime dependency (`@noble/hashes`) solely for cross-runtime cryptographic random bytes on Node 18 and browsers
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
if (job === null) {
  console.log('Job was dropped by enqueue middleware');
} else {
  console.log(`Enqueued: ${job.id}`);
}

// Enqueue with options
const delayedJob = await client.enqueue('report.generate', { id: 42 }, {
  queue: 'reports',
  delay: '5m',
  retry: { maxAttempts: 5, backoff: 'exponential' },
  unique: {
    keys: ['type', 'args'],
    argsKeys: ['id'],
    period: 'PT1H',
  },
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

### Durable Jobs

Use `registerDurable()` when a handler records deterministic time, randomness,
or external calls across retries:

```ts
worker.registerDurable('billing.capture', async (ctx, durable) => {
  const receipt = await durable.sideEffect('capture-payment', () =>
    capturePayment(ctx.job.args[0]),
  );

  await durable.checkpoint(1, { receipt });
  await durable.complete();
  return receipt;
});
```

Checkpoint loading is fail-closed. A true `404 Not Found` means no canonical
checkpoint exists; the SDK then checks the read-only legacy resume endpoint and
migrates any recovered replay log to the canonical resource. If that optional
legacy route returns `404 Not Found` or `405 Method Not Allowed`, the SDK treats
it as unsupported/no checkpoint and proceeds with the first execution. A
successful legacy response starts fresh only when it explicitly declares
`has_checkpoint: false`. If it declares `has_checkpoint: true`, checkpoint data
and `metadata._replay_log` are mandatory; either one missing is corruption and
raises `OJSCheckpointLoadError` rather than silently re-running side effects.
Connection, authentication, server, malformed-response, or decode failures are
propagated as `OJSCheckpointLoadError`, so the worker NACKs the job without
invoking the handler or any side effect. A transient canonical failure never
triggers the legacy fallback or a fresh execution.

During replay, `now()`, `random()`, and `sideEffect(key)` must match the next
saved entry exactly. An operation-order, entry-type, or side-effect-key mismatch
throws `ReplayIntegrityError` without consuming the entry or executing live
code. Record mode begins only after every saved replay entry has been consumed.

For gRPC checkpoint saves, state is normalized with JSON semantics before it is
encoded as `google.protobuf.Struct`: `Date` values use their ISO `toJSON()`
form, undefined object fields are omitted, and undefined/sparse array entries
become `null`. Cycles, non-finite numbers, `BigInt`, functions, and symbols are
rejected before the RPC. JSON keys such as `__proto__`, `constructor`, and
`prototype` remain ordinary data fields through protobuf serialization.

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

if (job !== null) {
  console.log(`Enqueued ${job.id}`);
}
```

`enqueue()` returns `null` when enqueue middleware intentionally drops a job.
Callers that install drop-capable middleware should handle that outcome
explicitly.

#### Migrating to 0.5

Version 0.5 makes the middleware drop outcome part of the public type:
`OJSClient.enqueue()` changed from `Promise<Job>` to `Promise<Job | null>`.
Existing code that immediately reads `job.id` must first handle `null`:

```ts
const job = await client.enqueue('email.send', [{ to: 'user@example.com' }]);
if (job === null) {
  // The enqueue middleware intentionally stopped delivery.
  return;
}
console.log(job.id);
```

Queue names follow the canonical job-options schema: at most 128 characters,
starting with a lowercase letter or digit, followed only by lowercase letters,
digits, hyphens, or dots (`^[a-z0-9][a-z0-9\-.]*$`). Consecutive and trailing
separators are valid, including `queue--name`, `queue.`, and `queue-`.

Enqueue arguments and metadata are cloned with JSON semantics before
middleware runs: `Date`, `URL`, and custom `toJSON()` values are normalized;
`undefined`, functions, and symbols are omitted from objects (or become `null`
in arrays); and caller objects are not mutated. BigInt, non-finite numbers,
cycles, and metadata whose root does not serialize to an object fail with
`OJSValidationError` before transport.

## Client API Reference

### Package entry points

Every documented entry point supports ESM, CommonJS, and TypeScript:

`@openjobspec/sdk`, `/middleware`, `/ml`, `/encryption`, `/otel`,
`/subscribe`, `/serverless`, `/serverless/cloudflare`,
`/serverless/vercel`, `/serverless/lambda`, `/agent`, `/attest`, and
`/recorder`.

### OJSClient

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `enqueue` | `enqueue<T>(type, args, options?)` | `Promise<Job \| null>` | Enqueue a single job; `null` means middleware dropped it |
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

`expiresAt` / wire `expires_at` is intentionally rejected for cron
registrations. Cron jobs are materialized at a future schedule time; converting
an absolute deadline to the gRPC proto's relative TTL during registration would
shift the requested expiration. Use a relative execution timeout or calculate
expiry inside the materialized job instead. Immediate `enqueue()` remains able
to convert an absolute `expiresAt` to a TTL safely because materialization
happens immediately.

Over the gRPC transport, a cron definition's `options` and envelope `meta`
are converted into `RegisterCronRequest.options` (a proto `EnqueueOptions`,
preserving explicit zero fields such as `priority: 0`), and `cron.list()`
maps each `CronEntry`'s `args`, `options`, `next_run_at`, and `last_run_at`
back out.

`cron.list()`'s `page`/`per_page` query parameters are handled entirely
client-side by `GrpcTransport`: service.proto's `ListCronRequest` carries no
pagination at all, so every registered entry is fetched in one `ListCron`
call, sorted by `name` for a stable/deterministic order, and sliced to the
requested page (default `page: 1`, `per_page: 25`). A present but
non-positive-integer `page`/`per_page` is rejected with a non-retryable
validation error rather than silently coerced.

`cron.register()`'s response is likewise reconstructed on the client side:
`RegisterCronResponse` (service.proto) carries only the registered `name`
and the *authoritative* `next_run_at` — it echoes back neither
`cron`/`timezone`/`type`/`args`/`options` nor a creation timestamp.
`CronJobInfo.status` and `CronJobInfo.created_at` are optional because the
current gRPC cron messages omit both fields (HTTP responses still provide
them). `GrpcTransport` fills in the rest **solely from the definition it
just submitted** plus `RegisterCronResponse`'s own authoritative
`name`/`next_run_at` and a locally captured registration timestamp — it
issues exactly **one** RPC (`RegisterCron`) and never performs a follow-up
`ListCron` lookup. (An earlier version did perform such a lookup to
"refine" the response with the server's own stored entry; that was removed
because it was racy — nothing guaranteed a just-registered or
concurrently-upserted entry was visible yet, or observed consistently, by
the time the lookup ran — and O(n) in the total number of registered
schedules just to find one entry by name, and could silently mix two
different response revisions together.) gRPC registration and list entries
report `status: 'active'` because service.proto has no paused/disabled cron
state. Registration also returns `created_at` as this SDK's timestamp
captured immediately before it sends the `RegisterCron` RPC, **not** a
server-authoritative creation time — service.proto has no field for it at
all. Subsequent gRPC list responses omit `created_at` rather than
fabricating it. Request `options` and top-level `meta` are preserved
exactly as submitted in the returned cron resource.

Unique-job policies are validated consistently for SDK-generated requests and
direct HTTP/gRPC transport calls: dimensions, selectors, and states must be
unique; `args_keys` may be empty but every present entry must be non-empty;
selecting `meta` requires non-empty `meta_keys`; and `period`, `states`, and
`on_conflict` follow the canonical schema. Calendar year/month durations are
valid HTTP schema values but cannot be represented exactly by protobuf
`Duration`; gRPC callers should use weeks, days, hours, minutes, or seconds.

### Batch Enqueue

```ts
const jobs = await client.enqueueBatch([
  { type: 'email.send', args: { to: 'a@example.com' } },
  { type: 'email.send', args: { to: 'b@example.com' } },
  { type: 'sms.send', args: { phone: '+15551234567' }, options: { queue: 'sms' } },
]);
```

For direct `GrpcTransport.request()` callers, input `default_options` (or
`defaultOptions`) is validated and expanded into every job client-side. The
protobuf `EnqueueBatchRequest.default_options` field is then omitted. This
preserves explicit per-job proto3 default values such as `priority: 0`,
`retry.jitter: false`, and empty arrays instead of allowing a backend merge to
mistake them for absent values and reapply the batch default.

`enqueueBatch()` runs every job's enqueue-middleware chain to a terminal
decision (send / drop / error) **before** issuing exactly **one** atomic
`POST /jobs/batch` request. Each job's batch terminal represents that single
atomic transport slot and is reached at most once. If a retry-style enqueue
middleware catches a transport or validation rejection and calls `next()`
again, the terminal immediately rejects with the **original** error rather
than issuing a second request — so the whole batch is never transmitted more
than once and the call never hangs.

> **No whole-batch transport retry.** Middleware may retry its own
> *pre-terminal* handler work, but it cannot retry an already-attempted atomic
> batch send. A transport failure rejects every terminal deterministically
> with the same error, and the batch promise rejects with that error.

## Worker API Reference

### OJSWorker

| Method / Property | Signature | Returns | Description |
|-------------------|-----------|---------|-------------|
| `register` | `register(type, handler)` | `this` | Register a handler for a job type |
| `registerDurable` | `registerDurable(type, handler)` | `this` | Register a checkpoint-aware durable handler |
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

### Progress Reporting

`reportProgress()` sends a worker's partial progress for a long-running
job back to the server, per ojs-progress.md section 6.1
(`PUT /ojs/v1/jobs/{id}/progress`):

```ts
import { reportProgress } from '@openjobspec/sdk';

worker.register('data.import', async (ctx) => {
  for (let i = 0; i < rows.length; i++) {
    await processRow(rows[i]);
    await reportProgress(
      transport,
      ctx.job.id,
      Math.round((i / rows.length) * 100), // ergonomic 0-100 percentage
      `Processed ${i} rows`,
    );
  }
});
```

The function's own signature stays the ergonomic 0–100 `percentage` API
shown above — only the exported **type** describing the request body
changed. `ProgressReport` is the canonical wire shape `reportProgress()`
actually describes: a union requiring at least one of `progress` or `data`,
with optional `checkpoint`. `progress` is a 0–1 fraction (not 0–100) and the
job ID lives in the URL, not the body. The now-deprecated `LegacyProgressReport`
(`{ job_id, percentage, message, data }`) is kept only for callers
migrating off the pre-wire-alignment shape this SDK used internally before
`reportProgress()` was corrected to send the real wire body; do not use it
for new code.

### gRPC Server Streams

`GrpcTransport` exposes push-based `streamJobs()` and `streamEvents()` async
iterables. Both reconnect with exponential backoff and stop permanently on
cancellation:

```ts
import { GrpcTransport } from '@openjobspec/sdk';

const transport = new GrpcTransport({ url: 'localhost:9090' });
const controller = new AbortController();

for await (const job of transport.streamJobs(
  { queues: ['default'], workerId: 'worker-1', maxConcurrent: 10 },
  { signal: controller.signal },
)) {
  console.log(job.id, job.type);
}
```

Reconnect classification is stream-specific:

| gRPC status | `StreamJobs` | `StreamEvents` |
|-------------|--------------|----------------|
| `UNAVAILABLE`, `DEADLINE_EXCEEDED`, `INTERNAL` | Retry with backoff | Retry with backoff |
| `RESOURCE_EXHAUSTED` | Retry with backoff | Terminal error |
| `CANCELLED` | Terminal | Terminal |

An external `AbortSignal`, `GrpcTransport.close()`, or consumer early return
ends the stream silently after cleanup. A `CANCELLED` status received while
those local signals remain active is remote and is thrown to the consumer.

#### `timeout` bounds setup only, never a healthy stream's lifetime

`GrpcStreamOptions.timeout` bounds **only** this transport's one-time
client/proto initialization and opening each individual connection attempt
(the initial connection and every reconnect) — never the overall lifetime
of the logical, possibly long-running stream. Once an attempt is open (the
underlying call reached the server), `timeout` no longer applies to it: a
healthy stream that keeps delivering, or sits idle, far longer than
`timeout` is never killed, matching ojs-grpc-binding.md sections
10.1.1/10.2.1 ("a healthy stream is expected to stay open indefinitely"). A
setup that does not open within `timeout` is treated like a transient
`DEADLINE_EXCEEDED` connectivity failure and retried through the normal
reconnect/backoff policy, exactly like `UNAVAILABLE` would be. An external
abort, transport close, or consumer `return()`/`throw()` also interrupts a
blocked client/proto initialization immediately rather than waiting for the
setup timeout:

```ts
for await (const job of transport.streamJobs(
  { queues: ['default'], workerId: 'worker-1' },
  { timeout: 5_000 }, // give up on a stuck connection attempt after 5s and retry
)) {
  console.log(job.id, job.type);
}
```

> **Corrected behavior:** earlier versions forwarded `timeout` directly as
> the underlying gRPC call's own deadline, which silently terminated an
> already-open, healthy stream once `timeout` elapsed — regardless of
> activity — forcing an unwanted reconnect every `timeout` milliseconds.
> `timeout` no longer does this. To restore the old semantics (a genuine
> hard ceiling on total stream duration, terminating even a healthy stream),
> opt in explicitly with the new, additive `streamDeadline` option:
>
> ```ts
> transport.streamJobs(request, { streamDeadline: 60_000 }); // hard 60s RPC lifetime
> ```
>
> Most long-lived worker/event streams should leave `streamDeadline` unset.

### gRPC ack result limitation

`AckRequest.result` (worker.proto) is a `google.protobuf.Struct`, which can
only represent a JSON object/map — it has no wire representation for a bare
scalar, array, or other non-object value. A plain JSON object handler
result (or an omitted/`null` result) is unaffected and stored normally.

A handler that resolves with a non-object result (e.g. a string, number,
boolean, or array) has **already completed successfully** by the time the
worker acks it, so `GrpcTransport` does not fail the ack or leave the job
unacknowledged (either of which could strand a successfully-processed job
for redelivery, or force a nack that misreports success as failure).
Instead, the job is **acknowledged without its result** — completion is
unaffected — and this transport reports the limitation once per ack via
`GrpcTransportConfig.onWarning` (a `GrpcProtocolWarning` carrying `code`,
`message`, and `originalResultType`), defaulting to `console.warn` when not
configured:

```ts
import { GrpcTransport } from '@openjobspec/sdk';

const transport = new GrpcTransport({
  url: 'localhost:9090',
  onWarning: (warning) => {
    // warning.code === 'ack_result_unrepresentable'
    myLogger.warn(warning.message, { type: warning.originalResultType });
  },
});
```

Result storage for non-object ack results is therefore omitted over the
current gRPC transport until the OJS wire protocol represents
`AckRequest.result` as a `google.protobuf.Value` instead of a `Struct`. The
HTTP transport is not affected by this limitation and stores any JSON-
serializable result, scalar or otherwise.

### gRPC NACK error mapping

The gRPC transport maps the complete public `JobError` into
`NackRequest.error`: `code`, `message`, `retryable`, `attempt`,
`occurred_at`, `backtrace`, and structured `details`. `occurred_at` is
validated and encoded as a protobuf `Timestamp`; `details` must be a JSON
object and is encoded as a protobuf `Struct`. Invalid timestamp or details
values are rejected before the RPC is invoked.

Canonical `JobError.backtrace` values are arrays of frame strings. The
public type also accepts the current gRPC proto's legacy newline-delimited
string; gRPC responses and client job responses normalize that string to an
array where possible, while gRPC NACK requests join canonical arrays for the
legacy wire field.

When `retryable` is omitted, the SDK sends `true`, preserving the worker's
retryable-by-default behavior. This default must be applied before
serialization because a non-optional proto3 boolean cannot distinguish an
omitted value from an explicit `false`; an explicit `false` is preserved.
`NackResponse.next_attempt_at` is always decoded to an RFC 3339 string (or
`null` when absent/malformed), never exposed as the raw `{ seconds, nanos }`
protobuf object.

Decoded gRPC retry policies account for proto3 scalar presence loss, but only
where a scalar's zero value is genuinely invalid or ambiguous with true
absence. `backoff_coefficient` (a multiplicative factor -- `0` or anything
below `1` is never a valid choice) and `on_exhaustion` (an empty string is
never a valid action) fall back to the authoritative OJS defaults
(`backoff_coefficient: 2`, `on_exhaustion: discard`) when decoded as their
proto3 zero value; the two Duration sub-messages (`initial_interval` /
`max_interval`) fall back to their defaults (`PT1S` / `PT5M`) only when the
sub-message itself is entirely absent -- an explicitly present `PT0S` is
never rewritten.

`max_attempts` and `jitter`, by contrast, are decoded exactly as received,
**including `0` and `false`**, whenever the `RetryPolicy` message itself is
present. Both are meaningful, valid OJS policy values in their own right
(`max_attempts: 0` means "never retry"; `jitter: false` means "no jitter"),
not evidence that the field was merely left unset. This does mean a subtle
proto3 ambiguity is unavoidable for a non-`optional` singular scalar field:
proto-loader's `defaults: true` decodes an explicitly-sent `jitter: false`
identically to a `jitter` field the sender never touched at all, and this
SDK cannot tell the two apart from the decoded value alone. Given the
`RetryPolicy` message is confirmed present, this SDK resolves that ambiguity
by trusting the wire value rather than guessing it means absence -- the
opposite choice would silently turn an explicit "don't retry" or "no
jitter" policy into the default "retry 3 times" / "jitter on", which is a
correctness regression this SDK will not introduce. A backend that wants
the documented default `jitter: true` must send it explicitly.

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

Workflow steps and batch callbacks likewise reject `expiresAt` / wire
`expires_at` before any transport request. Their jobs may be materialized only
after upstream work completes, so an absolute deadline converted to a relative
TTL when the workflow is submitted would move the deadline forward.

For the same reason, workflow steps and batch callbacks reject a developer
relative `delay` shorthand such as `'5m'`, `'30s'`, or `'1h'` -- the value
`enqueue()`'s own `delay` option accepts and converts to an absolute
`delay_until` relative to `Date.now()` *at submission time*. A non-first
chain step, a group member, or any batch callback is only materialized into
a real job once its predecessors finish, at an unpredictable later moment;
converting `'5m'` when the *workflow* is submitted would silently mean "5
minutes after submission," not "5 minutes after this step becomes eligible
to run." Pass an explicit RFC 3339 absolute timestamp instead, computed for
whenever the step is actually expected to run:

```ts
import { chain } from '@openjobspec/sdk';

const wf = chain(
  { type: 'data.fetch', args: {} },
  {
    type: 'data.followup',
    args: {},
    // Rejected: options: { delay: '5m' } -- ambiguous once this step is
    // deferred behind data.fetch.
    options: { delay: '2030-01-01T00:05:00Z' },
  },
);
```

Immediate `enqueue()` is unaffected: its `delay` option still accepts both
forms, because "now" at conversion time is always the actual enqueue time.

Every nested chain/group must also contain at least one child. Although the
public `chain()`/`group()` builders already reject empty top-level values, the
SDK validates manually constructed nested definitions too; an empty primitive
is rejected instead of being flattened as a no-op that silently splices the
surrounding dependency edge.

### Workflow Management

```ts
// Check workflow status
const status = await client.getWorkflow(workflow.id);
console.log(`${status.metadata.completed_count}/${status.metadata.job_count} jobs done`);

// Cancel a running workflow
await client.cancelWorkflow(workflow.id);
```

### Workflows over the gRPC transport

When a `GrpcTransport` is used, the SDK flattens the nested chain/group
definition into the proto `CreateWorkflowRequest` DAG (`repeated
WorkflowStep`) itself: every job becomes a `WorkflowStep` with a
deterministic, stable `id` (positional, e.g. `step-0`, `step-1-0`) and an
explicit `depends_on` list derived from the primitive semantics (chain =
sequential, group = parallel), and each step's enqueue options and
envelope `meta` are converted into the step's `EnqueueOptions`.

`batch` workflows are **not** representable over gRPC: proto's static
`WorkflowStep` DAG has no way to express a batch's conditional
`on_complete` / `on_success` / `on_failure` callbacks. `client.workflow()`
therefore rejects a batch (or a batch nested inside a chain/group) with a
non-retryable `unimplemented` error *before* any RPC is sent — use the HTTP
transport for batch workflows. An envelope-level `schema` on a step is
rejected for the same reason (proto `EnqueueOptions` has no `schema`
field).

Both `CreateWorkflowResponse`/`GetWorkflowResponse` (gRPC) and
`ojs-http-binding.md` §14.1/14.2 (HTTP) wrap the workflow status in a
`{ workflow: {...} }` envelope. `client.workflow()`/`client.getWorkflow()`
unwrap this envelope and resolve with the bare `WorkflowStatus` — a flat
(unwrapped) response body is also tolerated for backward compatibility
with a server or test double built against the previous, unwrapped shape.

The gRPC response is normalized to the same public `WorkflowStatus` shape:
`created_at`/`completed_at` are RFC 3339 strings, job totals are derived
from the stable proto step order, and optional `steps` preserve the
transport's per-step details. A decoded `google.protobuf.Timestamp` whose
value is exactly the zero/unset value (`{ seconds: 0, nanos: 0 }`) is
normalized to `null`, **never** to the literal Protobuf epoch instant
`1970-01-01T00:00:00.000Z`. This is a normative rule, not defensive
handling of malformed input: `ojs-protobuf-format.md` §6.2 ("Default Value
Handling") states an unset timestamp is the zero value and
"Implementations MUST NOT interpret the Protobuf epoch
(1970-01-01T00:00:00Z) as a valid OJS timestamp." A genuinely intended
epoch-second timestamp carrying any nonzero `nanos` (e.g.
`{ seconds: 0, nanos: 1_000_000 }`) is unaffected and still decodes
normally. The same rule applies to every decoded timestamp field
(`created_at`/`completed_at`, checkpoint `created_at`/`saved_at`,
`next_attempt_at`, cron `next_run_at`/`last_run_at`). When present,
`WorkflowStatus.type` is exactly one of the three standard public primitives:
`type?: 'chain' | 'group' | 'batch'` (there is no non-standard fourth value).
HTTP responses remain populated. `client.workflow()`
(`createWorkflow`) always knows and reports the real primitive you asked
for (`'chain'`/`'group'`; `'batch'` is rejected before the RPC — see
above), and `GrpcTransport` caches that authoritative type in-memory,
keyed by the server-assigned workflow ID, for the lifetime of the
transport instance. A later `client.getWorkflow()` call *on the same
transport instance* for a workflow ID it created itself therefore reports
the real type back — including for a single-step chain, which has zero
dependency edges (there is nothing for its one step to depend on), and for
a chain/group nested inside a group/chain (the outer primitive is what is
reported and cached).

The current Workflow proto does not carry the originating primitive at all,
but `getWorkflow()` does not require the process-local cache. On a cache
miss (for example, a workflow created by another process), the SDK infers
`'chain'` only for a strict multi-step linear sequence where each step
depends solely on its immediate predecessor, and infers `'group'` only for
a multi-step graph with no dependency edges. A one-step workflow or any
other DAG shape is returned successfully with `type` omitted, because its
originating primitive is not unambiguously recoverable. The HTTP transport
is unaffected and continues to return the server-provided type.

`WorkflowStepStatus` is transport-neutral: it includes the HTTP binding's
`available` state, nullable `job_id`, optional `depends_on`, zero-based
`index`, and optional `args`, `options`, `result`, `started_at`, and
`completed_at`. HTTP-only fields are preserved; gRPC derives `index` from
the stable proto order and maps an unassigned empty job ID to `null`.

## Middleware

The SDK uses an onion-model middleware chain for both worker execution and client enqueue operations. Each middleware wraps the next using the `(ctx, next) => ...` pattern.

The built-in `timeout()` middleware rejects outward at its deadline and
propagates cancellation through `ctx.signal`. Its optional
`settlementGraceMs` (default `100`) bounds how long `retry()` waits for
timed-out work to settle cooperatively; if it does not settle, the
`TimeoutError` is rethrown without starting an overlapping attempt. Nested
timeouts use a private per-context frame stack, so late inner/outer
settlements cannot restore a stale signal and the original worker signal is
restored only after every frame settles.

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
  job.meta = { ...job.meta, traceId: `trace-${job.id}` };
  return next(job);
});
```

Enqueue middleware follows an onion model whose terminal is the real
enqueue. Mutations applied to `job` **before** `await next(job)` are what
gets serialized and sent. `await next(job)` performs the actual enqueue and
resolves to the created `Job` (with its server-assigned `id`/`state`), or
rejects with the transport error. Mutations applied to the returned job
**after** `next()` are reflected in the value the caller receives but are
never re-sent:

```ts
client.useEnqueue('observe', async (job, next) => {
  job.args = encrypt(job.args);       // sent
  const created = await next(job);    // real enqueue; created.id is server-assigned
  metrics.record(created.id);         // observe the created job
  return created;                     // returned to the caller
});
```

`enqueueBatch()` applies the same per-job onion but still issues a single
atomic batch request: every job's chain runs to a terminal decision first,
then one request is sent and each chain's `next()` resolves with its
corresponding response job in order. A middleware error aborts the whole
batch before any request; dropped jobs are omitted; if every job is dropped,
no request is sent.

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

### Request timeout vs. external cancellation (`HttpTransport`)

The HTTP transport arms its per-request deadline by aborting the internal
`AbortController` with a distinct, typed reason. When **that internal timeout**
fires, the request rejects with an `OJSRequestTimeoutError` — a subtype of
`OJSConnectionError` (so existing `instanceof OJSConnectionError` handling
keeps treating it as a retryable transient failure) that additionally carries
`timeoutMs`, `path`, and structured `details` (`{ timeout_ms, path }`). It is
no longer surfaced as an opaque, reason-less `AbortError`.

Because `OJSRequestTimeoutError.retryable` is `true`, an internal timeout (and
an equivalent fetch/network failure) participates in the transport's
configured retry policy — **but only for response-safe `GET`/`HEAD` requests
and the SDK's contract-safe progress `PUT`**. A `POST` timeout is genuinely
ambiguous (the server may already have enqueued the job), so it is **never**
transparently retried; that ambiguity remains governed by the existing
idempotency rules (e.g. a caller-supplied `unique` policy) rather than blind
transport retries, avoiding a duplicate enqueue.

`DELETE` is also deliberately excluded from automatic retries. OJS delete
endpoints normally return `404` after a successful deletion, so a request that
commits server-side and then times out must surface its original timeout after
exactly one attempt instead of retrying and replacing it with a misleading
not-found error. This no-retry default also applies to `429 Retry-After` and
transient server responses for DELETE; an endpoint would need explicit,
endpoint-specific response normalization before retry could be safe. Existing
response-based retry policy for non-DELETE requests is unchanged.

An **external** `options.signal` cancellation is kept distinct: its own abort
`reason` is forwarded and normalized to a real `Error` (`abortReasonAsError`)
— the reason itself when it is already an `Error`/`DOMException`, or that
reason wrapped as `new Error('The operation was aborted', { cause: reason })`
otherwise, including a bare primitive or plain-object reason. An external
cancellation is **not** an `OJSRequestTimeoutError` and is never retried.

Both normalizations apply uniformly whether the abort surfaces while `fetch()`
itself is pending (even if the underlying `fetch()` implementation throws the
bare abort reason directly, not a `DOMException`) or while the response body is
still being read/parsed as JSON. An already-thrown OJS error (e.g. from a
parsed error response) always takes precedence and is never overridden.

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
  if (job === null) {
    console.log('Job was dropped by enqueue middleware');
  }
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

SSE subscriptions retry clean drops, network failures, HTTP 408/425/429, and
5xx responses. Other HTTP failures (including 400/401/403/404/422) are
terminal and surface as `SSEConnectionError` with the response `status`.
Transient HTTP responses honor `Retry-After`; in-stream `retry:` hints remain
the reconnect-delay base. Streaming parsing accepts LF, CRLF, and mixed line
endings, including CRLF delimiters fragmented across transport chunks, without
leaking delimiter carriage returns into event fields or data.

An explicit `Retry-After` value is honored **exactly and uncapped** for the
single reconnect it was issued for (RFC 9110 section 10.2.3) -- including a
delay far longer than this SDK's own local exponential-backoff ceiling
(30 seconds), such as an hour-long maintenance window. That local ceiling
caps only the SDK's *own* exponential growth (and the persistent SSE
`retry:` hint base); it is never applied to an authoritative server
instruction, which would silently defeat the very back-pressure signal
`Retry-After` exists to provide. The override is one-shot and never mutates
the persistent backoff base -- see `nextReconnectDelay()` in `subscribe.ts`.

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
| `testing.performed(filter?)` | Get all performed (executed) jobs -- the read-only counterpart of `allEnqueued()` for `assertPerformed()`/`assertCompleted()`/`assertFailed()`'s underlying store |
| `testing.drain(opts?)` | Process all pending jobs using registered handlers |
| `testing.clearAll()` | Clear all enqueued and performed jobs |

Every job returned by `testing.allEnqueued()`/`testing.performed()`, and every
`Job` a fake/inline-mode `client.enqueue()` call resolves with, is an
independent deep clone (using the exact JSON-semantic normalization rules
`createEnqueueEnvelope()` applies for real-mode enqueues -- a `Date`/`URL`/
custom `toJSON()` value normalizes identically, and a `__proto__`/
`constructor`/`prototype` key is preserved as ordinary data). Mutating a
returned job's `args`, `meta`, `options`, `tags`, `retry`, or `unique` --
including mutating it *after* `client.enqueue()` already resolved -- can
never alter what this module's internal store actually recorded; a later
`assertEnqueued()`/`allEnqueued()`/`performed()` call always observes
exactly the values captured at enqueue/completion time.

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

HTTP push delivery is authenticated before JSON parsing or handler execution.
Configure at least one HMAC secret; otherwise the HTTP adapters fail closed:

```ts
const handler = createLambdaHandler({
  signingSecrets: [
    process.env.OJS_PUSH_SIGNING_SECRET_CURRENT!,
    process.env.OJS_PUSH_SIGNING_SECRET_PREVIOUS!,
  ],
});
```

OJS signs the exact request bytes as
`HMAC-SHA256(secret, X-OJS-Timestamp + "." + raw_body)`. The timestamp must
be Unix seconds within ±5 minutes by default, and `X-OJS-Signature` contains
one or more comma-separated `sha256=<hex>` values. Multiple configured
secrets and signatures support rotation.

| Push option | Default | Description |
|-------------|---------|-------------|
| `signingSecret` | -- | One accepted HMAC secret |
| `signingSecrets` | -- | Accepted current/previous secrets during rotation |
| `freshnessSeconds` | `300` | Maximum permitted past or future clock skew |
| `maxBodyBytes` | `10 MiB` | Maximum raw HTTP request body size |
| `allowInsecurePush` | `false` | Explicit local-development migration mode; disables authentication and permits legacy bare-Job bodies |

Never enable `allowInsecurePush` on a publicly reachable deployment. Lambda
SQS and direct-invocation handlers are unchanged and do not use HTTP push
authentication.

The canonical HTTP body is:

```json
{
  "job": { "id": "...", "type": "...", "args": [] },
  "worker_id": "optional",
  "delivery_id": "optional"
}
```

`worker_id` and `delivery_id` are available as `ctx.workerId` and
`ctx.deliveryId`. A bare Job body is accepted only when
`allowInsecurePush: true`.

### HTTP push protocol: response-derived state transition (no ACK/NACK callback)

Cloudflare Workers, Vercel Edge Functions, and AWS Lambda's `httpHandler` are
push-delivery endpoints: the OJS backend that pushed the job over HTTP derives
the job's state transition **solely from this handler's HTTP response** — the
handler never performs a follow-up request back to the OJS server. There is no
"ACK" or "NACK" callback in this mode:

- **Handler resolves (success):** the handler returns HTTP `200` with
  `{ "status": "completed", "job_id": "..." }`.
- **Handler throws (failure):** the handler still returns HTTP `200`, with
  `{ "status": "failed", "job_id": "...", "error": { "code": "handler_error", "message": "...", "retryable": true } }`.
  Returning `200` (rather than `5xx`) here is intentional: it prevents the
  delivery platform itself from independently retrying the same push while the
  OJS backend, which parses this response body, makes its own retry/DLQ
  decision from the structured `error`.

Signature verification (above) is unaffected and still runs before any of this.

> **Deprecated (backward-compatible):** `url`, `apiKey`, and
> `callbackTimeoutMs` are still accepted on `CloudflareWorkerOptions`,
> `VercelEdgeOptions`, and `LambdaOptions` for backward compatibility with
> existing configuration objects, but `httpHandler`/`handleRequest` no longer
> read or use them — there is no callback request left to configure. They are
> retained (now optional) only as type-level compatibility aliases for existing
> callers. Today none of `sqsHandler`, `directHandler`, or any `httpHandler`
> calls back to the OJS server, so the old internal ACK/NACK callback helper
> has been removed rather than retained as dead infrastructure.

The SDK ships with first-class adapters for serverless platforms that process jobs via HTTP webhooks from the OJS server.

### AWS Lambda

```ts
import { createLambdaHandler } from '@openjobspec/sdk/serverless/lambda';

const handler = createLambdaHandler({
  signingSecret: process.env.OJS_PUSH_SIGNING_SECRET!,
});

handler.register('email.send', async (ctx) => {
  await sendEmail(ctx.job.args[0]);
});

export const lambdaHandler = handler.httpHandler;
```

The HTTP handler supports raw and API Gateway base64 bodies and performs
case-insensitive lookup of the OJS signature headers.

### Cloudflare Workers

```ts
import { createWorkerHandler } from '@openjobspec/sdk/serverless/cloudflare';

declare const OJS_PUSH_SIGNING_SECRET: string; // Cloudflare secret binding

const handler = createWorkerHandler({
  signingSecret: OJS_PUSH_SIGNING_SECRET,
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
  signingSecret: process.env.OJS_PUSH_SIGNING_SECRET!,
});

handler.register('notification.send', async (ctx) => {
  const payload = ctx.job.args[0] as { userId: string; message: string };
  await sendNotification(payload.userId, payload.message);
});

export const POST = handler.handleRequest;
export const runtime = 'edge';
```

All three adapters return `{ "status": "completed", "job_id": "..." }` (HTTP
`200`) on handler success and `{ "status": "failed", "job_id": "...", "error": { "code": "handler_error", "message": "...", "retryable": true } }`
(also HTTP `200`) on handler failure, deriving the state transition from the
response body alone. An unregistered job type follows the same failed-response
path (rather than returning HTTP `422`). Neither path performs a request back
to the OJS server.

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
| `keys` | `('type' \| 'queue' \| 'args' \| 'meta')[]?` | -- | Canonical dimensions that define the uniqueness fingerprint |
| `argsKeys` | `string[]?` | -- | Top-level args fields selected when `keys` includes `'args'` |
| `metaKeys` | `string[]?` | -- | Top-level metadata fields selected when `keys` includes `'meta'`; required and non-empty for that dimension |
| `key` | `string[]?` | -- | **Deprecated.** Legacy args field selectors; see migration behavior below |
| `period` | `string?` | -- | Uniqueness window (ISO 8601 duration) |
| `onConflict` | `'reject' \| 'replace' \| 'replace_except_schedule' \| 'ignore'?` | -- | Conflict resolution strategy |
| `states` | `JobState[]?` | -- | Job states to check for duplicates |

Use canonical options for new code:

```ts
unique: {
  keys: ['type', 'args'],
  argsKeys: ['id'],
  period: 'PT1H',
}
```

The SDK serializes this as `{ keys: ['type', 'args'], args_keys: ['id'], period: 'PT1H' }`; it never emits legacy `key`.

When migrating deprecated `key`, treat **every** entry as an args field selector, even when its string is `type`, `queue`, `args`, or `meta`. For example, `{ key: ['type', 'id'] }` becomes canonical `{ keys: ['args'], args_keys: ['type', 'id'] }`, not a fingerprint over the job-type dimension. Express protocol dimensions only with `keys`, for example `{ keys: ['type', 'args'], argsKeys: ['id'] }`. When canonical `argsKeys` and deprecated `key` are both supplied, canonical selectors remain first and legacy-only selectors are appended without duplicates; inputs are not mutated. Raw HTTP wire data must use canonical `keys`/`args_keys`; direct `GrpcTransport` input retains deprecated `key` only as an SDK compatibility path and applies the same all-args-selector migration before protobuf conversion. `argsKeys: []` is valid; when entries are present they must be non-empty and unique. `metaKeys` must always be non-empty when supplied, and selecting the `meta` dimension requires it.

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
npm ci

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

# Actor-Based SRP and Clean-Code Audit

| Field | Value |
|---|---|
| Repository | `ojs-js-sdk` (TypeScript; Node/browser SDK) |
| Branch | `refactor/clean-code-srp` (current dirty working tree intentionally left unstaged) |
| Outcome of eight-finding worker-result/workflow-delay/gRPC-init/retry-decode/SSE follow-up | Fixed F-137–F-144 (§4ah): worker acks only a JSON-normalized handler result and nacks a non-representable one exactly once as non-retryable `invalid_result` with no completion event/metric; workflow steps/callbacks reject a relative `delay` shorthand before serialization; unary `call()` races client/proto initialization against the request timeout/signal instead of hanging past either; `streamJobs()`/`streamEvents()` classify and retry an initialization failure/timeout through the normal reconnect backoff instead of bypassing it; decoded gRPC retry policies preserve an explicit `max_attempts: 0`/`jitter: false`; SSE event dispatch races handler settlement against `unsubscribe()`/abort and consumes a late settlement safely; SSE honors an explicit `Retry-After` exactly and uncapped; and push delivery returns a controlled HTTP 400 instead of throwing for a consumed/locked Request body. Tests/docs/AUDIT updated; changes remain **unstaged** |
| Outcome of DELETE retry-safety follow-up | Fixed F-136 (§4ag): ambiguous timeout/network retries are limited to GET/HEAD and contract-safe PUT; DELETE never retries generically because a committed delete normally becomes 404, including 429/transient-server responses without endpoint-specific normalization. Checkpoint, cron, workflow, schema, and dead-letter commit-then-timeout regressions prove one request and the original timeout; GET/PUT retry regressions remain green. Changes remain **unstaged** |
| Outcome of nine-finding stream/deferred/defaults/workflow/type/adapter follow-up | Fixed F-127–F-135 (§4af): gRPC setup errors/lifetime error guarding/private retry status; deferred absolute-expiry rejection; client-expanded batch defaults; nested-empty workflow rejection; exact iterator throw markers; legacy-checkpoint corruption coverage; canonical progress types; retry-policy proto-default decoding; and uniform missing-handler push failures. Tests/docs/AUDIT updated; changes remain **unstaged** |
| Outcome of immediate terminal-SSE cancellation follow-up | Fixed F-124 (§4ad): a terminal `job.state_changed` on a per-job subscription now returns an explicit stop control from the tracking handler to `connectOnce()`, which stops the subscription and cancels/releases the active reader immediately after handler settlement instead of waiting for EOF; buffered later events are never dispatched, terminal handler failures still reach `onError` exactly once, cancellation failures remain cleanup-only, and queue subscriptions retain normal multi-job delivery. Changes remain **unstaged** |
| Prior organization audit | `ORG-AUDIT.md` recorded this repository as **Skipped** — "TypeScript errors and two gRPC timeout tests" |
| Outcome of prior passes | The initial pass's findings below were implemented and green, and a follow-up pass closed every remaining gRPC gap the user explicitly called out — worker-heartbeat wire mapping, `GetCheckpoint`'s `saved_at` field, the unary cancellation lifecycle, and additive `StreamJobs`/`StreamEvents` support (§4a) — with deterministic tests throughout |
| Outcome of prior final-review pass | Fixed the four F-29–F-32 defects described in §4b |
| Outcome of current certification pass | Fixed all five certification findings: deadline-visible timeout/retry settlement (F-37), complete gRPC Job normalization (F-38), HTTP abort-through-body parsing (F-39), SSE signal-listener cleanup (F-40), and SSE reconnect-budget reset on first event (F-41). Deterministic regressions were added throughout; changes remain **unstaged** |
| Outcome of delivery/lifecycle follow-up | Fixed serverless callback delivery isolation (F-47), transport-owned gRPC stream shutdown/reopen generations (F-48), and exactly-once SSE handler invocation (F-49). Exact adapter responses and deterministic lifecycle regressions were added; changes remain **unstaged** |
| Outcome of synchronous-failure follow-up | Fixed terminal SSE handler-failure shutdown (F-50) and synchronous-throw normalization/guard cleanup in both middleware composers (F-51). Deterministic regressions cover sync/async terminal handlers, listener cleanup, no reconnect, execution/enqueue retry/drop, direct sync throws, and concurrent double-next rejection; changes remain **unstaged** |
| Outcome of crypto compatibility follow-up | Unified all private SDK crypto behind one new private runtime (`src/crypto.ts`): synchronous CSPRNG bytes now come from `@noble/hashes@1.8.0`, while asynchronous Web Crypto resolves ambient `globalThis.crypto` only when complete and otherwise lazily falls back to `node:crypto.webcrypto` with concurrency-safe caching. UUIDs, AES-GCM encryption, attestation SHA/HMAC, and durable random bytes now work on Node 18.20.8 / 20.20.2 / 22.23.1 and browser-like runtimes without public helper exports. Deterministic/provider tests cover absent/partial/complete ambient crypto, fallback failure recovery, ESM/CJS import safety, and preserved worker/event/request ID wire shapes. Changes remain **unstaged** |
| Outcome of enqueue-options conversion follow-up | Fixed F-53: `mapEnqueueOptions()` previously `Object.assign`ed the caller's `options` object onto the gRPC request completely unconverted — no HTTP-wire field (durations, timestamps, enum strings, nested `retry`/`unique`, `expires_at`, envelope `meta`) ever became valid proto `EnqueueOptions`. A new strict, shared HTTP-wire→protobuf converter now maps and validates every field for single `enqueue()`, every job in `enqueueBatch()`, and the actual `EnqueueBatchRequest.default_options`/`defaultOptions` protobuf field (while also resolving defaults under per-job overrides without mutating caller objects), rejects unknown/malformed options and non-JSON metadata before the generated client is invoked, preserves nanosecond RFC 3339 timestamp precision, and rejects an unrepresentable envelope-level `schema` explicitly. Verified with captured-request tests plus real `@grpc/proto-loader` `serialize()`/`deserialize()` round-trips against a field-for-field fixture proto. Changes remain **unstaged** |
| Outcome of unique/progress/SSE-cancellation follow-up | Fixed all three requested findings: F-54 (`buildProtoUniquePolicy()` now accepts `UniqueOptions.key` in both its documented "fields from args" form and the raw wire-dimension form, plus any mix of the two, instead of rejecting every non-dimension entry); F-55 (`grpcProgress()` now rejects every call with a non-retryable `unimplemented` `OJSError` instead of silently resolving `{}` as if a progress report reaching no real RPC had actually succeeded); and F-56 (`connectOnce()`'s abnormal-exit path — handler throw/rejection, `reader.read()` failure, or an abort surfacing as a read failure — now calls `reader.cancel(reason)` best-effort before `releaseLock()`, without letting a `cancel()` failure replace the original error; a clean EOF still releases without cancelling). Deterministic regressions were added for all three; changes remain **unstaged** |
| Outcome of canonical-unique/remote-cancellation follow-up | Fixed F-57 and F-58: developer unique options and public wire jobs now use schema-canonical `keys`/`argsKeys`/`metaKeys` with deterministic deprecated-`key` normalization, strict selector/meta validation, canonical HTTP serialization, and protobuf singular-`key` conversion; gRPC stream `CANCELLED` now ends silently only for a locally aborted caller/transport signal, while remote cancellation is surfaced to consumers. HTTP, gRPC, workflow, golden-response, schema-validation, and both-stream lifecycle regressions were added; changes remain **unstaged** |
| Outcome of durable-checkpoint failure-classification follow-up | Fixed F-59: checkpoint loading is now fail-closed. A canonical `OJSNotFoundError` means first execution for transports without legacy support; HTTP advertises legacy support and only then checks the read-only legacy endpoint, where `OJSNotFoundError`/`has_checkpoint:false` means first execution. A legacy response declaring `has_checkpoint:true` must contain `metadata._replay_log`; missing replay metadata is corruption and raises `OJSCheckpointLoadError` instead of silently restarting. Canonical transient failures never reach legacy or fresh mode. Network, auth, HTTP 5xx, JSON decode, structurally invalid response, corrupt replay-log, and legacy lookup failures are contextual `OJSCheckpointLoadError`s, so `registerDurable()` invokes neither the handler nor side effects and NACKs with the underlying retryability. Recovered legacy replay logs are migrated best-effort to the canonical resource. Deterministic regressions retain the 404 first-run case and cover canonical precedence, fallback/migration, connection/auth/500/malformed failures, zero side effects, no ACK, and retryable/non-retryable NACKs. Changes remain **unstaged** |
| Outcome of checkpoint-integrity/timestamp follow-up | Fixed F-60 and F-61: a successful canonical checkpoint lookup must now contain this SDK's complete replay wrapper, while malformed/foreign state fails closed without legacy fallback or side effects; protobuf timestamps are now range-checked, Date-bounded, and exception-safe across unary and streaming job normalization. Changes remain **unstaged** |
| Outcome of legacy-unique semantics follow-up | Corrected deprecated `UniqueOptions.key`: every legacy string is now an args selector (including `type`/`queue`/`args`/`meta`), canonical dimensions are accepted only through `keys`, and canonical `argsKeys` remain ordered first and are deduplicated without mutation. Raw HTTP stays canonical-only and direct `HttpTransport` enqueue/batch calls reject `unique.key` before network I/O; direct gRPC transport input retains this legacy SDK compatibility path. Changes remain **unstaged** |
| Outcome of worker-timeout NACK follow-up | Timeout/deadline classification now makes the authoritative timeout contract control NACK code, message, details, and retryability; a later downstream validation or non-retryable `OJSError` cannot overwrite timeout policy. Non-timeout `OJSError.retryable` propagation is preserved. Changes remain **unstaged** |
| Outcome of clean-SSE reconnect follow-up | Unexpected clean SSE closures now increment reconnect accounting and use the same capped exponential delay calculation as error closures. First-event resets, maximum attempts, and server `retry:` hint bases are preserved and covered by exact fake-timer sequences. Changes remain **unstaged** |
| Outcome of gRPC ack-result/workflow-mapping/cron-options follow-up | Fixed F-62/F-63/F-64 (§4r): `AckRequest.result` is now encoded as a `google.protobuf.Struct` (scalar/array results rejected non-retryably, `null`/omitted results omit the field); the nested public chain/group workflow shape (incl. nested group-in-chain and chain-in-group) is flattened into a proto `CreateWorkflowRequest` `WorkflowStep` DAG with deterministic stable step IDs, correct `depends_on`, converted args, and shared enqueue-options/`meta`, while batch and step `schema` are rejected with a non-retryable `unimplemented` error before the RPC; and cron registration maps `options`+`meta` into `RegisterCronRequest.options` (preserving explicit zeros) while listing decodes each `CronEntry`'s args/options/`next_run_at`/`last_run_at` via a new `fromProtoEnqueueOptions` inverse. New `tests/transport-grpc-workflow-cron-ack.test.ts` adds 30 captured-request + real `@grpc/proto-loader` serialization tests; the fixture proto gained field-for-field `AckRequest`/`WorkflowStep`/`CreateWorkflowRequest`/`RegisterCronRequest`/`CronEntry`/`ListCronResponse` messages. Changes remain **unstaged** |
| Outcome of gRPC ack-warning/workflow-envelope/cron-pagination-register follow-up | Fixed F-65/F-66/F-67 (§4s): a non-object `ack()` result no longer rejects an already-successfully-executed job (which previously left it neither acked nor nacked, stranding it for redelivery) — `grpcAck()` now acks it without a result and reports the limitation exactly once through a new backward-compatible `GrpcTransportConfig.onWarning` (default `console.warn`), carrying a `GrpcProtocolWarning`'s `code`/`message`/`originalResultType`; `OJSClient.workflow()`/`getWorkflow()` now unwrap the `{ workflow: WorkflowStatus }` envelope both `GrpcTransport` and the HTTP binding use (tolerating a flat body for backward compatibility), instead of resolving with the wrapper itself over gRPC; and `GrpcTransport.routeRequest()` now strips/parses the query string before route matching (previously any query string, including `CronOperations.list()`'s own `page`/`per_page`, silently broke `GET /cron` routing), with `grpcListCron()` validating/defaulting `page`/`per_page` (1/25) and paginating a code-point-name-sorted, deterministically-ordered entry list client-side, and `grpcRegisterCron()` now returning the documented `{ cron_job: CronJobInfo }` (previously only `{ name }`) reconstructed from the request plus the authoritative `RegisterCronResponse` `name`/`next_run_at`, a local timestamp captured immediately before the registration RPC (service.proto has no `created_at`), preserved top-level `meta` and `options` (including request fallback when `ListCron` omits them), and a best-effort authoritative follow-up `ListCron` lookup that falls back safely on any failure. New `tests/worker-grpc-ack-warning.test.ts` (4 tests, a real `OJSWorker` end-to-end), `tests/cron-operations-grpc.test.ts` (11 tests, real `CronOperations` end-to-end), plus additional cases in `tests/transport-grpc-workflow-cron-ack.test.ts` and `tests/client.test.ts`. README documents the ack-result limitation, the workflow-envelope unwrap, and the cron pagination/register reconstruction. Changes remain **unstaged** |
| Outcome of workflow-status/gRPC-NACK normalization follow-up | Fixed F-68/F-69 (§4t): proto Workflow responses conform to public `WorkflowStatus` (type, metadata counts/timestamps, stable optional step details), with create preserving the submitted primitive; the original get-time edge inference was later superseded by F-83's authoritative creation-time cache and explicit non-retryable `unimplemented` cache-miss error. gRPC NACK maps every `JobError` field, defaults omitted `retryable` to true while preserving false/zero, validates Timestamp/Struct inputs before RPC, and decodes `next_attempt_at` to RFC 3339. Captured-request and real proto serialization/runtime response tests were added. Changes remain **unstaged** |
| Outcome of ten-finding transport/lifecycle hardening pass | Fixed F-70–F-79 (§4u): bounded timeout settlement grace and nested signal frames; prompt bounded serverless callbacks; terminal external SSE abort and typed permanent/transient HTTP classification; pollution-safe recursive Struct decoding and zero timestamp handling; transport-accurate cron types; canonical unique validation parity; and transport-neutral job/workflow response types. Focused tests and docs were updated; changes remain **unstaged** |
| Outcome of eight-finding cancellation/honesty/encoding pass | Fixed F-80–F-87 (§4v): middleware `next()` re-entrancy now distinguishes "retry after rejection" (allowed) from "re-invoke after success" (rejected), scoped per invocation closure rather than per array index so a retried attempt never collides with a stale prior attempt's guard state; both gRPC server-stream consumers (`reconnectingServerStream` and `GrpcTransport.streamJobs()`/`streamEvents()`) now return a hand-built `AsyncIterableIterator` whose `.return()`/`.throw()` cancel the active call/abort an in-progress backoff sleep *synchronously*, not queued behind a pending `.next()` as a native async generator's would be; SSE heartbeat comments now count as live-connection proof and reset the reconnect-backoff counter (previously only a fully parsed event did, and only once); `GrpcTransport` now caches the authoritative `chain`/`group` primitive by workflow ID at `createWorkflow()` time and throws an explicit non-retryable `unimplemented` error for any workflow ID it did not itself create (the public `WorkflowStatus.type` is now exactly `'chain' | 'group' | 'batch'`, with the non-standard `'dag'` value removed), instead of guessing from dependency edges (wrong for a one-step chain, and unable to tell a batch from a group either way); every dynamic protobuf Struct/map field builder on the *encoding* side (`toProtoValue`, `toProtoStruct`, `toProtoJsonValue`, `enqueueMetaToProtoStruct`) now accumulates fields on a null-prototype object, so a `__proto__`/`constructor`/`prototype` key from real JSON input is encoded faithfully instead of silently vanishing into the accumulator's own prototype chain; a new schema-parity test suite locks in that the developer-normalization, raw-HTTP, and raw-gRPC unique-policy validators already agree exactly on `args_keys`/`meta_keys`/`period`/`states`/`on_conflict`; the exported `ProgressReport` type is now the canonical wire union (`{ progress, data?, checkpoint? } | { data, progress?, checkpoint? }`), enforcing ojs-progress.md §6.1's "at least one of `progress` or `data`" rule and §6.4's optional `checkpoint` at compile time (a separate deprecated `LegacyProgressReport` keeps the old `{ job_id, percentage, message, data }` shape for migrating callers; `reportProgress()`'s own ergonomic percentage signature is unchanged, and its internal request body is now typed as the canonical `ProgressReport`); and the existing prompt/bounded serverless callback delivery gained explicit endless-stream-with-active-traffic and timer-leak regressions. The already-normative `{seconds:0,nanos:0} → null` timestamp exception is retained unchanged, its rationale is documented in the README's gRPC normalization section, and it is explicitly cited to ojs-protobuf-format.md §6.2 ("Default Value Handling": implementations MUST NOT interpret the Protobuf epoch as a valid OJS timestamp) in `fromProtoTimestamp`'s doc comment and in its own dedicated, spec-citing test kept separate from the generic malformed-timestamp table. Changes remain **unstaged** |
| Outcome of enqueue-pipeline/package-surface follow-up | Fixed F-88–F-91 (§4w): single and batch enqueue now share one complete post-middleware envelope pipeline (including fake/inline and encryption), `enqueue()` honestly returns `Promise<Job \| null>`, and every source-advertised package subpath has ESM/CJS/type exports plus clean-pack verification. Changes remain **unstaged** |
| Outcome of SSE Retry-After/ML resource-metadata follow-up | Fixed F-92 and F-93 (§4x): an HTTP `Retry-After` reconnect hint now applies only to the single reconnect it was issued for (never mutating the persistent exponential-backoff base), while still consuming the `maxReconnectAttempts` budget; and `MLEnqueueOptions.meta` now precisely types `resources` as the new exported `MLResourcesMetadata` (matching `schemas/v1/ml-resources.schema.json` exactly) and the two legacy `ext_ml_max_tokens`/`ext_ml_max_batch_size` keys at the top level, removing the six obsolete, never-written-to top-level `meta.*` paths. Deterministic exact-timer and compile-time/runtime type tests were added; changes remain **unstaged** |
| Outcome of queue-validation/Lambda-response follow-up | Fixed F-103 and F-104 (§4z): queue validation now uses the exact canonical `^[a-z0-9][a-z0-9\-.]*$` schema pattern and 128-character maximum across HTTP/client and raw gRPC enqueue paths, including trailing/consecutive separator acceptance; Lambda's successful-NACK response now includes `job_id`, matching Cloudflare, Vercel, and the documented uniform adapter response. Exact validation, enqueue, batch, fake-mode, and Lambda response regressions were added; changes remain **unstaged** |
| Outcome of six-finding replay/transport/deadline follow-up | Fixed F-105–F-110 (§4aa): durable replay mismatches fail closed without live side effects; SSE handles fragmented/mixed CRLF; gRPC workflow gets no longer require a local cache and expose optional honest types; legacy checkpoint 404/405 means unsupported; gRPC checkpoints use validated JSON normalization; and serverless callback deadlines cover fetch through body handling. Focused runtime/type/protobuf tests and API documentation were added; changes remain **unstaged** |
| Outcome of enqueue-onion/durable-void/stream/JSON-clone/type-resolution follow-up | Fixed F-111–F-116 (§4ab): the enqueue middleware onion now terminates in the real transport/test-mode enqueue so `await next()` returns the actual created Job (single) and batch runs a barrier/deferred orchestration that still issues one atomic request; durable loaders accept a missing `result` as `undefined` for `call` entries only; gRPC stream backoff resets only on a caller-visible message (never a filtered keepalive); both stream iterator layers reject a consumer `.throw()` even when the inner generator unwinds cleanly; enqueue args/meta are normalized with JSON semantics (toJSON, undefined/function/symbol handling, BigInt/non-finite/cycle rejection, prototype-safe keys); and `typesVersions` maps every subpath for classic `moduleResolution: node` with a packed-package classic-resolution compile gate. Focused runtime/type tests were added and all package gates pass on Node 18/20/22; changes remain **unstaged** |
| Outcome of push-body/HTTP-push-protocol/gRPC-stream-timeout/cron-registration/abort-normalization/fake-cloning follow-up | Fixed seven findings (§4ac): push-body chunk reassembly now allocates one `Uint8Array(totalBytes)` and copies incrementally instead of a variadic `concatBytes(...chunks)` spread (avoiding a call-stack risk on many small fragments); Cloudflare/Vercel/Lambda `httpHandler`/`handleRequest` no longer call the OJS `/workers/ack`/`/workers/nack` callbacks at all — a handler success returns the push-protocol `{status:'completed'}` response and a handler failure returns an HTTP 200 structured `{status:'failed', error}` response, with the pushing backend deriving the state transition solely from that response; the shared ACK/NACK callback helpers remain as internal infrastructure for a possible future non-HTTP-push delivery mode, and `url`/`apiKey`/`callbackTimeoutMs` are now optional and documented `@deprecated` (accepted, unused) on all three adapters' options for backward compatibility; `GrpcStreamOptions.timeout` now bounds *only* client/proto initialization and opening each connection attempt (initial and every reconnect) via a new `connectTimeoutMs`/`waitForStreamOpen()` setup-bound mechanism keyed off the underlying call's `'metadata'`/`'status'`/`'error'` events, never the RPC's own deadline, so a healthy stream is never killed once open — a genuine hard RPC-lifetime deadline is now an explicit, additive, opt-in `streamDeadline` option instead; a pre-aborted (or aborted-while-initializing) gRPC unary `call()` now checks the signal *before* `ensureClient()` and rejects a normalized cancellation error without ever resolving imports/proto/channel; `grpcRegisterCron()` no longer issues a racy, O(n) best-effort follow-up `ListCron` lookup — `CronJobInfo` is now reconstructed solely from the submitted definition plus `RegisterCronResponse`'s own authoritative `name`/`next_run_at` and a locally captured `created_at`/`status:'active'`, in exactly one RPC call; `HttpTransport`'s outer request catch now normalizes *any* thrown value (including a bare primitive or plain object, not just `TypeError`/`DOMException`/`SyntaxError`) into a real `Error` via `abortReasonAsError(controller.signal)` whenever its internal controller is aborted, while still preserving an already-thrown OJS error unchanged; and `testing.ts`'s fake-mode job store now deep-clones `args`/`meta`/`options` with the exact JSON-semantic normalization `createEnqueueEnvelope()` uses (Date/URL/`toJSON()`, `__proto__`-safe) whenever recording a `FakeJob`, returning it via `_toJob()`, or exposing it through `allEnqueued()`/the new `performed()` accessor — so no post-`next()` mutation of a returned Job, and no mutation of a job read back via `allEnqueued()`/`performed()`, can ever corrupt the recorded store. Deterministic regressions were added throughout, including a 500,000-one-byte-chunk push-body test, zero-callback/response-contract adapter tests, live-stream-past-timeout and blocked-setup gRPC stream tests, a pre-abort/blocked-`ensureClient()` gRPC unary test, concurrent/upsert cron-registration tests, primitive/plain-object HTTP abort-normalization tests during both the request and body-read phases, and fake-mode real-mode-parity tests (post-`next()` mutation isolation, `__proto__`/Date-normalized values). All package gates pass on Node 18/20/22; changes remain **unstaged** |
| Outcome of batch-terminal/request-timeout follow-up | Fixed F-125 and F-126 (§4ae): each per-job `enqueueBatch()` terminal is a single atomic-transport slot reached at most once — a retry-style enqueue middleware re-invoking `next()` after the one atomic batch send now rejects immediately with the **original** terminal error (validation throw or transport rejection), never registering a new deferred, waiting for a second transport cycle, or hanging `Promise.allSettled(chains)`; whole-batch transport retry is explicitly unsupported. The `HttpTransport` internal timeout now aborts its controller with a typed, retryable `OJSRequestTimeoutError` (an `OJSConnectionError` subtype carrying `timeoutMs`/`path`/`details`) instead of an opaque reason-less `AbortError`, and keeps an external `options.signal` abort distinct and non-retried (including primitive/plain-object reasons). This pass originally treated `GET`/`PUT`/`DELETE` alike; F-136 (§4ag) later corrected the retry-safe set to GET/HEAD and contract-safe PUT, excluding DELETE. Deterministic regressions cover retry-once, multiple jobs, transport failure, timer-backoff, validation failure, GET timeout retry success/exhaustion, POST no-retry, primitive external abort, and body-read timeout. All gates pass on Node 18/20/22; changes remain **unstaged** |
| Commits created | 0 |

## 1. Scope

> **0.5 release follow-up (2026-09-02):** The previously implemented nullable
> enqueue behavior is now explicitly released as a breaking API change:
> `OJSClient.enqueue()` returns `Promise<Job | null>`. The changelog, README
> migration example, generated API documentation, type tests, and packed
> consumer checks all use that public contract.

This audit covers every file under `src/` and `tests/`, the build/lint/test/package configuration (`package.json`, `tsconfig*.json`, `vitest.config.ts`, `eslint.config.js`), and the CI workflow definitions (`.github/workflows/*.yml`), which describe the canonical gates (`npm ci`, `npm run lint`, `npm test`, `npm run test:coverage`, `npm run build`, `npm run size`, and a best-effort API-surface diff).

Cross-referenced against the normative specification (`../spec/spec/*.md`) and the machine-checkable JSON Schema contracts (`../ojs-json-schema/schemas/**`) to verify wire-format compliance, since this SDK's most valuable property is faithfully implementing an interoperable, versioned wire protocol.

## 2. Baseline (before this pass)

- `npm ci` — clean install from the committed lockfile, 250 packages, unchanged by this pass.
- `npm run build` (`tsc -p tsconfig.json && tsc -p tsconfig.cjs.json`) — **failed** with 3 TypeScript errors:
  - `src/agent/client.ts(57,39)`: `RequestInit` object literal incompatible with `exactOptionalPropertyTypes` (explicit `body: undefined`).
  - `src/recorder/index.ts(69,5)`: `noUncheckedIndexedAccess` — indexed array access possibly `undefined`.
  - `src/worker.ts(525,38)`: ad hoc `{ method: string; ... }` object not assignable to `TransportRequestOptions`'s literal `method` union.
- `npm run lint` — could not get past the `tsc --noEmit` gate (same 3 errors) to reach `eslint src/`; running `eslint` directly showed 1 error (`no-unnecessary-type-conversion` in `recorder/index.ts`) and 109 warnings.
- `npm test` (`vitest run`) — **464/464 tests passed**, but several suites relied on **real wall-clock timers** rather than deterministic fake timers, adding ~3.5s of unnecessary, flake-prone real-time waiting to a single run (`tests/worker.test.ts`'s job-timeout/heartbeat/poll-backoff tests, `tests/rate-limiter.test.ts`'s `HttpTransport rate-limit retry` suite with `vi.useFakeTimers({ shouldAdvanceTime: true })`, and several `setTimeout`-paced waits across both files and `tests/subscribe.test.ts`). This matches the organization audit's note about "two gRPC timeout tests" for this repository — the underlying flakiness class (real-timer-paced assertions) was present, even though the specific gRPC test durations observed here reflected repeated dynamic `import()` overhead rather than a real timeout race.
- `tests/fuzz.test.ts` was also observed to fail intermittently across repeated runs during this session (unrelated to timers): `fast-check`'s unseeded `fc.double()` occasionally generated `-0`, which fails `toEqual` (`Object.is`-based) after a legitimate JSON round-trip collapses it to `0`.
- `git status` — clean.

## 3. Actor / responsibility map

| Actor | Owns | Files |
|---|---|---|
| HTTP transport | Request construction, retry/backoff, abort/timeout composition, response/error parsing | `src/transport/http.ts`, `src/rate-limiter.ts` |
| gRPC transport | Channel/client lifecycle, unary-call plumbing, deadline/cancellation, HTTP-path→RPC routing, proto value/struct conversion | `src/transport/grpc.ts` |
| gRPC server-streaming | `StreamJobs`/`StreamEvents` reconnect/backoff, bounded backpressure, cancellation and listener/timer/call cleanup for a reconnecting server-streaming RPC — split out because this is a materially different failure-mode/lifecycle concern from unary-call plumbing above | `src/transport/grpc-stream.ts` |
| Transport contract | Shared request/response/config shape used by both transports and by `OJSClient`/`OJSWorker` | `src/transport/types.ts` |
| Client (producer) | Enqueue/batch/workflow/health orchestration, enqueue middleware composition | `src/client.ts` |
| Worker (consumer) | Poll loop, concurrency, execution middleware, heartbeat, graceful shutdown, ack/nack | `src/worker.ts` |
| Middleware composition | Onion-model dispatch and reentrancy guarding for both execution and enqueue chains | `src/middleware.ts` |
| Built-in middleware | Logging, metrics, timeout, retry — each a narrow, independently testable cross-cutting concern | `src/middleware/*.ts` |
| Job/workflow wire mapping | camelCase↔wire-format conversion for job options and workflow steps/callbacks | `src/job.ts`, `src/workflow.ts` |
| Durable execution | Checkpoint persistence/resume and deterministic replay of time/random/side-effects | `src/durable.ts` |
| Real-time subscriptions | SSE connection, parsing, reconnection, resumption | `src/subscribe.ts` |
| Progress reporting | Single-purpose wire call for worker→backend progress | `src/progress.ts` |
| Events | Typed pub/sub envelope and listener dispatch | `src/events.ts` |
| ML/AI resource extension | Schema-defined resource fields under `meta.resources`, with normative legacy-only limits under `meta.ext_ml_*` | `src/ml.ts` |
| Encryption codec | AES-256-GCM codec + enqueue/execution middleware | `src/encryption.ts` |
| Attestation (Labs) | Verifiable-compute attestor implementations | `src/attest/*.ts` |
| Execution recorder (Labs) | Trace capture for Replay Studio | `src/recorder/*.ts` |
| Agent client (Labs) | Fork/merge/pause/resume/replay HTTP client | `src/agent/*.ts` |
| Serverless adapters | Push-delivery handlers per platform; HTTP push transitions are derived solely from each adapter's response | `src/serverless/{lambda,cloudflare,vercel}.ts` |
| Testing utilities | Fake/inline mode job store and assertions | `src/testing.ts` |
| Validation | Structural pre-flight checks | `src/validation/schemas.ts` |
| Errors / error catalog | Typed error hierarchy and canonical code catalog | `src/errors.ts`, `src/error-codes.ts` |

No file exceeded a defensible single-actor scope once the fixes below were applied; no `Manager`/`Helper`/`Utils`-style generic dumping ground was introduced. `src/transport/grpc-stream.ts` is a narrowly-scoped, module-private actor ("the reconnecting server-stream engine StreamJobs/StreamEvents share"), extracted because it is a materially different lifecycle/failure-mode concern from `grpc.ts`'s unary-call plumbing (see §4a/§5). The earlier private `src/serverless/ojs-callback.ts` actor was removed in F-118 once HTTP push became response-derived and no non-HTTP adapter needed an out-of-band callback.

## 4. Findings, by severity

Severity reflects blast radius if unfixed: **P0** = silently broken against any real, spec-compliant OJS backend, or an active resource/race hazard; **P1** = a real bug reachable in normal usage that degrades correctness, security, or robustness; **P2** = code quality / lint / determinism.

### P0 — wire-format and correctness breaks

| ID | Location | Actors in conflict | Finding | Status |
|---|---|---|---|---|
| F-01 | `src/durable.ts` | Durable-execution client vs. HTTP transport's automatic `/ojs/v1` prefixing vs. `ojs-durable-execution.md` §7 | `checkpoint()`/`create()`/`complete()` requested `/ojs/v1/checkpoints/{id}(/resume)`. The transport *also* prefixes every path with `/ojs/v1`, so the real request was `/ojs/v1/ojs/v1/checkpoints/...` — doubly wrong, and on a structurally different resource path than the spec's `/jobs/{id}/checkpoint`. The request/response body shape (`step_index`/`metadata._replay_log`) also didn't match `checkpoint.schema.json`'s `additionalProperties:false` `{state, sequence}` contract, which has no metadata slot. **Durable execution could not have worked against any conformant backend.** | **Fixed** |
| F-02 | `src/progress.ts` | Progress-reporting client vs. `ojs-progress.md` §6.1 | `reportProgress()` sent `POST /workers/progress` with `{job_id, percentage (0-100), message, data}`. Spec requires `PUT /jobs/{id}/progress` with `{progress: <0..1 fraction>, data}` — wrong method, wrong path, wrong body shape, wrong value scale (percentage vs. fraction). | **Fixed** |
| F-03 | `src/serverless/{lambda,cloudflare,vercel}.ts` | Three independent adapters vs. `ojs-http-binding.md` §10.2/10.3 | All three push-delivery adapters called `POST /jobs/{id}/ack` / `/jobs/{id}/nack` — a route that does not exist. Per spec, ack/nack are **worker** operations at the fixed `/workers/ack`/`/workers/nack` paths, identifying the job via `job_id` in the body. `nack` also sent `{error: "string"}` instead of the required structured `{code, message, retryable}`. All three adapters would silently fail to report job outcomes to a real backend. | **Fixed** |
| F-04 | `src/subscribe.ts` | SSE client vs. `ojs-realtime.md` §2.1/2.2 | `subscribe()`/`subscribeJob()`/`subscribeQueue()` requested a nonexistent `GET /ojs/v1/events/stream?channel=...` endpoint. The spec's only two SSE endpoints are `GET /jobs/{id}/events` and `GET /queues/{name}/events`. Real-time subscriptions could not have worked against any conformant backend. | **Fixed** |
| F-05 | `src/subscribe.ts` | Same module vs. `ojs-realtime.md` §9.3 ("SDKs **MUST** implement automatic reconnection with exponential backoff") | No reconnection logic existed at all; a dropped connection silently ended (`.catch(() => {})`) with no retry, no `Last-Event-ID` resumption, and no visibility to the caller. This is a normative MUST-level SDK requirement, not an optional enhancement. | **Fixed** |
| F-06 | `src/subscribe.ts` | Same module vs. Node.js 18 runtime (declared `engines.node: >=18.0.0`, and the CI matrix tests Node 18/20/22) | `AbortSignal.any()` requires Node **20.3+**. Any consumer on Node 18.x passing an external `signal` to `subscribe()` would hit `TypeError: AbortSignal.any is not a function` immediately. | **Fixed** |
| F-07 | `src/middleware.ts` + `src/middleware/retry.ts` | Middleware-composition actor vs. the shipped retry-middleware actor | `composeExecution`'s reentrancy guard rejected **any** second call to `next()` at a given chain position, even sequentially after the first settled. The shipped `retry()` middleware calls `next()` repeatedly on failure — so wiring `retry()` into a real `MiddlewareChain`/`OJSWorker` always failed on the first retry attempt with `"next() called multiple times"`, silently converting a transient failure into an immediate hard failure. The existing unit tests for `retry()` never caught this because they invoke it directly with a raw closure, bypassing `composeExecution` entirely. | **Fixed** |
| F-08 | `src/ml.ts` | ML resource-extension builders vs. `ojs-json-schema/schemas/v1/ml-resources.schema.json` | `withModel`/`withCheckpoint`/`withPreemption`/`withCompute`/`withNodeSelector`/`withAffinity` each wrote a *separate top-level* `meta.*` key (`meta.model`, `meta.compute`, ...), while `withGPU`/`withTPU`/`withResources` correctly nested under `meta.resources`. The versioned schema defines `model`/`checkpoint`/`preemption`/`runtime`/`precision`/`distributed_strategy`/`node_selector`/`affinity` as siblings of `gpu`/`tpu`/`cpu` *inside* the single `meta.resources` object. `mergeMLOptions()` also shallow-merged `meta`, so combining e.g. `withGPU()` and `withModel()` after the fix would have let the second call's `resources` object silently clobber the first's. | **Fixed** |
| F-09 | `src/workflow.ts` | Workflow step-option mapping vs. `src/job.ts`'s `toWireOptions` vs. `ojs-workflows.md` job-option examples | `toWireStep()` hand-rolled a subset of option mapping (`queue`/`timeout`/`tags` only) and passed `retry` straight through **unconverted** (camelCase `maxAttempts` instead of the wire's snake_case `max_attempts`). `priority`, `delay`, `expiresAt`, `visibilityTimeout`, `unique`, `schema`, and `meta` were silently dropped for every workflow step and batch callback. | **Fixed** |
| F-26 | `src/transport/grpc.ts` (`grpcHeartbeat`) | Worker-level heartbeat vs. `worker.proto`'s `HeartbeatRequest`/`WorkerState` | The worker-level heartbeat (`src/worker.ts`'s `sendHeartbeat()`, which never sends a `job_id`) never populated `HeartbeatRequest.id` correctly — it indexed the `active_jobs` *count* field as if it were an array of job IDs (`asProtoArray(count)[0]`, always `undefined` for a `number`), so `id` was always `''`/omitted instead of the worker ID `worker.proto`'s own doc comment requires there. Worse, `current_state` (the `WorkerState` enum) was **never sent at all** — every gRPC heartbeat silently carried the proto3 zero-value `WORKER_STATE_UNSPECIFIED`, which the enum's own doc comment says "**MUST NOT** be used in valid heartbeat messages." A real conformant backend has no way to learn the worker's actual lifecycle state via gRPC, so BEAT-driven server-directed transitions (section 7.5) could never work correctly. | **Fixed** — `id`/`workerId` both map to the worker ID; `state` maps to the `WorkerState` enum string via a new `mapWorkerStateToProto` (inverse of the existing `mapWorkerState`); `active_jobs`/`active_job_ids` are no longer read at all |
| F-27 | `src/transport/grpc.ts` (`grpcGetCheckpoint`) | `GetCheckpointResponse.saved_at` vs. `checkpoint.schema.json`'s `created_at` | `GetCheckpointResponse.saved_at` (service.proto) decodes as `savedAt` (proto-loader with `keepCase: false`), but this transport had always read a field literally named `createdAt` instead — which does not exist on the wire at all, so `response.createdAt` was always `undefined` and every real gRPC `GetCheckpoint` call reported `created_at: null`, regardless of when the checkpoint was actually saved. (The prior pass's own code comment explicitly flagged and preserved this as "likely unintended... this refactor changes types, not wire behavior" — the user's explicit requirement now directs fixing the behavior itself.) | **Fixed** — reads `response.savedAt`; a new `fromProtoTimestamp` helper converts the decoded `google.protobuf.Timestamp` (`{ seconds, nanos }` — protobufjs has no JSON-mapping wrapper for `Timestamp` the way it does for `Struct`/`Value`, confirmed against a real `@grpc/grpc-js` + `@grpc/proto-loader` round trip) into the RFC 3339 string `created_at` expects |
| F-59 | `src/durable.ts` (`DurableContext.create`) | Checkpoint-lookup failure handling vs. durable execution's exactly-once-recording guarantee (`ojs-durable-execution.md` §4) | `create()` caught *every* error from the canonical `GET /jobs/{id}/checkpoint` lookup — network/connection failures, auth/authorization failures, malformed/undecodable JSON responses, and HTTP 5xx server errors, not just a true `404 Not Found` — and silently fell back to fresh record mode. That also made any compatibility fallback unsafe: a transient canonical outage could be mistaken for absence and re-run already-recorded side effects. | **Fixed** — canonical is always authoritative. Only its `OJSNotFoundError` permits an advertised legacy-capable transport to request `GET /checkpoints/{id}/resume`; all other canonical errors stop immediately. Legacy absence permits first execution, while legacy transport/decode/integrity errors also stop. Successful legacy replay is migrated best-effort to canonical state. `OJSCheckpointLoadError` preserves cause/context/retryability, and worker NACKs preserve that retryability without invoking handler code |
| F-60 | `src/durable.ts` (`canonicalReplayEntries`) | Successful canonical lookup vs. replay-wrapper ownership/integrity | After F-59, a canonical `200` whose `state` was a foreign object or omitted `_ojsReplayLog` still returned a fresh record-mode context; an empty array was indistinguishable from "not our wrapper." That reintroduced the same side-effect replay risk without any transport error. | **Fixed** — canonical state must be an object with an own array-valued `_ojsReplayLog`, a non-negative safe-integer `_ojsStepIndex`, a positive safe-integer `_ojsAttempt`, and an own `value` field. Every replay entry is shape/type checked. Empty logs are valid recognized wrappers; foreign/missing/wrong-type/malformed wrappers throw contextual `OJSCheckpointLoadError` and never reach legacy, migration writes, handler code, ACK, or durable side effects. Legacy `_replay_log` JSON decoding remains isolated to the explicit legacy endpoint path. |
| F-61 | `src/transport/grpc.ts` (`fromProtoTimestamp`) | Untrusted protobuf timestamp values vs. JavaScript Date limits | The helper converted seconds with `Number(...)`, accepted unchecked nanos, and called `toISOString()` directly. Max-int64/unsafe seconds, negative or ≥1e9 nanos, and Date-overflow values could therefore throw `RangeError` while normalizing a unary or streamed job. | **Fixed** — seconds must be a strict decimal string or number that converts to a safe integer; nanos must be an integer in `0..999999999`; the mathematical positive boundary, computed milliseconds, and ECMAScript TimeClip range (±8.64e15 ms) are checked before construction; `getTime()` and `toISOString()` are guarded so malformed/out-of-range values return `null`. Integer-millisecond conversion avoids IEEE-754 rounding of `999999999` nanos into the next second. The shared full-job golden fixture now covers max int64, negative/out-of-range nanos, and exact minimum/maximum Date values through both unary `GetJob` and `StreamJobs`, with focused checkpoint timestamp cases as well. |

### P1 — resource leaks, races, swallowed errors, security-relevant robustness

| ID | Location | Finding | Status |
|---|---|---|---|
| F-10 | `src/transport/http.ts` | The external `AbortSignal`'s `'abort'` listener was removed via `removeEventListener('abort', controller.abort)` — a *different* function reference than the one actually added (`() => controller.abort()`), so `removeEventListener` was always a no-op. Every request made with a caller-supplied signal leaked a listener for the signal's lifetime; a long-lived shared signal (e.g. a worker's own shutdown signal, reused across many requests) would accumulate listeners without bound. Also fixed: the same signal's abort *reason* wasn't propagated to the wrapped `AbortController`, and an already-aborted signal wasn't detected before starting the request. | **Fixed** |
| F-11 | `src/transport/grpc.ts` | `GrpcTransport.request()` destructured `options.signal` but never used it — unlike `HttpTransport`, callers had no way to cancel an in-flight gRPC unary call. Also: `call()` used a `new Promise(async (resolve, reject) => {...})` executor (the async-executor anti-pattern: a throw inside it is silently dropped rather than rejecting the constructed promise) and re-ran `await import('@grpc/grpc-js')` on every single call after the client was already initialized. | **Fixed** |
| F-12 | `src/events.ts` | `OJSEventEmitter.emit()` used `Promise.all` over listener results. A **synchronously throwing** listener interrupted the `for` loop outright, so listeners registered after it never even ran; an **asynchronously rejecting** listener made `emit()` itself reject. Since `OJSWorker` calls `events.emit('job.completed', ...)` *after* `ack()` has already succeeded, a buggy user-supplied `job.completed` listener would route an already-acked job into the `.catch()` failure path and **nack a job that had already been acked**. | **Fixed** |
| F-13 | `src/middleware/timeout.ts` | The `timeout()` middleware created its own private `AbortController` and aborted *it* on timeout, but never connected it to `ctx.signal`. Downstream handlers checking `ctx.signal` (e.g. to cancel an outgoing `fetch`) never observed the timeout — the real work kept running as an unobservable "zombie" after the middleware had already reported a `TimeoutError` upstream. | **Fixed** |
| F-14 | `src/worker.ts` | `processJob()`'s "no handler registered" branch called `this.nack(...).finally(() => {...})` with no `.catch()`. Since `nack()` can itself throw after exhausting its own retries, this was a genuine floating-promise / unhandled-rejection hazard in a long-running worker process. | **Fixed** |
| F-15 | `src/testing.ts` | `_recordEnqueue()` (inline mode) and `drain()` both did `catch { job.state = 'discarded'; }`, completely discarding the handler's thrown error. A failing test-mode job gave no way to see *why* it failed. | **Fixed** (additive `FakeJob.error` field) |
| F-16 | `src/transport/http.ts` | `abortableSleep()` rejected with `signal.reason` verbatim. Per spec, `AbortSignal.reason` may be *any* value the caller passed to `controller.abort(reason)` — a non-`Error` reason (string/object) would violate the implicit "rejects with an `Error`" contract relied on elsewhere (`instanceof Error` checks, stack traces). | **Fixed** (normalizes non-`Error` reasons; preserves original as `cause`) |
| F-17 | `src/transport/grpc.ts` | `service.proto` defines `SaveCheckpoint`/`GetCheckpoint`/`DeleteCheckpoint` RPCs (needed by the durable-execution fix, F-01) that were entirely unrouted — `DurableContext` over `GrpcTransport` would fail with `"Unsupported route"`. | **Fixed** |
| F-18 | `src/attest/types.ts` / `src/attest/index.ts` | `PQCOnlyAttestor` emits `signature.algorithm = 'hmac-sha256'`, a value absent from the exported `SignatureAlgorithm` constant map — consumers had no named constant to compare against. | **Fixed** (additive `SignatureAlgorithm.HmacSha256`) |
| F-19 | `src/agent/index.ts` | `AgentClient` throws `AgentError`, but the class was not re-exported from the `./agent` subpath barrel — consumers could not `instanceof`-check it without a deep, unsupported import path. | **Fixed** (additive re-export) |
| F-20 | `package.json` `exports` map | `./agent`, `./attest`, `./recorder` omitted `require.types`, unlike `"."` and `./serverless*`, which all reuse the ESM `.d.ts` for both conditions (the CJS build has `declaration:false` and emits no `.d.ts` of its own). CJS/`require()`-resolving TypeScript consumers got **zero** type information for these three subpaths. | **Fixed** |
| F-28 | `src/transport/grpc.ts` (`GrpcTransport.call()`) | F-11 added unary cancellation but left two gaps in the lifecycle: (1) `onAbort`'s closure captured `call` (a `const` assigned by `fn.call(...)` *after* the abort listener was registered) — if the generated method threw **synchronously**, the listener was already attached but nothing ever removed it, since the throw was never routed through `finish()`. A long-lived, reused signal (e.g. a worker's own shutdown signal) would leak one listener per synchronous-throw call, unbounded. (2) cancellation only settled the promise once the underlying implementation's callback *eventually* fired with a `CANCELLED` status (real grpc-js always does this, but a mock or incomplete/broken implementation might not) — there was no guarantee cancellation itself resolved promptly. | **Fixed** — the generated method call is now wrapped in `try`/`catch` so a synchronous throw is mapped (`mapSyncThrow`, mirroring `abortReasonAsError` in `transport/http.ts` for the same "never reject with a non-`Error`" reason) and routed through `finish()`, guaranteeing the listener is removed; a second `signal.aborted` check immediately before registering the listener closes the (currently theoretical, but now structurally guaranteed) race between the initial check and registration; `onAbort` now rejects directly with a mapped `OJSConnectionError` instead of only calling `cancel()` and waiting, so cancellation settles promptly even if the implementation never calls back, and any such late callback is a guaranteed no-op via the existing `settled` guard |

### P2 — determinism, lint, style

| ID | Location | Finding | Status |
|---|---|---|---|
| F-21 | `tests/worker.test.ts`, `tests/rate-limiter.test.ts` | Real-`setTimeout`-paced tests (`should timeout a job that takes too long`, `should transition to terminate when server directs`, `should use exponential backoff on consecutive poll errors`, the entire `HttpTransport rate-limit retry` suite, and 10 further worker tests) added ~3.5s of real wall-clock waiting per run and were structurally prone to CI-load flakiness. | **Fixed** — converted to `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync`/`runAllTimersAsync`; full suite dropped from ~4.2s to ~1.6s and is stable across 10+ repeated runs |
| F-22 | `tests/fuzz.test.ts` | `jsonValueArb`'s `fc.double()` could generate `-0`, which fails `toEqual` (`Object.is`-based) once a legitimate JSON round-trip collapses it to `0` — an intermittent, unseeded property-test flake unrelated to any product bug. | **Fixed** (normalize `-0`→`0` at generation time) |
| F-23 | `src/recorder/index.ts`, `types.ts` | Double-quoted strings and an extensionless `./types` import specifier, inconsistent with `.prettierrc`'s `singleQuote: true` and every other `src/` file's `.js`-suffixed relative imports. | **Fixed** |
| F-24 | `src/attest/index.ts` | `NoneAttestor`/`NitroAttestor`/`TDXAttestor`/`SEVAttestor` were declared `async` with no `await` inside (`require-await`). | **Fixed** — rewritten as non-`async` functions returning `Promise.resolve()`/`Promise.reject()` directly, preserving genuine-Promise-rejection semantics (verified: hardware stubs reject asynchronously, not via a synchronous throw) |
| F-25 | Various | Remaining auto-fixable/mechanical warnings: `prefer-regexp-exec`, `prefer-nullish-coalescing`, `dot-notation`, `array-type`, `consistent-generic-constructors`, `no-inferrable-types`, `prefer-promise-reject-errors`, `no-unnecessary-type-conversion` (1 **error**), `no-floating-promises`. | **Fixed** — `0` lint errors; warnings reduced from 110 to 62 at the end of the original pass (all `no-explicit-any` in `transport/grpc.ts`'s dynamic proto-shape handling), then to **`0`** by the end of this pass once the new streaming call/method types were given structural interfaces too instead of `any` (see §6, §9) |

## 4a. New capability: gRPC server-streaming (`StreamJobs`/`StreamEvents`)

The original pass deferred this (see the former §6 entry, now removed — superseded by this section) pending "a real design decision about whether/how `OJSWorker`'s proven polling loop should consume push-based delivery." The user's explicit requirement scoped this precisely: **a correct, additive, fully-tested `GrpcTransport` streaming API satisfies the transport scope** — `OJSWorker` integration is explicitly out of scope unless it can be made safely opt-in and fully tested, which is a separate, larger undertaking (see §11). What follows is what was actually implemented.

### API surface (all additive; zero existing exports changed)

```ts
class GrpcTransport implements Transport {
  // ...existing members unchanged...
  streamJobs(request: GrpcStreamJobsRequest, options?: GrpcStreamOptions): AsyncIterable<Job>;
  streamEvents(request?: GrpcStreamEventsRequest, options?: GrpcStreamOptions): AsyncIterable<GrpcStreamEvent>;
}

interface GrpcStreamJobsRequest { queues: string[]; workerId: string; maxConcurrent?: number }
interface GrpcStreamEventsRequest { queues?: string[]; eventTypes?: string[]; jobId?: string; workflowId?: string }
interface GrpcStreamOptions {
  signal?: AbortSignal;
  metadata?: Record<string, string>;
  timeout?: number; // per-attempt deadline; see rationale below
  reconnect?: GrpcStreamReconnectOptions;
}
interface GrpcStreamReconnectOptions { enabled?: boolean; initialDelayMs?: number; maxDelayMs?: number; maxAttempts?: number }
interface GrpcStreamEvent {
  id: string; type: string;
  job_id?: string; job_type?: string; queue?: string;
  timestamp?: string; data?: Record<string, unknown>; workflow_id?: string;
}
```

All five new types are re-exported from the package root (`src/index.ts`), alongside the pre-existing `GrpcTransport`/`GrpcTransportConfig` — verified with a `.d.ts`-level type-check against the built package (§9) and an ESM smoke-import from a scratch project with only the `@openjobspec/sdk` tarball installed (the optional `@grpc/grpc-js`/`@grpc/proto-loader` peer deps deliberately **not** installed there, see below).

### Design decisions and how each requirement was met

- **Lazy connect, import-safe without peer deps.** Both methods are thin `async function*` wrappers; the body (which calls the same `ensureClient()` unary calls already use) only runs once the returned `AsyncIterable` is actually iterated. Verified: calling `streamJobs()`/`streamEvents()` without iterating touches neither `@grpc/grpc-js` nor `@grpc/proto-loader`, and — in a scratch project with the packed tarball installed but the optional peer deps absent — merely *importing* `GrpcTransport` and calling these methods synchronously never throws; only iterating does, with the same `"gRPC dependencies not found..."` error the unary path already raises.
- **Auth/custom metadata and a deadline, only where requested.** `GrpcStreamOptions.metadata` merges with the transport's configured API key/auth/custom metadata exactly like the unary path's `createMetadata()`. Unlike unary calls, streams have **no default deadline** — applying the transport's unary `timeout` (30s default) would silently kill every healthy, intentionally long-lived stream every 30 seconds. `timeout` is applied only when the caller explicitly sets it, freshly computed (`Date.now() + timeout`) for *every* individual connection attempt (not once for the whole logical, possibly-long-running stream).
- **`AbortSignal` cancellation and consumer early-return cleanup.** Both are handled uniformly by `reconnectingServerStream` (`src/transport/grpc-stream.ts`): an abort listener calls the in-flight call's `cancel()` and rejects/stops the generator immediately (not waiting for the implementation's own callback — the same principle as the F-28 unary hardening above); a consumer's `break`/`return`/`throw` out of the consuming `for await` invokes the generator's own `.return()`/`.throw()`, which unwinds through a `finally` block that also calls `cancel()`. This was verified against a **real** in-process `@grpc/grpc-js` server: merely letting a `for await` `break` destroy the local Node `Readable` does **not** by itself notify the server (`'cancelled'` was never observed server-side without an explicit `cancel()` call) — the `finally`-wrapped `cancel()` is required, not cosmetic.
- **Bounded backpressure, no unbounded queue.** Messages are `yield`ed directly as pulled from the underlying call's async iterator — there is no secondary buffer/array anywhere in this feature. `for await` consumes a Node.js `Readable` (`@grpc/grpc-js`'s `ClientReadableStream` extends it) in paused mode, which is exactly `stream.pause()`/`resume()` semantics: the stream's own bounded internal buffer (grpc-js's object-mode default `highWaterMark`) provides real backpressure — the server sees read demand stop once that buffer fills — without this SDK's own code ever accumulating a second, unbounded queue on top of it. (There is no public `CallOptions` knob to raise/lower that buffer size from the client, so this is the correct, honest boundary of what's controllable from here.)
- **Reconnect on transient failures, honestly.** Reconnection is implemented **explicitly** in `src/transport/grpc-stream.ts` (not merely assumed from grpc-js channel-level behavior, which only covers *connection establishment*, not *resuming a broken application-level stream*). The private classifier is stream-specific: both streams retry `UNAVAILABLE`, `DEADLINE_EXCEEDED`, and `INTERNAL`; `StreamJobs` additionally retries `RESOURCE_EXHAUSTED`, while `StreamEvents` treats it as terminal. All retries use exponential backoff; cancellation (signal, status 1, or early-return) always stops silently and never reconnects. "Resume" means reconnecting with the identical logical request because neither RPC defines a cursor.
- **Normalized mapping, preserving OJS wire naming.** `streamJobs()` reuses the exact same `fromProtoJob()` unary `fetch()` already uses (via a new, narrowly-scoped `toJobData()` that only pins down the *types* `Job`'s required fields need — no field-mapping logic is duplicated). `streamEvents()` introduces `fromProtoEvent()`, mapping to the new `GrpcStreamEvent` type, which deliberately preserves the gRPC binding's own snake_case wire field names (`job_id`/`job_type`/`workflow_id`) rather than the CloudEvents-style envelope `src/events.ts`'s `OJSEventEmitter` uses internally — a different, unrelated pub/sub construct. The `stream.keepalive` sentinel message both RPCs define is filtered out of both streams and never yielded (mandatory per worker.proto for StreamJobs, and applied consistently to StreamEvents too).
- **No listener/timer/call leaks.** Every per-attempt `addEventListener`/timer/call is torn down in a `finally` block before the next reconnect attempt or generator exit, on all three exit paths (clean completion, thrown error, consumer-driven early return) — verified with `vi.spyOn` reference-counted add/remove assertions across a real reconnect cycle in `tests/transport-grpc-stream.test.ts`.
- **No speculative `OJSWorker` integration.** Not attempted, per the explicit instruction that a correct, tested transport-level API alone satisfies this requirement (see §11 for a scoped follow-up proposal).

### Why a new file (`src/transport/grpc-stream.ts`)

`transport/grpc.ts` already owns "channel/client lifecycle, unary-call plumbing, deadline/cancellation, HTTP-path→RPC routing" (see the actor map, §3). Reconnect/backoff decision-making, bounded backpressure, and per-attempt listener/timer/call cleanup for a long-lived stream are a **materially different responsibility with different failure modes** — folding the new module's ~300 lines of that logic directly into the already-1900-line `grpc.ts` would blur, not clarify, its single-actor scope. `grpc.ts` itself only gained a thin `openReconnectingStream()`/`openServerStream()` pair (resolve the client once, build one attempt's metadata/deadline) that *delegates* to the new module's `reconnectingServerStream()`. The new file is a real, narrow actor — not a generic "utils" dumping ground — and is not re-exported from the package's public surface (only its *types*, re-exported through `transport/grpc.ts`, are).

## 4b. Final-review pass: four additional high-confidence defects

A final review of the prior two passes' own output caught four defects in code those passes had already touched — three of them residual gaps in fixes previously marked "Fixed" (F-09's `meta`/`schema` mapping was only partially completed; the streaming/heartbeat pass's own `fromProtoValue` was never revisited for its pre-existing default-value bug; `subscribe.ts`'s F-04/F-05 reconnection fix never accounted for the per-job terminal-close case its own spec citation describes) plus one newly-identified concurrency/lifecycle bug in `worker.ts`. All four are **P0/P1-severity** (exactly-once correctness, wire-format data loss, and an unbounded reconnect loop) and are fixed with deterministic regression tests in this session.

| ID | Location | Finding | Status |
|---|---|---|---|
| F-29 | `src/worker.ts` (`processJob`) | The success/failure handling chained `execute(ctx).then(async (result) => { await this.ack(...); ... }).catch(async (error) => { ... await this.nack(...); ... })`. Because `ack()` was awaited *inside* the `.then()` callback, an ack failure (after `requestWithRetry()`'s own 3 attempts were exhausted) threw *inside* that callback — which rejected the promise `.then()` returned, so the failure fell through into the following `.catch()` and **incorrectly nacked a job whose handler had already succeeded**. Symmetrically, the `.catch()` branch's `await this.nack(...)` had no surrounding `try`/`catch`; since the whole `execute(ctx).then().catch().finally()` chain is fire-and-forget (`processJob()` never awaits or returns it), a nack failure propagated as an **unhandled promise rejection** in a long-running worker process. | **Fixed** — restructured to `execute(ctx).then(onSuccess, onFailure)` (the two-argument form, not a chained `.then().catch()`), so a failure *inside* `onSuccess` can never be routed to `onFailure`. `handleExecutionSuccess()`/`handleExecutionFailure()` each wrap their own ack/nack call in `try`/`catch` and never rethrow — an ack failure is logged as exactly that (an ack *delivery* failure) and never converted to a nack; a nack failure is logged and stops there, never an unhandled rejection. A shared `finishJob()` helper (also now used by the pre-existing "no handler registered" branch, which previously omitted the `resolveShutdownIfIdle()` call) guarantees exactly-once concurrency-slot release and shutdown-unblocking regardless of which terminal outcome occurred. |
| F-30 | `src/transport/grpc.ts` (`fromProtoValue`) | Decoded a `google.protobuf.Value` by checking `v.stringValue !== undefined && v.stringValue !== ''` (and the equivalent for `numberValue`/`boolValue`) — i.e., "is this oneof member's value non-zero/non-empty" as a proxy for "is it the set member". This is wrong by construction: a legitimately-set `0`, `false`, or `''` is indistinguishable from "unset" under that heuristic, so every one of those three real, on-the-wire values silently decoded as `null` instead of themselves — corrupting job args, checkpoint state, and `StreamEvents` data payloads containing any falsy-but-meaningful value. | **Fixed** — verified empirically (a real protobufjs/`@grpc/proto-loader` encode/decode round trip of this exact `Value` message, using this transport's own `loadSync()` options) that with `oneofs: true`, the decoded object carries a synthesized `kind` field naming exactly which single member is set, and every *other* member key is entirely absent (not zero-filled). `fromProtoValue()` now switches on `kind` first; a decoded value with no `kind` at all (e.g. a hand-constructed payload not using `oneofs: true`) falls back to field *presence* (still never "non-zero"); a `kind` naming something unrecognized fails safe to `null` rather than guessing. `fromProtoStruct()` needed no direct change — it already delegated per-field to `fromProtoValue()` and already handled a malformed/non-object `struct`/`fields` safely via the existing `asProtoRecord()` defaults. |
| F-31 | `src/job.ts` (`toWireOptions`) / `src/workflow.ts` (`toWireStep`) / `src/client.ts` (`enqueue`/`enqueueBatch`) | F-09 (an earlier pass) fixed `toWireStep()` to reuse the shared `toWireOptions()` instead of hand-rolling a subset mapping — but `toWireOptions()` itself never mapped `meta`/`schema` at all, and F-09's own regression test (`tests/workflow.test.ts`'s "should convert all documented job options for a workflow step...") passed `meta`/`schema` into the step's `options` input without ever asserting they appeared anywhere on the wire, so the gap went unnoticed. The result: `meta`/`schema` were silently dropped for every workflow step and batch callback. Separately (same root cause), `OJSClient.enqueue()`'s top-level request body never included `options.schema` at all (only `meta`, and only via a hand-rolled, non-empty-only check duplicated inline rather than shared), and `enqueueBatch()` included neither `meta` nor `schema` for any batch element. | **Fixed** — cross-referenced the normative wire placement first (`ojs-core.md` §5.2, `enqueue-request.schema.json`, and critically `job-options.schema.json`, which is `additionalProperties: false` and does **not** define `meta`/`schema` — nesting either inside the wire `options` object would fail schema validation against a conformant backend). Added a new shared `toWireEnvelopeFields()` in `job.ts` that maps `meta`/`schema` to the job-*envelope* level (sibling of `type`/`args`/`options`) — never inside `options` — and is now the single call site for this mapping used by `toWireStep()` (workflow steps and batch callbacks), `OJSClient.enqueue()` (top-level request body, read back off the post-middleware `job` object so a mutating enqueue middleware is still honored), and `OJSClient.enqueueBatch()` (each batch element, per `ojs-http-binding.md` §9.2: "Each element MUST follow the same schema as a single enqueue request"). `toWireOptions()` itself is deliberately unchanged — it must never include `meta`/`schema`, and a new test locks that in. Presence (not non-emptiness) decides inclusion throughout, so an explicitly-set empty `meta: {}` is now preserved rather than silently dropped (a small, deliberate behavior change from `client.ts`'s prior `Object.keys(job.meta).length > 0` check, made for internal consistency with `toWireEnvelopeFields()` and the rest of `toWireOptions()`'s own presence-based fields). |
| F-32 | `src/subscribe.ts` (`subscribe`) | F-04/F-05 (earlier passes) added mandatory reconnection-with-backoff, correctly citing `ojs-realtime.md` §9.3 — but never accounted for §2.1's documented terminal-close case: "If the job is in a terminal state (`completed`, `cancelled`, `discarded`), the server SHOULD send a single `job.state_changed` event reflecting the current state and then close the stream." Since `connectAndWait()`'s `.then()` branch (a clean stream close) unconditionally scheduled a reconnect with no regard for *why* the stream closed, `subscribeJob()` on an already-terminal (or newly-terminal) job reconnected **forever** — a permanent, silent resource/traffic leak for any caller watching a single job to completion, which is `subscribeJob()`'s primary use case. | **Fixed** — `subscribe()` now tracks (only for a `job:`-channel subscription; queue channels are unaffected, since many jobs continue to flow through a queue indefinitely) whether the just-finished connection observed a `job.state_changed` event whose `data.to` is one of `job.ts`'s `TERMINAL_STATES` (completed/cancelled/discarded — this SDK's single already-public source of truth for that set; no fourth terminal state is documented anywhere in the spec or this SDK's own state machine, so none was added). On a clean close following such an event, the subscription calls a new internal `stop()` (the same logic `unsubscribe()` already used) instead of scheduling a reconnect — permanently marking it complete and releasing its controller/timer. Malformed/fragmented `job.state_changed` data (non-JSON, non-object, non-string or absent `to`) safely reports "not terminal" rather than throwing, so normal reconnect-on-clean-close remains the fail-safe default when terminality can't be confirmed. |

### Design decisions and assumptions for this pass

- **`client.ts` was in scope even though the defect description named only `job.ts`/`workflow.ts`.** F-31's shared-helper fix could not make "ordinary enqueue... wire-compatible" true for `schema` without also touching `client.ts` — `schema` was completely unhandled there (not just placed incorrectly), for both `enqueue()` and `enqueueBatch()`. Fixing only `toWireOptions()`/`toWireStep()` and leaving `client.ts`'s independent `schema` gap in place would have left the stated requirement false.
- **`meta` empty-object handling in `client.ts` now matches `toWireEnvelopeFields()`'s presence-based semantics** (`!== undefined`, not "non-empty"), a small deliberate behavior change from the pre-existing `Object.keys(job.meta).length > 0` check, made so the envelope-building and final-body-building halves of `enqueue()` agree with each other and with the rest of this codebase's option-mapping convention (`toWireOptions()` and `cron.ts` are both presence-based already).
- **No fourth terminal job state exists to add for F-32.** `job.ts`'s `TERMINAL_STATES` (completed/cancelled/discarded) is already this SDK's public, single source of truth and matches `ojs-realtime.md` §2.1 and `ojs-core.md`'s 8-state model exactly; no other terminal state is documented anywhere consulted for this pass.
- **No new public API surface.** `toWireEnvelopeFields()` follows the exact precedent already set by `toWireOptions()`/`toWireWorkflow()`: exported from its own module (so `workflow.ts`/`client.ts` and its test file can import it) but deliberately **not** re-exported from `src/index.ts`'s public barrel. `subscribe.ts`'s new `isTerminalJobStateEvent()`/`stop()` are module-private. `worker.ts`'s new `handleExecutionSuccess`/`handleExecutionFailure`/`safeEmit`/`finishJob` are private class methods. Nothing in `SubscribeOptions`, `SSESubscription`, `EnqueueOptions`, `JobSpec`, or any other public type changed shape.

## 4c. Independent-review remediation: four additional findings

| ID | Location | Finding | Status |
|---|---|---|---|
| F-33 | `src/middleware/timeout.ts` + execution composition | Timeout used `Promise.race()` to reject upstream immediately while its downstream handler could still be running. An outer retry middleware could then invoke the same composed position again before the timed-out invocation settled, causing overlap and `"next() called multiple times"`. `ctx.signal` also remained replaced after settlement, and the abort listener registered by the timeout race was not removable. | **Superseded by F-37** — the interim fix serialized by delaying the outward timeout rejection itself. F-37 preserves immediate outward deadline reporting while moving serialization responsibility into retry via private settlement tracking. |
| F-34 | `src/durable.ts` + `GrpcTransport` checkpoint routing | `GrpcTransport.grpcGetCheckpoint()` correctly returns the canonical resource wrapper `{ checkpoint: { state, ... } }`, but `DurableContext.create()` only read the HTTP-flat `{ state, ... }` shape. Existing gRPC checkpoints therefore decoded correctly at the transport layer but were silently ignored by durable replay. | **Fixed** — durable checkpoint normalization accepts both shapes. A `GrpcTransport` + `DurableContext` integration test loads a wrapped protobuf `Struct`, replays an existing side effect without re-executing it, records a new side effect, and saves the migrated replay log back through `SaveCheckpoint`. |
| F-35 | `src/transport/grpc-stream.ts` + `src/transport/grpc.ts` | The shared stream engine retried only `UNAVAILABLE`/`DEADLINE_EXCEEDED`, so status 13 (`INTERNAL`) terminated both streams and status 8 (`RESOURCE_EXHAUSTED`) terminated `StreamJobs`, contrary to the required stream-specific recovery policy. | **Fixed** — a module-private retry-status option now carries the policy from each public stream method: status 13 retries for both streams; status 8 retries with backoff for `StreamJobs` only; cancellation remains terminal regardless of the configured set. Public integration tests deterministically verify all four status/stream combinations. |
| F-36 | `src/ml.ts` (`withCompute`) | `maxTokens`/`maxBatchSize` were emitted as `meta.resources.max_tokens`/`max_batch_size`, but the versioned resource schema is closed (`additionalProperties: false`) and defines neither key. The normative legacy extension contract defines `meta.ext_ml_max_tokens` (1–10,000,000) and `meta.ext_ml_max_batch_size` (1–100,000). | **Fixed** — `runtime`, `precision`, and `distributed_strategy` remain schema-defined `meta.resources` properties; token/batch limits use the exact legacy extension keys. Runtime validation enforces integer bounds, `ComputeConfig` is unchanged, and exact output/merge/schema-closure tests prevent either limit from re-entering `resources`. |

### Assumptions for the independent-review pass

- A handler that ignores an aborted timeout signal cannot be restarted safely. A direct timeout still reports immediately; when retry wraps it, retry waits indefinitely for that specific downstream invocation rather than consuming another attempt or worker slot.
- The gRPC checkpoint wrapper is canonical for `GrpcTransport`; the HTTP flat body remains supported for transport parity and compatibility.
- The ML split follows the explicit review direction and both authoritative contracts: schema-defined compute selectors stay in `meta.resources`, while only the two generation/inference limits use their normative `ext_ml_*` keys.
- No public type was removed or narrowed. In particular, `ComputeConfig` retains all five existing fields.

## 4d. Certification remediation: five findings

| ID | Location | Finding | Status |
|---|---|---|---|
| F-37 | `src/middleware/{timeout,retry}.ts` | Timeout needed to reject outward exactly at the deadline while still preventing retry overlap. Restoring `ctx.signal` or discarding cancellation listeners at outward rejection would hide the abort from still-running downstream work; waiting inside timeout delayed the required error. Retry delay also ignored worker cancellation. | **Fixed** — timeout rejects immediately and aborts the combined signal, while a module-private `WeakMap` links that exact `TimeoutError` to an always-settling lifecycle promise that owns downstream settlement, listener/timer cleanup, and `ctx.signal` restoration. Retry recognizes the token and waits before re-entry. Cooperative work retries without overlap; non-cooperative work consumes no second attempt. Backoff is abortable and removes its listener/timer on every path. |
| F-38 | `src/transport/grpc.ts`, `src/job.ts` | `fromProtoJob()` only mapped a small scalar subset and passed decoded timestamp objects through unchanged. It dropped metadata, result, policies, errors, expiry, durations, and lineage, and did not guarantee unary/stream parity. | **Fixed** — one mapper now normalizes all supported fields, including all timestamps, Struct/Value JSON, retry/unique policies, latest error plus history, timeout/visibility milliseconds, tags, tracing/workflow/lineage/specversion, and falsy defaults. Unary and `StreamJobs` full-fixture tests assert exact identical output. Public Job-related type additions are optional/additive. |
| F-39 | `src/transport/http.ts` | The external abort listener was detached as soon as response headers arrived, so caller cancellation during a slow `response.json()` parse was ignored; parse failure could also mask the caller's abort reason as “Invalid JSON.” | **Fixed** — listener lifetime now spans body parsing and ends only in `finally`. If parsing fails after the combined signal aborts, the caller's `Error` reason is rethrown. A partial streaming JSON body test verifies immediate rejection and exact one-for-one listener cleanup. |
| F-40 | `src/subscribe.ts` | Manual Node 18 signal composition added anonymous `{ once: true }` listeners to both internal and external signals but returned only the combined signal, leaving no way to remove listeners when a subscription stopped before either signal fired. Repeated subscriptions against one long-lived signal accumulated listeners. | **Fixed** — composition returns `{ signal, cleanup }`, uses named listeners, and removes both idempotently on unsubscribe/internal abort or external abort. Prototype listener spies provide a Node 18-compatible repeated-subscription leak regression. |
| F-41 | `src/subscribe.ts` | The SSE reconnect counter reset only after a clean close. A connection that delivered an event and then failed retained the prior failure count, so `maxReconnectAttempts: 1` could stop after fail → successful event → fail instead of granting the newly-live connection a fresh reconnect budget. | **Fixed** — the counter resets when each connection delivers its first parsed event. A deterministic fail → event → fail test confirms a subsequent reconnect occurs with a one-attempt limit. |

### Assumptions for the certification pass

- `google.protobuf.Duration` job timeout/visibility values normalize to SDK milliseconds; retry/unique policy durations normalize to ISO 8601 strings.
- Current `job.proto` exposes `workflow_id` but not the execution-history lineage extension. `parentId`/`rootId`/`causedBy` are nevertheless normalized when a compatible decoder/backend supplies them, preserving forward-compatible lineage data.
- A proto job result is accepted in either the current `Struct` representation or a `Value` representation, so scalar falsy results remain lossless across compatible schema revisions.

### 4e. Post-certification hardening: five findings

| ID | Location | Finding | Status |
|---|---|---|---|
| F-42 | `src/middleware/retry.ts` | If current attempt is final (`attempt >= maxRetries`), retry now rethrows the TimeoutError immediately without awaiting downstream settlement. Awaiting settlement is only done before an actual next retry. Non-cooperative final timeout surfaces promptly with no second invocation. | **Fixed** |
| F-43 | `src/subscribe.ts` | SSE clean closure now uses the same reconnect budget as errors: increments and checks `reconnectAttempt` before scheduling a reconnect. `maxReconnectAttempts=0` never reconnects. Counter resets only on first delivered event. | **Fixed** |
| F-44 | `src/subscribe.ts` | Whenever subscription terminates permanently (reconnect false, budget exhausted, terminal job, validation error), `stop()` is now called so all signal listeners, timers, and the internal AbortController are cleaned up. Invalid channels are classified as non-retryable even when reconnect defaults to enabled. Clean/error completion tests assert exact listener removal. | **Fixed** |
| F-45 | `src/subscribe.ts` | Synchronous `onError` throws and rejected promises from async callbacks are now caught and logged (`console.warn`), preventing unhandled rejections and ensuring reconnect/termination logic still runs. | **Fixed** |
| F-46 | `src/transport/grpc.ts` (`fromProtoDuration`) | Protobuf Duration→ISO formatting now uses `bigint`/string arithmetic: fixed 9-digit fractional nanos trimmed on right, never exponential notation, handles negative durations per protobuf normalization, preserves zero (`PT0S`), and renders the maximum protobuf seconds range exactly. | **Fixed** |

### 4f. Delivery and lifecycle follow-up: three findings

| ID | Location | Finding | Status |
|---|---|---|---|
| F-47 | Historical `src/serverless/{ojs-callback,lambda,cloudflare,vercel}.ts` | ACK/NACK helpers ignored HTTP status and response bodies, and each push adapter placed handler execution and ACK delivery in one `try`/`catch`. An ACK network/upstream failure after successful work therefore fell into the handler-failure branch and NACKed a completed job. NACK delivery failures also replaced the original handler error. | **Fixed historically, then superseded by F-118** — callback delivery and handler outcomes were first isolated and bounded; the out-of-band callback path was later removed entirely when HTTP push became response-derived. |
| F-48 | `src/transport/grpc.ts` | `close()` only closed the current client. Active streams, reconnect backoff timers, and streams sharing the transport had no transport-owned cancellation signal, so they could remain blocked or reconnect after close. | **Fixed** — each stream combines its caller signal with the current transport-generation signal and removes both source listeners on every exit. `close()` aborts that generation before closing/clearing the client, cancelling all calls and backoffs with no reconnect. A subsequent unary request or stream creates a fresh generation and may lazily initialize/reuse the transport again; stale in-progress client initialization cannot overwrite a newer generation. Tests cover active iteration, backoff timer removal, multiple streams, external-signal cleanup, and close/reopen through both stream and unary APIs. |
| F-49 | `src/subscribe.ts` | JSON parsing and handler invocation shared one `try`/`catch`. If valid JSON was parsed and the user handler threw, the catch block treated that handler exception as a parse failure and invoked the same handler a second time with `{raw: eventData}`. Async handler rejection was not awaited at all. | **Fixed** — parsing now produces exactly one `data` value inside the parse-only catch, then the handler is invoked once outside it through a promise-normalizing helper. Synchronous throws and asynchronous rejections reject the connection attempt and enter the existing error/reconnect policy without a raw-data reinvocation. Tests assert exact side-effect count, parsed payload, `onError`, and reconnect behavior for both failure modes. |

### 4g. Synchronous-failure and terminal-delivery follow-up: two findings

| ID | Location | Finding | Status |
|---|---|---|---|
| F-50 | `src/subscribe.ts` | Per-job terminal state was recorded before handler dispatch, but the connection rejection path ignored it. If that terminal event's handler threw or rejected, normal error policy could reconnect and replay a job event after the subscription had already observed a state from which no further events are possible. | **Fixed** — handler failures still notify `onError` at most once with synchronous and asynchronous callback failures isolated, then terminality forces the same idempotent `stop()` path as clean terminal completion. Tests assert sync throw, async rejection, exact listener removal, internal abort, and no subsequent fetch after 60 seconds of fake time. |
| F-51 | `src/middleware.ts` | `composeExecution` and `composeEnqueue` invoked middleware and final handlers before a promise existed. A synchronous throw escaped before `.finally()` could be attached, leaving that dispatch position permanently present in the pending guard and breaking a legitimate sequential retry with `"next() called multiple times"`. Direct synchronous handler/final-enqueue throws also escaped instead of becoming returned promise rejections. | **Fixed** — every middleware, execution handler, and final enqueue invocation now runs inside `Promise.resolve().then(...)`, with guard deletion in the resulting promise's `finally`. Tests cover execution retry after a synchronous middleware throw, enqueue retry ending in a drop, direct synchronous handler/final-enqueue rejection, and preservation of concurrent double-next rejection. |

### 4h. Node 18/browser crypto compatibility follow-up: one finding

| ID | Location | Finding | Status |
|---|---|---|---|
| F-52 | `src/crypto.ts`, `src/uuid.ts`, `src/encryption.ts`, `src/attest/index.ts`, `src/durable.ts`, `src/transport/http.ts`, `src/events.ts`, `src/worker.ts` | Private crypto handling was fragmented. The prior pass fixed request/event/worker UUID generation, but AES-GCM encryption, attestation SHA/HMAC, and durable random bytes still referenced ambient Web Crypto globals directly, so Node 18 and partial browser-like globals remained broken for genuine cryptographic operations. UUID generation also used a separate provider and package dependency rather than the same runtime abstraction. | **Fixed** — one new private module, `src/crypto.ts`, now owns all internal crypto runtime resolution. Synchronous random bytes come from `@noble/hashes@1.8.0` (never `Math.random()`), which supports Node 18 and browsers through maintained cross-runtime package exports. Asynchronous `getWebCrypto()` accepts ambient `globalThis.crypto` only when it is complete for the SDK's needs (`getRandomValues`, plus `subtle.digest`/`importKey`/`encrypt`/`decrypt`/`sign`), otherwise lazily imports `node:crypto` and uses `.webcrypto`; the fallback is cached safely under concurrency and cleared after failure so later calls can retry. `src/uuid.ts` now formats RFC 4122 v4 IDs from provider bytes, removing the `uuid` dependency entirely while preserving the exact `worker_<uuid>`, `evt_<uuid>`, and bare request-ID wire shapes. `src/encryption.ts`, `src/attest/index.ts`, and `src/durable.ts` now route through the same provider, preserving algorithms and wire formats aside from fresh randomness. Private seams in `src/crypto.ts` support deterministic/provider tests without public package exports. New `tests/crypto.test.ts` covers ambient crypto absent, partial, and browser-like cases; dynamic Node fallback; concurrency/cache; fallback retry after failure; deterministic UUID/durable/encryption seams; and clean ESM/CJS import-fallback execution. The full suite now passes **764/764** tests on Node 18.20.8, 20.20.2, and 22.23.1. |

### 4i. Enqueue-options gRPC conversion follow-up: one finding

| ID | Location | Finding | Status |
|---|---|---|---|
| F-53 | `src/transport/grpc.ts` (`mapEnqueueOptions`, `grpcEnqueue`, `grpcEnqueueBatch`) | job.proto's `EnqueueOptions` message (shared by `EnqueueRequest.options`, `BatchJobEntry.options`, and `EnqueueBatchRequest.default_options`) is a strongly-typed protobuf message: `delay_until`/`meta` are `Timestamp`/`Struct`, `timeout`/`ttl`/`visibility_timeout`/`retry.initial_interval`/`retry.max_interval`/`unique.period` are `Duration`, and `unique.on_conflict`/`unique.states` are enums encoded as string names (`enums: String`). The previous `mapEnqueueOptions()` simply `Object.assign`ed the caller's HTTP-wire `options` object onto the request as-is — every `*_ms` millisecond field, RFC 3339 `delay_until`/`expires_at` string, ISO 8601 `retry`/`unique` duration string, and lowercase `on_conflict`/`states` enum string reached the generated client completely unconverted (and `enqueueBatch()` had no `default_options` handling at all), so nothing beyond a bare `queue`/`priority`/`tags` could ever have worked against a real proto-loader-encoded wire. Envelope-level `meta`/`schema` (siblings of `type`/`args`/`options`, per `enqueue-request.schema.json`) were also never read at all — `EnqueueRequest`/`BatchJobEntry` have no top-level `meta` field of their own, so that metadata had nowhere else to go and was silently dropped; `schema` has no proto carrier whatsoever. | **Fixed** — a single strict, shared HTTP-wire→protobuf converter (`mapEnqueueOptions`/`buildProtoEnqueueOptions` plus per-field helpers) now backs single `enqueue()`, every job in `enqueueBatch()`, and the actual `EnqueueBatchRequest.default_options`/`defaultOptions` protobuf field (accepting either raw-caller spelling). It maps `queue`; `priority` including explicit `0`; `delay_until` with strict RFC 3339 parsing, all nine fractional digits, and canonical pre-epoch `Timestamp` normalization; integer `timeout_ms`/`visibility_timeout_ms` to `Duration`, preserving explicit `0`; `expires_at` to a positive relative `ttl` and rejects malformed/expired values; the full `retry` and `unique` policies; exact protobuf enum string names; tags; trace ID; max attempts; and envelope-level metadata to `Struct`. Unsupported fields, malformed/non-object options, invalid queue/numeric/enum/duration/timestamp values, and non-JSON/cyclic metadata fail as `OJSValidationError` before the generated client is invoked; envelope-level `schema` fails explicitly as `unimplemented`. Batch defaults are both encoded in `request.defaultOptions` and resolved under each entry's whole-field overrides without mutating defaults, per-job options, or metadata, while preserving request order. New `tests/transport-grpc-enqueue-options.test.ts` (59 tests) covers every field plus single/batch/default/override/explicit-zero/nanosecond/pre-epoch/invalid/metadata/schema cases using captured generated-client requests and actual `@grpc/proto-loader` message serialization against `tests/fixtures/proto/ojs/v1/enqueue_options.proto`. The full suite passes **823/823** tests on Node 18.20.8, 20.20.2, and 22.23.1. |

### 4j. Unique-options compatibility, gRPC progress, and SSE reader-cancellation follow-up: three findings

| ID | Location | Finding | Status |
|---|---|---|---|
| F-54 | `src/transport/grpc.ts` (`buildProtoUniquePolicy`) | Public `UniqueOptions.key` (`src/job.ts`) is documented (and, per `README.md`, always has been) as "fields from args to use as uniqueness key" (e.g. `['id']`) — the common application-code usage. But the wire-level `UniquePolicy.key` it maps to unconverted is actually a `repeated string` of protocol *dimensions* (`type`/`queue`/`args`/`meta`, per `ojs-unique-jobs.md` §4), and some callers already think in those wire terms and pass dimension names directly. `buildProtoUniquePolicy()` only accepted the four dimension names and threw `OJSValidationError` for anything else, so every caller using `key` as documented (an actual args field name like `'id'` or `'tenant_id'`) had every gRPC enqueue call rejected outright — this converter was simply incompatible with its own documented public API for one of its two legitimate uses, and had no way to express a mix of both (e.g. `['type', 'id']`). | **Fixed** — `key` entries that name a known dimension (`type`/`queue`/`args`/`meta`) are passed straight through as before; every other non-empty entry is now treated as an args field name, which implies the `args` dimension (added to the proto `key` list exactly once if not already present) and is folded into `argsKeys`, merged with any explicit `unique.args_keys`. Input order is preserved and duplicates are removed using first-seen order in both the derived `key` and merged `argsKeys` lists; the caller's `unique.key`/`unique.args_keys` arrays are never mutated. Mixed dimension+args-field arrays are supported, while empty entries still reject. `src/job.ts`'s `UniqueOptions.key` doc comment and `README.md`'s `UniqueOptions` table now document both accepted forms. New tests in `tests/transport-grpc-enqueue-options.test.ts` cover `['id']`, `['tenant_id']`, `['type', 'id']`, standard all-dimension `key`, repeated key entries, explicit `args_keys` merging/deduplication with and without overlap, empty entries, and no-mutation of both input arrays. |
| F-55 | `src/transport/grpc.ts` (`grpcProgress`) | `PUT /jobs/{id}/progress` (routed to the private `grpcProgress()`) silently resolved `Promise.resolve({})` regardless of input, as if a real backend had received and recorded the progress report. job.proto/service.proto (confirmed against `ojs-proto`'s `service.proto` RPC list) define **no progress RPC at all** — there is no wire operation this call could ever actually forward to over gRPC. Every `reportProgress()` (`src/progress.ts`) caller using a `GrpcTransport` therefore believed its progress reports were being recorded when they were unconditionally discarded, with no way to detect the gap. | **Fixed** — `grpcProgress()` now always rejects with a non-retryable (`retryable: false`) `OJSError` carrying code `unimplemented` and a message explaining that the current gRPC proto has no progress RPC and that `HttpTransport` should be used instead. It never resolves successfully for any input, signal, or timeout. `src/progress.ts`'s module doc comment now documents this gRPC gap explicitly. New tests in `tests/transport-grpc.test.ts` cover: the route always rejecting with `{code: 'unimplemented', retryable: false}`; the generated client never being reached for any plausibly-named progress method; rejection regardless of the reported value/optional `data`; rejection with an abort signal/explicit timeout supplied; and `reportProgress()` itself (the actual client-facing progress API) rejecting rather than resolving when called against a `GrpcTransport`, for boundary percentages 0 and 100. |
| F-56 | `src/subscribe.ts` (`connectOnce`) | The SSE read loop's `finally` block called only `reader.releaseLock()` on every exit path, including abnormal ones — a synchronously throwing or asynchronously rejecting event handler (via `invokeEventHandler`), a `reader.read()` failure (including one surfaced by `signal` aborting mid-read), or a decode/parse failure escaping its own local `try`/`catch`. Releasing the lock alone leaves the underlying source (the fetch response body/connection) neither cancelled nor told that no further reads will occur, which can leave it half-read/open instead of torn down. | **Fixed** — abnormal exits now go through a new `catch` block that calls `await reader.cancel(err)` before the `finally`'s `releaseLock()`, passing the triggering error as the cancellation reason; the `cancel()` call is wrapped in its own `try`/`catch` so a failing/rejecting cancellation is swallowed and never replaces or masks the original error, which is always rethrown unchanged. A clean EOF (the `while` loop's normal `break` on `done`) never enters the `catch` and is unaffected — it still only releases the lock, since there is nothing left to cancel. New tests in `tests/subscribe.test.ts` (`SSE reader cancellation on abnormal exit (connectOnce)`) cover: a synchronously throwing handler, an asynchronously rejecting handler, a `reader.read()` failure, `cancel()` called strictly before `releaseLock()`, a failing `reader.cancel()` never replacing or suppressing the original error, no cancellation on a clean EOF close, and a real-`ReadableStream`-backed connection-leak regression asserting the underlying source's own `cancel(reason)` callback fires end-to-end. |

### 4k. Canonical unique policy and gRPC remote cancellation: two findings

| ID | Location | Finding | Status |
|---|---|---|---|
| F-57 | `src/job.ts`, `src/validation/schemas.ts`, `src/transport/grpc.ts` | The SDK's public unique API and HTTP wire shape still centered on legacy singular `key`, while the normative JSON schema requires plural `keys` plus `args_keys`/`meta_keys`. Developer callers had no typed canonical selectors, HTTP requests serialized schema-invalid `key`, gRPC responses exposed the same noncanonical field, and the gRPC converter did not accept canonical raw `keys`. Legacy normalization also existed only inside the gRPC converter, so HTTP and workflow calls behaved differently. | **Fixed** — `UniqueOptions` now has canonical `keys`, `argsKeys`, and `metaKeys`; `UniquePolicy` exposes canonical wire fields and retains deprecated `key` only as a readable compatibility alias. One shared non-mutating normalizer orders canonical entries first, merges deprecated `key` dimensions/selectors deterministically, implies `args` for legacy args selectors, and deduplicates in first-seen order. Empty `argsKeys` is valid, while present selector entries must be non-empty and unique; `metaKeys` must be non-empty when supplied, and selecting `meta` requires it. `toWireUnique()` emits only `keys`, `args_keys`, `meta_keys`, `period`, `on_conflict`, and `states`. The gRPC converter accepts canonical `keys` and legacy raw `key`, maps dimensions to protobuf singular `key`, and maps selectors to `argsKeys`/`metaKeys`; proto responses normalize back to canonical `keys`. README/examples document canonical usage and the legacy merge rules. Tests cover HTTP client bodies, direct wire normalization, workflow steps, full-job golden response normalization, schema-shape validation, protobuf serialization, canonical/legacy merging, conflicts, empty selectors, and input immutability. |
| F-58 | `src/transport/grpc-stream.ts`, `src/transport/grpc.ts` | The reconnecting stream engine treated every received gRPC status `CANCELLED` as proof of its own cleanup and returned normally. A backend or intermediary could therefore remotely cancel `StreamJobs` or `StreamEvents`, and consumers would observe an ordinary end instead of the terminal transport failure. | **Fixed** — after first checking the combined caller/transport abort signal, a caught `CANCELLED` status with a live signal is now thrown as the original error. External abort and `GrpcTransport.close()` still abort the combined signal before cancelling the call and therefore terminate silently; consumer early return still unwinds through `finally`, cancels the call, and surfaces no cleanup error. Low-level and public API tests cover remote `CANCELLED`, external abort, transport close, and early break for both `StreamJobs` and `StreamEvents`. |

### 4r. gRPC ack-result, workflow-mapping, and cron-options follow-up: three findings

| ID | Location | Finding | Status |
|---|---|---|---|
| F-62 | `src/transport/grpc.ts` (`grpcAck`) | `AckRequest.result` (worker.proto) is a `google.protobuf.Struct`, but `grpcAck()` assigned the caller's plain JS result object straight through to `request.result` (`{...}` rather than `{ fields: { ... } }`), so no real proto-loader-encoded wire could accept an ack with a result — the field's on-the-wire type was never produced. A bare scalar/array result (which a `Struct` cannot represent at all) would likewise have been passed through unconverted. | **Fixed** — an object result is now converted through `toProtoStruct` (refactored to take a `{ label, wireField }` context so its rejection message names `AckRequest.result` rather than always blaming checkpoint state) into `{ fields: { <key>: Value } }` before the RPC; an omitted or explicit-`null` result still omits the field entirely (a job with no result). A bare scalar/array result is rejected with a non-retryable `OJSValidationError` before the RPC — never silently encoded as an empty Struct. New `tests/transport-grpc-workflow-cron-ack.test.ts` covers empty/nested/mixed-value results (including `0`/`false`/`''`/`null`), omitted and `null` results, and scalar/array/numeric rejection, using both captured requests and actual `@grpc/proto-loader` `serialize()`/`deserialize()` round-trips through a real `AckRequest` fixture message. |
| F-63 | `src/transport/grpc.ts` (`grpcCreateWorkflow`) | The public workflow builders serialize a *nested* wire tree (`{ type: 'chain', steps: [...] }` / `{ type: 'group', jobs: [...] }`, with jobs and nested primitives inside), but `grpcCreateWorkflow()` read a flat top-level `body.steps` and echoed each step's own `id`/`depends_on`/`args` verbatim. Consequently it produced **no steps at all** for a `group` (whose elements live under `jobs`, not `steps`), never generated the stable step IDs or `depends_on` edges the builders don't carry, and silently dropped every step's enqueue options/`meta`. Batch workflows — which proto's static `WorkflowStep` DAG cannot represent (no conditional `on_complete`/`on_success`/`on_failure`) — were mapped to an empty/garbage request rather than rejected. | **Fixed** — a recursive flattener now translates the nested chain/group tree (including nested group-in-chain and chain-in-group) into a proto `CreateWorkflowRequest` `WorkflowStep` DAG: each job becomes a step with a deterministic, stable positional `id` (`step-0`, `step-1-0`, …), an explicit `depends_on` derived from primitive semantics (chain = sequential edge to the previous element's exits; group = shared incoming, exits unioned), `args` converted via `toProtoValue`, and the shared enqueue-options converter (`mapEnqueueOptions`, incl. envelope `meta`) producing the step's `EnqueueOptions`. The top-level `name` is preserved. A batch (at any nesting depth) is rejected structurally by its callbacks with a non-retryable `unimplemented` `OJSError` **before** the RPC, so an ordinary job handler whose type is literally `batch` remains valid; an unrepresentable envelope `schema` on a step is rejected the same way, and an empty step list is never sent. New tests cover chain/group linear/shared dependencies, nested group-in-chain and chain-in-group edges, deterministic IDs/order, step option+meta conversion, name preservation, handler-name discrimination, and batch/schema/empty rejection with the RPC never invoked — plus a real `CreateWorkflowRequest` serialization round-trip. |
| F-64 | `src/transport/grpc.ts` (`grpcRegisterCron`, `grpcListCron`) | `RegisterCronRequest.options` and `CronEntry.options` (service.proto) are `EnqueueOptions` messages, and `CronEntry` also carries `args`/`next_run_at`/`last_run_at`. `grpcRegisterCron()` dropped the cron definition's `options` and envelope `meta` entirely (mapping only name/cron/type/args/timezone), and `grpcListCron()` returned only name/cron/timezone/type — discarding each entry's args, options, and run timestamps. | **Fixed** — `grpcRegisterCron()` now maps the definition's nested `options` plus envelope-level `meta` through the shared HTTP-wire→proto `EnqueueOptions` converter (`mapEnqueueOptions`, preserving explicit zero fields such as `priority: 0` and rejecting an unrepresentable envelope `schema`) into `request.options`. `grpcListCron()` decodes each entry's `args` (via `fromProtoValue`), `options` (via a new `fromProtoEnqueueOptions` inverse that reconstructs `queue`/`priority`/`delay_until`/`timeout_ms`/`retry`/`unique`/`tags`/`trace_id`/`max_attempts`/`visibility_timeout_ms`/`meta`, skipping unset message fields and default scalars), and `next_run_at`/`last_run_at` (via `fromProtoTimestamp`) into the `CronJobInfo` wire shape. New tests cover registration option/meta/zero mapping and schema rejection with captured + real-`RegisterCronRequest` serialization, and a listing round-trip decoding real `CronEntry`/`ListCronResponse` messages (args/options/timestamps, and default-only entries that omit them). |

### 4s. gRPC ack-warning, workflow-envelope, and cron-pagination/register follow-up: three findings

| ID | Location | Finding | Status |
|---|---|---|---|
| F-65 | `src/transport/grpc.ts` (`grpcAck`) | F-62 made `grpcAck()` reject a bare scalar/array ack result with a non-retryable `OJSValidationError` *before* the RPC. But by the time `ack()` runs, the job handler has **already completed successfully** — `OJSWorker.handleSuccess()` (`src/worker.ts`) catches an ack failure and only logs it, it never converts it into a nack. So a handler that resolved with e.g. a bare number/string/array left its job **neither acked nor nacked**, stranding an already-successful execution until its visibility timeout expired and the server redelivered it — silently double-processing a job whose result simply couldn't be stored on the current wire. | **Fixed** — a non-object ack result no longer throws. `grpcAck()` now acks the job **without** its result (the RPC still proceeds, so `acknowledged: true` reaches the direct caller and completion is preserved) and reports the limitation exactly once via a new backward-compatible `GrpcTransportConfig.onWarning` callback (defaulting to `console.warn`), passed a `GrpcProtocolWarning` with a stable `code` (`'ack_result_unrepresentable'`), a descriptive `message` naming `AckRequest.result`, and `originalResultType` (`typeof` the value, with arrays reported as `'array'`). Omitted/`null` results and valid objects still never warn. `onWarning` itself is wrapped so a throwing handler can never break the ack. New direct-transport tests (`tests/transport-grpc-workflow-cron-ack.test.ts`) cover string/array/numeric results acking without a result and warning exactly once (with a custom `onWarning` and with the `console.warn` default), plus no warning for omitted/`null`/object results. New worker-level tests (`tests/worker-grpc-ack-warning.test.ts`) run a real `OJSWorker` end-to-end over a capturing `GrpcTransport` and assert: the handler runs exactly once (no redelivery), exactly one `ack` RPC and zero `nack` RPCs are issued for scalar/array results, and the warning fires exactly once per run. |
| F-66 | `src/client.ts` (`OJSClient.workflow`, `getWorkflow`) | Both `ojs-http-binding.md` §14.1/14.2 and `GrpcTransport`'s `grpcCreateWorkflow`/`grpcGetWorkflow` (§4r, F-63) wrap the workflow status in a `{ workflow: {...} }` envelope — the same shape used by every other create/get response. `OJSClient.workflow()`/`getWorkflow()` returned `response.body` directly, assuming it *was* the flat `WorkflowStatus`. Over `GrpcTransport` this meant the public API resolved with the raw `{ workflow: {...} }` wrapper object instead of the status itself — `status.state`, `status.id`, etc. were all `undefined` one level too shallow. | **Fixed** — a new `unwrapWorkflowResponse()` helper returns `body.workflow` when present, and falls back to treating `body` itself as the flat `WorkflowStatus` otherwise — tolerating a server/test double built against the previous unwrapped shape without a breaking change. Both `workflow()` and `getWorkflow()` now go through it. New tests in `tests/client.test.ts` cover both the wrapped and flat response shapes for each method, and new tests in `tests/transport-grpc-workflow-cron-ack.test.ts` exercise a real `OJSClient` over a capturing `GrpcTransport` end-to-end, confirming the previously-returned envelope no longer leaks through. |
| F-67 | `src/transport/grpc.ts` (`routeRequest`, `grpcListCron`, `grpcRegisterCron`) | Two compounding bugs in cron support: (1) `routeRequest()` matched `normalizedPath` against route patterns via **strict equality**, with no query-string handling at all — so `CronOperations.list()`'s own request path (`/cron?page=2&per_page=10`, built by `src/cron.ts`) never matched `normalizedPath === '/cron'`, and `grpcListCron()` itself never read, validated, or applied `page`/`per_page` even when it *was* reached. (2) `grpcRegisterCron()` returned only `{ name: response.name }` — not the documented `{ cron_job: CronJobInfo }` envelope `CronOperations.register()` reads via `response.body.cron_job` — so `cron.register()` always resolved with `undefined` over `GrpcTransport`. | **Fixed** — `routeRequest()` now splits any query string off the path before route matching (used by every route, not just cron) and passes it to `grpcListCron()`. `grpcListCron()` validates `page`/`per_page` (positive integers, defaulting to `1`/`25`; a present non-positive-integer value is a non-retryable `OJSValidationError`), fetches every entry via one `ListCron` RPC (service.proto's `ListCronRequest` carries no pagination at all), sorts them by `name` for a deterministic/stable order, and slices the requested page into `{ cron_jobs, pagination: { page, per_page, total } }`. `grpcRegisterCron()` now returns `{ cron_job: CronJobInfo }`: reconstructed from the request body (cron/type/args/timezone/options), refined by the authoritative `RegisterCronResponse.name`/`next_run_at`, `status: 'active'` (service.proto has no paused/disabled state), and a client-captured `created_at` (service.proto has no creation-timestamp field at all — documented as an approximation, not a server-authoritative value). A best-effort follow-up `ListCron` lookup for the same name supplies more authoritative `args`/`options`/`timezone` when it succeeds and finds the entry; any failure (including a race where the entry isn't visible yet) falls back to the request-derived reconstruction without ever failing the already-successful registration. New `tests/cron-operations-grpc.test.ts` drives real `CronOperations` (not just raw transport requests) over a capturing `GrpcTransport`, covering default/explicit pagination, stable name-sorted ordering regardless of RPC response order, an out-of-range page, invalid `page`/`per_page` query values sent directly, register()'s request-derived and authoritative-lookup-refined reconstruction, the best-effort-lookup-failure fallback, and the exact registerCron/listCron requests captured. |

### 4t. Workflow-status and gRPC-NACK normalization follow-up: two findings

| ID | Location | Finding | Status |
|---|---|---|---|
| F-68 | `src/transport/grpc.ts` (`fromProtoWorkflow`, create/get workflow routes), `src/workflow.ts` | `fromProtoWorkflow()` exposed only `id`/`name`/`state`/`steps`, so a real gRPC response did not conform to the public `WorkflowStatus`: `type` and `metadata` were missing, proto timestamps were left unused, and the public type could not describe the already-returned step details. The proto also does not store the originating chain/group/batch primitive. | **Fixed, with the original get-time inference superseded by F-83** — responses include `id`, `name`, normalized `type`/`state`, metadata with RFC 3339 `created_at`/optional `completed_at` and counts derived from the stable ordered step list, plus backward-compatible optional typed `steps`. Create passes and caches the submitted top-level primitive (important for groups containing nested chains). Get uses that authoritative per-transport cache and throws explicit non-retryable `unimplemented` on a cache miss; it never infers from dependency edges. Real proto-loader response round-trips cover create/get timestamps, counts, order, cached type preservation, workflow state, and the external-ID error; existing client runtime cases cover flat and wrapped response envelopes. |
| F-69 | `src/transport/grpc.ts` (`grpcNack`) | gRPC NACK previously sent only `code`, `message`, and `retryable`, defaulted an omitted retryability flag to `false`, dropped `attempt`/`occurred_at`/`backtrace`/`details`, and returned `next_attempt_at` as the raw proto object. | **Fixed** — every `JobError` field maps to the request; omitted `retryable` defaults to `true` before proto3 serialization while explicit `false` and `attempt: 0` are preserved; `occurred_at` is validated/encoded as `Timestamp`; `details` is validated/encoded as `Struct`; invalid inputs fail before the RPC; and the response timestamp passes through `fromProtoTimestamp`. Captured request tests and real `NackRequest` serialization cover full/minimal/zero/false/invalid cases and normalized response time. |

### 4u. Transport/lifecycle hardening follow-up: ten findings

| ID | Location | Finding | Status |
|---|---|---|---|
| F-70 | `src/middleware/{timeout,retry,timeout-settlement}.ts` | Retry waited forever for a timed-out non-cooperative handler, hanging the worker slot; starting another attempt without settlement would overlap shared context. | **Fixed** — `TimeoutOptions.settlementGraceMs` defaults to 100 ms; outward timeout rejection remains immediate, retry waits only that bound, retries cooperative settlement, and rethrows the original `TimeoutError` when work remains live. |
| F-71 | `src/middleware/timeout.ts` | Nested timeouts restored a captured `ctx.signal` directly, so out-of-order late settlement could restore an aborted/stale inner signal. | **Fixed** — a private `WeakMap<JobContext, timeout-frame stack>` marks frames settled and pops only settled top frames; worker cancellation propagates through all layers and the original signal returns after every frame settles. |
| F-72 | Historical `src/serverless/ojs-callback.ts`, serverless option types | Callback delivery consumed response bodies before checking status, so endless 2xx/error bodies could stall an invocation. | **Fixed historically, then superseded by F-118** — the callback path was first bounded; it was later removed entirely once HTTP push became response-derived and no non-HTTP mode needed it. |
| F-73 | `src/subscribe.ts` | External SSE abort only aborted the composed fetch signal; an already-scheduled reconnect timer remained live until its deadline. | **Fixed** — external abort invokes the same idempotent stop path as unsubscribe, immediately clearing timers/listeners and preserving the external abort reason. |
| F-74 | `src/subscribe.ts` | Every SSE HTTP status was retried and status metadata was lost, causing permanent 400/401/403/404/422 loops. | **Fixed** — exported `SSEConnectionError` preserves status/retry hints; only 408/425/429/5xx, network/stream drops, and clean closures reconnect. Permanent HTTP and handler failures stop and clean up; `Retry-After` and SSE `retry:` hints are honored. |
| F-75 | `src/transport/grpc.ts` (`fromProtoStruct`) | Assigning decoded Struct keys with `result[k] = ...` let `__proto__` invoke the inherited setter and mutate the result prototype. | **Fixed** — every recursive field is installed with `Object.defineProperty` on a normal object, preserving `__proto__`, `constructor`, and `prototype` as enumerable own data without pollution. |
| F-76 | `src/transport/grpc.ts` (`fromProtoTimestamp`) | The OJS protobuf zero timestamp sentinel decoded as the Unix epoch rather than absent. | **Fixed** — `{seconds:0,nanos:0}` returns `null`; nonzero epoch-adjacent nanos remain valid. |
| F-77 | `src/cron.ts`, `src/transport/grpc.ts` | `CronJobInfo.status`/`created_at` were required even though current gRPC cron messages carry neither; list could not truthfully provide creation time. | **Fixed** — both fields are optional. HTTP values pass through; gRPC list and registration return semantically certain `status:'active'`, list omits `created_at`, and registration retains its documented locally captured timestamp. |
| F-78 | `src/job.ts`, `src/validation/schemas.ts`, `src/transport/{http,grpc}.ts` | Unique-policy validation diverged across serialization/transports and from the canonical schema. | **Fixed** — dimensions/selectors/states enforce exact enums and uniqueness; empty `args_keys` is valid with non-empty entries when present; selected `meta` requires non-empty `meta_keys`; period/conflict/state validation is shared across SDK, raw HTTP, and raw gRPC paths. Weeks convert exactly to protobuf Duration; calendar years/months fail clearly over gRPC because they are not exactly representable. |
| F-79 | `src/{job,workflow,client,worker}.ts`, `src/transport/grpc.ts` | Public response types encoded transport-specific impossibilities: canonical backtrace arrays were rejected, workflow `available`/null IDs/HTTP fields were absent, and normalizers fabricated or dropped data. | **Fixed** — `JobError.backtrace` accepts canonical arrays plus legacy strings; gRPC responses split strings into frames and NACK joins arrays. Workflow steps include `available`, nullable `job_id`, optional dependencies/IDs, index, and HTTP args/options/result/timestamps; HTTP fields are preserved and gRPC derives index/null IDs. |

### 4v. Cancellation-honesty/encoding follow-up: eight findings

| ID | Location | Finding | Status |
|---|---|---|---|
| F-80 | `src/middleware.ts` | `composeExecution()`/`composeEnqueue()` tracked re-entrancy with a `Set<number>`/`Map<number, ...>` keyed purely by chain-position *index*, deleted (or left mutable) once a call settled regardless of outcome. This allowed a position's `next()` to be called again *after it had already succeeded* — not just after a rejection — since nothing distinguished "settled successfully" from "settled by failing." It also meant a retried attempt's fresh downstream calls could collide with guard state left over from an earlier attempt at the *same* nominal position, once state was tracked per-index rather than per-invocation. | **Fixed** — each chain position now gets a fresh `next()` closure with private state on every entry (including every retry-driven re-entry), and that closure allows a further call only after its own prior call rejected; a further call after its own prior call *resolved* is rejected with a distinct, explicit error. Concurrent double-calls (present before) remain rejected identically. |
| F-81 | `src/transport/grpc-stream.ts`, `src/transport/grpc.ts` | `reconnectingServerStream()` was a native `async function*`, and `GrpcTransport.streamJobs()`/`streamEvents()` wrapped it in another native `async function*`. A native async generator's `.return()`/`.throw()` — exactly what a consuming `for await`'s `break`/`return`/`throw` invokes — are queued behind any already-pending `.next()` call per the ECMAScript AsyncGenerator spec. A consumer that called `.next()` (blocked on network I/O or a reconnect backoff sleep, potentially indefinitely) and then tried to cancel via `.return()`/`.throw()` before that `.next()` settled would have its cancellation request silently wait, with no way to interrupt the wait itself. | **Fixed** — both layers now return a hand-built `AsyncIterableIterator` object (not a native generator) whose `.return()`/`.throw()` execute *immediately* when called: they synchronously abort a private `AbortController`, which — because `AbortController.abort()` dispatches its event synchronously, not via a microtask — instantly triggers the underlying engine's own per-attempt abort listener (cancelling the active call) or resolves an in-progress backoff `delay()`, with no dependency on whatever `.next()` step happens to be pending. Ordinary external/transport `signal` cancellation and normal iteration are unchanged. |
| F-82 | `src/subscribe.ts` | The reconnect-backoff counter was reset only once per connection, on the first *parsed* SSE event (`deliveredEvent` inside `subscribe()`'s `trackingHandler`). A heartbeat/keep-alive comment line (`:...`, ojs-realtime.md section 9.2) — real proof a connection is alive, sent by servers specifically so idle connections aren't mistaken for dead ones — was silently ignored by the parser (`connectOnce()` had no branch for a comment line at all) and did nothing to the reconnect budget. A connection that received only heartbeats before dropping was treated exactly like one that never connected at all. | **Fixed** — `connectOnce()` now recognizes comment lines and reports them (and every parsed event, at the same point in the frame boundary a prior version already used) through a new `ConnectCallbacks.onActivity` callback; `subscribe()` resets its reconnect-attempt counter from that one callback for both cases. An empty/no-op chunk read from the underlying stream (one that decodes to no complete SSE line at all) never reaches this callback and therefore never resets the counter. |
| F-83 | `src/transport/grpc.ts`, `src/workflow.ts` | `fromProtoWorkflow()` inferred `type: 'chain'` whenever any step had a dependency edge and `'group'` otherwise (`inferWorkflowType()`). This is wrong for a legitimate single-step `chain` (which has *no* edges at all — there is nothing for its one step to depend on — so it was misreported as `'group'`), and can never distinguish a `batch`'s underlying jobs from an edge-free `group` either way, since the current `Workflow` proto carries no originating-primitive field at all. | **Fixed** — `GrpcTransport` caches the authoritative `'chain'`/`'group'` type by server-assigned workflow ID at `createWorkflow()` time (a bounded, FIFO-evicted, per-instance `Map`; `'batch'` never reaches the cache since it is rejected before the RPC). `getWorkflow()` consults that cache; a cache miss (a workflow ID this transport instance did not itself create) throws an explicit non-retryable `unimplemented` `OJSError` instead of guessing from the step DAG's edges. `inferWorkflowType()` and the non-standard public `'dag'` value were removed entirely — `WorkflowStatus.type` remains exactly `'chain' | 'group' | 'batch'`. |
| F-84 | `src/transport/grpc.ts` | `toProtoValue()`'s nested-struct-field loop, `toProtoStruct()`, `toProtoJsonValue()`, and `enqueueMetaToProtoStruct()` all accumulated dynamic, caller-controlled map/Struct fields on a plain `{}` object literal. `JSON.parse()` gives `__proto__`/`constructor`/`prototype` real, enumerable *own* properties (its `[[DefineOwnProperty]]`-based semantics bypass `Object.prototype`'s `__proto__` accessor), so a real job/meta/result payload containing a literal `"__proto__"` key would, once the encoder did `fields[k] = ...`, silently reassign the accumulator's own prototype instead of creating a data property — losing that key from the wire payload entirely (and corrupting the accumulator object's own prototype chain with attacker-influenced data), while `fromProtoStruct()`'s *decoding* direction had already been hardened this way in F-75. | **Fixed** — all four encoding-side builders now use `Object.create(null)` for their field accumulator, matching `fromProtoStruct()`'s existing `Object.defineProperty`-based decode-side protection. `__proto__`, `constructor`, and `prototype` keys are preserved as ordinary data through actual `@grpc/proto-loader` `serialize()`/`deserialize()` round-trips for generic Struct values, enqueue metadata, job args, NACK error details, and durable checkpoint state, including nested objects/lists. |
| F-85 | `src/job.ts`, `src/validation/schemas.ts`, `src/transport/grpc.ts` | F-78 (§4u) already aligned `args_keys`-may-be-empty-but-entries-must-be-unique, `meta_keys`-required-and-non-empty-when-`meta`-selected, exact `period`/`states`/`on_conflict` enums/patterns across the developer-normalization path (`normalizeUniqueSelection`/`toWireOptions`), the HTTP validator (`validateUniquePolicy`), and the raw gRPC converter (`buildProtoUniquePolicy`) — but no test asserted all three actually agree on the *same* input set, so a future change to any one of them could silently reintroduce drift undetected. | **Verified, and locked in with new tests** — a shared table of ~25 canonical unique-policy fixtures (valid and invalid) is now run through all three validation entry points in one parity suite; every case agrees. One narrow, intentional, already-documented exception (a calendar year/month `period` is schema-valid but rejected only by gRPC, since `google.protobuf.Duration` cannot represent it exactly) is captured in its own explicit test rather than being conflated with genuine drift. |
| F-86 | `src/progress.ts`, `src/index.ts` | The exported `ProgressReport` type was `{ job_id, percentage, message?, data? }` — the pre-wire-alignment shape this SDK used internally before `reportProgress()` was corrected (an earlier pass, documented in §2's F-02) to actually send ojs-progress.md section 6.1's real wire body. The exported *type* never caught up to that fix: it described a request `reportProgress()` has not sent in a long time, misleading any caller who used the type to construct a request body by hand. | **Fixed** — `ProgressReport` is now the canonical wire union `{ progress: number; data?: Record<string, unknown>; checkpoint?: Record<string, unknown> } | { data: Record<string, unknown>; progress?: number; checkpoint?: Record<string, unknown> }`, enforcing that at least `progress` or `data` is present while retaining the optional §6.4 checkpoint. A new, explicitly `@deprecated` `LegacyProgressReport` interface preserves the old `{ job_id, percentage, message?, data? }` shape for callers/documentation migrating off it. `reportProgress()`'s own function signature (`transport, jobId, percentage, message?, data?`) is unchanged, and its internal request body is typed as the canonical union. |
| F-87 | Historical `src/serverless/ojs-callback.ts` | F-72 (§4u) already made 2xx callback responses cancel their body immediately without awaiting EOF, and bounded non-2xx body reads under `callbackTimeoutMs` with cancellation — but the existing tests for this covered only a stream that never starts producing data (`start() {}`), not one that actively keeps streaming, and asserted no leftover fake-timer state. | **Verified historically, then superseded by F-118** — the callback regressions were retained until the callback actor itself was removed as dead code. Current HTTP-adapter regressions assert zero callback fetches instead. |

### 4w. Enqueue-pipeline and package-surface follow-up: four findings

| ID | Location | Finding | Status |
|---|---|---|---|
| F-88 | `src/{client,job,validation/schemas}.ts` | Single enqueue built `wireOptions` before middleware, passed only a partial envelope through middleware, validated the stale original options, and serialized only selected post-middleware fields. Mutations to queue/priority/timeout/scheduling/retry/unique/tags/visibility timeout and args/type could be lost, while response-only extension fields risked ad hoc leakage. | **Fixed** — `createEnqueueEnvelope()` builds a complete mutable request envelope (preserving explicit zeros), middleware fully settles before any validation or transport, and `toWireEnqueueRequest()` serializes a whitelist of canonical request fields from the returned envelope. Post-middleware validation covers queue, numbers, timestamps, retry, unique, tags, visibility timeout, metadata, and schema. HTTP and the gRPC converter now consume the same post-middleware canonical body; response/system/unknown fields are never copied. |
| F-89 | `src/{client,testing}.ts` | `enqueueBatch()` bypassed enqueue middleware entirely, and fake/inline modes recorded the original plaintext options before middleware could mutate, encrypt, drop, or reject them. | **Fixed** — every batch item runs independently and in original order through the same preparation/validation pipeline before the single atomic request. Dropped items are omitted, all-dropped returns `[]` without transport, and any throw/validation failure aborts before transport or fake-store writes. `_recordEnqueueEnvelope()` records only prepared envelopes, so fake and inline modes retain mutations and encrypted args/meta rather than plaintext. |
| F-90 | `src/client.ts`, docs/examples/type tests | Runtime middleware could return `null`, but `enqueue()` promised `Promise<Job>` and used an unsafe `as Job`, forcing callers into unsound dereferences. | **Fixed** — the public return type is `Promise<Job \| null>` with no cast. README, examples, integration tests, and result-consuming unit tests handle drops explicitly; `tsconfig.type-tests.json` locks the exact public return type. No convenience API was added because it would obscure the intentional drop outcome. |
| F-91 | `package.json`, `scripts/check-package.mjs`, package docs/tests | Source docs advertised `/middleware`, `/ml`, `/encryption`, `/otel`, `/subscribe`, and `/serverless/lambda`, but the package export map omitted them. Consumers could compile against source documentation yet fail package resolution. | **Fixed** — all advertised entry points now expose matching ESM, CJS, and declaration targets. `tests/package-exports.test.ts` locks the complete export map and source/build correspondence; `npm run check:package` builds, validates `npm pack --dry-run` contains every target, installs the tarball into a clean temporary consumer, imports every entry under ESM and CJS, and type-checks the installed package under both NodeNext and browser Bundler resolution. |

### 4x. SSE HTTP Retry-After scoping and ML resource-metadata typing follow-up: two findings

| ID | Location | Finding | Status |
|---|---|---|---|
| F-92 | `src/subscribe.ts` | An HTTP `Retry-After` response header on a transient SSE reconnect attempt (408/425/429/5xx) directly overwrote the subscription's persistent `baseReconnectDelayMs`. Since that variable is also the exponential-backoff base for every *subsequent* reconnect, a single transient `Retry-After` (e.g. a 429 advising a 10s wait) permanently replaced the spec's default 3000ms base for the rest of the subscription's life — including reconnects long after a live event/heartbeat had reset the attempt counter and the server had recovered, and regardless of whether a later drop had no `Retry-After` at all. | **Fixed** — a new one-shot `pendingRetryAfterMs` override is consumed exactly once, by the single reconnect scheduled immediately after the response that carried it, then cleared; `baseReconnectDelayMs` is never mutated by `Retry-After` (only the SSE `retry:` hint still updates it, unchanged). The override still advances `reconnectAttempt` like any other scheduled reconnect, so `maxReconnectAttempts` accounting is unaffected. Deterministic exact-timer tests cover 429 `Retry-After: 0`, delta-seconds, and HTTP-date responses, each followed by successful event/heartbeat activity and then a later clean or error drop; those later reconnects use the persistent SSE `retry:` hint or 3000ms default exactly, never the consumed HTTP value. Separate tests lock attempt-budget consumption, no tight loop, and the persistent exponential-base behavior after a further failure with no activity. |
| F-93 | `src/ml.ts`, `src/index.ts` | `MLEnqueueOptions.meta` explicitly typed obsolete top-level `model`/`checkpoint`/`preemption`/`compute`/`node_selector`/`affinity` properties as loose `Record<string, JsonValue>` bags — paths no with*() helper had written to since F-08 (§4, initial pass) moved every one of them under `meta.resources`. The type actively misdescribed the real wire contract and gave callers false confidence in a shape the runtime never produces. | **Fixed** — new exported `MLResourcesMetadata` (plus per-field `MLGPUResourceMetadata`/`MLTPUResourceMetadata`/`MLCPUResourceMetadata`/`MLModelResourceMetadata`/`MLCheckpointResourceMetadata`/`MLPreemptionResourceMetadata`) precisely types `meta.resources` exactly as `schemas/v1/ml-resources.schema.json` defines it: gpu/tpu/cpu/memory_gb/storage_gb/shm_size_gb/model/runtime/precision/distributed_strategy/checkpoint/preemption/node_selector/affinity, including the schema's actual nested optionality (only model.name and affinity-rule key/operator are required). `MLEnqueueOptions.meta` drops the six obsolete top-level paths entirely and instead types the two legacy extension keys `withCompute()` actually emits — `ext_ml_max_tokens`/`ext_ml_max_batch_size` — at the top level of `meta` (matching F-36/§4c, not fabricated into the schema-closed `resources` object), while retaining its `Record<string, JsonValue>` index signature so callers can still attach arbitrary, unrelated application metadata alongside the typed ML fields. Every with*() helper's internal resource-object construction now goes through the new precisely-typed interfaces (catching field-name typos against the schema at compile time) before being handed to the wire-format `Record<string, JsonValue>` container `withResources`/`withModel`/etc. actually return, so `Partial<EnqueueOptions>` return types — and therefore every existing call site — remain unchanged and fully assignable; no with*() helper's public signature or runtime JSON output changed. New `tests/types/ml-enqueue-options.ts` (compiled by `npm run test:types`) asserts `MLResourcesMetadata`'s exact per-field shape and optionality, that the six obsolete keys now fall back to the plain `JsonValue` index signature instead of a specific (wrong) sub-shape, that `resources` rejects incorrect paths, and that every with*() helper plus `mergeMLOptions()` remains assignable to both `EnqueueOptions` and `MLEnqueueOptions`. New runtime tests in `tests/ml.test.ts` merge a hand-constructed `MLEnqueueOptions` value (typed `resources` plus arbitrary metadata) with with*() helper output, accept schema-valid minimal nested resource objects, and round-trip a fully-populated `MLResourcesMetadata` object through `JSON.stringify`/`parse` to confirm the type is a faithful, standalone description of the wire format. |

### Assumptions for the SSE Retry-After/ML resource-metadata pass

- F-92's one-shot override applies only to `Retry-After` originating from an HTTP non-2xx SSE response (408/425/429/5xx); it is unrelated to and does not change the persistent SSE `retry:` field's semantics, which continues to update `baseReconnectDelayMs` for the life of the subscription as before (F-82, §4v).
- F-93 keeps the existing intentional `ext_ml_max_tokens`/`ext_ml_max_batch_size` hybrid placement from F-36 (§4c) unchanged — they are typed at the top level of `meta`, not inside the schema-closed `MLResourcesMetadata`, because that is where `withCompute()` actually writes them and where the normative legacy extension contract defines them.
- F-93 deliberately left every with*() helper's public return type as `Partial<EnqueueOptions>` rather than widening it to `Partial<MLEnqueueOptions>`: TypeScript's fresh-object-literal assignability rules require a literal assigned to an intersection of an index signature (`Record<string, JsonValue>`) and a specific named property (`resources?: MLResourcesMetadata`) to satisfy *both* simultaneously, which the precisely-typed `MLResourcesMetadata` sub-shapes cannot (they have no index signature themselves). Returning the existing general `Record<string, JsonValue>`-based value instead is provably still freely assignable to `MLEnqueueOptions` (verified both by direct experimentation and by the new type tests), so no caller-visible behavior or compatibility is lost by keeping the narrower, already-correct return type.

### Assumptions for the enqueue-pipeline/package-surface pass

- The canonical client-to-transport request remains the HTTP-shaped enqueue body already consumed by both `HttpTransport` and `GrpcTransport`; the latter performs the existing strict HTTP-wire→protobuf conversion after middleware preparation.
- The current upstream `job.proto` `EnqueueOptions` message has no `schema` field. The post-middleware canonical body therefore carries `schema` correctly to both transports, but `GrpcTransport` retains its explicit pre-RPC `unimplemented` rejection rather than silently dropping or inventing a non-standard metadata encoding. HTTP transmits it normally. Closing that last protobuf wire gap requires an upstream proto change outside this repository.
- The package type-check installs the declared optional gRPC/OpenTelemetry peer integrations in the clean consumer because importing and type-checking those opt-in entry points requires their peer type declarations.

**Normative exception preserved:** `fromProtoTimestamp()`'s `{seconds:0,nanos:0} → null` mapping (ojs-protobuf-format.md section 6.2: "An unset timestamp is represented as `null` / zero value... Implementations MUST NOT interpret the Protobuf epoch... as a valid OJS timestamp") was **not** changed by F-84's encoding-side prototype-pollution hardening — it is unrelated decode-side, business-rule logic, not a defensive/malformed-input fallback. Its existing implementation and inline comment were expanded to cite section 6.2 explicitly, and it now has its own dedicated test (deliberately separate from the generic malformed-timestamp-input table) asserting the exact zero sentinel maps to `null` and never to the literal epoch instant string.

### Assumptions for the cancellation-honesty/encoding pass

- F-80's "retry only after rejection, never after success" rule is scoped **per closure instance**, not per chain-position index. This is required for the built-in `retry()`/`timeout()` middleware pair to keep working correctly: a retried attempt re-enters every downstream position with brand-new closures, so a later attempt's own success is never confused with an earlier attempt's now-stale, already-settled closure at the same nominal array position.
- F-81's immediate-cancellation guarantee is scoped to the *steady-state* lifecycle (an active call, or an in-progress backoff sleep) — the one-time `ensureClient()` client/channel bootstrap inside `GrpcTransport.openReconnectingStream()` is not itself signal-driven (it never was), so a cancellation requested during that brief, already-fast, cached-after-first-use window is honored as soon as that bootstrap step completes, rather than being interrupted mid-flight. This matches the finding's focus on cancelling "the active underlying call" and "reconnect/backoff," not a one-time setup step with no prior wire operation to cancel.
- F-83's cache is intentionally per-`GrpcTransport`-instance, in-memory only, and bounded (FIFO eviction past 10,000 entries) — it does not persist across transport instances or processes, matching every other piece of per-instance state this transport already holds (e.g. `streamAbortController`, `initPromise`).
- F-84 intentionally left `src/ml.ts`'s own `mergeMLOptions()` object-spread/merge logic untouched: it already uses spread syntax (`{ ...p }`) throughout, which uses `[[DefineOwnProperty]]` semantics and is not vulnerable to the `__proto__`-accessor hazard the four gRPC encoding builders had; it is also a different actor (developer-ergonomics option merging, not protobuf wire encoding) from this finding's named scope.

## 5. Structural result

No file was split for length alone. `src/transport/grpc-stream.ts`, `src/middleware/timeout-settlement.ts`, `src/uuid.ts`, and the new `src/crypto.ts` are narrow actors, not utility dumps. The settlement module contains only the private WeakMap registry shared by timeout and retry; `src/crypto.ts` contains only internal crypto runtime resolution plus test seams; and `src/uuid.ts` contains only RFC 4122 v4 formatting on top of that runtime. None of those private helpers is re-exported from the package surface.

## 6. Deliberately preserved / deferred

- **`src/transport/grpc.ts`'s `no-explicit-any` warnings.** Now zero (`0` warnings repo-wide, see §9) — the proto request/response objects still come from `@grpc/proto-loader`'s runtime `loadSync()` with no generated TypeScript types, but every place that previously needed `any` uses a structurally-checked, narrowly-scoped interface instead (the same pattern the prior pass established for the client/module/metadata/call-object plumbing, now extended to the streaming call/method types too). Introducing full static proto types via a code-generation pipeline remains a large, separate undertaking, but is no longer needed to reach `0` warnings.
- **`src/ml.ts`'s mixed resource/legacy extension placement is intentional.** The versioned `ml-resources` schema closes `meta.resources` and defines `runtime`/`precision`/`distributed_strategy` there, but not token or batch limits. The normative legacy extension schema and prose define the latter as `ext_ml_max_tokens` and `ext_ml_max_batch_size`, including their integer ranges. F-36 therefore uses the narrow hybrid required by both contracts instead of inserting schema-invalid properties into `resources`.
- **Test-file type-checking.** `tsconfig.json` excludes `tests/`, and `npm run lint` only runs `eslint src/` — both pre-existing, deliberate scoping choices (the ESLint config also has an explicit relaxed-rules block for `tests/**/*.ts`). A recon build with tests included found ~120 pre-existing type errors across the test suite, unrelated to this pass; fixing them is a separate, large, unbounded undertaking outside this audit's mandate. Verified this pass introduced **zero** new errors against that same stricter baseline (and incidentally fixed 3 dormant ones as a side effect of rewritten test files).
- **Toolchain dependency audit is clean.** A fresh `npm ci` followed by `npm audit --audit-level=high` reports 0 vulnerabilities.

## 7. Compatibility assessment

- **Public TypeScript API surface:** zero exports removed. Additions are strictly additive: prior additions listed above, plus optional Job tracing/workflow/lineage fields, optional structured JobError diagnostics, and complete UniquePolicy fields/conflict action typing from F-38. The timeout settlement registry and the new `generateUuidV4()` UUID provider (F-52) both remain private and unexported.
- **Wire formats — genuinely changed (fixing previously non-functional behavior):** durable-execution checkpoints (F-01), progress reporting (F-02), serverless ack/nack (F-03), SSE subscription endpoints (F-04), workflow step options (F-09), the ML resource builders' `meta` container (F-08), the gRPC worker heartbeat (F-26), `GetCheckpoint`'s `saved_at`/`created_at` mapping (F-27), `fromProtoValue`'s decoding of legitimately-set default values (F-30), `meta`/`schema` reaching all enqueue paths (F-31), and the current pass's exact `ext_ml_max_tokens`/`ext_ml_max_batch_size` placement (F-36). These are compatibility **improvements**, not breaking changes to a working contract.
- **Wire formats — deliberately unchanged:** enqueue request shape and all request mappings. F-38 changes only gRPC response normalization so it matches the existing SDK/HTTP job wire shape instead of dropping fields.
- **Runtime behavior — deliberately changed with strong justification:** timeout reports at the deadline while retry alone serializes downstream settlement (F-37); HTTP cancellation remains live through parsing (F-39); SSE listener ownership is explicit (F-40); a connection that proves live receives a fresh reconnect budget (F-41); callback delivery failure is no longer confused with handler failure (F-47); `GrpcTransport.close()` owns stream shutdown while preserving reuse (F-48); SSE handlers run exactly once per parsed event (F-49); terminal handler failure cannot revive a completed per-job subscription (F-50); synchronous middleware/handler throws obey the same rejection and guard-cleanup lifecycle as asynchronous failures (F-51); and all private SDK crypto now flows through one Node 18/browser-safe runtime instead of an ID-only helper plus direct ambient Web Crypto globals, with UUID wire shapes and cryptographic wire contracts preserved (F-52); and a non-404 checkpoint-lookup failure in `DurableContext.create()` now throws a contextual `OJSCheckpointLoadError` instead of silently starting a fresh record-mode context, so a durable job is nacked for retry rather than risking re-execution of already-recorded side effects (F-59). Prior behavior changes remain as documented above.

## 8. Implemented changes (files)

**Core transports:** `src/transport/http.ts` (abort-listener leak, abort-reason normalization), `src/transport/grpc.ts` (cancellation hardening incl. sync-throw/late-callback handling, module caching, async-executor removal, checkpoint RPC routing + `saved_at` fix, worker-heartbeat wire mapping fix, structural typing for client/metadata/call, additive `streamJobs()`/`streamEvents()`, transport-owned stream generations for close/reopen), `src/transport/types.ts` (added `'PUT'`).

**New: `src/transport/grpc-stream.ts`** — the `StreamJobs`/`StreamEvents` reconnect/backoff/cancellation engine (`reconnectingServerStream`), split out as its own actor (see §4a and §5 for why).

**Worker/middleware:** `src/worker.ts` (unhandled-rejection fix, lint cleanup; **final-review pass:** exactly-once ack/nack outcome fix, F-29), `src/middleware.ts` (reentrancy-guard fix plus synchronous-throw normalization and guaranteed pending-guard cleanup for both compose functions, F-51), `src/middleware/{timeout,retry}.ts` plus new private `src/middleware/timeout-settlement.ts` (deadline-visible, non-overlapping timeout/retry lifecycle, F-37).

**Wire-format fixes:** `src/durable.ts`, `src/progress.ts`, `src/workflow.ts` (**final-review pass:** `meta`/`schema` placement, F-31), `src/ml.ts`, `src/serverless/{lambda,cloudflare,vercel}.ts` (historical callback status/body validation and handler/delivery isolation, F-47; callback actor later removed by F-118), `src/subscribe.ts` (**final-review pass:** terminal job-state reconnect fix, F-32; exactly-once sync/async handler dispatch, F-49; terminal handler-failure shutdown and cleanup, F-50).

**Final-review pass only:** `src/job.ts` (new shared `toWireEnvelopeFields()`, F-31), `src/client.ts` (`enqueue()`/`enqueueBatch()` now use `toWireEnvelopeFields()`; `schema` now reaches the wire at all, F-31), `src/transport/grpc.ts` (`fromProtoValue()` `kind`-discriminator fix, F-30).

**Independent-review pass (§4c):** `src/middleware/timeout.ts`, `src/durable.ts`, `src/transport/grpc-stream.ts`, `src/transport/grpc.ts`, `src/ml.ts`, `README.md`, and their focused test suites.

**Certification pass (§4d):** `src/middleware/{timeout,retry,timeout-settlement}.ts`, `src/transport/{grpc,http}.ts`, `src/job.ts`, `src/subscribe.ts`, and focused middleware/gRPC/HTTP/SSE tests.

**Labs modules:** `src/attest/index.ts`, `src/attest/types.ts`, `src/recorder/index.ts` (TS fix, quote style), `src/agent/client.ts` (TS fix), `src/agent/index.ts` (export).

**Robustness/observability:** `src/events.ts`, `src/testing.ts`.

**Config:** `package.json` (exports map). `src/index.ts` (additive re-exports of the five new gRPC streaming types).

**Tests:** all corresponding test files updated/extended; new `tests/attest.test.ts`, `tests/recorder.test.ts`, `tests/agent.test.ts` (previously 0% covered, from the initial pass); new **`tests/transport-grpc-stream.test.ts`** (26 deterministic unit tests directly against `reconnectingServerStream`/`computeStreamBackoffMs` — backoff-value determinism via an injectable RNG, reconnect/non-retry/exhaustion decisions, cancellation from both a signal and consumer early-return, listener/timer/call cleanup, `cancel()`-throwing robustness); `tests/transport-grpc.test.ts` substantially extended (heartbeat request-capture, checkpoint `savedAt` mapping, cancellation-lifecycle hardening, and a full `streamJobs()`/`streamEvents()` integration suite against the public `GrpcTransport` API); `tests/fuzz.test.ts` flake fix.

**Final-review pass tests (§4b):** `tests/worker.test.ts` (+4: ack-exhausts-retries/no-nack, nack-exhausts-retries/no-ack, prompt-shutdown-despite-ack-failure, job.failed-listener-throws — F-29); `tests/transport-grpc.test.ts` (+6: job-arg/checkpoint/`StreamEvents`-data default-value regressions for `0`/`false`/`''`/`null`/nested list & struct, both `kind`-tagged and `kind`-absent-fallback, plus an unrecognized-`kind` case — F-30); `tests/job.test.ts` — pre-existing but untouched by the prior two passes, now extended with `toWireEnvelopeFields`/`toWireOptions` meta/schema coverage (+13: mapping, empty/nested values, no-mutation, non-duplication into `options` — F-31); `tests/workflow.test.ts` (+7: step/callback `meta`/`schema` top-level placement, empty/nested values, no-mutation, non-duplication into `options` — F-31); `tests/client.test.ts` (+6: `enqueue`/`enqueueBatch` `meta`/`schema` placement, empty/nested values, no-mutation — F-31); `tests/subscribe.test.ts` (+15: terminal-state detection per state, non-terminal/queue-channel non-suppression, fragmented and malformed-event handling, cleanup/backpressure assertions — F-32). All added with `vi.useFakeTimers()`/deterministic control where timing is involved; zero new real-timer waits.

**Post-certification hardening tests (§4e):** `tests/middleware-impls.test.ts` covers zero-retry and exhausted-final non-cooperative timeouts; `tests/subscribe.test.ts` covers empty clean-stream budgets, first-event budget reset, exact listener cleanup on clean/error/validation completion, and synchronous/async `onError` isolation; `tests/transport-grpc.test.ts` covers nanosecond precision, trimmed fractions, normalized negatives, maximum-range seconds, and zero Duration formatting.

**Delivery/lifecycle follow-up tests (§4f):** the historical `tests/serverless-callback.test.ts` covered typed HTTP/network callback errors and the 8 KiB drain/cancel bound, while `tests/serverless{,-lambda}.test.ts` covered exact callback routes and failure isolation; F-118 later removed the unused callback actor/test and replaced adapter expectations with zero-callback response-contract coverage. `tests/transport-grpc.test.ts` covers active/backoff/multi-stream close, external-signal cleanup, and stream/unary reopen; `tests/subscribe.test.ts` covers exactly-once synchronous and asynchronous handler failures with side-effect counts and reconnect policy.

**Synchronous-failure follow-up tests (§4g):** `tests/subscribe.test.ts` covers terminal-event handler sync throw and async rejection, isolated throwing/rejecting `onError`, exact external-signal listener cleanup, and no reconnect/fetch; `tests/middleware.test.ts` covers execution retry after a synchronous middleware throw, enqueue retry ending in a drop, direct synchronous execution/final-enqueue rejection, and concurrent enqueue double-next rejection.

**Crypto compatibility follow-up (§4h):** new private `src/crypto.ts` shared by `src/uuid.ts`, `src/encryption.ts`, `src/attest/index.ts`, and `src/durable.ts`; `package.json`/`package-lock.json` swap `uuid` out for `@noble/hashes@1.8.0`; `README.md`, `AUDIT.md`, and internal transport/encryption comments were updated to describe the new runtime; `tests/crypto.test.ts` adds 11 provider/integration tests, while `tests/uuid.test.ts` was simplified to pure public-shape checks and `tests/encryption.test.ts` now uses the shared byte provider for key generation.

**Enqueue-options conversion follow-up (§4i):** `src/transport/grpc.ts` (`mapEnqueueOptions`/`buildProtoEnqueueOptions` and strict field-level HTTP-wire→protobuf timestamp/duration/enum/metadata helpers, replacing the previous `Object.assign`-based mapper; `grpcEnqueue`/`grpcEnqueueBatch` updated to use them, including the real `default_options`/`defaultOptions` request field and non-mutating resolved per-job overrides); new `tests/transport-grpc-enqueue-options.test.ts` (59 tests: captured generated-client requests plus real `@grpc/proto-loader` serialization round-trips) and new `tests/fixtures/proto/ojs/v1/enqueue_options.proto` (a field-for-field fixture subset of ojs-proto's real `job.proto` messages); `AUDIT.md` updated with F-53.

**Unique-options/progress/SSE-cancellation follow-up (§4j):** `src/transport/grpc.ts` (`buildProtoUniquePolicy()` now translates non-dimension `unique.key` entries into args fields, merging with explicit `args_keys`, F-54; `grpcProgress()` now always rejects with a non-retryable `unimplemented` `OJSError`, F-55); `src/job.ts` (`UniqueOptions.key` doc comment now documents both accepted forms, F-54); `src/progress.ts` (module doc comment documents the gRPC progress gap, F-55); `src/subscribe.ts` (`connectOnce()`'s abnormal-exit path now calls `reader.cancel(reason)` before `releaseLock()`, F-56); `README.md` (`UniqueOptions.key` table entry and explanatory paragraph, F-54). Tests extended: `tests/transport-grpc-enqueue-options.test.ts` (new `unique.key` dimension/args-field compatibility describe block, plus the pre-existing "unsupported dimension" rejection case replaced with genuinely-invalid cases — F-54); `tests/transport-grpc.test.ts` (new `progress reporting routing` describe block, including `reportProgress()`-against-`GrpcTransport` coverage — F-55); `tests/subscribe.test.ts` (new `SSE reader cancellation on abnormal exit (connectOnce)` describe block covering sync/async handler failures, a `reader.read()` failure, cancel-before-releaseLock ordering, a failing `reader.cancel()` not masking the original error, no cancellation on clean EOF, and a real-`ReadableStream` connection-leak regression — F-56); `AUDIT.md` updated with F-54/F-55/F-56.

**Canonical-unique/remote-cancellation follow-up (§4k):** `src/job.ts` adds canonical `UniqueOptions.keys`/`argsKeys`/`metaKeys`, canonical `UniquePolicy.keys`, the deprecated read alias, and shared deterministic normalization/validation; `src/validation/schemas.ts` validates the canonical schema shape; `src/client.ts` carries that validation through HTTP enqueue; `src/transport/grpc.ts` accepts canonical and legacy wire input, converts to protobuf singular `key`, and returns canonical `keys`; `src/transport/grpc-stream.ts` distinguishes remote `CANCELLED` from local signal/transport cancellation; `README.md`, `examples/basic-enqueue.ts`, and `AUDIT.md` document the final behavior. Tests extended across `tests/job.test.ts`, `tests/client.test.ts`, `tests/workflow.test.ts`, `tests/validation.test.ts`, `tests/transport-grpc-enqueue-options.test.ts`, `tests/transport-grpc-stream.test.ts`, and `tests/transport-grpc.test.ts`.

**Durable-checkpoint failure-classification follow-up (§4l):** `src/errors.ts` adds `OJSCheckpointLoadError` with job/attempt/source context, cause preservation, and inherited retryability; `src/durable.ts` validates canonical response/replay-log structure, falls back to the read-only legacy resume endpoint only after canonical `OJSNotFoundError`, propagates every other canonical or legacy load/decode/integrity failure, and migrates recovered legacy replay state best-effort to the canonical resource; `src/index.ts` re-exports the error; `src/worker.ts` preserves structured `OJSError.retryable` values in NACKs. `README.md` documents the fail-closed and migration behavior. Tests cover canonical precedence, legacy migration and migration failure, connection, auth, HTTP 500, invalid decoded bodies, JSON decode failure, legacy lookup failure, retained 404 first-run behavior, zero handler/side-effect calls, no ACK, and retryable/non-retryable NACKs.

**Checkpoint-integrity/timestamp follow-up (§4m):** `src/durable.ts` now distinguishes a recognized empty canonical replay wrapper from foreign/missing/corrupt state and validates the wrapper's step/attempt/value fields; `src/transport/grpc.ts` makes `fromProtoTimestamp()` safe for untrusted int64/nanos inputs and exact JavaScript Date boundaries. `tests/durable.test.ts`, `tests/worker.test.ts`, and `tests/transport-grpc.test.ts` cover empty logs, foreign/missing/wrong-type wrappers, invalid metadata, zero handler/transport side effects, max int64 seconds, unsafe/malformed seconds, invalid nanos, exact Date boundaries, and identical unary/stream full-job normalization.

**Legacy unique semantics follow-up (§4n):** `src/job.ts` now treats every deprecated `UniqueOptions.key` entry as an args field selector, including selector names that collide with canonical dimensions; only `keys` can express dimensions. Canonical `argsKeys` are retained first, legacy selectors append in first-seen order without duplicates, and caller arrays are not mutated. HTTP client serialization and schema validation remain canonical-only. `src/transport/grpc.ts` retains direct `unique.key` input only as a deprecated SDK compatibility boundary and applies the same all-args-selector normalization before mapping canonical dimensions to protobuf's singular `key`. `README.md` documents the migration rule; focused job, validation, client, and gRPC converter tests cover dimension-name collisions, merging, deduplication, immutability, canonical serialization, raw-HTTP rejection, and direct-gRPC compatibility.

This correction supersedes the historical F-54/F-57 compatibility wording that treated dimension-named legacy entries specially. That interpretation was ambiguous and incompatible with the original SDK contract, where deprecated `UniqueOptions.key` always selected fields from `args`; canonical dimensions now have exactly one spelling and one semantic path through `keys`.

**Worker timeout NACK follow-up (§4o):** `src/worker.ts` now resolves an authoritative timeout/deadline contract before constructing a failure NACK. A worker job-timeout abort reason takes precedence over a later downstream failure, built-in timeout middleware failures default to retryable timeout NACKs, and explicit timeout/deadline `OJSError` contracts retain their declared retryability. Only non-timeout failures inherit retryability from the downstream `OJSError`. `tests/worker.test.ts` deterministically covers timeout-first races followed by both `OJSValidationError` and another non-retryable `OJSError`, asserting the exact timeout code, message, details, and `retryable: true`.

**Clean SSE reconnect follow-up (§4p):** `src/subscribe.ts` now routes both unexpected clean EOFs and error closures through one reconnect-attempt increment and capped exponential delay calculation. The first event delivered on a connection still resets the consecutive-failure budget to zero, so a later clean drop restarts at attempt 1; terminal job completion, unsubscribe, `reconnect: false`, maximum-attempt limits, and the latest valid SSE `retry:` hint remain authoritative. `tests/subscribe.test.ts` asserts exact clean-close boundaries for `3000, 6000, 12000, 24000, 30000, 30000` milliseconds, a post-event reset back to 3000ms, a hinted `500, 1000` sequence, and no reconnect beyond the configured budget.

**gRPC ack-result/workflow-mapping/cron-options follow-up (§4r):** `src/transport/grpc.ts` — `grpcAck` now encodes `AckRequest.result` as a `google.protobuf.Struct` via a context-parameterized `toProtoStruct` (scalar/array rejected non-retryably, `null`/omitted results omit the field); `grpcCreateWorkflow` delegates to a new recursive `flattenWorkflowElement`/`buildProtoCreateWorkflowRequest` DAG converter (deterministic `step-<path>` IDs, chain/group `depends_on`, shared `mapEnqueueOptions`, batch/schema/empty rejection before the RPC, with structural primitive discrimination so a job handler named `batch` is not rejected); `grpcRegisterCron` maps `options`+`meta` through `mapEnqueueOptions` (now taking a `context` label) into `request.options`; and `grpcListCron` decodes args/options/`next_run_at`/`last_run_at` via a new `fromProtoEnqueueOptions` inverse. `tests/fixtures/proto/ojs/v1/enqueue_options.proto` gained field-for-field `AckRequest`/`WorkflowStep`/`CreateWorkflowRequest`/`RegisterCronRequest`/`CronEntry`/`ListCronResponse` messages; new `tests/transport-grpc-workflow-cron-ack.test.ts` (30 tests: captured requests + real `@grpc/proto-loader` serialization/round-trips). `README.md` documents the gRPC workflow-batch limitation and cron option/listing mapping; `AUDIT.md` updated with F-62/F-63/F-64.

**Current gRPC follow-up verification (§4r):** the focused new suite passes **30/30**. The final full suite passes **940/940** tests on Node 18.20.8, 20.20.2, and 22.23.1. On all three runtimes, `npm ci`, `npm run lint`, `npm test`, `npm run test:coverage`, `npm run build`, `npm run size`, `npm run docs`, and `npm audit --audit-level=high` pass; coverage is approximately 91% statements/lines, the measured entry bundle remains 906 B brotlied against the 15 kB limit, and the audit reports 0 vulnerabilities. Node 18 emits expected `EBADENGINE` warnings for the current ESLint/size-limit development toolchain, and TypeDoc completes with 14 pre-existing documentation warnings. The pull-request API-compat workflow was not executed in the dirty working tree because its fallback deliberately runs `git stash` and checks out base-branch `dist/`; publishing was not attempted.

**gRPC ack-warning/workflow-envelope/cron-pagination-register follow-up (§4s):** `src/transport/grpc.ts` — `grpcAck` no longer rejects a non-object result before the RPC; it now acks without the result and reports the limitation once via the new `GrpcTransportConfig.onWarning`/`GrpcProtocolWarning` (default `console.warn` receives the complete warning object), exported alongside `GrpcTransportConfig` from `src/index.ts`. `routeRequest` now strips/parses any query string before route matching, fixing `GET /cron`'s previously-silent routing failure for `CronOperations.list()`'s own `page`/`per_page` query params. `grpcListCron` validates/defaults that pagination (page 1 / 25 per page), applies it over a code-point-name-sorted deterministic order, and returns `{ cron_jobs, pagination }`; a new shared `fromProtoCronEntry` decodes each `CronEntry` and restores protobuf `EnqueueOptions.meta` to the HTTP-compatible cron resource's top-level `meta`. `grpcRegisterCron` now returns the documented `{ cron_job: CronJobInfo }` (previously only `{ name }`), reconstructed from the request plus the authoritative `RegisterCronResponse.name`/`next_run_at`, a local `created_at` captured immediately before the registration RPC, `status: 'active'`, separately preserved `options`/top-level `meta` (retained from the request when the follow-up entry omits them), and a best-effort authoritative follow-up `ListCron` lookup with a safe request-derived fallback. `src/client.ts` — `workflow()`/`getWorkflow()` now unwrap the `{ workflow: WorkflowStatus }` envelope both `GrpcTransport` and the HTTP binding use, via a new `unwrapWorkflowResponse()` that still tolerates a flat body. New `tests/worker-grpc-ack-warning.test.ts` (4 tests, a real `OJSWorker` over a capturing `GrpcTransport`) and `tests/cron-operations-grpc.test.ts` (11 tests, real `CronOperations` over a capturing `GrpcTransport`); `tests/transport-grpc-workflow-cron-ack.test.ts` grew from 30 to 34 tests (its 3 now-obsolete ack-rejection tests were replaced by 5 warn-and-ack/never-warns tests, its register test gained a follow-up-listCron-call assertion, and a new describe block adds 2 `OJSClient`-over-`GrpcTransport` workflow-envelope regressions) and `tests/client.test.ts` gained 2 workflow-envelope tests. `README.md` documents the ack-result limitation (with an `onWarning` example), the cron pagination/register reconstruction/protobuf timestamp limitation, and the workflow-envelope unwrap/tolerance. `AUDIT.md` updated with F-65/F-66/F-67 (§4s).

**Current follow-up verification (§4s):** the three new/extended gRPC suites pass **49/49** (`tests/transport-grpc-workflow-cron-ack.test.ts` 34/34, `tests/cron-operations-grpc.test.ts` 11/11, `tests/worker-grpc-ack-warning.test.ts` 4/4); the complete focused selection including `tests/client.test.ts` passes **78/78**. The final full suite passes **961/961** tests in isolated Docker workspaces on Node **18.20.8**, **20.20.0**, and **22.22.0**. On all three, clean `npm ci`, `npm run lint`, `npm test`, `npm run test:coverage`, `npm run build`, `npm run size` (906 B brotlied against the 15 kB limit), `npm audit --audit-level=high` (0 vulnerabilities), and `npm run docs` all pass. Coverage remains approximately 91.43–91.45% statements/lines, 88.74–88.75% branches, and 96.54–96.76% functions. Node 18's installation emits the pre-existing `EBADENGINE` warnings from the ESLint 10/size-limit development toolchain, but the literal `npm run lint` gate still completes successfully with 0 errors/0 warnings. TypeDoc completes with 0 errors and the same 14 pre-existing documentation warnings. Net across the full unstaged change set after this follow-up: **57 modified tracked files** and **18 untracked entries**; **0 staged files**. No files under `dist/` were hand-edited; all Docker gate work used read-only source mounts and ephemeral copies.

**Workflow-status/gRPC-NACK normalization follow-up (§4t):** `src/transport/grpc.ts` returns a complete public `WorkflowStatus` from proto workflow responses, preserving ordered step details and timestamps, deriving counts, and retaining the submitted create primitive through a type hint. The original get-time edge inference described by this historical pass was superseded by F-83: get now uses the authoritative creation-time cache and rejects an unknown external type with non-retryable `unimplemented`. `src/workflow.ts` exposes the optional typed step details backward-compatibly. The same transport maps every public `JobError` field into `NackRequest.error`, validates Timestamp/Struct inputs before dispatch, defaults an omitted proto3 `retryable` scalar to `true` without losing explicit `false` or `attempt: 0`, and normalizes `next_attempt_at`. `tests/transport-grpc-workflow-cron-ack.test.ts` and the real fixture proto cover captured full/minimal/zero/false/invalid requests, serialization round-trips, response timestamps, and create/get runtime normalization; README documents both behaviors and limitations.

**Current follow-up verification (§4t):** the focused workflow/NACK plus client selection passes **74/74**. The final full suite passes **972/972** tests in isolated Docker workspaces on Node **18.20.8**, **20.20.0**, and **22.22.0**. On all three, clean `npm ci`, `npm run lint`, `npm test`, `npm run test:coverage`, `npm run build`, `npm run size` (906 B brotlied against the 15 kB limit), `npm run docs`, and `npm audit --audit-level=high` (0 vulnerabilities) pass. Coverage is **91.77–91.79% statements/lines, 88.74% branches, and 96.77–96.99% functions**. Node 18 emits the pre-existing `EBADENGINE` warning from the size-limit development dependency chain; TypeDoc completes with 0 errors and the same 14 pre-existing warnings. Net across the full unstaged change set remains **57 modified tracked files** and **18 untracked entries**; **0 staged files**. All matrix runs used read-only source mounts and ephemeral Docker copies.

**Current ten-finding verification (§4u):** the complete suite now passes **1005/1005** tests on Node **18.20.8**, **20.20.2**, and **22.23.1**. Full lint, coverage, build, size, docs, and audit gates were rerun in isolated copies on all three runtimes. Coverage is **91.90–92.08% statements/lines, 88.91–88.92% branches, and 96.65–96.86% functions**; bundle size is **912 B brotlied** against 15 kB; audit reports 0 vulnerabilities; TypeDoc completes with 0 errors and the same 14 pre-existing warnings. `npm pack` produced a 281.3 kB tarball whose ESM, CJS, and serverless subpath imports all passed from a fresh consumer install. Generated declarations expose the additive/accuracy changes (`settlementGraceMs`, `SSEConnectionError`, backtrace union, optional cron fields, `available`, nullable workflow job IDs, and step index). `git diff --check` is clean; **57 tracked files remain modified, 18 entries remain untracked, and 0 files are staged**.

**Cancellation-honesty/encoding follow-up (§4v):** `src/middleware.ts` (`composeExecution()`/`composeEnqueue()` rewritten to per-invocation closures with success-consumes/rejection-retries guard state, F-80); `src/transport/grpc-stream.ts` (new exported `reconnectingServerStream()` `AsyncIterableIterator` wrapper around the renamed private `runReconnectingServerStream()` generator, plus `linkExternalAbort()`, F-81); `src/transport/grpc.ts` (`openReconnectingStream()` rewritten from an `async *` generator into a hand-built cancellable `AsyncIterableIterator`; `streamJobs()`/`streamEvents()` return types widened to `AsyncIterableIterator<...>`, F-81; new per-instance `workflowTypeCache`, `cacheWorkflowType()`, `grpcCreateWorkflow()`/`grpcGetWorkflow()` updated, `inferWorkflowType()` removed, F-83; `toProtoValue()`/`toProtoStruct()`/`toProtoJsonValue()`/`enqueueMetaToProtoStruct()` now use `Object.create(null)` accumulators, F-84; `fromProtoTimestamp()`'s zero-timestamp comment expanded with an explicit `ojs-protobuf-format.md` §6.2 citation); `src/subscribe.ts` (new `ConnectCallbacks.onActivity`, `connectOnce()` comment-line branch, `subscribe()`'s `trackingHandler` simplified to use it, F-82); `src/workflow.ts` (`WorkflowStatus.type` remains the standard `'chain' | 'group' | 'batch'` union, with the non-standard `'dag'` value removed, F-83); `src/progress.ts` (`ProgressReport` redefined as the canonical at-least-one-of-progress-or-data wire union with optional checkpoint, new deprecated `LegacyProgressReport`, F-86); `src/index.ts` (re-exports `LegacyProgressReport`, F-86). `README.md` documents the workflow-type cache/non-retryable cache-miss error (F-83), the `ProgressReport`/`LegacyProgressReport` split (F-86), and the normative zero-timestamp rationale from `ojs-protobuf-format.md` §6.2.

New/extended tests: `tests/middleware.test.ts` (+7: success-then-reject, rejection-then-retry across sync/async attempts, and enqueue equivalents, F-80); `tests/transport-grpc-stream.test.ts` (+5: pending-`next()` `return()`/`throw()` immediacy for both an active call and an in-progress backoff sleep, and external-signal listener-leak accounting updated for the new wrapper, F-81); `tests/transport-grpc.test.ts` (+4: integration-level pending-`next()` cancellation for both `streamJobs()`/`streamEvents()`, cancel-count assertions updated for the new immediate-cancellation wrapper, F-81; a dedicated zero-timestamp spec-citation test, normative exception); `tests/transport-grpc-workflow-cron-ack.test.ts` (+3: one-step-chain, nested group-in-chain/chain-in-group, and external/unrecognized-workflow-ID non-retryable `unimplemented` cases replacing the old edge-inference assertions, F-83; +3 malicious-key real-serialization tests covering ACK result Struct, NACK error details, and durable checkpoint state, F-84); `tests/transport-grpc-enqueue-options.test.ts` (+2: malicious-key meta and job-args tests, F-84); the fixture proto adds the exact `SaveCheckpointRequest`/`SaveCheckpointResponse` subset needed for the checkpoint wire round-trip; `tests/subscribe.test.ts` (+2: failure→heartbeat→drop backoff reset, and empty-chunk-does-not-reset plus `maxReconnectAttempts` honored, F-82); `tests/progress.test.ts` (+3: canonical wire-shape assertion, minimal-report shape, and canonical/legacy type-distinction documentation, F-86); new `tests/types/progress-report.ts` locks the at-least-one-field union and optional checkpoint at compile time; the historical `tests/serverless-callback.test.ts` regressions for F-87 were later removed together with the dead callback actor under F-118; new `tests/unique-policy-parity.test.ts` (80 tests: a shared ~25-case table run through the developer/HTTP/gRPC validators, plus the documented calendar-period gRPC exception, F-85).

**Current eight-finding verification (§4v):** the final repository matrix in §9 supersedes this pass-local snapshot: the full suite passes **1201/1201** tests and both `npm run lint` and `npm run test:types` pass on Node **18.20.8**, **20.20.2**, and **22.23.1**. `npm run check:package` validates all 13 package entry points and `npm run size` reports **912 B brotlied** against the 15 kB limit. `git diff --check` is clean and **0 files are staged**.

## 9. Final gate results

All gates below were rerun after the final F-111–F-116 integration on Node
18.20.8, 20.20.2, and 22.23.1 (via `nvm`) in the same dirty working tree.
Dependencies were already installed; package correctness was independently
verified through a fresh temporary tarball consumer on all three versions.

| Gate | Command | Result |
|---|---|---|
| Lint / ESM type-check | `npm run lint` | ✅ 0 errors, 0 warnings on all three versions |
| Public type contract | `npm run test:types` | ✅ all compile-time API assertions pass on all three versions |
| Tests (full suite) | `npm test` | ✅ **1260/1260** on all three versions |
| Coverage | `npm run test:coverage` | ✅ **90.56–90.57% statements/lines, 88.26–88.27% branches, ≥96.88% functions** on Node 18, 20, and 22; thresholds pass |
| Build / CJS type-check | `npm run build` | ✅ clean ESM and CJS builds on all three versions |
| Bundle size | `npm run size` | ✅ 935 B brotli (limit 15 kB) on all three versions |
| API documentation | `npm run docs` | ✅ generated with 0 errors (14 pre-existing reference warnings) |
| Package dry-run / clean install | `npm run check:package` | ✅ all 13 ESM/CJS/type targets present; every subpath imports under ESM/CJS and type-checks with NodeNext, browser Bundler, and classic CommonJS/`moduleResolution: node` resolution |
| Dependency audit | `npm audit --audit-level=high` | ✅ 0 vulnerabilities |
| Whitespace | `git diff --check` | ✅ clean |
| Workspace | `git status --porcelain=v1` | ✅ all changes remain unstaged: 59 modified tracked files + 26 untracked entries; 0 staged files; no tarball left behind |

The package check performs both `npm pack --dry-run --json` and a real `npm pack --json`, removes the generated tarball in a `finally` block, installs it into a clean temporary consumer with the declared optional integration peers, and removes that consumer after verification.

## 10. Blocked / genuinely deferred items

No SDK-local item was blocked. The full 1201-test suite and every requested gate pass on all three supported Node versions. The only upstream constraint is `job.proto`'s missing enqueue `schema` field, documented in §4w; the SDK correctly preserves it in the canonical post-middleware request and rejects the unrepresentable gRPC call explicitly rather than dropping it.

## 11. Suggested follow-ups (not in this pass)

1. ~~Replace direct Web Crypto globals with a Node 18/browser-compatible UUID source so the declared Node 18 CI matrix is green in ordinary script execution.~~ **Done — see §4h, F-52.**
2. ~~Extend the same Node 18 compatibility fix to `src/encryption.ts`, `src/attest/index.ts`, and `src/durable.ts`, which independently use `globalThis.crypto.subtle`/`getRandomValues` for AES-GCM encryption, HMAC-SHA256 attestation signing, and durable-execution random-hex generation.~~ **Done — they now use the shared private runtime in `src/crypto.ts`; see §4h and §9.**
3. Align the upstream ML prose and versioned schemas around the now-explicit split between schema-defined `meta.resources` fields and legacy `meta.ext_ml_*` fields, then propagate that clarification across SDKs.
4. If push-based job delivery is desired for `OJSWorker` (as an alternative to its proven polling loop), design it as an explicit, separate **opt-in** mode consuming the new `GrpcTransport.streamJobs()`, with its own concurrency/backpressure/shutdown test matrix verified against the worker's existing graceful-shutdown and ack/nack-retry semantics — deliberately not attempted in this pass per the explicit instruction that a correct, tested transport-level API alone satisfies the required scope.
5. Consider whether `StreamEvents`' `stream.keepalive` sentinel should be surfaced (rather than filtered, as this pass does for both streams) for callers that specifically want connection-health visibility — the spec's own event-type table lists it as a legitimate Level-0 type, unlike `StreamJobs`, where filtering it is a spec **MUST**.
6. Consider running `eslint` over `tests/**` as part of `npm run lint` (currently out of scope) now that this pass has not regressed the stricter test-inclusive baseline: an ad hoc recon `tsc` build including `tests/**` shows pre-existing type errors, all in files this pass never touched (the new `tests/transport-grpc-enqueue-options.test.ts` has zero). Fixing the pre-existing set would need its own dedicated pass.
7. Resolve the 13 existing TypeDoc reference warnings so the documentation gate is warning-free as well as error-free.
8. Consider adding a top-level `pending` enqueue option (`ojs-http-binding.md` §9.1's `options.pending` field, part of `job-options.schema.json`) to `EnqueueOptions`/`toWireOptions()` — noticed while cross-referencing the options schema for F-31, but outside these findings. Note this pass's F-53 fix *does* already support job.proto's `EnqueueOptions.max_attempts`/`trace_id` shorthand fields at the raw-transport `options` level, even though the published HTTP options schema doesn't yet document them either — see F-53's own note.
9. Consider publishing `job-options.schema.json`/`retry-policy.json`/`unique-policy.json` updates that document the `trace_id`/`max_attempts`/`options.meta` shorthand fields job.proto's `EnqueueOptions` already supports (used by this pass's gRPC converter for raw transport callers), so the HTTP binding and gRPC binding stay documented consistently.
10. Add a real progress-reporting RPC to `service.proto` (F-55 made `GrpcTransport` fail loudly instead of silently, but a gRPC-based worker still cannot report progress at all today; a real fix requires an upstream proto change this SDK cannot make unilaterally).
11. ~~Once `ojs-unique-jobs.md`/`unique-policy.json` are revised, align this SDK with canonical `keys`/selector fields.~~ **Done — F-57 now emits the published canonical schema while retaining deprecated `key` normalization locally.**
12. Align the ESLint 10 development dependency chain with the declared Node 18 support floor (or raise the tooling/runtime floor explicitly) so Node 18 `npm ci` no longer emits `EBADENGINE` warnings.
13. Add a dedicated `OJSAuthError` (401/403) class to `src/errors.ts`'s hierarchy — `parseErrorResponse()` currently falls through to the generic `OJSError` with `code: 'unknown'` unless the server happens to supply its own `code`, so auth failures (including the new checkpoint-load-failure path, F-59) are harder for callers to `instanceof`-match than other well-known failure modes.
14. Add a real originating-primitive field to the `Workflow` proto message (`workflow.proto`) so `GrpcTransport.getWorkflow()` can report the true `chain`/`group`/`batch` type for *any* workflow ID, not only ones this same transport instance created via `createWorkflow()` — until that upstream change exists, F-83's per-instance cache is authoritative for locally-created workflows and external/cache-miss lookups must fail explicitly with non-retryable `unimplemented` rather than inventing a type.
15. Consider whether `GrpcTransport.workflowTypeCache` (F-83) should become an injectable/shared cache (e.g. across multiple `GrpcTransport` instances pointed at the same backend, or a distributed cache) for deployments that create many short-lived transport instances — out of scope for this pass, which kept the cache strictly per-instance and in-memory to avoid introducing any new shared/external state dependency.
16. Add `schema` to the upstream protobuf enqueue request/options contract so the gRPC binding can preserve the core job-envelope field exactly like HTTP; until then this SDK must continue rejecting that one unrepresentable gRPC request explicitly.

---

## §4y — Push Auth / Envelope / Handler Response / gRPC Iterator / ML Types (Nine Findings)

| Finding | ID | Status |
|---|---|---|
| Lambda HTTP accepted unauthenticated push bodies and parsed them before authenticity checks | F-94 | ✅ Implemented |
| Cloudflare Worker accepted unauthenticated push bodies and had no bounded raw-body verification | F-95 | ✅ Implemented |
| Vercel Edge accepted unauthenticated push bodies and had no bounded raw-body verification | F-96 | ✅ Implemented |
| Cloudflare parsed a bare Job instead of the canonical push envelope and discarded delivery context | F-97 | ✅ Implemented |
| Vercel parsed a bare Job instead of the canonical push envelope and discarded delivery context | F-98 | ✅ Implemented |
| Cloudflare returned 500 after successfully delivering a NACK, causing redundant platform retries | F-99 | ✅ Implemented |
| Vercel returned 500 after successfully delivering a NACK, causing redundant platform retries | F-100 | ✅ Implemented |
| gRPC stream iterators installed listeners eagerly and could race initialization/concurrent reads | F-101 | ✅ Implemented |
| Named ML resource metadata was not assignable to the JSON-compatible enqueue metadata surface | F-102 | ✅ Implemented |

### F-94–F-96: Shared Serverless Push Auth

**New file:** `src/serverless/push-auth.ts` (private; no package export).

**Protocol:**
- Headers: `X-OJS-Timestamp` (Unix seconds), `X-OJS-Signature` (`sha256=<hex>`, comma-separated rotation candidates)
- Signed bytes: the UTF-8 timestamp and literal `.` followed by the exact raw body bytes (verified before JSON parsing)
- Constant-time byte comparison, with every configured secret/signature candidate evaluated
- Default freshness: ±5 minutes (configurable via `freshnessSeconds`)
- Bounded: streaming Fetch-body reader with a 10 MiB default, 32-byte timestamp header, 8 KiB signature header, and 32 signature candidates
- Key rotation: multiple secrets tried in order
- Cross-runtime: pure `@noble/hashes` HMAC; no `node:crypto` or `Buffer` dependency in the Cloudflare/Vercel path

**Options added to all adapter surfaces** (`LambdaOptions`, `CloudflareWorkerOptions`, `VercelEdgeOptions`):
- `signingSecret?: string` — primary secret
- `signingSecrets?: string[]` — rotation candidates
- `freshnessSeconds?: number` — clock skew tolerance (default 300)
- `maxBodyBytes?: number` — body size limit (default 10 MB)
- `allowInsecurePush?: boolean` — bypass auth (default `false`)

**Security:** No secret + `allowInsecurePush !== true` → HTTP 500, fail closed.

**Lambda specifics (F-94):** the HTTP handler validates/decodes API Gateway base64 bodies without changing the signed bytes and uses case-insensitive header lookup. SQS and direct modes are unchanged (no auth).

**Cloudflare/Vercel specifics (F-95/F-96):** Fetch request streams are cancelled as soon as the configured body limit is exceeded, preventing unbounded buffering before authentication.

### F-97–F-98: Canonical Push Envelope

All three adapters (Lambda HTTP, Cloudflare, Vercel) now parse the canonical push envelope:
```json
{ "job": { ... }, "worker_id": "...", "delivery_id": "..." }
```

- `worker_id` and `delivery_id` are exposed in the handler context (`ctx.workerId`, `ctx.deliveryId`)
- Legacy bare-Job body (`{ id, type, args, ... }`) is permitted ONLY when `allowInsecurePush: true`
- Without the insecure flag, a body missing the `job` field returns HTTP 400

### F-99–F-100: Handler Failure Response

After a handler throws and NACK succeeds:
- **Before:** Cloudflare/Vercel returned HTTP 500
- **After:** All adapters return HTTP 200 with `{ status: 'failed', job_id, error: { code, message, retryable } }`

Only NACK delivery failure (network/HTTP error reaching the OJS server) returns 502/503 as appropriate.

### F-101: gRPC Stream Iterator Improvements

`GrpcTransport.openReconnectingStream()` refactored:

1. **Deferred signal composition:** the transport generation signal is captured at iterator creation without installing a listener; `combineStreamSignals()` runs only on first operation that initializes the stream. Unused iterators retain zero event listeners and cannot attach to a newer generation after `close()`.
2. **Memoized initialization:** `ensureInner()` creates exactly one `initPromise`. Concurrent initial `next()` calls share this single promise (no double-open).
3. **Serialized next:** Each `next()` chains after the previous completes (via `nextChain`). No concurrent reads → no duplicate messages.
4. **return()/throw()/close before or during init:** cancellation is visible before the RPC open point and all composed-signal listeners are removed.

### F-102: ML Named Types

`MLResourcesMetadata` and all nested metadata shapes (`MLGPUResourceMetadata`, `MLTPUResourceMetadata`, etc.) are now **type aliases** (not interfaces), making them structurally compatible with `{ [key: string]: JsonValue }` index signatures. This means:

```typescript
const resources: MLResourcesMetadata = { gpu: { count: 4, type: 'nvidia-h100' } };
const opts: MLEnqueueOptions = { meta: { resources } }; // ✅ No cast needed
```

Compile-time tests in `tests/types/ml-enqueue-options.ts` verify direct assignability.

### Migration Notes

- **Breaking (minor):** Cloudflare/Vercel handler failure now returns HTTP 200 instead of 500. Clients relying on 5xx for handler failures should check the `status` field in the response body.
- **Breaking (security):** Without `signingSecret`/`signingSecrets` AND without `allowInsecurePush: true`, all HTTP push requests are rejected. Existing deployments must add one of these options.
- **Breaking (envelope):** Without `allowInsecurePush: true`, bare Job bodies (without the `{job: ...}` wrapper) are rejected with 400.
- **Backward-compatible:** Setting `allowInsecurePush: true` restores pre-auth behavior entirely.

### Tests Added

- `tests/push-auth.test.ts`: 46 tests, including valid/tamper/replay/future/rotation/missing-secret/oversize coverage for each adapter, bounded raw/base64 handling, Edge-safe crypto, envelope compatibility, context, and response semantics
- `tests/grpc-iterator.test.ts`: exact listener/RPC/read-concurrency assertions for unused, concurrent-next, return-before/during-init, throw-before/during-init, and close-during-init paths
- `tests/types/ml-enqueue-options.ts`: Compile-time assignability tests for Finding 5

Changes remain **unstaged**.

---

## §4z — Canonical Queue Validation / Lambda Successful-NACK Response (Two Findings)

| Finding | ID | Status |
|---|---|---|
| Queue validation rejected schema-valid consecutive and trailing separators | F-103 | ✅ Implemented |
| Lambda omitted `job_id` from its successful-NACK HTTP response | F-104 | ✅ Implemented |

### F-103: Canonical Queue Validation

`validateQueueName()` now uses the exact `job-options.schema.json` contract:
`^[a-z0-9][a-z0-9\-.]*$`, with the schema's 128-character maximum. Raw gRPC
enqueue conversion delegates to the same validator instead of maintaining a
second queue rule. Queue names such as `queue--name`, `queue..name`, `queue.`,
and `queue-` are accepted; uppercase characters, leading separators,
underscores, empty strings, and values over 128 characters remain rejected.
Regression coverage exercises direct validation, single enqueue, batch
enqueue, and fake-mode testing paths.

### F-104: Lambda Successful-NACK Response Parity

After a Lambda HTTP handler fails and its NACK callback succeeds, the exact
HTTP 200 body is now
`{ status: 'failed', job_id: job.id, error: { code, message, retryable } }`.
This matches the existing Cloudflare and Vercel adapters and the uniform
serverless response documented in README. The Lambda regression asserts the
complete response object rather than only its `status` field.

---

## §4aa — Durable Replay / SSE CRLF / gRPC Workflow & Checkpoint / Callback Deadline (Six Findings)

| Finding | ID | Status |
|---|---|---|
| Replay type/order/key mismatches silently switched to record mode and could execute live side effects | F-105 | ✅ Implemented |
| SSE parsing leaked CRLF delimiter carriage returns into blank boundaries and fields | F-106 | ✅ Implemented |
| gRPC `getWorkflow()` required a process-local type cache and failed cross-instance reads | F-107 | ✅ Implemented |
| Legacy checkpoint fallback treated HTTP 405 as a fatal load failure | F-108 | ✅ Implemented |
| gRPC checkpoint Struct encoding bypassed JSON normalization and accepted lossy/unsupported values | F-109 | ✅ Implemented |
| Serverless callback timeout covered only non-2xx body reads, not fetch/headers | F-110 | ✅ Implemented |

### F-105: Fail-Closed Durable Replay

`DurableContext.now()`, `random()`, and `sideEffect(key)` now inspect the next
saved entry without consuming it first. Type/order or exact side-effect-key
mismatches throw the exported non-retryable `ReplayIntegrityError`; replay mode
and the cursor remain intact, no new entry is appended, and live side-effect
code is never called. Record mode begins only after the complete saved log is
consumed. Canonical/legacy replay-log shape corruption remains a load-time
`OJSCheckpointLoadError`.

### F-106: LF/CRLF SSE Parsing

The streaming parser removes exactly one trailing `\r` from each line produced
by splitting on `\n`. This normalizes LF, CRLF, mixed line endings, fragmented
CRLF delimiters, and CRLF blank event boundaries while preserving preceding
data content. SSE field parsing now removes at most the protocol's one optional
space after `:`, rather than trimming arbitrary leading content.

### F-107: Cache-Independent gRPC Workflow Status

Public `WorkflowStatus.type` is optional because the current gRPC `Workflow`
message omits the originating primitive; HTTP remains populated. Create-time
submitted hints and same-instance cache entries remain authoritative. On a
cache miss, `getWorkflow()` succeeds and infers only a strict multi-step linear
chain or a multi-step edge-free group. One-step and arbitrary DAG responses
omit `type` instead of returning a false/non-standard value or throwing.

### F-108: Legacy Checkpoint Endpoint Absence

After the authoritative canonical checkpoint endpoint returns 404, a legacy
resume endpoint response of either 404 or 405 now means “unsupported/no legacy
checkpoint” and permits first execution. `OJSMethodNotAllowedError` gives the
HTTP transport a stable 405 classification. Network, authorization, 5xx,
decode, and replay-integrity failures remain fail closed as
`OJSCheckpointLoadError`.

### F-109: JSON-Semantic gRPC Checkpoint Encoding

Before `SaveCheckpointRequest.state` enters `google.protobuf.Struct`
conversion, it is normalized through `JSON.stringify`/`JSON.parse` semantics.
Dates use `toJSON()` ISO strings, undefined object properties are omitted, and
undefined/sparse array entries become null. Cycles, non-finite numbers, BigInt,
functions, symbols, and non-object normalized roots are rejected before the
RPC. Null-prototype Struct accumulators continue preserving `__proto__`,
`constructor`, and `prototype` as ordinary data through real serialization.

### F-110: Whole-Delivery Serverless Callback Deadline

`callbackTimeoutMs` now starts before `fetch()` and one AbortController budget
covers connection setup, response headers, and bounded error-body handling.
An abort-ignoring fetch is raced against the deadline so it cannot hang;
pre-header timeout becomes a retryable network `CallbackDeliveryError`. If a
non-2xx response arrives first, its HTTP classification is preserved and body
inspection receives only the remaining budget. Timers and SDK-owned abort
listeners are removed in `finally`, readers/late response bodies are cancelled
best-effort, and successful 2xx callbacks still return immediately after
headers.

### Tests Added/Extended

- `tests/durable.test.ts`, `tests/errors.test.ts`: replay order/type/key,
  zero-live-side-effect, legacy 404/405, and typed error coverage
- `tests/subscribe.test.ts`: fragmented CRLF, mixed LF/CRLF, blank-boundary,
  and preserved-content coverage
- `tests/transport-grpc-workflow-cron-ack.test.ts`,
  `tests/types/workflow-status.ts`: cross-instance workflow type inference,
  ambiguous omission, JSON-semantic checkpoint normalization, invalid values,
  malicious keys, and actual proto serialization
- Historical callback-helper regressions were removed with the dead helper
  under F-118; `tests/serverless{,-lambda}.test.ts` now cover zero callback
  fetches and exact HTTP push response contracts.

Changes remain **unstaged**.

**Current six-finding verification (§4aa):** the complete suite passes
**1226/1226** tests on Node **18.20.8**, **20.20.2**, and **22.23.2**.
In isolated Docker copies on all three runtimes, `npm ci`, `npm run lint`,
`npm run test:types`, `npm test`, `npm run test:coverage`, `npm run build`,
`npm run check:package`, `npm run size`, `npm run docs`, and
`npm audit --audit-level=high` pass. Coverage is approximately
**90.22–90.23% statements/lines, 88.15–88.16% branches, and
96.68–96.87% functions**; all 13 package entry points pass ESM/CJS and
Node/browser type verification; bundle size is **935 B brotlied** against the
15 kB limit; audit reports 0 vulnerabilities. Node 18 retains the documented
development-tool `EBADENGINE` warnings, and TypeDoc completes with 0 errors
and the same 14 pre-existing warnings. No files are staged.

---

## §4ab — Enqueue Onion / Durable Void / gRPC Stream / JSON Clone / Type Resolution (Six Findings)

| Finding | ID | Status |
|---|---|---|
| Enqueue middleware chain terminated in a no-op echo, so `await next()` never returned the real created Job and batch had no barrier orchestration | F-111 | ✅ Implemented |
| Durable replay loader rejected `call` entries whose recorded `undefined` result was (correctly) dropped by JSON serialization | F-112 | ✅ Implemented |
| gRPC stream reconnect backoff reset on every raw message, including filtered `stream.keepalive` sentinels | F-113 | ✅ Implemented |
| A consumer `.throw()` on a reconnecting stream iterator could resolve cleanly instead of rejecting once the inner generator unwound via signal-abort | F-114 | ✅ Implemented |
| Enqueue args/meta cloning treated objects as records, dropping `toJSON`, silently corrupting `Date`, and never rejecting BigInt/non-finite/cycles | F-115 | ✅ Implemented |
| Package exposed conditional `exports` types only, so classic `moduleResolution: node` consumers could not resolve subpath declarations | F-116 | ✅ Implemented |

### F-111: Enqueue Middleware Onion Terminates in the Real Enqueue

`OJSClient.enqueue()` previously ran the enqueue middleware chain against a
no-op terminal that merely echoed the envelope, then performed the transport
call *after* the chain resolved. `await next()` therefore returned the
pre-send envelope, and any post-`next()` mutation was re-serialized and sent.

The chain now terminates in a real `terminalEnqueue(job)` that validates/
serializes the post-middleware envelope (`toWireEnqueueRequest`, which throws
before any I/O for an invalid envelope) and then performs the single real
enqueue — one `POST /jobs`, or the in-memory record in fake/inline test mode —
returning the actual created Job (server-assigned id/state). Consequently
`await next()` resolves to that created Job, post-`next()` code observes its
id/state or a transport error, and post-`next()` mutations affect only the
value the outermost middleware returns to the caller; they are never re-sent,
because serialization already happened when `next()` reached the terminal.

`enqueueBatch()` keeps its single atomic transport call but now uses a
barrier/deferred orchestration: every per-job middleware chain runs against a
terminal that validates/serializes the item and registers a deferred; a
barrier waits until every chain has reached its terminal or settled (dropped
by returning `null`, or errored). A middleware/validation error aborts the
whole batch before any transport call (pending terminals are rejected and the
first error is thrown); dropped items are omitted; if every item drops, no
request is issued. Otherwise one `POST /jobs/batch` (or per-item in-memory
records in test mode) is sent, each terminal is resolved with its
corresponding response Job in original order, and the chains are then awaited
so their post-`next()` code runs (observing the response Job or, on transport
failure, the rejected deferred, which also rejects the whole batch). A
response-cardinality mismatch is treated as a connection/protocol failure and
rejects every pending terminal rather than resolving one with `undefined`.

### F-112: Durable Void Side-Effect Replay

`DurableContext.sideEffect()` records the raw callback return value, which may
legitimately be `undefined`. Because `JSON.stringify` drops object properties
whose value is `undefined`, such a `call` entry serializes with no `result`
key. The replay-log loader (`replayEntriesFromState`, used for both the
current wrapped state and the legacy `_replay_log` string) previously rejected
any entry missing `result`. It now requires `result` only for `time`
(parseable ISO string) and `random` (hex string) entries; a `call` entry may
omit `result`, and the replay path interprets the absent key as `undefined`
and returns it without invoking the callback. Recording an `undefined` result
remains JSON-compatible (the entry round-trips as `{seq,type:'call',key}`).

### F-113: Keepalive-Aware Stream Backoff Reset

`runReconnectingServerStream` reset its reconnect-attempt counter on every raw
message pulled from the underlying call, before `map()` ran. Filtered
`stream.keepalive` sentinels (which `map()` drops by returning `undefined`)
therefore reset the counter, so a stream that only ever emitted keepalives
between transient failures could reconnect forever and never honor
`maxAttempts`. The reset now happens only after `map(raw)` yields a
caller-visible (non-`undefined`) value, so keepalives no longer count as a
successful delivery. A real message still resets the counter.

### F-114: Consumer `.throw()` Always Rejects After Cleanup

Calling `.throw(err)` on a reconnecting stream iterator aborts the internal
signal to cancel the active call/backoff synchronously. That abort makes the
inner native generator return *cleanly* (via its own signal-aborted guard)
rather than re-surfacing `err`, so `inner.throw(err)` resolved `{done:true}`
and the consumer's `.throw()` resolved silently instead of rejecting. Both
iterator layers — `grpc-stream.ts`'s `reconnectingServerStream` and
`grpc.ts`'s `GrpcTransport.streamJobs()`/`streamEvents()` wrapper — now let the
inner unwind, then reject with the consumer-provided error. A *different*
inner rejection (a genuine stream/cleanup failure) still propagates unchanged.

### F-115: JSON-Semantic Enqueue Cloning

Enqueue `args`/`meta` cloning walked objects as plain records: `toJSON` was
never called (a `Date` collapsed to `{}`, a `URL` likewise), `undefined`/
functions/symbols were mishandled, and BigInt/non-finite numbers/cycles were
accepted or silently corrupted. Cloning now mirrors
`JSON.parse(JSON.stringify(value))` semantics — invoking `toJSON(key)`
(`Date`/`URL`/custom), preserving finite numbers/strings/booleans/`null`,
turning array holes/omitted elements into `null`, and dropping omitted object
properties — with two fail-closed departures: non-finite numbers and BigInt
throw `OJSValidationError` (instead of `null`/`TypeError`), and cycles throw
`OJSValidationError`. Results are built on null-prototype objects so hostile
keys (`__proto__`/`constructor`/`prototype`) are preserved as ordinary data.
Normalization runs at envelope creation (before middleware) and again at wire
serialization before terminal validation, and never mutates the caller's
objects. Metadata whose root `toJSON()` result is not an object is rejected
instead of being silently replaced with an empty record.

### F-116: Classic-Resolution Type Discovery

The package exposed subpath declarations only through conditional `exports`
`types`, which TypeScript's classic `moduleResolution: node` ignores. A
`typesVersions["*"]` map now points every non-root subpath
(`serverless`, `serverless/{cloudflare,vercel,lambda}`, `middleware`, `ml`,
`encryption`, `otel`, `subscribe`, `agent`, `attest`, `recorder`) at its
`dist/esm` declaration; the root is covered by the top-level `types` field.
`scripts/check-package.mjs` gained a third packed-package compile pass with
`module: CommonJS`/`moduleResolution: node` (alongside the existing
`NodeNext` and `Bundler` passes and the ESM/CJS runtime import checks), so a
regression in the classic mappings fails the `check:package` gate.

### Tests Added/Extended

- `tests/client.test.ts`: single-enqueue onion ordering, server-assigned
  id/state observed post-`next()`, transport-failure propagation, encryption
  before `next()`, fake/inline termination, and pre-vs-post-`next()`
  serialization; batch ordered terminal resolution, post-`next()`
  return-only mutation, transport-failure and response-cardinality rejection
  of every terminal, and fake-mode atomic recording. The prior "serialize all
  post-middleware mutations" test was rewritten to the corrected onion
  contract.
- `tests/transport-grpc-enqueue-options.test.ts`: the single-enqueue mapping
  test was rewritten to assert only pre-`next()` mutations reach the wire and
  post-`next()` mutations appear on the returned Job only.
- `tests/job.test.ts`: `Date`/`URL`/custom `toJSON`, array-`undefined`→`null`,
  object omission of `undefined`/functions/symbols, non-finite/BigInt/cycle
  rejection, diamond acceptance, prototype-safe hostile keys, and
  no-caller-mutation coverage, including normalization before terminal
  validation and rejection of non-object metadata `toJSON()` roots.
- `tests/durable.test.ts`: recording an `undefined` side effect as a
  `result`-less entry, and replaying `undefined` from serialized
  current-format and legacy checkpoints without invoking the callback.
- `tests/transport-grpc-stream.test.ts`: keepalives never reset the attempt
  counter (maxAttempts still honored) while a real message does, plus
  pending and post-yield `.throw()` rejecting with the consumer error.
- `tests/grpc-iterator.test.ts`: a connected `GrpcTransport` stream iterator's
  `.throw()` rejects with the consumer error even though the mock/inner
  unwinds cleanly.
- `tests/package-exports.test.ts`: every non-root subpath is mapped in
  `typesVersions["*"]` to its `exports` declaration, with no stale keys.

Changes remain **unstaged**.

**Six-finding verification (§4ab):** the complete suite passes **1260/1260**
tests on Node **18.20.8**, **20.20.2**, and **22.23.1**. On all three
runtimes `npm run lint`, `npm run test:types`, `npm test`, `npm run build`,
`npm run check:package`, `npm run test:coverage`, `npm run size`,
`npm run docs`, and `npm audit --audit-level=high` pass (the package check now
verifies 13 entry points under ESM, CJS, Node types, browser types, and classic
`module=CommonJS, moduleResolution=node` types). Coverage is
~**90.56–90.57% statements/lines, 88.26–88.27% branches, and at least 96.88%
functions** across the three runtimes; package size is **935 B brotlied**
against the 15 kB limit; dependency audit reports **0 vulnerabilities**; and
TypeDoc completes with **0 errors** and the same 14 pre-existing warnings. No
files are staged.

## §4ac — HTTP Push Protocol / gRPC Stream Timeout & Pre-Abort / Cron Registration / Abort Normalization / Fake-Mode Deep Cloning (Seven Findings)

| Finding | ID | Status |
|---|---|---|
| Push-body chunk reassembly used a variadic `concatBytes(...chunks)` spread, risking a call-stack/argument-limit failure on many small fragments | F-117 | ✅ Implemented |
| Cloudflare/Vercel/Lambda `httpHandler` called back to the OJS `/workers/ack`/`/workers/nack` endpoints after an HTTP-pushed job, duplicating the state-transition signal the response itself already carries | F-118 | ✅ Implemented |
| `GrpcStreamOptions.timeout` was applied as the underlying gRPC call's own deadline, silently killing an already-open, healthy stream once it elapsed | F-119 | ✅ Implemented |
| A pre-aborted (or aborted-while-initializing) gRPC unary `call()` still resolved the optional gRPC peer dependencies/proto/channel before checking the signal | F-120 | ✅ Implemented |
| `grpcRegisterCron()` performed a racy, O(n) best-effort follow-up `ListCron` lookup to "refine" its response | F-121 | ✅ Implemented |
| `HttpTransport`'s outer request catch could propagate an un-normalized (even primitive) thrown value when its internal `AbortController` was aborted | F-122 | ✅ Implemented |
| `testing.ts`'s fake-mode job store shallow-copied (or, in `_toJob()`, did not copy at all) `args`/`meta`, letting a mutation of a returned job corrupt the recorded store | F-123 | ✅ Implemented |

### F-117: Push-Body Chunk Reassembly Without a Variadic Spread

`readBoundedRequestBody()` (`src/serverless/push-auth.ts`) reassembled the
streamed request body with `concatBytes(...chunks)` — spreading every
buffered chunk as an individual call argument. A request delivered as many
small fragments (e.g. hundreds of thousands of one-byte chunks) risks
exceeding the JS engine's call-stack/argument limit purely from that spread,
independent of the (already-enforced) total byte-size limit. The final
buffer is now allocated once (`new Uint8Array(totalBytes)`, using the byte
count already tracked for the size-limit check) and each chunk is copied in
with `.set(chunk, offset)` in a plain loop — no spread, no per-chunk
re-allocation, and no behavioral change to the existing bounded-read/cancel
semantics.

### F-118: HTTP Push Protocol Is Response-Derived, Not Callback-Derived

Cloudflare's `handleRequest()`, Vercel's `handleRequest()`, and Lambda's
`httpHandler()` previously called the shared `ackJob()`/`nackJob()` helpers
(`POST /ojs/v1/workers/ack`/`nack`) after running the registered handler,
racing a second write path against the response the pushing OJS backend was
already about to receive. This is redundant for an HTTP-push delivery model:
the backend that pushed the job over HTTP can and does derive the job's
state transition from this handler's own HTTP response, with no follow-up
request needed.

All three adapters' HTTP push paths now:

- **Handler success:** return HTTP `200` with `{ status: 'completed', job_id }` — no callback.
- **Handler failure:** return HTTP `200` with `{ status: 'failed', job_id, error: { code: 'handler_error', message, retryable: true } }` — no callback. (The prior version returned this same shape, but only *after* a callback round-trip and its own delivery-failure branch; a NACK-callback-delivery-failure response code path — 502/503 — no longer exists on the HTTP push path since no callback is made.)

Signature verification (timestamp/HMAC/freshness/replay/rotation, per
`push-auth.ts`) is completely unaffected and still runs before any handler
dispatch.

**Compatibility:** `CloudflareWorkerOptions.url`/`apiKey`/`callbackTimeoutMs`,
`VercelEdgeOptions.url`/`apiKey`/`callbackTimeoutMs`, and
`LambdaOptions.url`/`apiKey`/`callbackTimeoutMs` are now optional (previously
`url` was required) and documented `@deprecated`: they are still accepted on
existing configuration objects for backward compatibility, but `httpHandler`/
`handleRequest` no longer read or use them, since there is no longer a
callback request to configure. `sqsHandler`/`directHandler` (Lambda's other
two invocation modes) never called back to the OJS server either, before or
after this change. Because no non-HTTP mode needs an out-of-band callback,
the old internal ACK/NACK callback helper was removed instead of retained as
dead infrastructure.

### F-119: gRPC Stream `timeout` Bounds Setup Only, Never a Healthy Stream's Lifetime

`GrpcTransport`'s `openServerStream()` previously passed `GrpcStreamOptions.
timeout` straight through as `callOptions.deadline` on the underlying
`@grpc/grpc-js` call — a genuine RPC-lifetime deadline that terminates the
call once elapsed, *regardless of activity*. Since this deadline was
recomputed fresh (`Date.now() + timeout`) on every reconnect attempt, any
caller who set `timeout` (with no other way to express "give up connecting
after N ms") got a stream that silently died and reconnected every `timeout`
milliseconds even while healthy and actively delivering messages — directly
contradicting the stream's own documented contract ("a healthy stream is
expected to stay open indefinitely," ojs-grpc-binding.md §§10.1.1/10.2.1).

`timeout` now bounds *setup only*:

- **Client/proto initialization** (`GrpcTransport.ensureClient()`, run at
  most once no matter how many streams/reconnects follow) is raced against
  `timeout` and stream/consumer abort via
  `ensureClientWithSetupTimeout()`, rejecting with an `OJSConnectionError`
  if initialization itself never settles in time and stopping promptly if
  the stream is cancelled.
- **Opening each connection attempt** — the initial connection and every
  subsequent reconnect — is bounded by a new `connectTimeoutMs` option on
  `grpc-stream.ts`'s `reconnectingServerStream`/`runReconnectingServerStream`,
  via a new `waitForStreamOpen()` helper. It races the attempt's `connect()`
  result against `timeout`, using the call's optional structural
  `on('metadata' | 'status' | 'error', ...)` surface (real `@grpc/grpc-js`
  `ClientReadableStream` calls provide this, being `Readable`/`EventEmitter`
  instances) as the earliest reliable "this attempt reached the server, or
  failed trying" signal. A call implementation without that surface (e.g. a
  minimal test fake) is treated as immediately open, so the bound then only
  covers client/proto initialization for such implementations.
- **Once an attempt is open**, `timeout` no longer applies to it for the
  rest of its lifetime — a stream that keeps delivering, or sits idle, for
  far longer than `timeout` is never killed.
- **A setup that does not open in time** is cancelled and treated exactly
  like a transient `DEADLINE_EXCEEDED` connectivity failure — retried
  through the exact same reconnect/backoff/`maxAttempts` policy as
  `UNAVAILABLE`, never left hanging indefinitely and never a silent, hard
  failure.

`openServerStream()` no longer sets `callOptions.deadline` from `timeout` at
all. A new, additive, purely opt-in `GrpcStreamOptions.streamDeadline`
restores the old semantics *only* when a caller genuinely wants a hard
RPC-lifetime ceiling (passed straight through as the gRPC call's deadline,
recomputed fresh on every reconnect attempt exactly as `timeout` used to
be) — most long-lived worker/event streams should leave it unset.

### F-120: Pre-Aborted gRPC Unary Call Checks the Signal Before `ensureClient()`

`GrpcTransport.call()` previously awaited `ensureClient()` (the dynamic
`import()` of the optional `@grpc/grpc-js`/`@grpc/proto-loader` peer
dependencies, proto loading, and channel construction) *before* checking
whether the caller's `AbortSignal` was already aborted. A caller that passed
an already-cancelled request therefore still paid for (and could still fail
on, e.g. with a "proto files not found" error masking the real
cancellation) that entire initialization sequence, only to then reject on
an unrelated code path or coincidentally return the correct-looking error
for the wrong reason.

The signal is now checked *first*, throwing the same normalized
`OJSConnectionError('Request cancelled: <method>')` immediately if already
aborted, before `ensureClient()` is ever invoked — never resolving imports,
loading the proto, or opening a channel for a request that was already
cancelled before it began. A second check immediately after `ensureClient()`
resolves (retained from before) still closes the real, non-theoretical race
of the signal aborting while that initialization was in flight.

### F-121: `grpcRegisterCron()` No Longer Performs a Racy, O(n) Follow-Up `ListCron` Lookup

`grpcRegisterCron()` previously issued the `RegisterCron` RPC and then a
*second*, best-effort `ListCron` RPC to find the newly-registered entry by
name and "refine" the response with it (its `args`/`options`/`timezone`,
falling back to the raw request echo on any failure or if the entry wasn't
found). This was racy — nothing guaranteed the entry was visible yet, or
observed in a mutually consistent state, by the time the follow-up ran, and
a concurrent upsert of the same cron name could return a mix of two
different response revisions — and O(n) in the total number of registered
schedules just to locate one entry by name on every single registration.

`grpcRegisterCron()` now issues exactly **one** RPC. `CronJobInfo` is
reconstructed solely from:

1. The submitted definition (`cron`, `type`, `args`, `timezone`, `options`,
   `meta` — a faithful echo of exactly what was asked to be registered), and
2. `RegisterCronResponse`'s own authoritative `name`/`next_run_at` (the only
   two fields it actually carries), and
3. A registration timestamp captured locally, immediately before the RPC
   (service.proto has no `created_at` field at all), with `status: 'active'`
   (service.proto has no paused/disabled cron state).

### F-122: `HttpTransport` Normalizes Any Abort-Triggered Rejection, Even a Primitive

`HttpTransport.executeRequest()`'s outer `catch` block preserved already-
thrown OJS errors, wrapped `TypeError`/`DOMException`/`SyntaxError` as an
`OJSConnectionError`, and otherwise re-threw the caught value completely
unchanged — including a bare primitive (a string, number, or plain object)
that some non-standard `fetch()` implementation might throw directly instead
of a `DOMException`/`Error` when its internal `AbortController` (the
request's own timeout, or an external `options.signal` forwarded into it)
is aborted. That would violate the "always reject with a real `Error`"
invariant this SDK's own `abortReasonAsError` helper already documents and
enforces on the sibling body-reading/JSON-parse-failure path.

The outer catch now checks `controller.signal.aborted` immediately after
preserving an already-thrown OJS error, and if the internal controller was
aborted, throws `abortReasonAsError(controller.signal)` — the signal's own
`reason`, unwrapped if it is already an `Error`/`DOMException`, or
`new Error('The operation was aborted', { cause: reason })` otherwise —
*regardless* of what `fetch()` itself actually threw. This takes priority
over the generic `TypeError`/`DOMException`/`SyntaxError` wrapping below it,
so an abort's real cause is surfaced consistently whether the abort
surfaces while `fetch()` itself is pending or while the response body is
still being read/parsed as JSON (the existing, narrower check in that
inner path now overlaps with, rather than duplicates, this general one).
An already-thrown OJS error still always wins and is never overridden by
this normalization.

### F-123: Fake/Testing-Mode Deep Cloning

`src/testing.ts`'s in-memory fake-mode job store recorded a `FakeJob`'s
`args`/`meta` with a *shallow* `[...envelope.args]`/`{ ...envelope.meta }`
copy — protecting only the outer array/object, never values nested within
it — and `_toJob()` (which converts a stored `FakeJob` back into the public
`Job` shape returned through the enqueue middleware onion, i.e. the value a
caller's `await client.enqueue(...)` actually resolves with) did not copy
`args`/`meta` at all, directly reusing the exact same array/object
references stored in the record. A caller mutating a nested value inside a
job returned by `client.enqueue()` — entirely legitimate "post-`next()`"
code per the enqueue-onion contract (§4ab/F-111) — would therefore silently
corrupt this module's own recorded store, so a later
`testing.assertEnqueued()`/`allEnqueued()` would observe the *mutated*
value instead of what was actually recorded at enqueue time. The same
reference-sharing problem applied in reverse to `allEnqueued()`'s exposed
array of live `FakeJob` objects.

`_recordEnqueueEnvelope()`, `_toJob()`, `envelopeToOptions()`'s `options.meta`
field, and a new `cloneEnqueueOptions()`/`cloneFakeJob()` pair used by
`allEnqueued()` (and the new `performed()` accessor below) now all deep-clone
`args`/`meta` using `job.ts`'s existing JSON-semantic normalization
(`cloneJsonArray`/`cloneJsonRecord`, newly exported for this reuse) — the
exact same rules `createEnqueueEnvelope()` already applies for the real
enqueue path: a `Date`/`URL`/custom `toJSON()` value normalizes identically
in fake mode as in real mode, and a `__proto__`/`constructor`/`prototype`
key is preserved as ordinary data on a null-prototype object rather than
walking or polluting a real prototype chain. `tags`/`retry`/`unique` (all
already using the pre-existing `copyRetry`/`copyUnique`/spread-array
patterns) are also independently re-cloned wherever a `FakeJob` is exposed.

**Additive:** a new `testing.performed(filter?)` accessor was added
alongside the pre-existing `testing.allEnqueued(filter?)` — the read-only
counterpart for the `performed` half of the store `assertPerformed()`/
`assertCompleted()`/`assertFailed()` already consult internally, returning
the same deep-cloned-per-job guarantee.

### Migration Notes

- **Breaking (behavioral, security-neutral):** Cloudflare/Vercel/Lambda's
  HTTP push handlers no longer call back to the OJS server's `/workers/ack`/
  `/workers/nack` endpoints. A deployment whose OJS backend previously relied
  on receiving that separate callback (rather than deriving the transition
  from the push response itself) must be updated to consult the response.
  `url`/`apiKey`/`callbackTimeoutMs` are now optional and unused on all three
  adapters' options (backward-compatible: still accepted, simply ignored).
- **Breaking (behavioral):** `GrpcStreamOptions.timeout` no longer acts as a
  hard RPC-lifetime deadline — a caller that relied on it silently
  terminating a long-lived healthy stream every `timeout` milliseconds (for
  example, as an ad hoc periodic-reconnect mechanism) must switch to the new,
  explicit, additive `streamDeadline` option to restore that exact behavior.
- **Backward-compatible:** the pre-abort/`ensureClient()`-ordering fix,
  the cron-registration single-RPC fix, the `HttpTransport` abort
  normalization fix, and the fake-mode deep-cloning fix are all pure
  correctness/robustness fixes with no public API or wire-format changes.
- **Additive:** `GrpcStreamOptions.streamDeadline` and `testing.performed()`
  are new, optional/additional public surface; no existing export changed
  shape.

### Tests Added

- `tests/push-auth.test.ts`: a 500,000-one-byte-chunk `readBoundedRequestBody()`
  reassembly test (via a fast duck-typed reader, isolating the code path
  under test from unrelated real-`ReadableStream` per-read engine overhead);
  a new "HTTP push protocol response contract (zero callback)" describe
  block asserting `fetch` is never called and the exact `completed`/`failed`
  response bodies for all three adapters, including with `url`/`apiKey`/
  `callbackTimeoutMs` configured.
- `tests/serverless.test.ts` and `tests/serverless-lambda.test.ts`: rewritten
  ack/nack-callback-asserting tests replaced with zero-callback,
  exact-response-contract tests (including the deprecated/unused options).
- `tests/transport-grpc.test.ts`: `options.streamDeadline` (not `timeout`)
  now sets `callOptions.deadline`; a live, already-open stream is not
  cancelled once `options.timeout` elapses; abort/consumer return stop a
  blocked client/proto initialization promptly; a pre-aborted signal rejects
  before `ensureClient()` is ever called (`protoPath` pointed at a
  nonexistent directory, spying on `ensureClient` to assert zero calls) and
  the same holds when the signal aborts while `ensureClient()` is still
  pending.
- `tests/transport-grpc-stream.test.ts`: a new `connectTimeoutMs` describe
  block — no bound when unset, a call without `on()`/`off()` treated as
  immediately open, a blocked (never-opens) setup cancelled/reconnected like
  `DEADLINE_EXCEEDED` honoring backoff/`maxAttempts`, a prompt rejection with
  reconnect disabled, and an already-open healthy stream never killed once
  `connectTimeoutMs` elapses even while it keeps delivering.
- `tests/cron-operations-grpc.test.ts` and
  `tests/transport-grpc-workflow-cron-ack.test.ts`: rewritten to assert
  exactly one `registerCron` RPC (no `listCron` follow-up), a conflicting/
  stale `ListCron`-store entry of the same name is never consulted,
  concurrent `register()` calls for different names never cross-contaminate
  results even when responses resolve out of issue order, and upserting the
  same name twice reflects only the latest submitted definition.
- `tests/http.test.ts`: primitive and plain-object values thrown directly by
  `fetch()` (both when the call itself is pending and during body/JSON
  reading) are normalized via `abortReasonAsError`, never propagated as-is;
  an already-thrown OJS error still wins over an independently-aborted
  signal; two pre-existing abort tests were updated to assert the corrected,
  consistent (unwrapped-Error, not blanket `OJSConnectionError`) contract.
- `tests/testing.test.ts`: a new "Finding 7" describe block — mutating a
  `client.enqueue()`-returned job's nested args/meta/tags after `next()`
  cannot alter the recorded store; mutating a job returned by
  `allEnqueued()`/`performed()` cannot alter the store; mutating the
  caller's own args/meta objects after enqueuing does not affect the
  record; two `_toJob()` calls for the same record never share references;
  and real-mode parity tests confirming fake-mode recording normalizes
  `Date` values and preserves `__proto__`/`constructor`/`prototype` keys
  identically to `createEnqueueEnvelope()`.

Changes remain **unstaged**.

**Seven-finding verification (§4ac):** the complete suite passes
**1273/1273** tests on Node **18.20.8**, **20.20.2**, and **22.23.2**. On all
three runtimes `npm run lint`, `npm run test:types`, `npm test`,
`npm run build`, `npm run check:package`, `npm run size`, `npm run docs`, and
`npm audit --audit-level=high` pass (the package check verifies 13 entry
points under ESM, CJS, Node types, browser types, and classic
`module=CommonJS, moduleResolution=node` types; the audit reports **0
vulnerabilities**; TypeDoc completes with **0 errors** and the same 14
pre-existing documentation warnings). `npm run test:coverage` was run on
Node 20.20.2 (matching this repository's own CI, which restricts the
coverage step to Node 20): **90.04% statements/lines, 88.10% branches, and
96.49% functions** overall, comfortably above the configured 80%/75%/80%
thresholds; package size is **935 B brotlied** against the 15 kB limit. No
files are staged.

## §4ad — Immediate Per-Job Terminal SSE Cancellation

| Finding | ID | Status |
|---|---|---|
| Per-job subscriptions recorded terminality in an outer flag but kept parsing/reading until EOF, so a non-closing stream remained active and later events already buffered after the terminal frame could still reach user code | F-124 | ✅ Implemented |

### F-124: Terminal Delivery Explicitly Stops `connectOnce()`

The subscription wrapper now classifies a terminal per-job
`job.state_changed` before invoking user code and returns an explicit
`'stop'` dispatch control to `connectOnce()` after the handler settles.
`connectOnce()` starts `reader.cancel(reason)`, synchronously applies the
subscription stop/abort callback, and returns immediately from the parser,
so it neither requests another chunk nor dispatches a later event already
present in the current chunk. This no longer depends on an outer
`sawTerminalJobState` flag observed only after the connection promise
eventually resolves at EOF.

If the terminal handler throws or rejects, `SSEHandlerError` carries the
same stop control. `connectOnce()` cancels and stops before rethrowing, while
the outer error path deliberately still reports the original handler error
to `onError` exactly once despite the subscription already being stopped.
Reader cancellation remains best-effort: a rejecting `cancel()` cannot
replace the handler result/error and `releaseLock()` always runs. Queue
channels never emit the stop control, even when an individual queued job
reaches a terminal state.

### Tests Added

- `tests/subscribe.test.ts`: a terminal event on a stream that never closes
  cancels immediately; a later event in the same chunk is not dispatched;
  the same terminal-plus-later chunk on a queue channel dispatches both;
  terminal handler failure calls `onError` once, cancels, and suppresses the
  buffered follower; and a rejecting `reader.cancel()` still releases the
  lock, stops permanently, and does not surface as a subscription error.

Changes remain **unstaged**.

**Immediate terminal-SSE verification (§4ad):** on Node **22.23.1**, the
focused subscription suite passes **81/81** and the complete suite passes
**1277/1277** tests. `npm run lint`, `npm run test:types`, `npm test`,
`npm run test:coverage`, `npm run build`, `npm run check:package`,
`npm run size`, `npm run docs`, `npm audit --audit-level=high`, and
`git diff --check` all pass. Coverage is **90.20% statements/lines, 88.04%
branches, and 96.69% functions**; the package check verifies all **13**
entry points; size is **935 B brotlied** against the 15 kB limit; dependency
audit reports **0 vulnerabilities**; and TypeDoc completes with **0 errors**
and the same 14 pre-existing warnings. No files are staged.

## §4ae — Batch Terminal Retry-Once & Distinct HTTP Request Timeout

| Finding | ID | Status |
|---|---|---|
| A retry-style enqueue middleware that re-invoked `next()` after the single atomic batch transport had already been attempted re-entered the per-job terminal, which registered a *fresh* deferred and hung forever (stranding `Promise.allSettled(chains)`) waiting for a second transport cycle that never comes | F-125 | ✅ Implemented |
| The `HttpTransport` internal timeout aborted its controller with no reason, so a per-request deadline surfaced as an opaque, reason-less `AbortError` `DOMException` — indistinguishable from an external cancellation, carrying no timeout/path detail, and unable to participate in the retry policy | F-126 | ✅ Implemented |

### F-125: Each Batch Terminal Is a Single Atomic-Transport Slot

`OJSClient.enqueueBatch()` runs every per-job enqueue-middleware chain to a
terminal decision (send / drop / error) **before** issuing exactly **one**
atomic `POST /jobs/batch` request, then resolves/rejects each chain's terminal
deferred with its corresponding response Job (or the shared transport error).

Each job's batch terminal represents that one atomic transport slot and may now
be *reached* only once. A retry-style enqueue middleware that catches a
transport or validation rejection and calls `next()` again would otherwise
re-enter the terminal after the batch had already been attempted. The terminal
now:

- records the **original** terminal error — whether it was a synchronous
  validation throw from `toWireEnqueueRequest()` (captured in a `catch` before
  it propagates) or the deferred `reject(error)` the shared batch transport
  step invoked (wrapped so the exact error object is recorded);
- on any re-invocation, immediately returns `Promise.reject(originalError)`
  (falling back to a descriptive `OJSConnectionError` only in the impossible
  case that no error was recorded yet) **without** registering a new deferred,
  resolving a gate, or waiting for another transport cycle;
- never replaces the recorded `BatchTerminal` deferred.

This makes the retry middleware receive the **same deterministic error** on
every attempt, lets its chain unwind, and lets `Promise.allSettled(chains)`
settle promptly — no hang, and exactly one transport call for the whole batch.

**Whole-batch transport retry is intentionally unsupported.** Middleware may
retry its own *pre-terminal* handler work, but it cannot retry an
already-attempted atomic batch send; this is documented in `enqueueBatch()`'s
inline comment and in the README's "Batch Enqueue" section.

### F-126: Internal Timeout Is a Typed, Retryable, Method-Aware Error

`HttpTransport.executeRequest()` now arms its per-request deadline by aborting
the internal `AbortController` with a distinct, typed reason: a new
`OJSRequestTimeoutError` (a subtype of `OJSConnectionError`, so existing
`instanceof OJSConnectionError` handling keeps treating it as a retryable
transient failure — backward compatible) that carries `timeoutMs`, `path`, and
structured `details` (`{ timeout_ms, path }`). Because the catch and
body-read/JSON-parse paths normalize `controller.signal.reason` via
`abortReasonAsError`, an internal timeout — whether it fires while `fetch()`
is pending or while the response body is still streaming — surfaces as this
typed, retryable error instead of an opaque, reason-less `AbortError`.

`request()`'s retry loop introduced method-gated internal-timeout retries in
this pass. Its original `GET`/`PUT`/`DELETE` classifier was later superseded by
F-136 (§4ag): current behavior retries ambiguous timeout/network failures only
for GET/HEAD and contract-safe PUT, never DELETE. A `POST` timeout remains
genuinely ambiguous (the server may already have enqueued the job), so it is
never transparently retried; that ambiguity remains governed by the existing
idempotency rules (e.g. a caller-supplied `unique` policy), avoiding a duplicate
enqueue. An **external** `options.signal` abort keeps
surfacing its own (non-timeout) reason — normalized to a real `Error`,
including bare primitive/plain-object reasons — and is never classified as a
retryable timeout, so it is never retried.

### Tests Added

- `tests/client.test.ts` (`enqueueBatch terminal retry semantics`): a retry
  middleware re-invoking `next()` after a transport failure rejects with the
  original error and issues exactly one transport call; the same across
  multiple jobs (one atomic batch of 3, all attempts observe the identical
  error); a transport failure without retry middleware rejects every terminal
  once with no re-issue; a retry middleware that backs off with a real timer
  still resolves promptly with one transport call (no hang across the async
  gap); and a retry middleware re-invoking `next()` after a validation failure
  aborts before any transport call with the identical original validation error.
- `tests/http.test.ts` (`HttpTransport internal timeout`): the internal timeout
  surfaces as a retryable `OJSRequestTimeoutError` (also an `OJSConnectionError`)
  with `timeoutMs`/`path`/`details`; a `GET` internal timeout is retried and
  succeeds on a later attempt; a persistent `GET` timeout exhausts retries and
  rejects with the timeout error; a `POST` internal timeout is **not** retried
  (exactly one attempt, avoiding a duplicate enqueue); an external primitive
  abort reason stays distinct (normalized `Error`, not a timeout) and is not
  retried; and an internal timeout during body reading is surfaced as a
  retryable timeout and retried for a `GET`.

Changes remain **unstaged**.

**Batch-terminal / request-timeout verification (§4ae):** all canonical gates
were run under Node **18.20.8**, **20.20.2**, and **22.23.1**. `npm test`
passes **1290/1290** on every version (up from 1277: +5 batch-terminal, +6
HTTP-timeout, and +2 `OJSRequestTimeoutError` unit cases); `npm run lint`, `npm run test:types`, `npm run build`,
`npm run check:package` (**13** entry points), and `npm run size` (**941 B**
brotlied against the 15 kB limit) pass on all three. On Node 22:
`npm run test:coverage` reports **90.23% statements/lines, 88.09% branches,
96.72% functions** (above the 80%/75%/80% thresholds); `npm run docs` completes
with **0 errors** and the same 14 pre-existing warnings; `npm audit
--audit-level=high` reports **0 vulnerabilities**; and `git diff --check` is
clean. No files are staged.

## §4af — Stream Setup, Deferred Expiry, Batch Defaults, Workflow Validation, Iterator Throws, Checkpoints, Progress, Retry Decode, and Push Missing Handlers (Nine Findings)

| Finding | ID | Status |
|---|---|---|
| Initial gRPC stream `error` events were treated as successful open signals; timeout cancellation could later emit an unhandled `CANCELLED`; setup timeout overwrote public `OJSError.code` with numeric status | F-127 | ✅ Implemented |
| Absolute `expires_at` was converted to a relative TTL for cron/workflow jobs before their deferred materialization time | F-128 | ✅ Implemented |
| gRPC batch requests sent both expanded per-job defaults and `default_options`, allowing proto3 zero/false/empty overrides to be reapplied by backend merge | F-129 | ✅ Implemented |
| Empty nested workflow chains/groups flattened as no-ops and silently spliced surrounding dependencies | F-130 | ✅ Implemented |
| Consumer `.throw(marker)` could be swallowed/normalized while the aborted inner generator unwound cleanly | F-131 | ✅ Implemented |
| Legacy checkpoint truth asserted without `_replay_log` needed exact fail-closed coverage, while only false/404/405 may start fresh | F-132 | ✅ Implemented |
| Public progress typing needed the canonical at-least-progress-or-data union, optional checkpoint, and explicit deprecated legacy export coverage | F-133 | ✅ Implemented |
| `fromProtoRetryPolicy()` fabricated `PT0S`, coefficient `0`, false jitter, and empty exhaustion action from proto-loader defaults | F-134 | ✅ Implemented |
| Cloudflare/Vercel returned HTTP 422 for a missing handler instead of the normal HTTP 200 structured failed push response used by Lambda | F-135 | ✅ Implemented |

### Implementation summary

- **F-127:** `waitForStreamOpen()` now rejects with the actual initial service
  error, while metadata/status remain successful open signals. A passive
  lifetime error listener stays attached until definitive end/status so an
  asynchronous cancellation error cannot become uncaught. Setup timeouts remain
  public `OJSConnectionError` values with `code: 'connection_error'`; the
  numeric deadline status is stored privately as non-enumerable
  `grpcStatusCode` for reconnect classification.
- **F-128:** immediate enqueue retains absolute-expiry-to-TTL conversion.
  `CronOperations`, workflow wire mapping, and the raw gRPC cron/workflow
  converters reject `expiresAt`/`expires_at` non-retryably before transport,
  because later materialization would shift the absolute deadline.
- **F-129:** raw batch defaults are validated once, expanded into every job,
  and omitted from protobuf `EnqueueBatchRequest.default_options`. Explicit
  per-job `0`, `false`, and empty arrays therefore survive proto3 serialization
  without a second backend default merge.
- **F-130:** public workflow serialization and gRPC DAG construction validate
  every nested chain/group before flattening. `A -> empty -> B` is rejected
  rather than silently becoming `A -> B`.
- **F-131:** both iterator layers abort immediately, use `inner.return()` only
  for cleanup, and reject with the exact consumer marker by identity, including
  non-`Error` values, in pending and post-yield states.
- **F-132:** the existing fail-closed loader is locked down with exact tests:
  `has_checkpoint:false`, legacy 404, and legacy 405 start fresh;
  `has_checkpoint:true` without checkpoint data, metadata, or
  `metadata._replay_log` raises contextual `OJSCheckpointLoadError`.
- **F-133:** `ProgressReport` remains the canonical union requiring at least
  `progress` or `data`, with optional `checkpoint`; deprecated
  `LegacyProgressReport` remains separately exported. Runtime and compile-time
  tests cover all valid and invalid variants.
- **F-134:** retry decoding applies authoritative OJS defaults
  (`3`/`PT1S`/`2`/`PT5M`/`true`/`discard`) to proto3 scalar absence, preserves
  present duration messages/non-default values, and no longer exposes
  synthetic zero/empty values.
- **F-135:** missing Cloudflare/Vercel handlers now flow through the same
  handler-failure path as Lambda: HTTP 200, structured `handler_error`, job ID,
  retryable true, and no callback request.

### Tests and documentation

Focused regressions cover a real unavailable gRPC endpoint, blocked setup
cancellation/error-listener cleanup, metadata/status opening, immediate versus
deferred expiry, captured/serialized/backend-mirror batch defaults,
`A -> empty -> B`, pending/post-yield iterator throws at both layers, every
legacy checkpoint fresh/corrupt branch, progress runtime/type shapes, plain and
real proto-loader retry policies, and zero-callback missing-handler responses.
README sections for cron, batch enqueue, workflows, durable checkpoints,
progress, gRPC retry normalization, and serverless push delivery document the
resulting behavior.

Changes remain **unstaged**.

**Nine-finding verification (§4af):** all gates pass on Node **18.20.8**,
**20.20.2**, and **22.23.1**. On every runtime, `npm run lint`, `npm run
test:types`, `npm test` (**1320/1320**), `npm run test:coverage`, `npm run
build`, `npm run check:package` (**13** entry points), `npm run size` (**941 B**
brotlied against the 15 kB limit), `npm run docs`, `npm audit
--audit-level=high`, and `git diff --check` pass. Coverage across the three
runtimes is **90.42–90.43% statements/lines, 88.50–88.51% branches, and
96.76–96.94% functions**; dependency audit reports **0 vulnerabilities**;
TypeDoc completes with **0 errors** and the same 14 pre-existing warnings. No
files are staged.

## §4ag — DELETE Retry Safety

| ID | Location | Finding | Status |
|---|---|---|---|
| F-136 | `src/transport/http.ts`, DELETE resource operations | The generic internal-timeout retry classifier treated DELETE as safe based only on HTTP idempotence. An OJS delete can commit before the client receives the response; retrying then returns the endpoint's normal post-delete 404 and masks the original ambiguous timeout. DELETE also inherited generic 429 and transient-server retries without endpoint-specific response normalization. | **Fixed** — ambiguous timeout/network retries are limited to response-safe GET/HEAD and the SDK's contract-safe progress PUT. DELETE performs one attempt for timeout/network, 429, and configured transient-server failures; the original typed error is preserved. Non-DELETE response retry policy remains unchanged. |

### Regression coverage

`tests/http.test.ts` simulates the server committing the first DELETE and then
withholding the response until the client timeout for checkpoint, cron,
workflow, schema, and dead-letter endpoints. A second mock response is 404, so
each test proves both that only one request was issued and that the caller
receives `OJSRequestTimeoutError`, never `OJSNotFoundError`. Separate cases
lock down one-attempt DELETE behavior for `429 Retry-After` and `503`, while
GET and progress PUT continue retrying both internal timeouts and ambiguous
network failures.

README documents the method-level retry contract and why DELETE's HTTP
idempotence is insufficient for transparent OJS retries. Changes remain
**unstaged**.

**DELETE retry-safety verification (§4ag):** all gates pass on Node
**18.20.8**, **20.20.2**, and **22.23.1**. On every runtime, `npm run lint`,
`npm run test:types`, `npm test` (**1330/1330**), `npm run test:coverage`,
`npm run build`, `npm run check:package` (**13** entry points), `npm run size`
(**941 B** brotlied against the 15 kB limit), `npm run docs`, and `npm audit
--audit-level=high` pass. Coverage is **90.43–90.44% statements/lines, 88.54%
branches, and 96.76–96.94% functions**; dependency audit reports **0
vulnerabilities**; TypeDoc completes with **0 errors** and the same 14
pre-existing warnings. `git diff --check` is clean and no files are staged.

## §4ah — Worker Result Validation, Workflow Relative Delay, gRPC Initialization Races, Retry Decode Fidelity, and SSE Hardening (Eight Findings)

| ID | Location | Finding | Status |
|---|---|---|---|
| F-137 | `src/worker.ts` `handleExecutionSuccess()` | A handler's resolved result was acked (and `job.completed` emitted) with only a bare `as JsonValue` cast — a `BigInt`, non-finite number, or circular reference would reach `ack()`'s own JSON serialization uncaught, and `job.completed`/the `jobsCompleted` counter fired even when the ack itself failed to deliver. | **Fixed** — the result is normalized through exact JSON semantics before ack; an unrepresentable result is a deterministic handler/result defect, nacked exactly once as non-retryable `invalid_result`, never acked, with no completion event/metric. Completion is now reported only once the ack has actually succeeded. |
| F-138 | `src/workflow.ts` `toWireStep()` | A workflow step/batch callback's `options.delay` accepted the same relative shorthand (`'5m'`) `enqueue()` does, silently converting it to an absolute `delay_until` at *workflow-submission* time via the shared `parseDuration()`/`toWireOptions()` path — wrong for any step materialized later, once its predecessors finish. | **Fixed** — a relative delay shorthand is rejected non-retryably before serialization for every step/callback, at any depth of nesting; an explicit RFC 3339 absolute timestamp is unaffected and passes through unchanged. |
| F-139 | `src/transport/grpc.ts` `call()` | The unary RPC path unconditionally `await`ed `ensureClient()` before computing its deadline: a blocked/slow client-proto initialization was immune to both the request's own `timeout` and an `AbortSignal`, and a successful-but-slow initialization silently granted the RPC itself a fresh full-length deadline instead of the caller's remaining budget. | **Fixed** — `call()` now races `ensureClient()` against the request timeout and signal via the (widened, dual-purpose) `ensureClientWithSetupTimeout()`, without ever manually resolving the shared, memoized initialization a concurrent/future caller may still depend on; the RPC deadline is computed from the call's own start time, so a slow initialization is charged against the same budget rather than reset. |
| F-140 | `src/transport/grpc.ts` `openReconnectingStream()`, `src/transport/grpc-stream.ts` `runReconnectingServerStream()` | Client/proto initialization for `streamJobs()`/`streamEvents()` ran once, entirely *outside* `reconnectingServerStream`, before that reconnect engine was even constructed: an initialization failure or timeout rejected the whole stream immediately with zero retries, regardless of `reconnect`/`maxAttempts` configuration. | **Fixed** — `connect` may now return a `Promise` (`runReconnectingServerStream` `await`s it), and `GrpcTransport` performs its client/proto initialization *inside* `connect`, on every attempt; a failure/timeout is tagged `grpcStatusCode: UNAVAILABLE` and classified/retried through the normal backoff/`maxAttempts` machinery. A pending `connect()` is additionally raced against `signal` (new `connectOrAbort()`) so an external/transport abort cancels the wait even when the underlying `connect` implementation is not itself abort-aware. |
| F-141 | `src/transport/grpc.ts` `fromProtoRetryPolicy()` | A decoded `RetryPolicy.max_attempts: 0` or `jitter: false` was indistinguishable from an entirely-omitted field under proto-loader's `defaults: true`, and was unconditionally rewritten to the OJS defaults (`3`/`true`) — silently turning an explicit "never retry"/"no jitter" policy into the opposite. | **Fixed** — whenever the `RetryPolicy` message itself is present, `max_attempts` and `jitter` are decoded exactly as received, including `0`/`false`; only `backoff_coefficient` (invalid below `1`), `on_exhaustion` (invalid empty), and absent Duration sub-messages still receive the protocol defaults. The unavoidable proto3 ambiguity for an omitted `jitter` scalar is documented at the decode site and in the README. |
| F-142 | `src/subscribe.ts` `connectOnce()` | The per-event dispatch unconditionally `await`ed the user handler; `unsubscribe()`/an external abort could not interrupt a slow or permanently-pending handler, and a handler that later rejected after the subscription had already moved on risked an unhandled promise rejection. | **Fixed** — a new `settleHandlerOrAbort()` races the handler's settlement against `signal`; on abort, the reader is cancelled/released immediately and no further lines already buffered in the same chunk are ever dispatched. The handler's eventual settlement (resolve or reject) is unconditionally consumed via a permanently-attached no-op continuation, so it can never surface as an unhandled rejection. |
| F-143 | `src/subscribe.ts` `nextReconnectDelay()` | A server-provided `Retry-After` override was run through `Math.min(overrideDelayMs, MAX_RECONNECT_DELAY_MS)` — an explicit, authoritative multi-minute/hour server instruction was silently clamped down to the SDK's own 30-second local exponential-backoff ceiling. | **Fixed** — the `Retry-After` override is honored exactly, uncapped; `MAX_RECONNECT_DELAY_MS` now caps only the SDK's own persistent exponential-backoff base (and the SSE `retry:` hint), never an explicit server instruction. |
| F-144 | `src/serverless/push-auth.ts` `readBoundedRequestBody()` | `request.body.getReader()` was called unguarded: an already-consumed (`bodyUsed`) or already-locked `Request` body makes `getReader()` throw synchronously, which propagated out of `readBoundedRequestBody()` — and so out of every push adapter's `handleRequest()` — as an uncaught rejection instead of a controlled HTTP response. | **Fixed** — `bodyUsed`/`request.body.locked` are checked proactively for a precise error message, and `getReader()` itself is additionally wrapped in a `try`/`catch` as a backstop for any other synchronous failure; both paths return a normal `{ ok: false, status: 400, ... }` result instead of throwing. |

### Design decisions and assumptions for this pass

- **F-137 (invalid result semantics):** reuses this SDK's existing JSON-semantic normalizer (`normalizeJsonValue`, already used for enqueue `args`/`meta`) rather than inventing new rules, via a new exported `normalizeHandlerResult()` in `job.ts`. A top-level `undefined` result is left as `undefined` (omits the wire `result` field, matching `ack()`'s pre-existing handling); a top-level function/symbol result normalizes to that same "no result," mirroring `JSON.stringify(fn) === undefined` — a deliberate, minimal interpretation consistent with every other JSON-semantic boundary in this codebase, not a distinct error class from BigInt/circular/non-finite. `handleInvalidResult()` mirrors `handleExecutionFailure()`'s nack-then-emit-`job.failed` shape with a hardcoded `invalid_result`/`retryable: false`.
- **F-138 (relative delay):** the fix is scoped to the ergonomic `EnqueueOptions.delay` → wire `delay_until` conversion path (`assertNoRelativeDelay()` in `workflow.ts`, mirroring the existing `assertNoDeferredExpiresAt()`), which is the only place a relative shorthand can be silently misinterpreted; a raw wire-level `GrpcTransport`/`HttpTransport` caller supplying a non-RFC-3339 `delay_until` string directly was already rejected generically by timestamp validation (`parseRfc3339Timestamp`/`validateTimestamp`), unrelated to this finding. Immediate `enqueue()`'s own relative-delay support is intentionally unaffected — "now" at conversion time is always the actual enqueue time there.
- **F-139/F-140 (gRPC initialization races):** both reuse the same `ensureClientWithSetupTimeout()` helper (widened rather than duplicated), now shared by the unary path (bounded by the per-call timeout) and the streaming path (bounded by `GrpcStreamOptions.timeout`, invoked on every reconnect attempt via the new `connectAttempt()`/`connect` closure). Initialization failures are tagged with a synthetic `grpcStatusCode: UNAVAILABLE` (mirroring `waitForStreamOpen()`'s existing `DEADLINE_EXCEEDED` tagging convention for its own distinct setup timeout) purely so they flow through the pre-existing numeric-status-code retry classification — this transport's own choice for "the channel could not be created," not a status any server ever returned. `runReconnectingServerStream()`'s new `connectOrAbort()` additionally races a *pending* `connect()` call against `signal`, since a caller-supplied `connect` (the low-level `reconnectingServerStream()` export's own contract) cannot be assumed abort-aware.
- **F-141 (retry decode):** resolves an irreducible proto3 ambiguity (a non-`optional` singular scalar has no wire presence of its own) in favor of trusting the decoded value whenever the enclosing `RetryPolicy` message is confirmed present, rather than guessing a falsy scalar means "never set." This is a deliberate behavior change from the prior pass's (§4af, F-134) blanket defaulting; three previously-passing tests asserting the old behavior (`tests/transport-grpc.test.ts`'s shared `FULL_WIRE_JOB` fixture and its two dedicated retry-decode tests, plus `tests/transport-grpc-workflow-cron-ack.test.ts`'s two cron-listing retry tests) were updated to the corrected expected output, with new tests locking in both the corrected zero/false-preserving behavior and that an explicit `jitter: true`/positive `max_attempts` still round-trips unchanged.
- **F-142 (SSE handler race):** `settleHandlerOrAbort()` always attaches a rejection handler to the caller's handler promise *before* either race outcome is possible (a synchronous, unconditional `.catch(() => undefined)`), independent of which side of the race wins, so a handler that later rejects — possibly long after the subscription tore down — can never be observed as an unhandled rejection. A defensive `signal.aborted` re-check immediately before invoking the handler (in addition to the race itself) covers the — currently unreachable, but future-proofed — case of an abort occurring synchronously between reading a chunk and dispatching an event within it.
- **F-143 (Retry-After):** no change to `parseRetryAfter()` itself (already computed the exact, uncapped millisecond value); the bug was solely `nextReconnectDelay()`'s post-hoc `Math.min(...)` against `MAX_RECONNECT_DELAY_MS`, removed for the override branch only. The persistent exponential-backoff branch (driven by `baseReconnectDelayMs`, itself settable by the SSE `retry:` hint) keeps its existing cap.
- **F-144 (push-auth body):** the fix lives in the single shared `readBoundedRequestBody()` helper used by both the Cloudflare and Vercel adapters (Lambda uses a different, non-`Request`/`ReadableStream` delivery model and was never affected), so both call sites are covered by one change; `bodyUsed`/`.locked` are checked proactively (for a specific, actionable error message) with `getReader()` itself still wrapped defensively in case a runtime rejects it for some other reason these two flags do not predict.

### Tests Added

- `tests/worker.test.ts` (`handler result validation`): a new `runJobWithHandler()` helper plus dedicated cases for a circular-reference result, a `BigInt` result, and a non-finite-number result (all: zero acks, exactly one nack with `invalid_result`/`retryable: false`, zero `job.completed`, exactly one `job.failed`); a `Date` result acked via its `toJSON()` ISO string; a custom class with `toJSON()` acked via its serialized value; an `undefined` result acked with the `result` field omitted entirely; and a valid result whose *ack* delivery fails, proving `job.completed`/the completion counter are withheld even though the handler itself succeeded (previously fired unconditionally).
- `tests/workflow.test.ts` (`relative delay rejection`): rejection of the relative shorthand on a single-step chain (asserting the exact `'5m'` value appears in the error message), on every unit (`5m`/`30s`/`1h`/`100ms`/`2d`) via a batch callback, and on a group member; acceptance of an explicit RFC 3339 timestamp on both a step and a callback; a 6-step chain golden proving eager rejection of a relative delay on the 5th step (deep behind four ordinary predecessors) without ever materializing/sending any of them, plus the equivalent golden with an absolute delay asserting the exact expected wire structure; and rejection of a relative delay on a group nested three levels deep inside a longer chain. The pre-existing `'should convert all supported job options for a workflow step...'` test was updated to use an absolute timestamp instead of the (no-longer-valid) `'5m'` shorthand it previously asserted succeeded.
- `tests/transport-grpc.test.ts` (`AbortSignal cancellation`): a rewritten blocked-initialization test proving the call rejects immediately on abort *without ever resolving* a permanently-blocked `ensureClient()` mock; a companion test proving a *later* resolution of that same blocked mock (after the call already rejected) is a safe no-op; a fake-timer test proving a blocked initialization rejects with a retryable connection error once the call's own timeout elapses, with the underlying RPC never issued; a fake-timer test proving the RPC deadline reflects the *remaining* budget (5s total − 2s consumed by a slow-but-successful initialization = a 3s-remaining deadline) rather than a fresh window; and a test proving two concurrent calls sharing one blocked initialization are independent — one giving up via its own abort signal never affects the other, which proceeds once the shared initialization later completes. The two pre-existing "no leak" listener tests were updated to assert a leak-free *set* of add/remove pairs (now two independent pairs — setup-race plus RPC-cancellation — rather than the previous one).
- `tests/transport-grpc.test.ts` (`server-streaming`): a new test proving an `ensureClient()` initialization failure is classified as retryable and the stream succeeds on the very next reconnect attempt; a companion exhaustion test proving `maxAttempts` is honored when initialization keeps failing on every attempt. The pre-existing lazy-connect test was updated to pass `reconnect: { enabled: false }`, since an initialization failure against its intentionally-bogus `protoPath` is now (correctly) retried forever by default rather than failing immediately.
- `tests/transport-grpc-stream.test.ts`: a new `describe('reconnectingServerStream — async connect()')` block covering an async `connect()` that rejects once then succeeds (backoff-driven retry), one that keeps rejecting until `maxAttempts` is exhausted, and one whose pending promise is abandoned promptly when `signal` aborts (with a late resolution of that abandoned promise proving safe/non-throwing).
- `tests/transport-grpc.test.ts` (`request/response mapping`) and `tests/transport-grpc-workflow-cron-ack.test.ts` (`cron listing`): the shared `FULL_WIRE_JOB` fixture and four dedicated retry-decode tests were corrected to the new preserved-zero/false behavior (renamed for clarity where the name asserted the old "authoritative defaults" premise), plus two new sanity tests (one via `createMockGrpcTransport`, one via a real proto-loader round-trip) proving an explicit `jitter: true` is *not* merely flipped by the fix.
- `tests/subscribe.test.ts`: a new `describe('SSE unsubscribe during async handler')` block with a never-settling handler (proving `unsubscribe()` cancels/releases the reader promptly without waiting on it), a later-resolves case (proving the resolution after `unsubscribe()` is silently discarded, without reconnecting or re-dispatching), a later-rejects case (proving no unhandled rejection, using the existing `process.on('unhandledRejection', ...)` convention), and a same-chunk case proving a second buffered event is never dispatched once the first's pending handler is aborted. A new `it.each` fake-timer table locks in exact 120-second and 3600-second `Retry-After` delays (uncapped), plus a mixed-scenario test proving the local cap still applies to an ordinary exponential-backoff reconnect immediately following an uncapped `Retry-After` one. The one pre-existing listener-count test affected by the new per-event settlement race was updated (2 → 3 total add/remove pairs, with an explanatory comment) rather than weakened.
- `tests/push-auth.test.ts` and `tests/serverless.test.ts`: four new `readBoundedRequestBody()` unit tests (`bodyUsed`, `.locked`, a `getReader()` that throws for an unpredicted reason, and a sanity check that a real unconsumed/unlocked `Request` still reads normally) plus, for both the Cloudflare and Vercel adapters, an already-consumed and an already-locked real Fetch API `Request` end-to-end, asserting a plain HTTP 400 JSON response rather than a thrown/rejected `handleRequest()`.

Changes remain **unstaged**.

**Eight-finding verification (§4ah):** all canonical gates were run under Node
**18.20.8**, **20.20.2**, and **22.23.1** via `nvm`. `npm run lint`, `npm run
test:types`, `npm test` (**1375/1375** — up from the **1330/1330** last
recorded in §4ag, plus whatever this branch's own already-dirty working tree
had independently added before this pass began; this pass's own net
contribution is the ~40 new/renamed focused tests enumerated above), `npm run
build`, `npm run check:package` (**13** entry points under
ESM/CJS/Node-types/browser-types/classic-CommonJS resolution), and `npm run
size` (**941 B** brotlied against the 15 kB limit) pass identically on all
three versions. `npm run test:coverage` reports **90.50–90.51%
statements/lines, 88.36–88.38% branches, 96.83–97.01% functions** across the
three runtimes — all above the 80%/75%/80% thresholds. `npm run docs`
completes with **0 errors** and the same **14** pre-existing reference
warnings on every version. `npm audit --audit-level=high` reports **0
vulnerabilities** on every version. `git diff --check` is clean, and `git
status --porcelain=v1` shows every change as modified/untracked with **0**
staged files, on all three Node versions.

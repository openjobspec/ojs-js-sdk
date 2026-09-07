/**
 * gRPC transport implementation for OJS.
 *
 * Uses @grpc/grpc-js and @grpc/proto-loader as optional peer dependencies.
 * This transport implements the same Transport interface as HttpTransport,
 * mapping HTTP-style requests to gRPC RPCs transparently.
 *
 * @example
 * ```ts
 * import { OJSClient, GrpcTransport } from '@openjobspec/sdk';
 *
 * const transport = new GrpcTransport({ url: 'localhost:9090' });
 * const client = new OJSClient({ transport });
 * ```
 */

import {
  OJSConnectionError,
  OJSError,
  OJSNotFoundError,
  OJSServerError,
  OJSValidationError,
  OJSDuplicateError,
  OJSConflictError,
  OJSRateLimitError,
} from '../errors.js';
import type {
  Transport,
  TransportRequestOptions,
  TransportResponse,
  OJSResponseHeaders,
} from './types.js';
import {
  normalizeUniqueSelection,
  type Job,
  type JsonValue,
} from '../job.js';
import {
  validateQueueName,
  validateUniquePolicy,
} from '../validation/schemas.js';
import { DEFAULT_RETRY_POLICY } from '../retry.js';
import {
  reconnectingServerStream,
  type GrpcServerStreamCall,
  type GrpcStreamReconnectOptions,
} from './grpc-stream.js';

/** Configuration for the gRPC transport. */
export interface GrpcTransportConfig {
  /** gRPC server address (e.g., 'localhost:9090'). */
  url: string;

  /** Optional API key for authentication (sent as x-ojs-api-key metadata). */
  apiKey?: string | undefined;

  /** Optional ****** for authentication (sent as authorization metadata). */
  auth?: string | undefined;

  /** Default deadline in milliseconds for unary RPCs. Default: 30000. */
  timeout?: number | undefined;

  /** Custom metadata to include in every RPC call. */
  metadata?: Record<string, string> | undefined;

  /**
   * Path to the proto directory containing OJS proto files.
   * If not specified, attempts to resolve from the ojs-proto package.
   */
  protoPath?: string | undefined;

  /**
   * Called whenever this transport silently degrades an operation because
   * the current gRPC protobuf contract cannot represent something the
   * caller asked for (e.g. a non-object `ack()` result — see
   * {@link GrpcProtocolWarning}). Defaults to logging via `console.warn`.
   * A handler that throws is swallowed — a broken warning callback must
   * never fail the underlying RPC.
   */
  onWarning?: ((warning: GrpcProtocolWarning) => void) | undefined;
}

/**
 * Describes a non-fatal gRPC protocol limitation this transport worked
 * around instead of failing the call. See `GrpcTransportConfig.onWarning`.
 */
export interface GrpcProtocolWarning {
  /** Stable, machine-readable warning code, e.g. `'ack_result_unrepresentable'`. */
  code: string;
  /** Human-readable description of the limitation and what this transport did instead. */
  message: string;
  /**
   * `typeof` of the JS value that triggered the warning, with `'array'`
   * reported instead of `'object'` for array results (`google.protobuf
   * .Struct` cannot represent either, but for different reasons worth
   * distinguishing in logs/telemetry).
   */
  originalResultType: string;
}

/** Default `GrpcTransportConfig.onWarning`: logs via `console.warn`. */
function defaultGrpcWarningHandler(warning: GrpcProtocolWarning): void {
  console.warn(warning);
}

// --- Server-streaming public API (StreamJobs / StreamEvents) ---
//
// Additive only: none of the types or methods below change `request()`,
// `Transport`, or any existing export. See service.proto's `StreamJobs`/
// `StreamEvents` RPCs and ojs-grpc-binding.md section 10 for the
// authoritative semantics; `grpc-stream.ts` implements the actual
// reconnect/backoff/cancellation engine these methods delegate to.

/**
 * Request for {@link GrpcTransport.streamJobs}. See worker.proto's
 * `StreamJobsRequest` and ojs-grpc-binding.md sections 6.5/10.1.
 */
export interface GrpcStreamJobsRequest {
  /** Required. One or more queue names to subscribe to, in priority order. */
  queues: string[];
  /**
   * Required. Worker identifier so the server can track stream
   * assignments and reclaim jobs if this worker disconnects without
   * acknowledging them (worker.proto: "Without a worker identifier, the
   * server cannot reclaim jobs that were streamed to a worker that
   * disconnected without acknowledging them.").
   */
  workerId: string;
  /**
   * Maximum number of concurrent unacknowledged jobs this worker accepts;
   * the server MUST NOT send more. Default: `1`.
   */
  maxConcurrent?: number | undefined;
}

/**
 * Request for {@link GrpcTransport.streamEvents}. See events.proto's
 * `StreamEventsRequest` and ojs-grpc-binding.md sections 6.5/10.2. All
 * filters are optional and combined with AND logic; omitting all of them
 * subscribes to every event.
 */
export interface GrpcStreamEventsRequest {
  /** Only receive events for these queues. Empty/omitted means all queues. */
  queues?: string[] | undefined;
  /** Only receive these event types (e.g. `'job.completed'`). Empty/omitted means all types. */
  eventTypes?: string[] | undefined;
  /** Only receive events for this specific job ID. */
  jobId?: string | undefined;
  /** Only receive events for this specific workflow ID. */
  workflowId?: string | undefined;
}

/**
 * Options shared by {@link GrpcTransport.streamJobs} and
 * {@link GrpcTransport.streamEvents}.
 */
export interface GrpcStreamOptions {
  /**
   * Cancels the stream when aborted: the current connection attempt is
   * cancelled immediately and no further reconnect is attempted. A
   * consumer's early `break`/`return`/`throw` out of the consuming
   * `for await` loop has the same effect without needing a signal.
   */
  signal?: AbortSignal | undefined;
  /** Additional metadata merged with the transport's default/configured
   * metadata, sent on the initial connection and every reconnect attempt. */
  metadata?: Record<string, string> | undefined;
  /**
   * Bounds *setup only*: this transport's own client/proto initialization
   * (`ensureClient()`, run once, before the very first connection attempt)
   * plus opening each individual connection attempt's stream (the initial
   * attempt and every subsequent reconnect) — never an overall lifetime
   * deadline for the logical, possibly long-running reconnecting stream.
   * Per ojs-grpc-binding.md sections 10.1.1/10.2.1, a healthy stream is
   * expected to stay open indefinitely: once an attempt is open (the
   * underlying call reached the server, successfully or not), this
   * timeout no longer applies to it — an already-open, healthy stream
   * that keeps delivering (or sits idle) far longer than `timeout` is
   * *not* killed. A setup that does not open within `timeout` is treated
   * like a transient connectivity failure (equivalent to
   * `DEADLINE_EXCEEDED`) and retried through the normal reconnect/backoff
   * policy below, exactly like `UNAVAILABLE` would be. Left unset,
   * neither initialization nor connection attempts have any deadline —
   * unlike unary RPCs, there is no default here, since applying this
   * transport's unary `timeout` (30s by default) as an actual RPC-lifetime
   * deadline would silently kill every healthy stream after 30 seconds.
   * To impose a genuine hard lifetime deadline on the underlying RPC call
   * itself instead (restoring that older, since-corrected behavior),
   * opt in explicitly via {@link streamDeadline}.
   */
  timeout?: number | undefined;
  /**
   * Optional, additive **hard RPC-lifetime deadline** (milliseconds)
   * passed straight through as the underlying gRPC call's own deadline —
   * unlike {@link timeout} above (which only bounds setup), this
   * terminates even an already-open, healthy stream once it elapses,
   * exactly like the pre-existing unary-call `timeout` semantics. Left
   * unset (the default), a stream that successfully opens has no
   * lifetime deadline at all, matching ojs-grpc-binding.md's "a healthy
   * stream is expected to stay open indefinitely." Set this only when a
   * genuine hard ceiling on total stream duration is actually desired
   * (e.g. a bounded diagnostic session) — most long-lived worker/event
   * streams should leave it unset.
   */
  streamDeadline?: number | undefined;
  /** Reconnect/backoff policy override; see `GrpcStreamReconnectOptions`. */
  reconnect?: GrpcStreamReconnectOptions | undefined;
}

// Re-exports the reconnect-policy type already imported above, so
// consumers can name it (e.g. `GrpcStreamOptions['reconnect']` callers
// building a `GrpcStreamReconnectOptions` object) without a deep import
// of `transport/grpc-stream.js`, which is not part of the package's
// public surface.
export type { GrpcStreamReconnectOptions };

/**
 * A single event pushed by the server via the StreamEvents RPC (see
 * events.proto's `Event` message), returned by
 * {@link GrpcTransport.streamEvents}. Preserves the gRPC binding's own
 * wire field naming (`job_id`/`job_type`/`workflow_id`, snake_case,
 * matching this transport's other HTTP-style response shapes) rather
 * than the CloudEvents-style envelope `src/events.ts`'s `OJSEventEmitter`
 * uses — that is a different, higher-level SDK-internal pub/sub construct
 * unrelated to this wire format.
 */
export interface GrpcStreamEvent {
  id: string;
  type: string;
  job_id?: string | undefined;
  job_type?: string | undefined;
  queue?: string | undefined;
  timestamp?: string | undefined;
  data?: Record<string, unknown> | undefined;
  workflow_id?: string | undefined;
}

// gRPC status code constants (mirrors grpc.status)
const GRPC_STATUS = {
  OK: 0,
  CANCELLED: 1,
  INVALID_ARGUMENT: 3,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DEADLINE_EXCEEDED: 4,
} as const;

const STREAM_JOBS_RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([
  GRPC_STATUS.DEADLINE_EXCEEDED,
  GRPC_STATUS.RESOURCE_EXHAUSTED,
  GRPC_STATUS.INTERNAL,
  GRPC_STATUS.UNAVAILABLE,
]);

const STREAM_EVENTS_RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([
  GRPC_STATUS.DEADLINE_EXCEEDED,
  GRPC_STATUS.INTERNAL,
  GRPC_STATUS.UNAVAILABLE,
]);

/**
 * Tags an arbitrary thrown/rejected client/proto initialization failure
 * with a `grpcStatusCode` of `UNAVAILABLE`, unless it already carries a
 * numeric status code (e.g. a real gRPC error re-thrown unchanged) —
 * mirrors `grpc-stream.ts`'s `waitForStreamOpen()`'s identical
 * `DEADLINE_EXCEEDED` tagging convention for its own distinct "stream
 * open" setup timeout. Client/proto initialization (`ensureClient()`) has
 * no gRPC status of its own — it never reaches the wire — so
 * `UNAVAILABLE` is this transport's own chosen classification for "the
 * underlying channel could not be created," letting
 * `reconnectingServerStream`'s `isRetryableStreamError` treat it exactly
 * like any other transient connectivity failure and retry it through the
 * normal backoff/`maxAttempts` machinery (Finding: stream initialization
 * in reconnect engine).
 */
function tagRetryableGrpcError(error: unknown): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const existingCode = (normalized as { grpcStatusCode?: unknown }).grpcStatusCode;
  if (typeof existingCode !== 'number') {
    Object.defineProperty(normalized, 'grpcStatusCode', {
      configurable: false,
      enumerable: false,
      value: GRPC_STATUS.UNAVAILABLE,
      writable: false,
    });
  }
  return normalized;
}

interface GrpcStreamPrivateOptions {
  retryableStatusCodes: ReadonlySet<number>;
}

/** Bound on `GrpcTransport.workflowTypeCache` — see its own doc comment. */
const WORKFLOW_TYPE_CACHE_MAX_ENTRIES = 10_000;

function combineStreamSignals(
  transportSignal: AbortSignal,
  callerSignal: AbortSignal | undefined,
): { signal: AbortSignal; cleanup: () => void } {
  if (!callerSignal) {
    return { signal: transportSignal, cleanup: () => undefined };
  }
  const externalSignal = callerSignal;

  const combined = new AbortController();
  let transportListenerAttached = false;
  let callerListenerAttached = false;
  let cleaned = false;

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (transportListenerAttached) {
      transportSignal.removeEventListener('abort', onTransportAbort);
      transportListenerAttached = false;
    }
    if (callerListenerAttached) {
      externalSignal.removeEventListener('abort', onCallerAbort);
      callerListenerAttached = false;
    }
  };

  const propagate = (source: AbortSignal): void => {
    if (!combined.signal.aborted) {
      combined.abort(source.reason);
    }
    cleanup();
  };

  function onTransportAbort(): void {
    propagate(transportSignal);
  }

  function onCallerAbort(): void {
    propagate(externalSignal);
  }

  if (transportSignal.aborted) {
    propagate(transportSignal);
  } else {
    transportSignal.addEventListener('abort', onTransportAbort, { once: true });
    transportListenerAttached = true;
  }

  if (!combined.signal.aborted) {
    if (externalSignal.aborted) {
      propagate(externalSignal);
    } else {
      externalSignal.addEventListener('abort', onCallerAbort, { once: true });
      callerListenerAttached = true;
    }
  }

  return { signal: combined.signal, cleanup };
}

/**
 * Minimal structural shape of the parts of `@grpc/grpc-js` this transport
 * depends on. Defined locally (rather than importing the real package's
 * types) so the emitted public `.d.ts` never references `@grpc/grpc-js` —
 * it is an optional peer dependency and consumers without it installed
 * must still be able to type-check code that merely imports GrpcTransport.
 */
interface GrpcMetadata {
  set(key: string, value: string): void;
}

interface GrpcServiceError extends Error {
  code?: number;
  details?: string;
}

/** A pending unary call, as returned by a generated client method. */
interface GrpcClientCall {
  cancel(): void;
}

type GrpcUnaryCallback<T> = (error: GrpcServiceError | null, response: T) => void;

/** A single generated unary client method, e.g. `client.enqueue(...)`. */
type GrpcUnaryMethod = (
  request: unknown,
  metadata: GrpcMetadata,
  options: { deadline: Date },
  callback: GrpcUnaryCallback<unknown>,
) => GrpcClientCall;

/**
 * A single generated server-streaming client method, e.g.
 * `client.streamJobs(...)`. Unlike a unary method, it has no callback
 * parameter — it returns the call object (an async-iterable stream)
 * directly — and its deadline is optional: a streaming RPC is not
 * required to have one (see `GrpcStreamOptions.timeout`).
 */
type GrpcServerStreamMethod = (
  request: unknown,
  metadata: GrpcMetadata,
  options: { deadline?: Date },
) => GrpcServerStreamCall;

/** The generated OJS service client: a map of RPC name to unary method. */
type GrpcServiceClient = Record<string, GrpcUnaryMethod | undefined> & {
  close(): void;
};

interface GrpcModule {
  Metadata: new () => GrpcMetadata;
  credentials: { createInsecure(): unknown };
  loadPackageDefinition(packageDefinition: unknown): unknown;
}

/**
 * Minimal structural shape of the parts of `@grpc/proto-loader` this
 * transport depends on. Defined locally for the same reason as
 * `GrpcModule` above: the optional-peer-dependency boundary means the
 * emitted public `.d.ts` must never reference `@grpc/proto-loader`'s own
 * types directly.
 */
interface ProtoLoaderModule {
  loadSync(filename: string, options: ProtoLoaderLoadOptions): unknown;
}

/**
 * Options accepted by `@grpc/proto-loader`'s `loadSync`, restricted to the
 * subset this transport actually passes in `initClient()` below. Per
 * protobufjs's `IConversionOptions` (which proto-loader's `Options` type
 * extends), `longs` accepts the global `String` or `Number` constructors
 * and `enums` only ever accepts `String` — both select a JS
 * representation for wire values, not an arbitrary callback — so those
 * are typed precisely instead of falling back to the unsafe `Function`
 * type (banned by `@typescript-eslint/no-unsafe-function-type`).
 */
interface ProtoLoaderLoadOptions {
  keepCase?: boolean;
  longs?: StringConstructor | NumberConstructor;
  enums?: StringConstructor;
  defaults?: boolean;
  oneofs?: boolean;
  includeDirs?: string[];
}

/**
 * gRPC transport for OJS.
 *
 * Implements the Transport interface by mapping HTTP-style path/method
 * combinations to the corresponding OJS gRPC service RPCs.
 */
export class GrpcTransport implements Transport {
  readonly supportsLegacyCheckpointResume = false;

  private client: GrpcServiceClient | undefined;
  private grpcModule: GrpcModule | undefined;
  private readonly config: GrpcTransportConfig;
  private readonly defaultTimeout: number;
  private readonly defaultMetadata: Record<string, string>;
  private initPromise: Promise<void> | null = null;
  private streamAbortController = new AbortController();
  private generation = 0;
  /**
   * Caches the authoritative public primitive (`'chain'` | `'group'`;
   * `'batch'` is always rejected before the RPC — see
   * `workflowBatchUnimplemented`) for every workflow this transport
   * instance itself created via `createWorkflow()`, keyed by the
   * server-assigned workflow ID. `getWorkflow()` consults this cache
   * first so a workflow this transport created reports its real type;
   * a foreign workflow ID with no cache entry is still returned. Its flat
   * step DAG is classified only when it is a strict multi-step linear
   * chain or a multi-step edge-free group; ambiguous one-step/arbitrary
   * DAGs omit the optional public `WorkflowStatus.type`. Bounded
   * (`WORKFLOW_TYPE_CACHE_MAX_ENTRIES`) with FIFO eviction (oldest-created
   * first, via `Map`'s insertion-order iteration) so a long-lived transport
   * creating very many workflows cannot grow this cache unboundedly; this
   * is an in-memory, per-instance hint only and does not survive across
   * transports or processes.
   */
  private readonly workflowTypeCache = new Map<string, 'chain' | 'group'>();

  constructor(config: GrpcTransportConfig) {
    this.config = config;
    this.defaultTimeout = config.timeout ?? 30_000;
    this.defaultMetadata = { ...config.metadata };

    if (config.apiKey) {
      this.defaultMetadata['x-ojs-api-key'] = config.apiKey;
    }
    if (config.auth) {
      this.defaultMetadata.authorization = config.auth;
    }
  }

  /**
   * Lazily initializes the gRPC client on first use.
   * This allows the transport to be created synchronously while
   * deferring the dynamic import of gRPC dependencies.
   */
  private async ensureClient(): Promise<void> {
    this.ensureActiveGeneration();
    if (this.client) return;
    if (this.initPromise) return this.initPromise;

    const initPromise = this.initClient(this.generation);
    this.initPromise = initPromise;
    try {
      await initPromise;
    } finally {
      if (this.initPromise === initPromise) {
        this.initPromise = null;
      }
    }
  }

  /**
   * Bounds `ensureClient()` (dynamic import of the optional gRPC peer
   * dependencies, proto loading, and client construction — this
   * transport's own "client/proto initialization", cheap and effectively
   * instant on every call after the first successful one) with
   * `setupTimeoutMs`, and races it against `signal` aborting first.
   *
   * Shared by two callers with different budgets:
   *
   *   - Unary `call()` passes its own per-call timeout (the same budget
   *     that later becomes the RPC deadline — see {@link call}'s "Pass
   *     remaining timeout budget to RPC" handling) so a blocked/slow
   *     initialization cannot silently consume time beyond what the
   *     caller configured, or hang forever past it.
   *   - `streamJobs()`/`streamEvents()` pass {@link GrpcStreamOptions.timeout}
   *     on every connection attempt (initial and every reconnect), so an
   *     initialization failure/timeout is classified and retried through
   *     the exact same backoff/`maxAttempts` machinery as any other
   *     transient stream error, instead of a one-time bypass.
   *
   * In both cases this is strictly a *setup* bound: once `ensureClient()`
   * resolves (the client is cached on `this.client` and reused for every
   * later call on this transport instance), this method itself resolves
   * near-instantly on every subsequent invocation and never applies again
   * to whatever RPC/stream follows.
   *
   * Critically, cancellation/timeout here never "manually resolves" the
   * shared, memoized `ensureClient()` — a caller that gives up merely
   * stops *waiting* on it; the underlying initialization (visible to every
   * other concurrent/future caller via `this.initPromise`) keeps running
   * to completion (or failure) on its own and is safely ignored here if it
   * settles later. Left `undefined` with no `signal`, initialization has
   * no bound at all.
   */
  private async ensureClientWithSetupTimeout(
    setupTimeoutMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return;
    if (setupTimeoutMs === undefined && !signal) {
      return this.ensureClient();
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const waits: Promise<void>[] = [this.ensureClient()];

    if (setupTimeoutMs !== undefined) {
      waits.push(
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new OJSConnectionError(
                `gRPC client/proto initialization timed out after ${setupTimeoutMs}ms`,
              ),
            );
          }, setupTimeoutMs);
        }),
      );
    }

    if (signal) {
      waits.push(
        new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          onAbort = resolve;
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      );
    }

    try {
      await Promise.race(waits);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }

  private ensureActiveGeneration(): void {
    if (this.streamAbortController.signal.aborted) {
      this.streamAbortController = new AbortController();
    }
  }

  /**
   * Invokes `config.onWarning` (or the default `console.warn`-based
   * handler) for a non-fatal protocol degradation. A throwing handler is
   * swallowed so a caller-supplied `onWarning` can never fail the RPC it
   * describes.
   */
  private emitWarning(warning: GrpcProtocolWarning): void {
    const onWarning = this.config.onWarning ?? defaultGrpcWarningHandler;
    try {
      onWarning(warning);
    } catch {
      // A broken warning handler must never break the underlying call.
    }
  }

  private async initClient(generation: number): Promise<void> {
    const path = await import('node:path');
    const fs = await import('node:fs');

    // Resolve proto path
    let protoDir = this.config.protoPath;
    if (!protoDir) {
      // Try to find the proto files relative to common locations
      const candidates = [
        path.resolve(process.cwd(), 'node_modules', 'ojs-proto', 'proto'),
        path.resolve(process.cwd(), '..', 'ojs-proto', 'proto'),
        path.resolve(__dirname, '..', '..', '..', 'ojs-proto', 'proto'),
      ];
      for (const candidate of candidates) {
        if (
          fs.existsSync(path.join(candidate, 'ojs', 'v1', 'service.proto'))
        ) {
          protoDir = candidate;
          break;
        }
      }
    }

    if (!protoDir) {
      throw new OJSConnectionError(
        'Could not find OJS proto files. Set protoPath in GrpcTransportConfig ' +
          'or ensure ojs-proto is available.',
      );
    }

    const serviceProto = path.join(protoDir, 'ojs', 'v1', 'service.proto');
    if (!fs.existsSync(serviceProto)) {
      throw new OJSConnectionError(
        `Could not find OJS service proto at ${serviceProto}. ` +
          'Set protoPath to the directory containing ojs/v1/service.proto.',
      );
    }

    let grpc: GrpcModule;
    let protoLoader: ProtoLoaderModule;

    try {
      grpc = await import('@grpc/grpc-js');
      protoLoader = await import('@grpc/proto-loader');
    } catch {
      throw new OJSConnectionError(
        'gRPC dependencies not found. Install @grpc/grpc-js and @grpc/proto-loader: ' +
          'npm install @grpc/grpc-js @grpc/proto-loader',
      );
    }

    const packageDefinition = protoLoader.loadSync(serviceProto, {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs: [protoDir],
    });

    const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
    const OJSServiceCtor = resolveOJSServiceConstructor(protoDescriptor);

    const client = new OJSServiceCtor(
      this.config.url,
      grpc.credentials.createInsecure(),
    );
    if (generation !== this.generation) {
      client.close();
      return;
    }
    this.client = client;
    // Cache the loaded module so `call()` never needs to re-import it —
    // dynamic `import()` of the same specifier resolves from Node's module
    // cache anyway, but re-awaiting it on every single RPC call is needless
    // overhead in a hot path (worker polling, high-throughput enqueue).
    this.grpcModule = grpc;
  }

  /**
   * Creates gRPC metadata from default and per-request metadata.
   */
  private createMetadata(extra?: Record<string, string>): Record<string, string> {
    return {
      ...this.defaultMetadata,
      ...extra,
    };
  }

  /**
   * Wraps a gRPC unary call in a Promise with timeout, metadata, and
   * `AbortSignal` cancellation support.
   */
  private async call(
    method: string,
    request: unknown,
    timeout?: number,
    extraMetadata?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    // Check for a pre-aborted signal *before* `ensureClient()` — a caller
    // that passes an already-aborted signal must get a prompt, normalized
    // cancellation rejection without this transport ever resolving the
    // optional gRPC peer dependencies, loading the proto, or opening a
    // channel (`ensureClient()`'s dynamic `import()`/proto load/channel
    // construction, none of which is needed to know the request was
    // already cancelled before it began). This mirrors the identical
    // pre-flight check inside the Promise executor below, which exists
    // only to close the (today purely theoretical, since nothing else
    // async happens in between) race between this check and metadata/
    // deadline resolution — this one is the actual fast path.
    if (signal?.aborted) {
      throw new OJSConnectionError(`Request cancelled: ${method}`);
    }

    // The full budget for this call, timed from *this* instant — not from
    // whenever `ensureClient()` happens to resolve. Capturing it now (before
    // any await) means a slow/blocked client/proto initialization eats into
    // the same budget the caller configured for the whole call, rather than
    // silently granting the RPC itself a brand-new, full-length deadline on
    // top of however long initialization already took.
    const callStartedAt = Date.now();
    const timeoutMs = timeout ?? this.defaultTimeout;

    // Races `ensureClient()` (dynamic import/proto load/client construction
    // — at most once per transport instance, memoized on `this.initPromise`)
    // against this call's own timeout budget and `signal` aborting, instead
    // of unconditionally `await`ing it. A blocked/never-resolving
    // initialization (or one that simply takes longer than `timeoutMs`)
    // therefore rejects this call promptly with a retryable connection
    // error rather than hanging indefinitely regardless of the configured
    // timeout/signal — the whole point of a per-call deadline. This never
    // "manually resolves" the shared, memoized initialization: a call that
    // gives up here only stops waiting on it; `ensureClient()` itself keeps
    // running (or never does, if it is a test double built to hang forever)
    // and is safely ignored by this call if/when it eventually settles,
    // while any other concurrent or future call sharing the same
    // `this.initPromise` is completely unaffected.
    await this.ensureClientWithSetupTimeout(timeoutMs, signal);

    // Re-check: the signal could have been aborted while `ensureClient()`
    // was pending (a real async gap, unlike the point below).
    if (signal?.aborted) {
      throw new OJSConnectionError(`Request cancelled: ${method}`);
    }

    const grpc = this.grpcModule;
    if (!grpc || !this.client) {
      throw new OJSConnectionError('gRPC client failed to initialize.');
    }

    const metadata = new grpc.Metadata();
    const allMeta = this.createMetadata(extraMetadata);
    for (const [key, value] of Object.entries(allMeta)) {
      metadata.set(key, value);
    }

    // The remaining budget from `callStartedAt`, not a fresh `timeoutMs`
    // window starting now — see this method's opening comment. If
    // initialization consumed some of the budget, the RPC itself gets only
    // what is left, exactly matching a caller's expectation that the whole
    // call (setup included) completes within `timeoutMs`.
    const deadline = new Date(callStartedAt + timeoutMs);

    const fn = this.client[method];
    if (!fn) {
      throw new OJSError(
        `Unsupported gRPC method: ${method}`,
        'unimplemented',
        { retryable: false },
      );
    }

    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      // Declared (and default-initialized to `undefined`) *before* onAbort
      // is defined, so `onAbort`'s closure can never observe `call` in the
      // temporal dead zone even in the pathological case where an 'abort'
      // listener fires reentrantly while `fn.call(...)` below is still
      // executing (e.g. a test double that calls `signal`'s controller
      // synchronously). `call` is only ever read via the optional-chained
      // `call?.cancel()` below, never assumed to be set.
      let call: GrpcClientCall | undefined;

      const finish = (cb: () => void): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        cb();
      };

      const onAbort = (): void => {
        // Reject immediately: cancellation must settle this promise
        // promptly even if the underlying implementation's `cancel()`
        // never invokes the original callback (a real grpc-js call
        // reliably does, via a CANCELLED status, but a mock/incomplete
        // implementation might not). `finish()` guards against the
        // eventual real callback re-settling — a "late callback" after an
        // abort is simply ignored.
        finish(() => {
          reject(new OJSConnectionError(`Request cancelled: ${method}`));
        });
        try {
          call?.cancel();
        } catch (cancelErr) {
          // The underlying cancel() itself failing must not be silently
          // swallowed, but it also must not stop the rejection above —
          // this promise has already settled by this point regardless.
          console.warn(`[ojs-grpc] call.cancel() threw for '${method}':`, String(cancelErr));
        }
      };

      if (signal) {
        if (signal.aborted) {
          // Closes the race between the initial `signal?.aborted` check
          // above (before metadata/deadline/method resolution) and this
          // point: nothing async happens in between today, but this
          // guarantees correctness even if that ever changes, and handles
          // a signal aborted reentrantly by a caller's own synchronous
          // side effects. Reject directly rather than registering a
          // listener for an 'abort' event that has already fired and will
          // never fire again.
          finish(() => {
            reject(new OJSConnectionError(`Request cancelled: ${method}`));
          });
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        call = fn.call(
          this.client,
          request,
          metadata,
          { deadline },
          (err, response) => {
            finish(() => {
              if (err) {
                reject(mapGrpcError(err));
              } else {
                resolve(response);
              }
            });
          },
        );
      } catch (syncErr) {
        // The generated method itself threw synchronously, before ever
        // returning a call object (e.g. client-side request/metadata
        // rejection). `finish()` removes the abort listener registered
        // just above, so this can never leak one even though no call was
        // actually issued to cancel.
        finish(() => {
          reject(mapSyncThrow(syncErr));
        });
      }
    });
  }

  async request<T = unknown>(
    options: TransportRequestOptions,
  ): Promise<TransportResponse<T>> {
    const { method, path, body, timeout, signal } = options;
    const headers: OJSResponseHeaders = {};

    try {
      const result = await this.routeRequest(method, path, body, timeout, signal);
      return {
        status: 200,
        headers,
        body: result as T,
      };
    } catch (error) {
      if (error instanceof OJSError) {
        throw error;
      }
      throw new OJSConnectionError(
        `gRPC request failed: ${(error as Error).message}`,
        error as Error,
      );
    }
  }

  /**
   * Routes an HTTP-style request to the appropriate gRPC method.
   */
  private async routeRequest(
    method: string,
    path: string,
    body: unknown,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    // Normalize: strip /ojs/v1 prefix if present, and separate any query
    // string from the path used for route matching. A raw query string
    // previously made every route match fail past this point (e.g.
    // `normalizedPath === '/cron'` is false for '/cron?page=2&per_page=10'
    // — CronOperations.list()'s exact request path), silently discarding
    // GET /cron's page/per_page instead of routing to grpcListCron at all.
    const withoutPrefix = path.replace(/^\/ojs\/v1/, '');
    const queryIndex = withoutPrefix.indexOf('?');
    const normalizedPath = queryIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, queryIndex);
    const queryString = queryIndex === -1 ? '' : withoutPrefix.slice(queryIndex + 1);
    const segments = normalizedPath.split('/');
    // segments[0] is '' (leading slash), segments[1] is resource, segments[2] is id, etc.

    // --- Job operations ---
    if (method === 'POST' && normalizedPath === '/jobs') {
      return this.grpcEnqueue(body, timeout, signal);
    }
    if (method === 'POST' && normalizedPath === '/jobs/batch') {
      return this.grpcEnqueueBatch(body, timeout, signal);
    }
    if (method === 'GET' && (/^\/jobs\/[^/]+$/.exec(normalizedPath))) {
      const jobId = segments[2]!;
      return this.grpcGetJob(jobId, timeout, signal);
    }
    if (method === 'DELETE' && (/^\/jobs\/[^/]+$/.exec(normalizedPath))) {
      const jobId = segments[2]!;
      return this.grpcCancelJob(jobId, timeout, signal);
    }

    // --- Worker operations ---
    if (method === 'POST' && normalizedPath === '/workers/fetch') {
      return this.grpcFetch(body, timeout, signal);
    }
    if (method === 'POST' && normalizedPath === '/workers/ack') {
      return this.grpcAck(body, timeout, signal);
    }
    if (method === 'POST' && normalizedPath === '/workers/nack') {
      return this.grpcNack(body, timeout, signal);
    }
    if (method === 'POST' && normalizedPath === '/workers/heartbeat') {
      return this.grpcHeartbeat(body, timeout, signal);
    }
    if (method === 'PUT' && (/^\/jobs\/[^/]+\/progress$/.exec(normalizedPath))) {
      return this.grpcProgress(body, timeout, signal);
    }

    // --- Queue operations ---
    if (method === 'GET' && normalizedPath === '/queues') {
      return this.grpcListQueues(timeout, signal);
    }
    if (method === 'GET' && (/^\/queues\/[^/]+\/stats$/.exec(normalizedPath))) {
      const queueName = segments[2]!;
      return this.grpcQueueStats(queueName, timeout, signal);
    }
    if (
      method === 'POST' &&
      (/^\/queues\/[^/]+\/pause$/.exec(normalizedPath))
    ) {
      const queueName = segments[2]!;
      return this.grpcPauseQueue(queueName, timeout, signal);
    }
    if (
      method === 'POST' &&
      (/^\/queues\/[^/]+\/resume$/.exec(normalizedPath))
    ) {
      const queueName = segments[2]!;
      return this.grpcResumeQueue(queueName, timeout, signal);
    }

    // --- Dead letter operations ---
    if (method === 'GET' && normalizedPath === '/dead-letter') {
      return this.grpcListDeadLetter(body, timeout, signal);
    }
    if (
      method === 'POST' &&
      (/^\/dead-letter\/[^/]+\/retry$/.exec(normalizedPath))
    ) {
      const jobId = segments[2]!;
      return this.grpcRetryDeadLetter(jobId, timeout, signal);
    }
    if (method === 'DELETE' && (/^\/dead-letter\/[^/]+$/.exec(normalizedPath))) {
      const jobId = segments[2]!;
      return this.grpcDeleteDeadLetter(jobId, timeout, signal);
    }

    // --- Cron operations ---
    if (method === 'GET' && normalizedPath === '/cron') {
      return this.grpcListCron(queryString, timeout, signal);
    }
    if (method === 'POST' && normalizedPath === '/cron') {
      return this.grpcRegisterCron(body, timeout, signal);
    }
    if (method === 'DELETE' && (/^\/cron\/[^/]+$/.exec(normalizedPath))) {
      const name = segments[2]!;
      return this.grpcUnregisterCron(name, timeout, signal);
    }

    // --- Workflow operations ---
    if (method === 'POST' && normalizedPath === '/workflows') {
      return this.grpcCreateWorkflow(body, timeout, signal);
    }
    if (method === 'GET' && (/^\/workflows\/[^/]+$/.exec(normalizedPath))) {
      const workflowId = segments[2]!;
      return this.grpcGetWorkflow(workflowId, timeout, signal);
    }
    if (method === 'DELETE' && (/^\/workflows\/[^/]+$/.exec(normalizedPath))) {
      const workflowId = segments[2]!;
      return this.grpcCancelWorkflow(workflowId, timeout, signal);
    }

    // --- Durable execution (checkpoint) operations ---
    if (method === 'POST' && (/^\/jobs\/[^/]+\/checkpoint$/.exec(normalizedPath))) {
      const jobId = segments[2]!;
      return this.grpcSaveCheckpoint(jobId, body, timeout, signal);
    }
    if (method === 'GET' && (/^\/jobs\/[^/]+\/checkpoint$/.exec(normalizedPath))) {
      const jobId = segments[2]!;
      return this.grpcGetCheckpoint(jobId, timeout, signal);
    }
    if (method === 'DELETE' && (/^\/jobs\/[^/]+\/checkpoint$/.exec(normalizedPath))) {
      const jobId = segments[2]!;
      return this.grpcDeleteCheckpoint(jobId, timeout, signal);
    }

    // --- System operations ---
    if (method === 'GET' && normalizedPath === '/health') {
      return this.grpcHealth(timeout, signal);
    }
    if (
      method === 'GET' &&
      (normalizedPath === '/manifest' || path === '/ojs/manifest')
    ) {
      return this.grpcManifest(timeout, signal);
    }

    throw new OJSError(
      `Unsupported route: ${method} ${path}`,
      'unimplemented',
      { retryable: false },
    );
  }

  // --- gRPC method implementations ---

  private async grpcEnqueue(
    body: unknown,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const b = asProtoRecord(body);
    const request: EnqueueProtoRequest = {
      type: b.type,
      args: asProtoArray(b.args).map(toProtoValue),
    };
    const options = mapEnqueueOptions(b);
    if (options) {
      request.options = options;
    }
    const response: JobRpcResponse = asProtoRecord(
      await this.call('enqueue', request, timeout, undefined, signal),
    );
    return { job: fromProtoJob(response.job) };
  }

  private async grpcEnqueueBatch(
    body: unknown,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const b = asProtoRecord(body);
    // Expand `default_options` into every entry client-side and deliberately
    // omit EnqueueBatchRequest.default_options itself. Proto3 erases scalar/
    // repeated-field presence for explicit 0/false/empty values; if defaults
    // were also sent, a backend merge could mistake those explicit per-job
    // overrides for absence and apply the defaults again.
    const defaultOptionsSource = Object.prototype.hasOwnProperty.call(
      b,
      'default_options',
    )
      ? b.default_options
      : b.defaultOptions;
    const defaultWireOptions =
      defaultOptionsSource === undefined
        ? undefined
        : requireOptionsRecord(defaultOptionsSource, 'default_options');
    if (defaultWireOptions) {
      assertKnownFields(defaultWireOptions, ENQUEUE_OPTION_FIELD_SET, 'default_options');
    }
    if (defaultWireOptions) {
      // Validate every default even when every job overrides it. The result
      // is intentionally discarded because defaults are materialized only
      // into each per-job options message below.
      buildProtoEnqueueOptions(
        mergeWireEnqueueOptions(defaultWireOptions, undefined),
      );
    }

    const request: {
      jobs: {
        type: unknown;
        args: unknown[];
        options?: Record<string, unknown>;
      }[];
    } = {
      jobs: asProtoArray(b.jobs).map((raw) => {
        const j = asProtoRecord(raw);
        const options = mapEnqueueOptions(j, defaultWireOptions);
        const entry: { type: unknown; args: unknown[]; options?: Record<string, unknown> } = {
          type: j.type,
          args: asProtoArray(j.args).map(toProtoValue),
        };
        if (options) entry.options = options;
        return entry;
      }),
    };
    const response: JobsRpcResponse = asProtoRecord(
      await this.call('enqueueBatch', request, timeout, undefined, signal),
    );
    return {
      jobs: asProtoArray(response.jobs).map(fromProtoJob),
    };
  }

  private async grpcGetJob(jobId: string, timeout?: number, signal?: AbortSignal): Promise<unknown> {
    const response: JobRpcResponse = asProtoRecord(
      await this.call('getJob', { jobId }, timeout, undefined, signal),
    );
    return { job: fromProtoJob(response.job) };
  }

  private async grpcCancelJob(
    jobId: string,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response: JobRpcResponse = asProtoRecord(
      await this.call('cancelJob', { jobId }, timeout, undefined, signal),
    );
    return { job: fromProtoJob(response.job) };
  }

  private async grpcFetch(body: unknown, timeout?: number, signal?: AbortSignal): Promise<unknown> {
    const b = asProtoRecord(body);
    const request: FetchProtoRequest = {
      queues: b.queues,
      count: b.count ?? 1,
    };
    if (b.worker_id) {
      request.workerId = b.worker_id;
    }
    const response: JobsRpcResponse = asProtoRecord(
      await this.call('fetch', request, timeout, undefined, signal),
    );
    return {
      jobs: asProtoArray(response.jobs).map(fromProtoJob),
    };
  }

  private async grpcAck(body: unknown, timeout?: number, signal?: AbortSignal): Promise<unknown> {
    const b = asProtoRecord(body);
    const request: AckProtoRequest = { jobId: b.job_id };
    // AckRequest.result (worker.proto) is a `google.protobuf.Struct`, so
    // an object-shaped result MUST be converted to `{ fields: { ... } }`
    // before the RPC — the previous code assigned the plain JS object
    // straight through, which no real proto-loader-encoded wire could
    // accept. An omitted or explicit-`null` result leaves the field unset
    // (a job with no result).
    //
    // A bare scalar/array result has no faithful `Struct` representation
    // at all. The handler has ALREADY run to completion by the time
    // `ack()` is called, so failing this call (or leaving the job
    // unacknowledged) would either strand the job for redelivery or force
    // a nack that misreports a successful execution as a failure — worse
    // outcomes than simply not persisting the result. Instead: ack the
    // job WITHOUT its result (completion is preserved) and surface an
    // explicit, once-per-call protocol warning via `onWarning` so callers
    // can observe the limitation instead of it failing silently.
    if (b.result !== undefined && b.result !== null) {
      if (isProtoStructRepresentable(b.result)) {
        request.result = toProtoStruct(b.result, {
          label: 'ack result',
          wireField: 'AckRequest.result',
        });
      } else {
        const originalResultType = protoResultTypeLabel(b.result);
        this.emitWarning({
          code: 'ack_result_unrepresentable',
          message:
            `AckRequest.result (google.protobuf.Struct, the gRPC wire type of an ` +
            `ack result) cannot represent a ${originalResultType} value — only a ` +
            'JSON object maps to Struct. The job was acknowledged successfully ' +
            '(completion is not affected), but its result was NOT stored over ' +
            'this gRPC connection. Result storage for non-object ack results is ' +
            'omitted until the OJS gRPC protocol represents AckRequest.result as ' +
            'a google.protobuf.Value instead of a Struct; the HTTP transport is ' +
            'not affected by this limitation.',
          originalResultType,
        });
      }
    }
    const response: AckRpcResponse = asProtoRecord(
      await this.call('ack', request, timeout, undefined, signal),
    );
    return { acknowledged: response.acknowledged ?? true };
  }

  private async grpcNack(body: unknown, timeout?: number, signal?: AbortSignal): Promise<unknown> {
    const b = asProtoRecord(body);
    const error = asProtoRecord(b.error);
    const protoError: Record<string, unknown> = {
      code: typeof error.code === 'string' ? error.code : '',
      message: typeof error.message === 'string' ? error.message : '',
      // `retryable` is a non-optional proto3 scalar, so a decoder cannot
      // distinguish an omitted value from an explicitly-sent false. At the
      // SDK boundary we still can: omission follows JobError's historical
      // retryable-by-default behavior, while an explicit false is retained.
      retryable: typeof error.retryable === 'boolean' ? error.retryable : true,
      attempt: typeof error.attempt === 'number' ? error.attempt : 0,
      backtrace: Array.isArray(error.backtrace)
        ? error.backtrace
            .filter((frame): frame is string => typeof frame === 'string')
            .join('\n')
        : typeof error.backtrace === 'string'
          ? error.backtrace
          : '',
    };
    if (error.occurred_at !== undefined && error.occurred_at !== null) {
      protoError.occurredAt = toProtoTimestamp(
        error.occurred_at,
        'NackRequest.error.occurred_at',
      );
    }
    if (error.details !== undefined && error.details !== null) {
      protoError.details = toProtoStruct(error.details, NACK_DETAILS_STRUCT_CONTEXT);
    }
    const request = {
      jobId: b.job_id,
      error: protoError,
    };
    const response: NackRpcResponse = asProtoRecord(
      await this.call('nack', request, timeout, undefined, signal),
    );
    return {
      state: mapJobState(response.state),
      next_attempt_at: fromProtoTimestamp(response.nextAttemptAt),
    };
  }

  private async grpcHeartbeat(body: unknown, timeout?: number, signal?: AbortSignal): Promise<unknown> {
    const b = asProtoRecord(body);
    // src/worker.ts's heartbeat body (see sendHeartbeat()) is always a
    // *worker-level* heartbeat: it identifies itself via `worker_id` and
    // never sends a `job_id`. HeartbeatRequest.id (worker.proto) doubles as
    // "the UUIDv7 job identifier for a per-job heartbeat, or the worker
    // identifier for a worker-level heartbeat" per its own doc comment, so
    // both `id` and `worker_id` map to the same worker identifier here.
    // (Previously this indexed `active_jobs` — the worker's active-job
    // *count*, not an array — as if it were a list of job IDs, which was
    // simply wrong for a worker-level heartbeat and is removed.)
    const workerId = asProtoString(b.worker_id) ?? '';
    const request: HeartbeatProtoRequest = {
      id: workerId,
      workerId,
    };
    const protoState = mapWorkerStateToProto(b.state);
    if (protoState) {
      request.currentState = protoState;
    }
    const response: HeartbeatRpcResponse = asProtoRecord(
      await this.call('heartbeat', request, timeout, undefined, signal),
    );
    return {
      state: mapWorkerState(response.directedState),
    };
  }

  private grpcProgress(_body: unknown, _timeout?: number, _signal?: AbortSignal): Promise<unknown> {
    // job.proto/service.proto (see ojs-proto's `service.proto` RPC list)
    // define no progress-reporting RPC at all — there is no wire
    // operation this call could ever forward to. The previous
    // implementation silently resolved `{}` as if the report had
    // succeeded, which is worse than doing nothing: `reportProgress()`
    // callers (src/progress.ts) would believe a real backend had
    // received and recorded progress that was actually discarded,
    // with no way to detect the gap. Fail loudly and permanently
    // instead — a non-retryable `unimplemented` `OJSError` — so
    // callers learn immediately that gRPC has no progress RPC yet,
    // rather than silently losing progress reports. Not declared
    // `async` since it never awaits anything.
    return Promise.reject(
      new OJSError(
        'GrpcTransport does not support progress reporting: the OJS gRPC ' +
          'proto (service.proto) defines no progress RPC, so PUT ' +
          '/jobs/{id}/progress cannot be forwarded over gRPC. Use ' +
          'HttpTransport for reportProgress(), or wait for a future proto ' +
          'revision that adds a progress RPC.',
        'unimplemented',
        { retryable: false },
      ),
    );
  }

  private async grpcListQueues(timeout?: number, signal?: AbortSignal): Promise<unknown> {
    const response: ListQueuesRpcResponse = asProtoRecord(
      await this.call('listQueues', {}, timeout, undefined, signal),
    );
    return {
      queues: asProtoArray(response.queues).map((raw) => {
        const q = asProtoRecord(raw);
        return {
          name: q.name,
          status: q.paused ? 'paused' : 'active',
          available_count: parseInt(asProtoIntegerString(q.availableCount), 10),
        };
      }),
    };
  }

  private async grpcQueueStats(
    queueName: string,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response: QueueStatsRpcResponse = asProtoRecord(
      await this.call(
        'queueStats',
        { queue: queueName },
        timeout,
        undefined,
        signal,
      ),
    );
    const stats = asProtoRecord(response.stats);
    return {
      queue: response.queue ?? queueName,
      status: stats.paused ? 'paused' : 'active',
      stats: {
        available: parseInt(asProtoIntegerString(stats.available), 10),
        active: parseInt(asProtoIntegerString(stats.active), 10),
        scheduled: parseInt(asProtoIntegerString(stats.scheduled), 10),
        retryable: parseInt(asProtoIntegerString(stats.retryable), 10),
        dead: parseInt(asProtoIntegerString(stats.dead), 10),
        completed_last_hour: parseInt(asProtoIntegerString(stats.completedLastHour), 10),
        failed_last_hour: parseInt(asProtoIntegerString(stats.failedLastHour), 10),
      },
    };
  }

  private async grpcPauseQueue(
    queueName: string,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    await this.call('pauseQueue', { queue: queueName }, timeout, undefined, signal);
    return { status: 'paused' };
  }

  private async grpcResumeQueue(
    queueName: string,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    await this.call('resumeQueue', { queue: queueName }, timeout, undefined, signal);
    return { status: 'active' };
  }

  private async grpcListDeadLetter(
    body: unknown,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const b = asProtoRecord(body);
    const request: ListDeadLetterProtoRequest = {};
    if (b.queue) request.queue = b.queue;
    if (b.limit) request.limit = b.limit;
    const response: ListDeadLetterRpcResponse = asProtoRecord(
      await this.call('listDeadLetter', request, timeout, undefined, signal),
    );
    return {
      jobs: asProtoArray(response.jobs).map(fromProtoJob),
      pagination: {
        total: parseInt(asProtoIntegerString(response.totalCount), 10),
      },
    };
  }

  private async grpcRetryDeadLetter(
    jobId: string,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response: JobRpcResponse = asProtoRecord(
      await this.call(
        'retryDeadLetter',
        { jobId },
        timeout,
        undefined,
        signal,
      ),
    );
    return { job: fromProtoJob(response.job) };
  }

  private async grpcDeleteDeadLetter(
    jobId: string,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    await this.call('deleteDeadLetter', { jobId }, timeout, undefined, signal);
    return {};
  }

  private async grpcListCron(
    queryString: string,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    // service.proto's ListCronRequest/ListCronResponse carry no pagination
    // at all — the RPC always returns every registered entry. `page`/
    // `per_page` (the same HTTP-wire query params `CronOperations.list()`
    // sends) are therefore validated and applied entirely client-side
    // here. Entries are sorted by `name` first for a deterministic, stable
    // order across repeated calls/pages — the RPC itself gives no
    // ordering guarantee, and paginating over an unstably-ordered list
    // could duplicate or skip entries between pages.
    const { page, perPage } = parseCronListPagination(queryString);
    const response: ListCronRpcResponse = asProtoRecord(
      await this.call('listCron', {}, timeout, undefined, signal),
    );
    const allEntries = asProtoArray(response.entries)
      .map(fromProtoCronEntry)
      .sort((a, b) => {
        const left = String(a.name ?? '');
        const right = String(b.name ?? '');
        return left < right ? -1 : left > right ? 1 : 0;
      });
    const total = allEntries.length;
    const start = (page - 1) * perPage;
    return {
      cron_jobs: allEntries.slice(start, start + perPage),
      pagination: { page, per_page: perPage, total },
    };
  }

  private async grpcRegisterCron(
    body: unknown,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const b = asProtoRecord(body);
    const request: RegisterCronProtoRequest = {
      name: b.name,
      cron: b.cron,
      type: b.type,
      args: asProtoArray(b.args).map(toProtoValue),
    };
    if (b.timezone) request.timezone = b.timezone;
    // RegisterCronRequest.options (service.proto) is an EnqueueOptions
    // applied to every generated job. Map the cron definition's nested
    // `options` plus envelope-level `meta` through the same strict
    // HTTP-wire -> proto converter used by enqueue (preserving explicit
    // zero fields like priority: 0, and rejecting an unrepresentable
    // envelope `schema`), instead of dropping them as the previous mapper
    // did.
    const options = mapEnqueueOptions(
      b,
      undefined,
      'cron registration',
      false,
    );
    if (options) request.options = options;
    const registrationTimestamp = new Date().toISOString();
    const response: RegisterCronRpcResponse = asProtoRecord(
      await this.call('registerCron', request, timeout, undefined, signal),
    );

    // RegisterCronResponse (service.proto) carries only `name` and
    // `next_run_at` — it does not echo back cron/timezone/type/args/
    // options, nor any `created_at`. CronJobInfo is reconstructed solely
    // from the definition we submitted (a faithful echo of exactly what
    // the server was asked to register) plus this response's own
    // authoritative `name`/`next_run_at` and the registration timestamp
    // captured immediately above — never from a second follow-up
    // `ListCron` RPC. An additional `ListCron` lookup here would be racy
    // (nothing guarantees a just-registered or concurrently-upserted
    // entry is visible yet, or observed in a consistent state, by the
    // time it runs) and O(n) in the total number of registered schedules
    // just to find one by name; it also risked returning a mix of two
    // different response revisions (the register call's own response
    // merged with a separately-fetched, possibly stale list snapshot).
    const name = asProtoString(response.name) ?? asProtoString(b.name) ?? '';

    const cronJob: Record<string, unknown> = {
      name,
      cron: b.cron,
      type: b.type,
      args: asProtoArray(b.args),
    };
    if (b.timezone) cronJob.timezone = b.timezone;
    if (b.options !== undefined) cronJob.options = b.options;
    if (b.meta !== undefined) cronJob.meta = b.meta;
    // A cron schedule is unconditionally active immediately after a
    // successful registration (service.proto has no paused/disabled cron
    // state), and cannot have a prior run yet.
    cronJob.status = 'active';
    // `created_at` has no proto source at all: neither RegisterCronResponse
    // nor CronEntry carries a creation timestamp. This SDK captures the
    // moment immediately before issuing the registration RPC as a documented
    // registration-time value. CronJobInfo.created_at is optional because
    // later gRPC list calls have no source for it — see README's gRPC cron
    // section.
    cronJob.created_at = registrationTimestamp;
    // RegisterCronResponse.next_run_at is the sole authoritative source
    // for a just-registered schedule's next run.
    const responseNextRunAt = fromProtoTimestamp(response.nextRunAt);
    if (responseNextRunAt !== null) {
      cronJob.next_run_at = responseNextRunAt;
    }

    return { cron_job: cronJob };
  }

  private async grpcUnregisterCron(
    name: string,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    await this.call('unregisterCron', { name }, timeout, undefined, signal);
    return {};
  }

  private async grpcCreateWorkflow(
    body: unknown,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    // Translate the public (nested) chain/group wire shape into the flat
    // proto WorkflowStep DAG (deterministic step IDs + explicit
    // depends_on), reject batch/schema before the RPC, and never send an
    // empty steps list. See `buildProtoCreateWorkflowRequest`.
    const workflowBody = asProtoRecord(body);
    const request = buildProtoCreateWorkflowRequest(workflowBody);
    const response: WorkflowRpcResponse = asProtoRecord(
      await this.call('createWorkflow', request, timeout, undefined, signal),
    );
    const requestedType = asWorkflowType(workflowBody.type);
    const created = fromProtoWorkflow(response.workflow, requestedType);
    // Remember the authoritative type by the server-assigned ID so a
    // later getWorkflow() for this same workflow reports it accurately
    // even when its flat DAG is structurally ambiguous. `requestedType`
    // is always defined in practice (batch never reaches this point;
    // chain/group are the only two
    // `buildProtoCreateWorkflowRequest` accepts), but the check is kept
    // explicit rather than assumed.
    const createdId = typeof created.id === 'string' ? created.id : '';
    if (createdId && (requestedType === 'chain' || requestedType === 'group')) {
      this.cacheWorkflowType(createdId, requestedType);
    }
    return { workflow: created };
  }

  /** Records `type` for `workflowId` in `workflowTypeCache`, evicting the
   * oldest entry first (FIFO, via `Map`'s insertion-order iteration) once
   * the bound is reached. */
  private cacheWorkflowType(workflowId: string, type: 'chain' | 'group'): void {
    if (
      !this.workflowTypeCache.has(workflowId) &&
      this.workflowTypeCache.size >= WORKFLOW_TYPE_CACHE_MAX_ENTRIES
    ) {
      const oldestKey = this.workflowTypeCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.workflowTypeCache.delete(oldestKey);
      }
    }
    this.workflowTypeCache.set(workflowId, type);
  }

  private async grpcGetWorkflow(
    workflowId: string,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response: WorkflowRpcResponse = asProtoRecord(
      await this.call(
        'getWorkflow',
        { workflowId },
        timeout,
        undefined,
        signal,
      ),
    );
    // The current Workflow proto carries no originating-primitive field.
    // A creation-time cache hit remains authoritative; on a miss,
    // `fromProtoWorkflow` performs only the narrow structural inference
    // documented on `WorkflowStatus.type` and otherwise omits the field.
    const cachedType = this.workflowTypeCache.get(workflowId);
    return { workflow: fromProtoWorkflow(response.workflow, cachedType) };
  }

  private async grpcCancelWorkflow(
    workflowId: string,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    await this.call(
      'cancelWorkflow',
      { workflowId },
      timeout,
      undefined,
      signal,
    );
    return { state: 'cancelled' };
  }

  private async grpcHealth(timeout?: number, signal?: AbortSignal): Promise<unknown> {
    const response: HealthRpcResponse = asProtoRecord(
      await this.call('health', {}, timeout, undefined, signal),
    );
    const statusMap: Record<string, string> = {
      HEALTH_STATUS_OK: 'ok',
      HEALTH_STATUS_DEGRADED: 'degraded',
      HEALTH_STATUS_UNHEALTHY: 'unhealthy',
    };
    return { status: statusMap[asProtoString(response.status) ?? ''] ?? 'ok' };
  }

  private async grpcManifest(timeout?: number, signal?: AbortSignal): Promise<unknown> {
    const response: ManifestRpcResponse = asProtoRecord(
      await this.call('manifest', {}, timeout, undefined, signal),
    );
    return {
      ojs_version: response.ojsVersion,
      implementation: response.implementation,
      conformance_level: response.conformanceLevel,
      protocols: response.protocols,
      backend: response.backend,
      extensions: response.extensions,
    };
  }

  // --- Durable execution (checkpoint) RPCs ---
  // See ojs-durable-execution.md section 4 and service.proto's
  // SaveCheckpoint/GetCheckpoint/DeleteCheckpoint RPCs. `state` is typed as
  // `google.protobuf.Struct` on the wire, which (unlike the HTTP binding's
  // `state: <any JSON value>`) can only represent an object/map — not a bare
  // scalar or array. DurableContext (src/durable.ts) always sends an
  // object-shaped state, so this is not a practical limitation for the
  // SDK's own durable-execution support, but is surfaced clearly below
  // rather than silently mangling a non-object state.

  private async grpcSaveCheckpoint(
    jobId: string,
    body: unknown,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const state = asProtoRecord(body).state;
    const normalizedState = normalizeCheckpointJson(state);
    const response: SaveCheckpointRpcResponse = asProtoRecord(
      await this.call(
        'saveCheckpoint',
        { jobId, state: toProtoStruct(normalizedState) },
        timeout,
        undefined,
        signal,
      ),
    );
    return { checkpoint: { job_id: jobId, sequence: Number(response.sequence ?? 0) } };
  }

  private async grpcGetCheckpoint(
    jobId: string,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response: GetCheckpointRpcResponse = asProtoRecord(
      await this.call('getCheckpoint', { jobId }, timeout, undefined, signal),
    );
    return {
      checkpoint: {
        job_id: response.jobId ?? jobId,
        state: fromProtoStruct(response.state),
        sequence: Number(response.sequence ?? 0),
        created_at: fromProtoTimestamp(response.savedAt),
      },
    };
  }

  private async grpcDeleteCheckpoint(
    jobId: string,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    await this.call('deleteCheckpoint', { jobId }, timeout, undefined, signal);
    return { deleted: true, job_id: jobId };
  }

  // --- Server-streaming public API (additive; see grpc-stream.ts) ---

  /**
   * Opens the `StreamJobs` server-streaming RPC and yields jobs pushed by
   * the server as they become available — a high-throughput, push-based
   * alternative to polling via unary `fetch()`. See service.proto's
   * `StreamJobs` RPC and ojs-grpc-binding.md section 10.1.
   *
   * - Lazily connects: no dynamic import, proto load, or channel is
   *   created until the returned iterable is actually iterated (this
   *   method itself is only a thin, hand-built iterator wrapper).
   * - Jobs are normalized to the same shape unary `fetch()` returns (both
   *   go through `fromProtoJob`); the `stream.keepalive` sentinel job
   *   (worker.proto: "a Job with type 'stream.keepalive' and empty args")
   *   is filtered out and never yielded, per the spec's "Clients MUST
   *   filter keepalives."
   * - Automatically reconnects on transient `UNAVAILABLE`,
   *   `DEADLINE_EXCEEDED`, `INTERNAL`, and `RESOURCE_EXHAUSTED` failures
   *   with exponential backoff and resumes by re-issuing the same
   *   `StreamJobsRequest` (there is no cursor to resume from — see
   *   ojs-grpc-binding.md section 10.1.1). Local signal/transport
   *   cancellation ends silently; a remote `CANCELLED` status, other
   *   terminal errors, or reconnect exhaustion are thrown.
   * - `options.signal` cancellation and the consumer's own early
   *   `break`/`return`/`throw` out of the consuming `for await` both
   *   cleanly cancel the in-flight call; no listener, timer, or call is
   *   ever left behind (see `grpc-stream.ts`).
   * - The returned `AsyncIterableIterator`'s `.return()`/`.throw()` (which
   *   is exactly what a `for await`'s `break`/`return`/`throw` invokes)
   *   cancel the active call/abort an in-progress reconnect backoff
   *   *immediately* — synchronously, the instant they are called — even
   *   while a `.next()` on this same iterator is still pending. See
   *   `grpc-stream.ts`'s exported `reconnectingServerStream` for why a
   *   bare native async generator cannot give this guarantee.
   *
   * Additive: does not change `request()`/`Transport` or any existing
   * export.
   */
  streamJobs(
    request: GrpcStreamJobsRequest,
    options?: GrpcStreamOptions,
  ): AsyncIterableIterator<Job> {
    return this.openReconnectingStream<Job>(
      'streamJobs',
      {
        queues: request.queues,
        workerId: request.workerId,
        maxConcurrent: request.maxConcurrent ?? 1,
      },
      options,
      (raw) => {
        const job = fromProtoJob(raw);
        return job.type === 'stream.keepalive' ? undefined : toJobData(job);
      },
      { retryableStatusCodes: STREAM_JOBS_RETRYABLE_STATUS_CODES },
    );
  }

  /**
   * Opens the `StreamEvents` server-streaming RPC and yields lifecycle
   * events (job/queue/workflow) as they occur, for monitoring/dashboards/
   * observability tooling. See service.proto's `StreamEvents` RPC and
   * ojs-grpc-binding.md section 10.2.
   *
   * Uses the same lazy-connect, backoff, and cancellation cleanup as
   * {@link streamJobs}, but its retry classification is intentionally
   * narrower: `UNAVAILABLE`, `DEADLINE_EXCEEDED`, and `INTERNAL` reconnect;
   * `RESOURCE_EXHAUSTED` is terminal for event streams. Events are returned
   * as {@link GrpcStreamEvent}, preserving the gRPC binding's own wire field
   * naming; the `stream.keepalive` sentinel event is filtered out and never
   * yielded, per the spec's "Clients SHOULD filter keepalive events."
   *
   * @param request Optional filters (queues/eventTypes/jobId/workflowId,
   *   combined with AND logic); omitted or empty means "all events."
   */
  streamEvents(
    request?: GrpcStreamEventsRequest,
    options?: GrpcStreamOptions,
  ): AsyncIterableIterator<GrpcStreamEvent> {
    return this.openReconnectingStream<GrpcStreamEvent>(
      'streamEvents',
      {
        queues: request?.queues ?? [],
        eventTypes: request?.eventTypes ?? [],
        jobId: request?.jobId ?? '',
        workflowId: request?.workflowId ?? '',
      },
      options,
      (raw) => {
        const event = fromProtoEvent(raw);
        return event.type === 'stream.keepalive' ? undefined : event;
      },
      { retryableStatusCodes: STREAM_EVENTS_RETRYABLE_STATUS_CODES },
    );
  }

  /**
   * Shared plumbing for `streamJobs()`/`streamEvents()`: builds the
   * signal composition, then delegates reconnect/backoff/cancellation to
   * `reconnectingServerStream`, whose `connect` callback performs this
   * transport's client/proto initialization (`ensureClient()`, same one
   * unary `call()` uses) as part of *every* connection attempt — the
   * initial one and every subsequent reconnect — not as a one-time,
   * separate bootstrap step before `reconnectingServerStream` even
   * exists. This is what lets an initialization failure or timeout be
   * classified and retried through the normal backoff/`maxAttempts`
   * machinery below exactly like any other transient stream error,
   * instead of a one-time bypass that would previously fail the whole
   * stream immediately on its very first attempt with zero retries no
   * matter how `reconnect` was configured (Finding: stream initialization
   * in reconnect engine). Once the client is initialized — the common
   * case for every attempt after the first successful one — that step
   * resolves near-instantly, so this adds no meaningful latency to a
   * healthy stream's reconnects.
   *
   * This is a plain method returning a hand-built `AsyncIterableIterator`
   * — deliberately **not** an `async *` generator itself. If it were, its
   * own `.return()`/`.throw()` (which is what a consuming `for await`'s
   * `break`/`return`/`throw` invokes) would be queued behind this
   * method's own currently-pending `.next()` step per the AsyncGenerator
   * spec, even though that step just delegates (`yield*`) to
   * `reconnectingServerStream`'s already-immediate cancellation. Building
   * the iterator by hand here lets `.return()`/`.throw()` reach the inner
   * `reconnectingServerStream` iterator's own immediate cancellation
   * without first waiting on anything — including a blocked/slow
   * `connect()` attempt, which is skipped entirely once cancellation has
   * been requested.
   */
  private openReconnectingStream<Mapped>(
    method: string,
    protoRequest: Record<string, unknown>,
    options: GrpcStreamOptions | undefined,
    map: (raw: unknown) => Mapped | undefined,
    privateOptions: GrpcStreamPrivateOptions,
  ): AsyncIterableIterator<Mapped> {
    this.ensureActiveGeneration();
    const transportSignal = this.streamAbortController.signal;

    // Defer signal composition until first next/throw/return so unused
    // iterators retain zero listeners (Finding 4).
    let signalComposition: { signal: AbortSignal; cleanup: () => void } | undefined;
    const iteratorAbortController = new AbortController();

    const getSignalComposition = (): { signal: AbortSignal; cleanup: () => void } => {
      if (!signalComposition) {
        const externalComposition = combineStreamSignals(
          transportSignal,
          options?.signal,
        );
        const iteratorComposition = combineStreamSignals(
          externalComposition.signal,
          iteratorAbortController.signal,
        );
        let cleaned = false;
        signalComposition = {
          signal: iteratorComposition.signal,
          cleanup: () => {
            if (cleaned) return;
            cleaned = true;
            iteratorComposition.cleanup();
            externalComposition.cleanup();
          },
        };
      }
      return signalComposition;
    };

    let inner: AsyncIterableIterator<Mapped> | undefined;
    let cancelledBeforeConnect = false;
    let finished = false;
    let nextChain: Promise<IteratorResult<Mapped, void>> = Promise.resolve({
      done: true,
      value: undefined,
    } as IteratorResult<Mapped, void>);

    const finish = (): void => {
      if (finished) return;
      finished = true;
      signalComposition?.cleanup();
    };

    /**
     * Performs one connection attempt's full sequence: bounds this
     * transport's client/proto initialization with `options.timeout` and
     * races it against `sc.signal` aborting (see
     * `ensureClientWithSetupTimeout`), then opens the requested
     * server-streaming RPC. Passed as `reconnectingServerStream`'s
     * `connect` below, so it runs on *every* attempt — not memoized here
     * the way `inner`/the stream itself is — while `ensureClient()`'s own
     * memoization (`this.initPromise`) still guarantees no duplicate
     * underlying channel/proto-load work happens across those repeated
     * calls, and `runReconnectingServerStream`'s strictly sequential loop
     * guarantees no two attempts (and so no two `connect()` calls, and no
     * two streams) are ever in flight at once for this iterator.
     */
    const connectAttempt = async (
      sc: { signal: AbortSignal },
    ): Promise<GrpcServerStreamCall> => {
      try {
        await this.ensureClientWithSetupTimeout(options?.timeout, sc.signal);
      } catch (error) {
        throw tagRetryableGrpcError(error);
      }
      if (sc.signal.aborted) {
        // A local abort during a blocked/slow initialization, not a real
        // initialization failure. `runReconnectingServerStream` already
        // treats *any* error as silent cancellation once its `signal` is
        // aborted (see its `if (signal?.aborted) return;` check), so the
        // exact error/type here is unobservable to a real caller — a
        // plain, clearly-labelled error just avoids a confusing "failed
        // to initialize" message for what is actually a deliberate stop.
        throw new OJSConnectionError(
          'gRPC stream cancelled during client initialization',
        );
      }

      const grpc = this.grpcModule;
      if (!grpc || !this.client) {
        throw tagRetryableGrpcError(
          new OJSConnectionError('gRPC client failed to initialize.'),
        );
      }
      return this.openServerStream(
        this.client,
        grpc,
        method,
        protoRequest,
        options?.streamDeadline,
        options?.metadata,
      );
    };

    /**
     * Creates the reconnecting stream on first use only (memoized:
     * concurrent initial next() calls share exactly one `inner`
     * instance — Finding 4). No async work is required before creating
     * it: `connectAttempt` above performs client/proto initialization
     * lazily, on its own, the first time `reconnectingServerStream`
     * actually invokes it.
     */
    const ensureInner = (): Promise<AsyncIterableIterator<Mapped> | undefined> => {
      if (inner) return Promise.resolve(inner);
      if (cancelledBeforeConnect) return Promise.resolve(undefined);

      const sc = getSignalComposition();
      if (sc.signal.aborted || cancelledBeforeConnect) {
        return Promise.resolve(undefined);
      }

      inner = reconnectingServerStream<unknown, Mapped>({
        connect: () => connectAttempt(sc),
        map,
        signal: sc.signal,
        reconnect: options?.reconnect,
        retryableStatusCodes: privateOptions.retryableStatusCodes,
        connectTimeoutMs: options?.timeout,
      });
      return Promise.resolve(inner);
    };

    const iterator: AsyncIterableIterator<Mapped> = {
      next: (): Promise<IteratorResult<Mapped, void>> => {
        // Serialize next operations to guarantee no duplicate messages (Finding 4).
        const prev = nextChain;
        const current = (async (): Promise<IteratorResult<Mapped, void>> => {
          await prev.catch(() => { /* serialization chain */ });
          if (finished) return { done: true, value: undefined };
          try {
            const stream = await ensureInner();
            if (!stream) {
              finish();
              return { done: true, value: undefined };
            }
            const result = await stream.next();
            if (result.done) finish();
            return result;
          } catch (error) {
            finish();
            throw error;
          }
        })();
        nextChain = current.catch(
          () =>
            ({ done: true, value: undefined }) as IteratorResult<Mapped, void>,
        );
        return current;
      },

      return: async (
        value?: void | PromiseLike<void>,
      ): Promise<IteratorResult<Mapped, void>> => {
        // Cancel shared init and prevent opening where possible (Finding 4).
        cancelledBeforeConnect = true;
        if (!iteratorAbortController.signal.aborted) {
          iteratorAbortController.abort(
            new OJSConnectionError(
              'gRPC stream iterator cancelled by consumer',
            ),
          );
        }
        try {
          const result = await inner?.return?.(value);
          return result ?? { done: true, value: undefined };
        } finally {
          finish();
        }
      },

      throw: async (err?: unknown): Promise<IteratorResult<Mapped, void>> => {
        cancelledBeforeConnect = true;
        if (!iteratorAbortController.signal.aborted) {
          iteratorAbortController.abort(
            new OJSConnectionError(
              'gRPC stream iterator cancelled by consumer',
            ),
          );
        }
        try {
          // Cancellation has already propagated synchronously through the
          // iterator-owned AbortController. Use return() only for cleanup;
          // passing the marker into the aborting inner iterator risks its
          // clean unwind swallowing that marker.
          await inner?.return?.();
        } catch {
          // Cleanup is best-effort; the public throw contract below wins.
        } finally {
          finish();
        }
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- AsyncIterator.throw accepts an arbitrary marker and must preserve it by identity.
        return Promise.reject(err);
      },

      [Symbol.asyncIterator](): AsyncIterableIterator<Mapped> {
        return iterator;
      },
    };

    return iterator;
  }

  /**
   * Starts one attempt at a server-streaming RPC (unlike `call()`, no
   * callback — the call object is the async-iterable stream itself).
   * Builds fresh metadata and, if a hard RPC-lifetime deadline is
   * explicitly requested for this attempt (`streamDeadline` — see
   * `GrpcStreamOptions.streamDeadline`), a fresh `Date.now() + streamDeadline`
   * deadline every time it runs, so each reconnect attempt gets its own
   * independent window rather than inheriting a stale one from an earlier
   * attempt. `GrpcStreamOptions.timeout` (the *setup*-only bound) is never
   * passed here — it is applied instead as `connectTimeoutMs` around this
   * method's caller in `grpc-stream.ts`'s `runReconnectingServerStream`,
   * which lets an already-open stream run past it indefinitely.
   */
  private openServerStream(
    client: GrpcServiceClient,
    grpc: GrpcModule,
    method: string,
    request: unknown,
    streamDeadline: number | undefined,
    extraMetadata: Record<string, string> | undefined,
  ): GrpcServerStreamCall {
    const metadata = new grpc.Metadata();
    const allMeta = this.createMetadata(extraMetadata);
    for (const [key, value] of Object.entries(allMeta)) {
      metadata.set(key, value);
    }

    const fn = resolveStreamMethod(client, method);
    const callOptions: { deadline?: Date } = {};
    if (streamDeadline !== undefined) {
      callOptions.deadline = new Date(Date.now() + streamDeadline);
    }
    return fn.call(client, request, metadata, callOptions);
  }

  /** Close the underlying gRPC channel. */
  close(): void {
    this.streamAbortController.abort(
      new OJSConnectionError('gRPC transport closed'),
    );
    this.generation++;

    const client = this.client;
    this.client = undefined;
    this.grpcModule = undefined;
    this.initPromise = null;
    client?.close();
  }
}

// --- Runtime narrowing for @grpc/proto-loader dynamic values ---
//
// @grpc/proto-loader decodes every protobuf message into a plain JS object
// at runtime; there is no compile-time schema, and — since these values
// cross a network boundary — nothing guarantees a response actually
// matches the shape the .proto file declares. The helpers below are the
// only place this module asserts "this dynamic value is at least an
// object" or "...an array" before reading named fields off it. Every
// individual field read remains `unknown` and is defaulted/coerced
// explicitly at its use site — the same defensive `?? <default>` style
// already used throughout this file — rather than trusted outright the
// way `any` would allow.

/** Narrows a proto-loader dynamic value to a plain, keyable object. */
function isProtoRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * As `isProtoRecord`, but defaults a non-object value to `{}` so callers
 * can keep reading optional fields off the result the same way they would
 * read optional fields off a real decoded message (every field access
 * below this point safely yields `undefined` instead of throwing).
 */
function asProtoRecord(value: unknown): Record<string, unknown> {
  return isProtoRecord(value) ? value : {};
}

/** Narrows a proto-loader `repeated` field to an array of dynamic values. */
function isProtoArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * As `isProtoArray`, but defaults a missing/malformed field to `[]`,
 * mirroring the zero-value `defaults: true` already fills in for
 * `repeated` fields that were never set on the wire.
 */
function asProtoArray(value: unknown): unknown[] {
  return isProtoArray(value) ? value : [];
}

/**
 * Returns `value` if it is a string, else `undefined`. Used to safely read
 * an enum field (decoded as its string name, since `enums: String` was
 * passed to `loadSync`) before using it as a lookup key.
 */
function asProtoString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Coerces a proto-loader integer-like field to a decimal string suitable
 * for `parseInt`. 64-bit integer fields (e.g. queue counters) are decoded
 * as strings since `longs: String` was passed to `loadSync`, but this
 * also accepts a raw number defensively (`parseInt` itself would happily
 * stringify one) and otherwise falls back to `'0'`, matching this
 * transport's existing `<field> ?? '0'` default for a missing counter.
 */
function asProtoIntegerString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '0';
}

// --- gRPC service constructor resolution ---

/** Constructor signature of the generated `OJSService` gRPC client class
 * produced by navigating `grpc.loadPackageDefinition()`'s output down to
 * `ojs.v1.OJSService`. */
type OJSServiceConstructor = new (address: string, credentials: unknown) => GrpcServiceClient;

/**
 * Navigates the dynamic package definition object returned by
 * `grpc.loadPackageDefinition()` down to `ojs.v1.OJSService` and confirms
 * it is at least a constructor function, throwing a clear
 * `OJSConnectionError` otherwise.
 *
 * `grpc.loadPackageDefinition` returns `unknown` in this file's local
 * `GrpcModule` type (see above) because its actual shape is fully
 * dynamic — driven entirely by whatever .proto packages were loaded at
 * runtime. This function is the one place that structure is asserted,
 * narrowed as far as JS actually lets us verify a dynamically-produced
 * constructor's shape: that it is callable with `new`. Verifying the
 * exact parameter/return types of a runtime-generated constructor is not
 * something any amount of static narrowing can prove; this is the honest
 * boundary of what's checkable, and it's covered by an explicit runtime
 * check rather than a silent cast.
 */
function resolveOJSServiceConstructor(packageDescriptor: unknown): OJSServiceConstructor {
  if (!isProtoRecord(packageDescriptor)) {
    throw new OJSConnectionError(
      'Malformed proto package definition: expected an object.',
    );
  }
  const ojsNamespace = packageDescriptor.ojs;
  if (!isProtoRecord(ojsNamespace)) {
    throw new OJSConnectionError(
      "Malformed proto package definition: missing 'ojs' package.",
    );
  }
  const v1Namespace = ojsNamespace.v1;
  if (!isProtoRecord(v1Namespace)) {
    throw new OJSConnectionError(
      "Malformed proto package definition: missing 'ojs.v1' package.",
    );
  }
  const OJSServiceCtor = v1Namespace.OJSService;
  if (typeof OJSServiceCtor !== 'function') {
    throw new OJSConnectionError(
      "Malformed proto package definition: 'ojs.v1.OJSService' is not a service constructor.",
    );
  }
  return OJSServiceCtor as OJSServiceConstructor;
}

/**
 * Resolves a named RPC on the dynamic client object as a server-streaming
 * method. `GrpcServiceClient`'s index signature types every method as
 * `GrpcUnaryMethod` for the unary `call()` path — but a server-streaming
 * method is actually shaped differently at runtime (no callback
 * parameter; returns the call object directly). The client object is
 * accepted here through a `Record<string, unknown>` parameter (structurally
 * satisfied by `GrpcServiceClient` without a cast, since every value type
 * is assignable to `unknown`) precisely so that distinction can be
 * checked honestly with a single runtime `typeof` guard — the same
 * approach `resolveOJSServiceConstructor` above takes for the service
 * constructor itself.
 */
function resolveStreamMethod(
  client: Record<string, unknown>,
  method: string,
): GrpcServerStreamMethod {
  const fn = client[method];
  if (typeof fn !== 'function') {
    throw new OJSError(`Unsupported gRPC method: ${method}`, 'unimplemented', {
      retryable: false,
    });
  }
  return fn as GrpcServerStreamMethod;
}

// --- Proto RPC request shapes ---
//
// These describe the gRPC request objects this transport builds
// client-side before sending, for the RPCs whose request is assembled
// incrementally (a field conditionally added after the initial object
// literal) rather than in a single literal. Field values stay `unknown`
// because they originate from the caller-supplied HTTP-shaped body (see
// the "Proto RPC response shapes" note below for why that's `unknown`
// too) — only the field *names* are asserted here, matching the
// corresponding message in job.proto / worker.proto / queue.proto.

interface EnqueueProtoRequest {
  type: unknown;
  args: unknown[];
  options?: Record<string, unknown>;
}

interface FetchProtoRequest {
  queues: unknown;
  count: unknown;
  workerId?: unknown;
}

interface AckProtoRequest {
  jobId: unknown;
  result?: unknown;
}

interface HeartbeatProtoRequest {
  id: string;
  workerId: string;
  currentState?: string;
}

interface ListDeadLetterProtoRequest {
  queue?: unknown;
  limit?: unknown;
}

interface RegisterCronProtoRequest {
  name: unknown;
  cron: unknown;
  type: unknown;
  args: unknown[];
  timezone?: unknown;
  options?: Record<string, unknown>;
}

// --- Proto RPC response shapes ---
//
// @grpc/proto-loader decodes each RPC's response message into a plain JS
// object (camelCase field names, since `keepCase: false` was passed to
// `loadSync` above). These interfaces document exactly which fields of
// each response message this transport reads — see service.proto,
// job.proto, worker.proto, queue.proto, and workflow.proto in ojs-proto
// for the authoritative message definitions. Every field is optional and
// `unknown`-typed: proto-loader's output is inherently dynamic, so field
// presence and type are always confirmed/defaulted at the point of use via
// the narrowing helpers above, never assumed from these interfaces alone.

/** Shared by EnqueueResponse, GetJobResponse, CancelJobResponse, and
 * RetryDeadLetterResponse, which each carry a single `Job job = 1`. */
interface JobRpcResponse {
  job?: unknown;
}

/** Shared by EnqueueBatchResponse and FetchResponse, which each carry a
 * single `repeated Job jobs = 1`. */
interface JobsRpcResponse {
  jobs?: unknown;
}

/** Shared by CreateWorkflowResponse and GetWorkflowResponse, which each
 * carry a single `Workflow workflow = 1`. */
interface WorkflowRpcResponse {
  workflow?: unknown;
}

interface AckRpcResponse {
  acknowledged?: unknown;
}

interface NackRpcResponse {
  state?: unknown;
  nextAttemptAt?: unknown;
}

interface HeartbeatRpcResponse {
  directedState?: unknown;
}

interface ListQueuesRpcResponse {
  queues?: unknown;
}

interface QueueStatsRpcResponse {
  queue?: unknown;
  stats?: unknown;
}

interface ListDeadLetterRpcResponse {
  jobs?: unknown;
  totalCount?: unknown;
}

interface ListCronRpcResponse {
  entries?: unknown;
}

interface RegisterCronRpcResponse {
  name?: unknown;
  nextRunAt?: unknown;
}

interface HealthRpcResponse {
  status?: unknown;
}

interface ManifestRpcResponse {
  ojsVersion?: unknown;
  implementation?: unknown;
  conformanceLevel?: unknown;
  protocols?: unknown;
  backend?: unknown;
  extensions?: unknown;
}

interface SaveCheckpointRpcResponse {
  sequence?: unknown;
}

interface GetCheckpointRpcResponse {
  jobId?: unknown;
  state?: unknown;
  sequence?: unknown;
  /**
   * `GetCheckpointResponse.saved_at` (service.proto) decodes as `savedAt`
   * — proto-loader was loaded with `keepCase: false` — and is a
   * `google.protobuf.Timestamp` (`{ seconds, nanos }`), not a plain
   * string. See `fromProtoTimestamp`, which normalizes it to the HTTP
   * binding's `created_at` RFC 3339 string shape
   * (checkpoint.schema.json's `checkpointResponse.created_at`).
   */
  savedAt?: unknown;
}

// --- Proto value conversion helpers ---

/**
 * Converts a JS value to a google.protobuf.Value-compatible object
 * for proto-loader's JSON representation.
 */
function toProtoValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return { nullValue: 0 };
  }
  if (typeof value === 'string') {
    return { stringValue: value };
  }
  if (typeof value === 'number') {
    return { numberValue: value };
  }
  if (typeof value === 'boolean') {
    return { boolValue: value };
  }
  if (Array.isArray(value)) {
    return { listValue: { values: value.map(toProtoValue) } };
  }
  if (typeof value === 'object') {
    // A plain `{}` here inherits `Object.prototype`, whose `__proto__`
    // accessor turns a computed assignment like `fields['__proto__'] = x`
    // into *reassigning this object's own prototype* instead of creating
    // a data property literally named `__proto__` — silently dropping
    // that key from the encoded Struct (or worse, corrupting `fields`'
    // prototype chain with attacker-controlled data) even though
    // `__proto__`/`constructor`/`prototype` are all perfectly valid JSON
    // object keys a real job's nested args can legitimately contain. A
    // null-prototype accumulator has no such accessor, so every key —
    // including those three — becomes a real, faithfully round-tripped
    // own data property.
    const fields: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      fields[k] = toProtoValue(v);
    }
    return { structValue: { fields } };
  }
  return { stringValue: String(value) };
}

/**
 * The proto-loader JSON shape of a `google.protobuf.Value`. This
 * transport's `loadSync()` passes both `oneofs: true` and `defaults: true`
 * (see the module-level config below): for a oneof group, that combination
 * synthesizes a virtual `kind` field naming exactly which single member is
 * actually set, and — verified empirically against a real
 * protobufjs/`@grpc/proto-loader` encode/decode round trip of this exact
 * `Value` message — leaves every *other* member key entirely absent
 * (`undefined`), rather than zero-filling them. `kind` is therefore the
 * only reliable discriminator for which case is active; the previously
 * present member keys are read only after switching on it.
 */
interface ProtoValueMessage {
  kind?: unknown;
  stringValue?: unknown;
  numberValue?: unknown;
  boolValue?: unknown;
  nullValue?: unknown;
  listValue?: unknown;
  structValue?: unknown;
}

/**
 * Converts a proto Value back to a JS value.
 *
 * Uses the `kind` oneof discriminator (see `ProtoValueMessage`) rather
 * than "is this field's value non-zero/non-empty" — the latter is wrong by
 * construction: a legitimately-set `0`, `false`, or `''` is
 * indistinguishable from "unset" under that heuristic, so it silently
 * decoded every one of those three real, on-the-wire values as `null`
 * instead of themselves. Falls back to plain field *presence* (still
 * correct — just less explicit than `kind` — never "non-zero") for a
 * decoded value that has no `kind` at all, e.g. a hand-constructed
 * payload from a decoder not configured with `oneofs: true`. A `kind`
 * that names something unrecognized (malformed data, or a newer wire
 * schema this decoder doesn't know about) fails safe to `null` rather
 * than guessing.
 */
function fromProtoValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    // Tolerate a bare primitive defensively; a real proto-loader Value
    // (oneofs:true) always decodes to the object shape handled below.
    return value;
  }
  if (!isProtoRecord(value)) return null;
  const v: ProtoValueMessage = value;
  const kind = typeof v.kind === 'string' ? v.kind : undefined;

  switch (kind) {
    case 'stringValue':
      return typeof v.stringValue === 'string' ? v.stringValue : '';
    case 'numberValue':
      return typeof v.numberValue === 'number' ? v.numberValue : 0;
    case 'boolValue':
      return typeof v.boolValue === 'boolean' ? v.boolValue : false;
    case 'nullValue':
      return null;
    case 'listValue': {
      const listValue = asProtoRecord(v.listValue);
      return asProtoArray(listValue.values).map(fromProtoValue);
    }
    case 'structValue':
      return fromProtoStruct(v.structValue);
    case undefined:
      // No `kind` discriminator present at all — fall through to the
      // presence-based fallback below rather than assuming "unset".
      break;
    default:
      return null;
  }

  // Fallback for a decoded Value without a `kind` discriminator. Field
  // *presence*, not "is it non-zero", is the correct signal here too —
  // this intentionally differs from (and fixes) the original zero-value
  // exclusion heuristic.
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.numberValue !== undefined) return v.numberValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.nullValue !== undefined) return null;
  if (v.listValue !== undefined) {
    const listValue = asProtoRecord(v.listValue);
    return asProtoArray(listValue.values).map(fromProtoValue);
  }
  if (v.structValue !== undefined) return fromProtoStruct(v.structValue);
  return null;
}

/**
 * Describes the caller-facing context (a human label and the concrete
 * protobuf field) a `toProtoStruct` conversion is happening in, so the
 * rejection message for an unrepresentable non-object value names the
 * exact wire field the caller was trying to fill rather than always
 * blaming checkpoint state.
 */
interface ProtoStructContext {
  /** Human-readable description of the value, e.g. `'checkpoint state'`. */
  label: string;
  /** The protobuf field carrying it, e.g. `'SaveCheckpointRequest.state'`. */
  wireField: string;
}

const CHECKPOINT_STRUCT_CONTEXT: ProtoStructContext = {
  label: 'checkpoint state',
  wireField: 'SaveCheckpointRequest.state',
};

const NACK_DETAILS_STRUCT_CONTEXT: ProtoStructContext = {
  label: 'nack error details',
  wireField: 'NackRequest.error.details',
};

/**
 * Applies JSON.stringify/JSON.parse semantics before checkpoint state enters
 * protobuf Struct conversion. This intentionally honors `toJSON()` (including
 * Date's ISO conversion), omits undefined object fields, and turns undefined
 * array entries/holes into null. Values JSON would otherwise silently degrade
 * (`NaN`/infinities) or discard (`function`/`symbol`) are rejected explicitly,
 * as are BigInt and cyclic/unserializable graphs.
 */
function normalizeCheckpointJson(state: unknown): Record<string, unknown> {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(state, (_key, value: unknown) => {
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new OJSValidationError(
          'gRPC checkpoint state must not contain non-finite numbers.',
        );
      }
      if (typeof value === 'bigint') {
        throw new OJSValidationError(
          'gRPC checkpoint state must not contain BigInt values.',
        );
      }
      if (typeof value === 'function' || typeof value === 'symbol') {
        throw new OJSValidationError(
          `gRPC checkpoint state must not contain unsupported ${typeof value} values.`,
        );
      }
      return value;
    });
  } catch (error) {
    if (error instanceof OJSValidationError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const reason = /circular|cyclic/iu.test(message)
      ? 'must not contain cycles'
      : `could not be serialized as JSON: ${message}`;
    throw new OJSValidationError(`gRPC checkpoint state ${reason}.`);
  }

  if (encoded === undefined) {
    throw new OJSValidationError(
      'gRPC checkpoint state must be a JSON object after JSON normalization.',
    );
  }

  const normalized = JSON.parse(encoded) as unknown;
  if (!isProtoRecord(normalized)) {
    throw new OJSValidationError(
      'gRPC checkpoint state must be a JSON object after JSON normalization: ' +
        'google.protobuf.Struct cannot represent a bare scalar or array.',
    );
  }
  return normalized;
}

/**
 * Reports whether `value` can be faithfully represented as a
 * `google.protobuf.Struct` (a JSON object/map) — `null` counts as
 * "no value" at call sites, not as a representable Struct, so it is
 * intentionally excluded here and handled by the caller instead.
 */
function isProtoStructRepresentable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A short, stable label for the JS type of an unrepresentable ack result,
 * used in `GrpcProtocolWarning.originalResultType`. Arrays are labelled
 * `'array'` (not `'object'`) since `Array.isArray` is the more useful
 * signal for a caller deciding what changed about their result.
 */
function protoResultTypeLabel(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Converts a plain JS object to a `google.protobuf.Struct`-compatible
 * object (`{ fields: { [key]: Value } }`). Unlike `toProtoValue`, this
 * produces a bare Struct, not a Value that wraps one — `Struct` fields on
 * the wire (e.g. SaveCheckpointRequest.state, AckRequest.result) do not
 * have the extra `structValue` envelope.
 *
 * A bare scalar or array is rejected with a non-retryable
 * `OJSValidationError` (rather than silently encoded as an empty Struct):
 * `google.protobuf.Struct` can only model a JSON object/map, so there is
 * no faithful wire representation for a scalar/array here. The message
 * names `context.label`/`context.wireField` so each call site (checkpoint
 * state, ack result) produces an actionable, correctly-attributed error.
 */
function toProtoStruct(
  state: unknown,
  context: ProtoStructContext = CHECKPOINT_STRUCT_CONTEXT,
): { fields: Record<string, unknown> } {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) {
    throw new OJSValidationError(
      `gRPC ${context.label} must be a JSON object: google.protobuf.Struct ` +
        `(the wire type of ${context.wireField}) cannot represent a bare ` +
        'scalar or array. The HTTP binding is less restrictive.',
    );
  }
  // Null-prototype accumulator — see `toProtoValue`'s doc comment on the
  // identical pattern for why a plain `{}` here would silently mishandle
  // a `__proto__` key in caller-supplied checkpoint state/ack results.
  const fields: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const [k, v] of Object.entries(state as Record<string, unknown>)) {
    fields[k] = toProtoValue(v);
  }
  return { fields };
}

/** Converts a `google.protobuf.Struct` back to a plain JS object. */
function fromProtoStruct(struct: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const fields = asProtoRecord(asProtoRecord(struct).fields);
  for (const [k, v] of Object.entries(fields)) {
    Object.defineProperty(result, k, {
      value: fromProtoValue(v),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

/**
 * Converts a decoded `google.protobuf.Timestamp` to an RFC 3339 string.
 * Unlike `google.protobuf.Struct`/`Value`, protobufjs has no JSON-mapping
 * wrapper for the well-known `Timestamp` type, so proto-loader decodes it
 * as a plain `{ seconds, nanos }` message — `seconds` as a decimal string
 * (since `longs: String` was passed to `loadSync`) and `nanos` as a
 * number — rather than an ISO string. Returns `null` for an
 * unset/malformed timestamp (proto-loader yields `null` for an omitted
 * singular message field with `defaults: true`), matching this
 * transport's existing `<field> ?? null` convention for optional values.
 */
function fromProtoTimestamp(value: unknown): string | null {
  if (!isProtoRecord(value)) return null;
  const secondsRaw = value.seconds;
  if (
    (typeof secondsRaw !== 'string' && typeof secondsRaw !== 'number') ||
    (typeof secondsRaw === 'string' && !/^-?\d+$/.test(secondsRaw))
  ) {
    return null;
  }

  const seconds = Number(secondsRaw);
  if (!Number.isSafeInteger(seconds)) return null;

  const nanosRaw = value.nanos ?? 0;
  if (
    typeof nanosRaw !== 'number' ||
    !Number.isSafeInteger(nanosRaw) ||
    nanosRaw < 0 ||
    nanosRaw > 999_999_999
  ) {
    return null;
  }
  const nanos = nanosRaw;
  // Normative exception, not a defensive/malformed-input fallback: per
  // ojs-protobuf-format.md section 6.2 ("Default Value Handling"), "An
  // unset timestamp is represented as `null` / zero value (`seconds: 0,
  // nanos: 0`). Implementations MUST NOT interpret the Protobuf epoch
  // (1970-01-01T00:00:00Z) as a valid OJS timestamp." The exact zero
  // value is therefore always treated as "unset" and mapped to `null`
  // here, deliberately never returning the literal epoch instant
  // '1970-01-01T00:00:00.000Z' — even though that epoch second is
  // otherwise a perfectly representable, in-range `Date`. A genuinely
  // intended epoch-second timestamp with any nonzero `nanos` (e.g.
  // `{ seconds: 0, nanos: 1_000_000 }`) is unaffected by this rule and
  // still decodes normally below.
  if (seconds === 0 && nanos === 0) return null;

  // ECMAScript Date's TimeClip range is exactly ±8.64e15 milliseconds.
  // Check the second/nanosecond boundary separately so sub-millisecond
  // nanos above the positive maximum cannot round back down into range.
  const minDateMilliseconds = -8_640_000_000_000_000;
  const maxDateMilliseconds = 8_640_000_000_000_000;
  const minDateSeconds = minDateMilliseconds / 1000;
  const maxDateSeconds = maxDateMilliseconds / 1000;
  if (
    seconds < minDateSeconds ||
    seconds > maxDateSeconds ||
    (seconds === maxDateSeconds && nanos > 0)
  ) {
    return null;
  }

  // Apply Date's integer-millisecond TimeClip semantics without first
  // adding a fractional value to a large epoch number, which could round
  // 999.999999ms up to the next second in IEEE-754 arithmetic.
  const fractionalMilliseconds = nanos / 1_000_000;
  const millisecondOffset = seconds < 0
    ? Math.ceil(fractionalMilliseconds)
    : Math.floor(fractionalMilliseconds);
  const milliseconds = seconds * 1000 + millisecondOffset;
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < minDateMilliseconds ||
    milliseconds > maxDateMilliseconds
  ) {
    return null;
  }

  try {
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  } catch {
    return null;
  }
}

interface ProtoDuration {
  seconds: number;
  nanos: number;
}

function readProtoDuration(value: unknown): ProtoDuration | undefined {
  if (!isProtoRecord(value)) return undefined;
  const secondsRaw = value.seconds;
  const seconds =
    typeof secondsRaw === 'string'
      ? Number(secondsRaw)
      : typeof secondsRaw === 'number'
        ? secondsRaw
        : NaN;
  const nanos = typeof value.nanos === 'number' ? value.nanos : 0;
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) return undefined;
  return { seconds, nanos };
}

/** Converts a protobuf Duration to the HTTP binding's millisecond value. */
function fromProtoDurationMs(value: unknown): number | null {
  const duration = readProtoDuration(value);
  return duration
    ? duration.seconds * 1000 + duration.nanos / 1_000_000
    : null;
}

/** Converts a protobuf Duration to the SDK policy shape's ISO 8601 value.
 *
 * Uses integer/string arithmetic to avoid floating-point exponential notation
 * and rounding errors. Per protobuf normalization, sign is on seconds (nanos
 * shares sign with seconds, or is zero when seconds is zero). Fractional
 * seconds are rendered as fixed 9-digit nanos trimmed of trailing zeros.
 */
function fromProtoDuration(value: unknown): string | undefined {
  if (!isProtoRecord(value)) return undefined;
  const secondsRaw = value.seconds;
  let seconds: bigint;
  try {
    if (typeof secondsRaw === 'string' && /^-?\d+$/.test(secondsRaw)) {
      seconds = BigInt(secondsRaw);
    } else if (typeof secondsRaw === 'number' && Number.isSafeInteger(secondsRaw)) {
      seconds = BigInt(secondsRaw);
    } else {
      return undefined;
    }
  } catch {
    return undefined;
  }
  let nanos = typeof value.nanos === 'number' ? value.nanos : 0;
  if (!Number.isInteger(nanos) || Math.abs(nanos) > 999_999_999) return undefined;

  // Protobuf normalization: nanos shares sign with seconds.
  // Normalize to absolute values with a leading sign.
  const negative = seconds < 0n || (seconds === 0n && nanos < 0);
  if (negative) {
    seconds = -seconds;
    nanos = -nanos;
  }

  const days = seconds / 86_400n;
  const remainAfterDays = seconds % 86_400n;
  const hours = remainAfterDays / 3_600n;
  const remainAfterHours = remainAfterDays % 3_600n;
  const minutes = remainAfterHours / 60n;
  const wholeSec = remainAfterHours % 60n;

  // Render fractional part from nanos using string arithmetic (never exponential).
  let fracStr = '';
  if (nanos > 0) {
    // Fixed 9 digits, trimmed on right.
    const raw = String(nanos).padStart(9, '0');
    fracStr = '.' + raw.replace(/0+$/, '');
  }

  const sign = negative ? '-' : '';
  let result = `${sign}P`;
  if (days > 0n) result += `${days}D`;
  if (hours > 0n || minutes > 0n || wholeSec > 0n || nanos > 0 || days === 0n) {
    result += 'T';
    if (hours > 0n) result += `${hours}H`;
    if (minutes > 0n) result += `${minutes}M`;
    if (wholeSec > 0n || nanos > 0 || (hours === 0n && minutes === 0n)) {
      result += `${wholeSec}${fracStr}S`;
    }
  }
  return result;
}

/**
 * Decodes a proto `RetryPolicy` message into the SDK's HTTP-wire retry
 * shape. Returns `undefined` only when the *message itself* is absent
 * (proto-loader's `defaults: true` decodes an unset singular message
 * field to `null`) — in that case every field below legitimately falls
 * back to the protocol's authoritative retry defaults (ojs-retry.md
 * section 8: `3`/`PT1S`/`2.0`/`PT5M`/`true`/`[]`/`'discard'`), since there
 * genuinely is no policy to decode.
 *
 * Once the message *is* present, this function draws a careful line
 * between two different kinds of "zero-valued" fields:
 *
 *   - `max_attempts` and `jitter` are trusted exactly as decoded,
 *     including `0`/`false`. Both are meaningful, explicit, valid
 *     protocol values in their own right (ojs-retry.md section 2.2:
 *     `max_attempts: 0` means "never retry, fail immediately on the
 *     first attempt"; `jitter: false` deliberately disables jitter) — not
 *     evidence the field was merely never set. proto3 gives a singular,
 *     non-`optional` scalar field (as both are declared in job.proto) no
 *     wire presence of its own: an explicitly encoded `0`/`false` and an
 *     entirely omitted field both decode to the identical `0`/`false`
 *     with proto-loader's `defaults: true`, and this SDK cannot
 *     distinguish them from the scalar value alone. Given the *message*
 *     itself is confirmed present here, this function resolves that
 *     unavoidable proto3 ambiguity by trusting what the server actually
 *     sent rather than guessing it must mean absence — the opposite
 *     choice would silently rewrite an explicit "don't retry"/"no
 *     jitter" policy into the default "retry 3 times"/"jitter on",
 *     exactly the kind of silent correctness bug this SDK's retry
 *     handling must never introduce. A backend that truly wants the
 *     default `3`/`true` MUST send it explicitly — which proto-loader/
 *     grpc-js already does for any message built from the OJS default
 *     policy.
 *   - `backoff_coefficient` and `on_exhaustion`, by contrast, have no
 *     valid zero/empty value at all (a `< 1` multiplicative backoff
 *     coefficient and an empty exhaustion-action string are not
 *     legitimate policy choices under any circumstance — see
 *     `buildProtoRetryPolicy`'s own `>= 1` / enum validation on the
 *     encode side), so a decoded `0`/`''` unambiguously means "not
 *     meaningfully set" and safely defaults. Duration sub-messages
 *     (`initial_interval`/`max_interval`) retain proto3 message
 *     presence, so an explicitly present `PT0S` remains `PT0S`; only an
 *     absent/null Duration message receives the protocol default.
 */
function fromProtoRetryPolicy(value: unknown): Record<string, unknown> | undefined {
  if (!isProtoRecord(value)) return undefined;

  const initialInterval =
    fromProtoDuration(value.initialInterval) ??
    DEFAULT_RETRY_POLICY.initial_interval;
  const maxInterval =
    fromProtoDuration(value.maxInterval) ??
    DEFAULT_RETRY_POLICY.max_interval;
  const nonRetryableErrors = asProtoArray(value.nonRetryableErrors).filter(
    (entry): entry is string => typeof entry === 'string',
  );
  const onExhaustion =
    value.onExhaustion === 'discard' || value.onExhaustion === 'dead_letter'
      ? value.onExhaustion
      : DEFAULT_RETRY_POLICY.on_exhaustion;

  return {
    max_attempts:
      typeof value.maxAttempts === 'number'
        ? value.maxAttempts
        : DEFAULT_RETRY_POLICY.max_attempts,
    initial_interval: initialInterval,
    backoff_coefficient:
      typeof value.backoffCoefficient === 'number' &&
      value.backoffCoefficient >= 1
        ? value.backoffCoefficient
        : DEFAULT_RETRY_POLICY.backoff_coefficient,
    max_interval: maxInterval,
    jitter:
      typeof value.jitter === 'boolean' ? value.jitter : DEFAULT_RETRY_POLICY.jitter,
    non_retryable_errors: nonRetryableErrors,
    on_exhaustion: onExhaustion,
  };
}

function mapUniqueConflictAction(value: unknown): string {
  const byName: Record<string, string> = {
    UNIQUE_CONFLICT_ACTION_UNSPECIFIED: 'reject',
    UNIQUE_CONFLICT_ACTION_REJECT: 'reject',
    UNIQUE_CONFLICT_ACTION_REPLACE: 'replace',
    UNIQUE_CONFLICT_ACTION_IGNORE: 'ignore',
    UNIQUE_CONFLICT_ACTION_REPLACE_EXCEPT_SCHEDULE: 'replace_except_schedule',
  };
  const byNumber: Record<number, string> = {
    0: 'reject',
    1: 'reject',
    2: 'replace',
    3: 'ignore',
    4: 'replace_except_schedule',
  };
  if (typeof value === 'string') {
    return byName[value] ?? value.toLowerCase().replace('unique_conflict_action_', '');
  }
  return typeof value === 'number' ? byNumber[value] ?? 'reject' : 'reject';
}

function fromProtoUniquePolicy(value: unknown): Record<string, unknown> | undefined {
  if (!isProtoRecord(value)) return undefined;
  return {
    keys: asProtoArray(value.key),
    period: fromProtoDuration(value.period),
    on_conflict: mapUniqueConflictAction(value.onConflict),
    states: asProtoArray(value.states).map(mapJobState),
    args_keys: asProtoArray(value.argsKeys),
    meta_keys: asProtoArray(value.metaKeys),
  };
}

/**
 * Inverse of `buildProtoEnqueueOptions`: converts a decoded proto
 * `EnqueueOptions` message back into the SDK's HTTP-wire options shape
 * (`queue`/`priority`/`delay_until`/`timeout_ms`/`retry`/`unique`/`tags`/
 * `trace_id`/`max_attempts`/`visibility_timeout_ms`/`meta`). Cron decoding
 * moves `meta` back to the cron resource's top level, matching the HTTP
 * schema. Returns `undefined` when nothing meaningful is set.
 *
 * With proto-loader's `defaults: true`, unset singular *message* fields
 * (`delayUntil`/`timeout`/`retry`/`unique`/`visibilityTimeout`/`meta`)
 * decode to `null`, so they are naturally skipped by the presence checks
 * below; unset *scalar* fields zero-fill, so those are included only when
 * they carry a non-default value to avoid emitting noise for every listed
 * cron entry. The relative `ttl` Duration has no absolute HTTP-wire field
 * (its inverse would need a "now" reference), so it is intentionally not
 * reconstructed here.
 */
function fromProtoEnqueueOptions(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isProtoRecord(value)) return undefined;
  const options: Record<string, unknown> = {};

  if (typeof value.queue === 'string' && value.queue.length > 0) {
    options.queue = value.queue;
  }
  if (typeof value.priority === 'number' && value.priority !== 0) {
    options.priority = value.priority;
  }
  const delayUntil = fromProtoTimestamp(value.delayUntil);
  if (delayUntil !== null) options.delay_until = delayUntil;
  const timeoutMs = fromProtoDurationMs(value.timeout);
  if (timeoutMs !== null) options.timeout_ms = timeoutMs;
  const retry = fromProtoRetryPolicy(value.retry);
  if (retry) options.retry = retry;
  const unique = fromProtoUniquePolicy(value.unique);
  if (unique) options.unique = unique;
  const tags = asProtoArray(value.tags);
  if (tags.length > 0) options.tags = tags;
  if (typeof value.traceId === 'string' && value.traceId.length > 0) {
    options.trace_id = value.traceId;
  }
  if (typeof value.maxAttempts === 'number' && value.maxAttempts !== 0) {
    options.max_attempts = value.maxAttempts;
  }
  const visibilityMs = fromProtoDurationMs(value.visibilityTimeout);
  if (visibilityMs !== null) options.visibility_timeout_ms = visibilityMs;
  if (isProtoRecord(value.meta)) {
    options.meta = fromProtoStruct(value.meta);
  }

  return Object.keys(options).length > 0 ? options : undefined;
}

/**
 * Decodes one proto `CronEntry` (service.proto) into the SDK's
 * `CronJobInfo` HTTP-wire shape. Shared by `grpcListCron` (decoding every
 * listed entry) and `grpcRegisterCron`'s best-effort authoritative
 * follow-up lookup (finding the just-registered entry by name).
 */
function fromProtoCronEntry(raw: unknown): Record<string, unknown> {
  const e = asProtoRecord(raw);
  const entry: Record<string, unknown> = {
    name: e.name,
    cron: e.cron,
    timezone: e.timezone,
    type: e.type,
    args: asProtoArray(e.args).map(fromProtoValue),
    // CronEntry has no paused/disabled state and only registered schedules
    // can appear in ListCron, so active is semantically certain.
    status: 'active',
  };
  const decodedOptions = fromProtoEnqueueOptions(e.options);
  if (decodedOptions) {
    const { meta, ...options } = decodedOptions;
    if (isProtoRecord(meta)) entry.meta = meta;
    if (Object.keys(options).length > 0) entry.options = options;
  }
  const nextRunAt = fromProtoTimestamp(e.nextRunAt);
  if (nextRunAt !== null) entry.next_run_at = nextRunAt;
  const lastRunAt = fromProtoTimestamp(e.lastRunAt);
  if (lastRunAt !== null) entry.last_run_at = lastRunAt;
  return entry;
}

/** Default page/per_page for gRPC-side `ListCron` pagination — the RPC
 * itself carries none (see `parseCronListPagination`). Matches
 * `CronOperations.list()`'s and the HTTP binding's documented defaults. */
const CRON_LIST_DEFAULT_PAGE = 1;
const CRON_LIST_DEFAULT_PER_PAGE = 25;

/**
 * Parses and validates `page`/`per_page` out of the HTTP-style query
 * string `CronOperations.list()` sends (e.g. `'page=2&per_page=10'`),
 * defaulting to page 1 / 25 per page when absent. A *present* value that
 * is not a positive integer is rejected with a non-retryable
 * `OJSValidationError` rather than silently coerced (`Number('abc')` is
 * `NaN`, a negative/zero page would slice nonsensically, etc.) — the
 * caller passed something no server should honor either.
 */
function parseCronListPagination(queryString: string): { page: number; perPage: number } {
  const params = new URLSearchParams(queryString);
  return {
    page: parsePositiveIntQueryParam(params, 'page', CRON_LIST_DEFAULT_PAGE),
    perPage: parsePositiveIntQueryParam(params, 'per_page', CRON_LIST_DEFAULT_PER_PAGE),
  };
}

function parsePositiveIntQueryParam(
  params: URLSearchParams,
  name: string,
  fallback: number,
): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) {
    throw new OJSValidationError(
      `gRPC cron listing: query parameter '${name}' must be a positive integer, got '${raw}'.`,
    );
  }
  return Number(raw);
}

function fromProtoJsonValue(value: unknown): unknown {
  return isProtoRecord(value) && 'fields' in value
    ? fromProtoStruct(value)
    : fromProtoValue(value);
}

function fromProtoJobError(value: unknown): Record<string, unknown> {
  const error = asProtoRecord(value);
  return {
    code: typeof error.code === 'string' ? error.code : '',
    message: typeof error.message === 'string' ? error.message : '',
    retryable: typeof error.retryable === 'boolean' ? error.retryable : false,
    attempt: typeof error.attempt === 'number' ? error.attempt : 0,
    occurred_at: fromProtoTimestamp(error.occurredAt),
    backtrace:
      typeof error.backtrace === 'string' && error.backtrace.length > 0
        ? error.backtrace.split(/\r?\n/u)
        : [],
    details: fromProtoStruct(error.details),
  };
}

/** Maps a proto Job to the JSON format expected by the SDK. */
function fromProtoJob(job: unknown): Record<string, unknown> {
  if (!job) return {};
  const j = asProtoRecord(job);
  const errors = asProtoArray(j.errors).map(fromProtoJobError);
  const explicitError = isProtoRecord(j.error)
    ? fromProtoJobError(j.error)
    : undefined;
  const error = explicitError ?? errors.at(-1) ?? null;

  return {
    specversion: typeof j.specversion === 'string' && j.specversion
      ? j.specversion
      : '1.0',
    id: typeof j.id === 'string' ? j.id : '',
    type: typeof j.type === 'string' ? j.type : '',
    queue: typeof j.queue === 'string' && j.queue ? j.queue : 'default',
    args: asProtoArray(j.args).map(fromProtoValue),
    meta: fromProtoStruct(j.meta),
    state: mapJobState(j.state),
    priority: typeof j.priority === 'number' ? j.priority : 0,
    attempt: typeof j.attempt === 'number' ? j.attempt : 0,
    max_attempts: typeof j.maxAttempts === 'number' ? j.maxAttempts : 0,
    retry: fromProtoRetryPolicy(j.retryPolicy),
    unique: fromProtoUniquePolicy(j.uniquePolicy),
    result: j.result === null || j.result === undefined
      ? null
      : fromProtoJsonValue(j.result),
    error,
    errors,
    created_at: fromProtoTimestamp(j.createdAt),
    enqueued_at: fromProtoTimestamp(j.enqueuedAt),
    scheduled_at: fromProtoTimestamp(j.scheduledAt),
    started_at: fromProtoTimestamp(j.startedAt),
    completed_at: fromProtoTimestamp(j.completedAt),
    expires_at: fromProtoTimestamp(j.expiresAt),
    timeout: fromProtoDurationMs(j.timeout),
    visibility_timeout: fromProtoDurationMs(j.visibilityTimeout),
    tags: asProtoArray(j.tags),
    trace_id: typeof j.traceId === 'string' ? j.traceId : '',
    workflow_id: typeof j.workflowId === 'string' ? j.workflowId : '',
    parent_id: typeof j.parentId === 'string' ? j.parentId : '',
    root_id: typeof j.rootId === 'string' ? j.rootId : '',
    caused_by: typeof j.causedBy === 'string' ? j.causedBy : '',
    schema: typeof j.schema === 'string' ? j.schema : '',
  };
}

/**
 * Narrows `fromProtoJob()`'s dynamically-typed output into the SDK's
 * public `Job` shape, for `GrpcTransport.streamJobs()`'s public API —
 * the same normalized job data unary `fetch()` returns (both go through
 * `fromProtoJob`), just with the required fields' *types* pinned down
 * (every field is read as `unknown` off the dynamic proto object, since
 * proto-loader's output has no compile-time schema; see the "Runtime
 * narrowing" note below). No field mapping is duplicated here.
 */
function toJobData(raw: Record<string, unknown>): Job {
  return {
    ...raw,
    specversion: typeof raw.specversion === 'string' ? raw.specversion : '1.0',
    id: typeof raw.id === 'string' ? raw.id : '',
    type: typeof raw.type === 'string' ? raw.type : '',
    queue: typeof raw.queue === 'string' ? raw.queue : 'default',
    args: Array.isArray(raw.args) ? (raw.args as JsonValue[]) : [],
  };
}

/**
 * Maps a proto `Event` (events.proto) to the exported `GrpcStreamEvent`
 * shape, preserving the gRPC binding's own wire field naming
 * (`job_id`/`job_type`/`workflow_id`, snake_case) — see `GrpcStreamEvent`'s
 * own doc comment for why this is deliberately not the CloudEvents-style
 * envelope `OJSEventEmitter` uses.
 */
function fromProtoEvent(raw: unknown): GrpcStreamEvent {
  const e = asProtoRecord(raw);
  const event: GrpcStreamEvent = {
    id: typeof e.id === 'string' ? e.id : '',
    type: typeof e.type === 'string' ? e.type : '',
  };
  if (typeof e.jobId === 'string' && e.jobId) event.job_id = e.jobId;
  if (typeof e.jobType === 'string' && e.jobType) event.job_type = e.jobType;
  if (typeof e.queue === 'string' && e.queue) event.queue = e.queue;
  const timestamp = fromProtoTimestamp(e.timestamp);
  if (timestamp) event.timestamp = timestamp;
  if (isProtoRecord(e.data)) event.data = fromProtoStruct(e.data);
  if (typeof e.workflowId === 'string' && e.workflowId) event.workflow_id = e.workflowId;
  return event;
}

/**
 * Maps a proto Workflow to the JSON format.
 *
 * `typeHint` is authoritative when available: it is either the primitive
 * submitted to `createWorkflow()` or the same-instance creation-time cache
 * entry. Without a hint, a multi-step DAG is classified only when it is a
 * strict linear chain or entirely edge-free group. One-step and arbitrary
 * DAGs omit the optional public `WorkflowStatus.type`.
 */
function fromProtoWorkflow(
  workflow: unknown,
  typeHint?: 'chain' | 'group' | 'batch',
): Record<string, unknown> {
  const w = asProtoRecord(workflow);
  const stateMap: Record<string, string> = {
    WORKFLOW_STATE_PENDING: 'pending',
    WORKFLOW_STATE_RUNNING: 'running',
    WORKFLOW_STATE_COMPLETED: 'completed',
    WORKFLOW_STATE_FAILED: 'failed',
    WORKFLOW_STATE_CANCELLED: 'cancelled',
  };
  const steps = asProtoArray(w.steps).map((raw, index) => {
    const s = asProtoRecord(raw);
    return {
      index,
      id: typeof s.id === 'string' ? s.id : '',
      type: typeof s.type === 'string' ? s.type : '',
      state: mapStepState(s.state),
      job_id:
        typeof s.jobId === 'string' && s.jobId.length > 0 ? s.jobId : null,
      depends_on: asProtoArray(s.dependsOn).filter(
        (dependency): dependency is string => typeof dependency === 'string',
      ),
    };
  });
  const workflowType = typeHint ?? inferWorkflowType(steps);
  const createdAt = fromProtoTimestamp(w.createdAt) ?? '';
  const completedAt = fromProtoTimestamp(w.completedAt);
  const metadata: Record<string, unknown> = {
    created_at: createdAt,
    job_count: steps.length,
    completed_count: steps.filter((step) => step.state === 'completed').length,
    failed_count: steps.filter((step) => step.state === 'failed').length,
  };
  if (completedAt !== null) metadata.completed_at = completedAt;

  return {
    id: typeof w.id === 'string' ? w.id : '',
    name: typeof w.name === 'string' ? w.name : '',
    ...(workflowType === undefined ? {} : { type: workflowType }),
    state: stateMap[asProtoString(w.state) ?? ''] ?? 'running',
    metadata,
    steps,
  };
}

function inferWorkflowType(
  steps: { id: string; depends_on: string[] }[],
): 'chain' | 'group' | undefined {
  if (steps.length < 2) return undefined;

  const ids = new Set<string>();
  for (const step of steps) {
    if (!step.id || ids.has(step.id)) return undefined;
    ids.add(step.id);
  }

  if (steps.every((step) => step.depends_on.length === 0)) {
    return 'group';
  }

  if (steps[0]!.depends_on.length !== 0) return undefined;

  for (let index = 1; index < steps.length; index++) {
    const dependencies = steps[index]!.depends_on;
    if (
      dependencies.length !== 1 ||
      dependencies[0] !== steps[index - 1]!.id
    ) {
      return undefined;
    }
  }
  return 'chain';
}

function asWorkflowType(value: unknown): 'chain' | 'group' | 'batch' | undefined {
  return value === 'chain' || value === 'group' || value === 'batch'
    ? value
    : undefined;
}

// --- Workflow: public wire shape -> proto CreateWorkflowRequest DAG ---
//
// The public builders (`chain()`/`group()`/`batch()` in src/workflow.ts,
// serialized by `toWireWorkflow()`) produce a *nested* wire tree:
//   chain -> { type: 'chain', name?, steps: [ element, ... ] }
//   group -> { type: 'group', name?, jobs:  [ element, ... ] }
//   batch -> { type: 'batch', name?, jobs, callbacks }
// where each element is either a job wire step
// (`{ type, args, meta?, schema?, options? }`) or a nested chain/group/batch.
//
// `CreateWorkflowRequest` (workflow.proto), by contrast, is a *flat* DAG:
// `repeated WorkflowStep steps`, each with a stable `id`, an explicit
// `depends_on` list, `args`, and per-step `options` (an `EnqueueOptions`).
// The previous mapper read a non-existent top-level `body.steps` and echoed
// each step's own `id`/`depends_on` verbatim, so it produced no steps at all
// for a `group` (whose elements live under `jobs`), never generated the step
// IDs/dependencies the public builders don't carry, and silently dropped
// every step option. The converter below flattens the nested tree into the
// proto DAG deterministically instead.
//
// Flattening rules (standard workflow-primitive DAG semantics):
//   - job:   one WorkflowStep depending on its incoming set; it is both the
//            single entry and single exit of its subtree.
//   - chain: elements run sequentially — element i+1 depends on the *exit*
//            nodes of element i; the chain's entry is element 0's entry and
//            its exit is the last element's exit.
//   - group: elements run in parallel — every element shares the group's
//            incoming set; the group's exit is the union of its elements'
//            exits.
//   - batch: unrepresentable (see `workflowBatchUnimplemented`).

interface WorkflowFlattenState {
  steps: Record<string, unknown>[];
}

/** Deterministic, stable step ID from a positional path, e.g. `[1,0]` ->
 * `'step-1-0'`. The same input workflow always yields the same IDs. */
function workflowStepId(path: number[]): string {
  return path.length === 0 ? 'step-root' : `step-${path.join('-')}`;
}

/** Non-retryable error for a batch primitive, which has no WorkflowStep
 * representation (its conditional on_complete/on_success/on_failure
 * callbacks cannot be expressed as a static DAG). Thrown before the RPC. */
function workflowBatchUnimplemented(path: number[]): OJSError {
  const where = path.length === 0 ? '' : ` (at step path ${path.join('.')})`;
  return new OJSError(
    'gRPC workflow: a batch primitive cannot be represented as a ' +
      `CreateWorkflowRequest WorkflowStep DAG${where} — workflow.proto's ` +
      "`repeated WorkflowStep steps` has no way to express a batch's " +
      'conditional on_complete/on_success/on_failure callbacks. Send batch ' +
      'workflows over the HTTP transport instead.',
    'unimplemented',
    { retryable: false },
  );
}

function requireWorkflowRecord(
  element: unknown,
  path: number[],
): Record<string, unknown> {
  if (!isProtoRecord(element)) {
    throw new OJSValidationError(
      `gRPC workflow: step at path ${path.join('.') || '(root)'} must be an object.`,
    );
  }
  return element;
}

/** Appends one job leaf as a WorkflowStep and returns its (single) exit ID. */
function appendWorkflowJobStep(
  job: Record<string, unknown>,
  path: number[],
  incoming: string[],
  state: WorkflowFlattenState,
): string {
  const id = workflowStepId(path);
  if (typeof job.type !== 'string' || job.type.length === 0) {
    throw new OJSValidationError(
      `gRPC workflow: step '${id}' must have a non-empty 'type'.`,
    );
  }
  const step: Record<string, unknown> = {
    id,
    type: job.type,
    args: asProtoArray(job.args).map(toProtoValue),
    dependsOn: incoming,
  };
  // Shared HTTP-wire -> proto EnqueueOptions conversion, identical to
  // single enqueue: reads the step's nested `options` plus envelope-level
  // `meta`, and rejects an unrepresentable envelope `schema` (and any
  // unknown/malformed option) with a clear, step-attributed error.
  const options = mapEnqueueOptions(
    job,
    undefined,
    `workflow step '${id}'`,
    false,
  );
  if (options) step.options = options;
  state.steps.push(step);
  return id;
}

/**
 * Recursively flattens one workflow element into `state.steps`, returning
 * the element subtree's exit step IDs (the nodes a following chain element
 * must depend on). `incoming` is the set of step IDs this element depends
 * on. Discrimination mirrors `toWireStep()`: a `batch` (identified by its
 * structural `callbacks` field) is rejected first, then `steps` => chain,
 * `jobs` => group, otherwise a job leaf. The `type` string alone cannot
 * identify a primitive because it is also a valid job-handler name.
 */
function flattenWorkflowElement(
  element: unknown,
  path: number[],
  incoming: string[],
  state: WorkflowFlattenState,
): string[] {
  const el = requireWorkflowRecord(element, path);

  if (el.callbacks !== undefined) {
    throw workflowBatchUnimplemented(path);
  }

  if (Array.isArray(el.steps)) {
    let prev = incoming;
    (el.steps as unknown[]).forEach((child, i) => {
      prev = flattenWorkflowElement(child, [...path, i], prev, state);
    });
    return prev;
  }

  if (Array.isArray(el.jobs)) {
    const exits: string[] = [];
    (el.jobs as unknown[]).forEach((child, i) => {
      exits.push(...flattenWorkflowElement(child, [...path, i], incoming, state));
    });
    return exits;
  }

  return [appendWorkflowJobStep(el, path, incoming, state)];
}

/**
 * Validates the complete primitive tree before appending any flat DAG steps.
 * An empty nested chain/group is not a no-op: silently flattening it would
 * splice the surrounding dependency edge (for example A -> empty -> B into
 * A -> B) and accept a workflow different from the one the caller supplied.
 */
function assertNoEmptyWorkflowPrimitive(
  element: unknown,
  path: number[],
): void {
  const el = requireWorkflowRecord(element, path);

  if (Array.isArray(el.steps)) {
    if (el.steps.length === 0) {
      throw new OJSValidationError(
        `gRPC workflow: chain at path ${path.join('.') || '(root)'} must contain at least one step.`,
      );
    }
    (el.steps as unknown[]).forEach((child, index) => {
      assertNoEmptyWorkflowPrimitive(child, [...path, index]);
    });
    return;
  }

  if (Array.isArray(el.jobs)) {
    if (el.jobs.length === 0) {
      throw new OJSValidationError(
        `gRPC workflow: group at path ${path.join('.') || '(root)'} must contain at least one job.`,
      );
    }
    (el.jobs as unknown[]).forEach((child, index) => {
      assertNoEmptyWorkflowPrimitive(child, [...path, index]);
    });
  }
}

/**
 * Converts a `toWireWorkflow()` body into a `CreateWorkflowRequest`
 * (`{ name, steps }`). Rejects a batch (before the RPC) and never emits an
 * empty `steps` list — the CreateWorkflow RPC requires at least one step.
 * The top-level `name` is preserved.
 */
function buildProtoCreateWorkflowRequest(
  body: Record<string, unknown>,
): { name: string; steps: Record<string, unknown>[] } {
  assertNoEmptyWorkflowPrimitive(body, []);
  const state: WorkflowFlattenState = { steps: [] };
  flattenWorkflowElement(body, [], [], state);
  if (state.steps.length === 0) {
    throw new OJSValidationError(
      'gRPC workflow: CreateWorkflowRequest requires at least one step, but ' +
        'the workflow produced none.',
    );
  }
  return {
    name: typeof body.name === 'string' ? body.name : '',
    steps: state.steps,
  };
}

/** Maps proto JobState enum string to lowercase state name. */
function mapJobState(state: unknown): string {
  const map: Record<string, string> = {
    JOB_STATE_SCHEDULED: 'scheduled',
    JOB_STATE_AVAILABLE: 'available',
    JOB_STATE_PENDING: 'pending',
    JOB_STATE_ACTIVE: 'active',
    JOB_STATE_COMPLETED: 'completed',
    JOB_STATE_RETRYABLE: 'retryable',
    JOB_STATE_CANCELLED: 'cancelled',
    JOB_STATE_DISCARDED: 'discarded',
  };
  if (typeof state === 'string') {
    return map[state] ?? state.toLowerCase().replace('job_state_', '');
  }
  if (typeof state === 'number') {
    const numMap: Record<number, string> = {
      1: 'scheduled',
      2: 'available',
      3: 'pending',
      4: 'active',
      5: 'completed',
      6: 'retryable',
      7: 'cancelled',
      8: 'discarded',
    };
    return numMap[state] ?? 'available';
  }
  return 'available';
}

/** Maps proto WorkflowStepState to lowercase string. */
function mapStepState(state: unknown): string {
  const map: Record<string, string> = {
    WORKFLOW_STEP_STATE_WAITING: 'waiting',
    WORKFLOW_STEP_STATE_PENDING: 'pending',
    WORKFLOW_STEP_STATE_AVAILABLE: 'available',
    WORKFLOW_STEP_STATE_ACTIVE: 'active',
    WORKFLOW_STEP_STATE_COMPLETED: 'completed',
    WORKFLOW_STEP_STATE_FAILED: 'failed',
    WORKFLOW_STEP_STATE_CANCELLED: 'cancelled',
  };
  if (typeof state === 'string') {
    if (
      state === 'waiting' ||
      state === 'pending' ||
      state === 'available' ||
      state === 'active' ||
      state === 'completed' ||
      state === 'failed' ||
      state === 'cancelled'
    ) {
      return state;
    }
    return map[state] ?? 'pending';
  }
  return 'pending';
}

/** Maps proto WorkerState to lowercase string. */
function mapWorkerState(state: unknown): string {
  const map: Record<string, string> = {
    WORKER_STATE_RUNNING: 'running',
    WORKER_STATE_QUIET: 'quiet',
    WORKER_STATE_TERMINATE: 'terminate',
  };
  if (typeof state === 'string') {
    return map[state] ?? 'running';
  }
  return 'running';
}

/**
 * Inverse of `mapWorkerState`: maps the SDK's lowercase worker-state string
 * (as sent in the `state` field of src/worker.ts's heartbeat body) to the
 * proto `WorkerState` enum's string name — `enums: String` was passed to
 * proto-loader's `loadSync`, so the generated client accepts (and echoes
 * back) enum values as their string name rather than a bare integer.
 * Returns `undefined` for a missing/unrecognized state so the caller can
 * simply omit the field, leaving the proto3 zero-value
 * `WORKER_STATE_UNSPECIFIED` rather than guessing at one.
 */
function mapWorkerStateToProto(state: unknown): string | undefined {
  if (typeof state !== 'string') return undefined;
  const map: Record<string, string> = {
    running: 'WORKER_STATE_RUNNING',
    quiet: 'WORKER_STATE_QUIET',
    terminate: 'WORKER_STATE_TERMINATE',
  };
  return map[state];
}

// --- Enqueue options: HTTP-wire -> protobuf EnqueueOptions conversion ---
//
// job.proto's `EnqueueOptions` message (shared by `EnqueueRequest.options`,
// `BatchJobEntry.options`, and `EnqueueBatchRequest.default_options`) is a
// fixed, strongly-typed protobuf message: `queue`, `priority`,
// `delay_until` (Timestamp), `timeout` (Duration), `retry` (RetryPolicy),
// `unique` (UniquePolicy), `ttl` (Duration — a *relative* time-to-live,
// not an absolute deadline), `tags`, `trace_id`, `meta` (Struct),
// `max_attempts`, and `visibility_timeout` (Duration). The previous
// `mapEnqueueOptions()` merely `Object.assign`ed the caller-supplied
// `options` object as-is onto the request — every HTTP-wire field name
// (`delay_until` as an RFC 3339 *string*, `timeout_ms` as milliseconds,
// `expires_at` as an absolute deadline, snake_case `retry`/`unique`
// sub-fields, lowercase enum strings, ...) reached the generated gRPC
// client completely unconverted, so nothing but a bare `queue`/`priority`
// could ever have worked against a real proto-loader-encoded wire.
//
// The functions below are the single strict, shared converter for all
// three of those call sites (`grpcEnqueue`, `grpcEnqueueBatch`'s per-job
// entries, and `grpcEnqueueBatch`'s `default_options`/`defaultOptions`),
// so every field is mapped and validated exactly once, consistently.

/**
 * HTTP-wire field names this converter recognizes on an `options`-shaped
 * object — see `job-options.schema.json` for `queue`/`priority`/
 * `delay_until`/`timeout_ms`/`expires_at`/`retry`/`unique`/`tags`/
 * `visibility_timeout_ms`, plus `trace_id`/`max_attempts`/`meta`, which
 * job.proto's `EnqueueOptions` also carries directly as shorthand/
 * cross-cutting fields even though the published HTTP options schema
 * does not yet enumerate them (see AUDIT.md's F-31 follow-up note). Used
 * both to merge a batch's `default_options` under a per-job `options`
 * object (whole-field override, never a deep merge of nested `retry`/
 * `unique` sub-fields — the same "does this field replace the default
 * entirely" semantics as protobuf singular-message-field replacement)
 * and to whitelist which properties `mergeWireEnqueueOptions` reads,
 * so unrelated properties are never accidentally merged in.
 */
const ENQUEUE_OPTION_FIELDS = [
  'queue',
  'priority',
  'delay_until',
  'timeout_ms',
  'expires_at',
  'retry',
  'unique',
  'tags',
  'trace_id',
  'meta',
  'max_attempts',
  'visibility_timeout_ms',
] as const;

const ENQUEUE_OPTION_FIELD_SET = new Set<string>(ENQUEUE_OPTION_FIELDS);
const RETRY_OPTION_FIELD_SET = new Set([
  'max_attempts',
  'initial_interval',
  'backoff_coefficient',
  'max_interval',
  'jitter',
  'non_retryable_errors',
  'on_exhaustion',
]);
const UNIQUE_OPTION_FIELD_SET = new Set([
  'keys',
  'key',
  'period',
  'on_conflict',
  'states',
  'args_keys',
  'meta_keys',
]);

/**
 * Merges two HTTP-wire `options`-shaped objects field-by-field —
 * `overrides` wins whenever it *has* a given field (per
 * `ENQUEUE_OPTION_FIELDS`), even when its value is a meaningful falsy
 * one (`0`, `false`, `''`), matching this file's existing
 * presence-over-truthiness convention. Neither input is mutated; a
 * fresh object is always returned, so a caller's `default_options` or
 * per-job `options` object is safe to reuse across every job in a batch.
 */
function mergeWireEnqueueOptions(
  defaults: Record<string, unknown> | undefined,
  overrides: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const field of ENQUEUE_OPTION_FIELDS) {
    if (defaults && Object.prototype.hasOwnProperty.call(defaults, field)) {
      merged[field] = defaults[field];
    }
  }
  for (const field of ENQUEUE_OPTION_FIELDS) {
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, field)) {
      merged[field] = overrides[field];
    }
  }
  return merged;
}

/** Throws a validation error identifying the offending `options` field. */
function invalidEnqueueOption(field: string, reason: string): never {
  throw new OJSValidationError(
    `gRPC enqueue options: '${field}' ${reason}.`,
  );
}

function requireOptionsRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidEnqueueOption(field, 'must be an object');
  }
  return value as Record<string, unknown>;
}

function assertKnownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    invalidEnqueueOption(`${field}.${unknown}`, 'is not a supported field');
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') invalidEnqueueOption(field, 'must be a string');
  return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
  const s = requireString(value, field);
  if (s.length === 0) invalidEnqueueOption(field, 'must be a non-empty string');
  return s;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalidEnqueueOption(field, 'must be a boolean');
  return value;
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalidEnqueueOption(field, 'must be a finite number');
  }
  return value;
}

function requireInteger(
  value: unknown,
  field: string,
  bounds?: { min?: number; max?: number },
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    invalidEnqueueOption(field, 'must be an integer');
  }
  if (bounds?.min !== undefined && value < bounds.min) {
    invalidEnqueueOption(field, `must be >= ${bounds.min}`);
  }
  if (bounds?.max !== undefined && value > bounds.max) {
    invalidEnqueueOption(field, `must be <= ${bounds.max}`);
  }
  return value;
}

function requireStringArray(
  value: unknown,
  field: string,
  options: { nonEmpty?: boolean; unique?: boolean } = {},
): string[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (v) =>
        typeof v === 'string' &&
        (!options.nonEmpty || v.length > 0),
    )
  ) {
    invalidEnqueueOption(field, 'must be an array of strings');
  }
  if (options.unique && new Set(value).size !== value.length) {
    invalidEnqueueOption(field, 'must not contain duplicate values');
  }
  return value as string[];
}

function toProtoJsonValue(
  value: unknown,
  field: string,
  seen: Set<object>,
): unknown {
  if (value === null) return { nullValue: 0 };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      invalidEnqueueOption(field, 'must contain only finite JSON numbers');
    }
    return { numberValue: value };
  }
  if (typeof value !== 'object') {
    invalidEnqueueOption(field, 'must contain only JSON-compatible values');
  }

  const objectValue = value as object;
  if (seen.has(objectValue)) {
    invalidEnqueueOption(field, 'must not contain cyclic references');
  }
  seen.add(objectValue);
  try {
    if (Array.isArray(value)) {
      return {
        listValue: {
          values: value.map((item, index) =>
            toProtoJsonValue(item, `${field}[${index}]`, seen),
          ),
        },
      };
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalidEnqueueOption(field, 'must contain only plain JSON objects');
    }
    // Null-prototype accumulator — see `toProtoValue`'s doc comment on
    // this same pattern in grpc.ts's other Struct/map field builders.
    const fields: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      fields[key] = toProtoJsonValue(item, `${field}.${key}`, seen);
    }
    return { structValue: { fields } };
  } finally {
    seen.delete(objectValue);
  }
}

function enqueueMetaToProtoStruct(
  value: unknown,
): { fields: Record<string, unknown> } {
  const meta = requireOptionsRecord(value, 'meta');
  const prototype = Object.getPrototypeOf(meta);
  if (prototype !== Object.prototype && prototype !== null) {
    invalidEnqueueOption('meta', 'must be a plain JSON object');
  }
  // Null-prototype accumulator — see `toProtoValue`'s doc comment on this
  // same pattern in grpc.ts's other Struct/map field builders.
  const fields: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  const seen = new Set<object>([meta]);
  for (const [key, item] of Object.entries(meta)) {
    fields[key] = toProtoJsonValue(item, `meta.${key}`, seen);
  }
  return { fields };
}

const NANOS_PER_SECOND = 1_000_000_000n;
const MAX_PROTO_DURATION_SECONDS = 315_576_000_000n;
const MIN_PROTO_TIMESTAMP_SECONDS = -62_135_596_800n;
const MAX_PROTO_TIMESTAMP_SECONDS = 253_402_300_799n;

function nanosToProtoDuration(
  nanos: bigint,
  field: string,
): { seconds: string; nanos: number } {
  if (nanos < 0n) invalidEnqueueOption(field, 'must be >= 0');
  const seconds = nanos / NANOS_PER_SECOND;
  if (seconds > MAX_PROTO_DURATION_SECONDS) {
    invalidEnqueueOption(field, 'exceeds the protobuf Duration range');
  }
  return {
    seconds: seconds.toString(),
    nanos: Number(nanos % NANOS_PER_SECOND),
  };
}

/** Converts a non-negative integer millisecond count (an HTTP-wire `*_ms`
 * field) to a proto Duration. */
function msToProtoDuration(
  value: unknown,
  field: string,
): { seconds: string; nanos: number } {
  const ms = requireInteger(value, field, { min: 0 });
  if (!Number.isSafeInteger(ms)) {
    invalidEnqueueOption(field, 'must be a safe integer');
  }
  return nanosToProtoDuration(BigInt(ms) * 1_000_000n, field);
}

interface ParsedRfc3339Timestamp {
  seconds: bigint;
  nanos: number;
}

const RFC3339_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([Zz]|([+-])(\d{2}):(\d{2}))$/;

/**
 * Parses an RFC 3339 timestamp without losing sub-millisecond precision.
 * Timestamp nanos are always non-negative, including for pre-epoch
 * instants, as required by google.protobuf.Timestamp.
 */
function parseRfc3339Timestamp(
  value: unknown,
  field: string,
): ParsedRfc3339Timestamp {
  const raw = requireNonEmptyString(value, field);
  const match = RFC3339_TIMESTAMP.exec(raw);
  if (!match) {
    invalidEnqueueOption(field, `must be a valid RFC 3339 timestamp (got: ${raw})`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    invalidEnqueueOption(field, `must be a valid RFC 3339 timestamp (got: ${raw})`);
  }

  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, 0);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second
  ) {
    invalidEnqueueOption(field, `must be a valid RFC 3339 timestamp (got: ${raw})`);
  }

  const offsetSign = match[9] === '-' ? -1 : 1;
  const offsetSeconds = BigInt(
    offsetSign * (offsetHour * 3600 + offsetMinute * 60),
  );
  const seconds = BigInt(local.getTime() / 1000) - offsetSeconds;
  if (
    seconds < MIN_PROTO_TIMESTAMP_SECONDS ||
    seconds > MAX_PROTO_TIMESTAMP_SECONDS
  ) {
    invalidEnqueueOption(field, 'is outside the protobuf Timestamp range');
  }
  const nanos = Number((match[7] ?? '').padEnd(9, '0') || '0');
  return { seconds, nanos };
}

function toProtoTimestamp(
  value: unknown,
  field: string,
): { seconds: string; nanos: number } {
  const timestamp = parseRfc3339Timestamp(value, field);
  return {
    seconds: timestamp.seconds.toString(),
    nanos: timestamp.nanos,
  };
}

const ISO_DURATION =
  /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)(?:\.(\d{1,9}))?S)?)?$/;

/** Parses the OJS duration subset into a protobuf Duration without
 * losing nanosecond precision. */
function isoDurationToProtoDuration(
  value: unknown,
  field: string,
): { seconds: string; nanos: number } {
  const raw = requireNonEmptyString(value, field);
  const match = ISO_DURATION.exec(raw);
  if (
    !match ||
    (match[1] === undefined &&
      match[2] === undefined &&
      match[3] === undefined &&
      match[4] === undefined &&
      match[5] === undefined &&
      match[6] === undefined &&
      match[7] === undefined)
  ) {
    invalidEnqueueOption(
      field,
      `must be a valid ISO 8601 duration (got: ${raw})`,
    );
  }
  if (BigInt(match[1] ?? 0) !== 0n || BigInt(match[2] ?? 0) !== 0n) {
    invalidEnqueueOption(
      field,
      'contains calendar years/months that cannot be represented exactly by google.protobuf.Duration; use weeks, days, hours, minutes, or seconds',
    );
  }
  const seconds =
    BigInt(match[3] ?? 0) * 604_800n +
    BigInt(match[4] ?? 0) * 86_400n +
    BigInt(match[5] ?? 0) * 3_600n +
    BigInt(match[6] ?? 0) * 60n +
    BigInt(match[7] ?? 0);
  const nanos =
    seconds * NANOS_PER_SECOND +
    BigInt((match[8] ?? '').padEnd(9, '0') || '0');
  return nanosToProtoDuration(nanos, field);
}

/**
 * Converts an absolute `expires_at` RFC 3339 deadline into job.proto
 * `EnqueueOptions.ttl` — a *relative* Duration from now, per its own doc
 * comment ("Converted to an absolute expires_at timestamp by the
 * server."), unlike `Job.expires_at` (the response-side field, which
 * *is* an absolute Timestamp — see `fromProtoJob`). Rejects a
 * malformed/unparseable string, and rejects a deadline that has already
 * passed (or resolves to a non-positive TTL): job.proto has no way to
 * represent an already-past relative TTL, and silently clamping or
 * silently sending `ttl: 0` would either drop the caller's intent or
 * ambiguously collide with "no TTL" as a value.
 */
function expiresAtToProtoTtl(value: unknown, field: string): { seconds: string; nanos: number } {
  const expiresAt = parseRfc3339Timestamp(value, field);
  const expiresAtNanos =
    expiresAt.seconds * NANOS_PER_SECOND + BigInt(expiresAt.nanos);
  const ttlNanos = expiresAtNanos - BigInt(Date.now()) * 1_000_000n;
  if (ttlNanos <= 0n) {
    invalidEnqueueOption(
      field,
      'must be in the future (the supplied value is already expired or not a positive TTL); ' +
        "job.proto's EnqueueOptions.ttl is a relative duration and cannot represent an already-past deadline",
    );
  }
  return nanosToProtoDuration(ttlNanos, field);
}

/** HTTP-wire `unique.on_conflict` string -> proto `UniqueConflictAction`
 * enum string name (`enums: String` was passed to `loadSync`). The
 * inverse of `mapUniqueConflictAction`'s response-side mapping. */
const WIRE_TO_PROTO_UNIQUE_CONFLICT_ACTION: Readonly<Record<string, string>> = {
  reject: 'UNIQUE_CONFLICT_ACTION_REJECT',
  replace: 'UNIQUE_CONFLICT_ACTION_REPLACE',
  ignore: 'UNIQUE_CONFLICT_ACTION_IGNORE',
  replace_except_schedule: 'UNIQUE_CONFLICT_ACTION_REPLACE_EXCEPT_SCHEDULE',
};

function toProtoUniqueConflictAction(value: unknown, field: string): string {
  const raw = requireString(value, field);
  const mapped = WIRE_TO_PROTO_UNIQUE_CONFLICT_ACTION[raw];
  if (!mapped) {
    invalidEnqueueOption(
      field,
      `must be one of ${Object.keys(WIRE_TO_PROTO_UNIQUE_CONFLICT_ACTION).join(', ')} (got: ${raw})`,
    );
  }
  return mapped;
}

/** HTTP-wire lowercase job state string -> proto `JobState` enum string
 * name. The inverse of `mapJobState`'s response-side mapping. */
const WIRE_TO_PROTO_JOB_STATE: Readonly<Record<string, string>> = {
  scheduled: 'JOB_STATE_SCHEDULED',
  available: 'JOB_STATE_AVAILABLE',
  pending: 'JOB_STATE_PENDING',
  active: 'JOB_STATE_ACTIVE',
  completed: 'JOB_STATE_COMPLETED',
  retryable: 'JOB_STATE_RETRYABLE',
  cancelled: 'JOB_STATE_CANCELLED',
  discarded: 'JOB_STATE_DISCARDED',
};

function toProtoJobStateEnum(value: unknown, field: string): string {
  const raw = requireString(value, field);
  const mapped = WIRE_TO_PROTO_JOB_STATE[raw];
  if (!mapped) {
    invalidEnqueueOption(
      field,
      `must be one of ${Object.keys(WIRE_TO_PROTO_JOB_STATE).join(', ')} (got: ${raw})`,
    );
  }
  return mapped;
}

/** job.proto's `RetryPolicy.on_exhaustion` is a plain `string` field (not
 * a protobuf enum), but the published schema and every SDK-side type
 * restrict it to exactly these two values — validated here so a typo
 * fails fast client-side instead of reaching the server unchecked. */
const VALID_ON_EXHAUSTION = new Set(['discard', 'dead_letter']);

function toProtoOnExhaustion(value: unknown, field: string): string {
  const raw = requireString(value, field);
  if (!VALID_ON_EXHAUSTION.has(raw)) {
    invalidEnqueueOption(field, "must be 'discard' or 'dead_letter'");
  }
  return raw;
}

/** Converts an HTTP-wire `retry` object (job-options.schema.json's
 * `retry-policy.json` $ref) to a proto `RetryPolicy`. Every sub-field is
 * optional and independently validated/converted; a meaningfully falsy
 * value (`max_attempts: 0`, `jitter: false`) is preserved, never dropped. */
function buildProtoRetryPolicy(value: unknown): Record<string, unknown> {
  const retry = requireOptionsRecord(value, 'retry');
  assertKnownFields(retry, RETRY_OPTION_FIELD_SET, 'retry');
  const proto: Record<string, unknown> = {};
  if (retry.max_attempts !== undefined) {
    proto.maxAttempts = requireInteger(retry.max_attempts, 'retry.max_attempts', {
      min: 0,
      max: 2_147_483_647,
    });
  }
  if (retry.initial_interval !== undefined) {
    proto.initialInterval = isoDurationToProtoDuration(retry.initial_interval, 'retry.initial_interval');
  }
  if (retry.backoff_coefficient !== undefined) {
    const coefficient = requireFiniteNumber(
      retry.backoff_coefficient,
      'retry.backoff_coefficient',
    );
    if (coefficient < 1) {
      invalidEnqueueOption('retry.backoff_coefficient', 'must be >= 1');
    }
    proto.backoffCoefficient = coefficient;
  }
  if (retry.max_interval !== undefined) {
    proto.maxInterval = isoDurationToProtoDuration(retry.max_interval, 'retry.max_interval');
  }
  if (retry.jitter !== undefined) {
    proto.jitter = requireBoolean(retry.jitter, 'retry.jitter');
  }
  if (retry.non_retryable_errors !== undefined) {
    proto.nonRetryableErrors = requireStringArray(
      retry.non_retryable_errors,
      'retry.non_retryable_errors',
      { nonEmpty: true, unique: true },
    );
  }
  if (retry.on_exhaustion !== undefined) {
    proto.onExhaustion = toProtoOnExhaustion(retry.on_exhaustion, 'retry.on_exhaustion');
  }
  return proto;
}

/** Converts an HTTP-wire `unique` object (job-options.schema.json's
 * `unique-policy.json` $ref) to a proto `UniquePolicy`. Canonical HTTP
 * `keys` maps to protobuf's singular `key`; `args_keys`/`meta_keys` map to
 * `argsKeys`/`metaKeys`. Direct `GrpcTransport` callers may still supply the
 * deprecated SDK `key` option; every entry is treated as an args selector,
 * matching `UniqueOptions.key`, before conversion to canonical proto fields. */
function buildProtoUniquePolicy(value: unknown): Record<string, unknown> {
  const unique = requireOptionsRecord(value, 'unique');
  assertKnownFields(unique, UNIQUE_OPTION_FIELD_SET, 'unique');
  const proto: Record<string, unknown> = {};
  const selection = normalizeUniqueSelection(
    {
      keys: unique.keys,
      key: unique.key,
      argsKeys: unique.args_keys,
      metaKeys: unique.meta_keys,
    },
    {
      keys: 'unique.keys',
      key: 'unique.key',
      argsKeys: 'unique.args_keys',
      metaKeys: 'unique.meta_keys',
    },
  );
  const canonicalPolicy: Record<string, unknown> = {};
  if (selection.keys !== undefined) canonicalPolicy.keys = selection.keys;
  if (selection.argsKeys !== undefined) {
    canonicalPolicy.args_keys = selection.argsKeys;
  }
  if (selection.metaKeys !== undefined) {
    canonicalPolicy.meta_keys = selection.metaKeys;
  }
  if (unique.period !== undefined) canonicalPolicy.period = unique.period;
  if (unique.on_conflict !== undefined) {
    canonicalPolicy.on_conflict = unique.on_conflict;
  }
  if (unique.states !== undefined) canonicalPolicy.states = unique.states;
  const validationErrors = validateUniquePolicy(canonicalPolicy, 'unique');
  if (validationErrors.length > 0) {
    invalidEnqueueOption(
      validationErrors[0]!.field,
      validationErrors.map((error) => error.message).join('; '),
    );
  }
  if (selection.keys !== undefined) proto.key = selection.keys;
  if (selection.argsKeys !== undefined) proto.argsKeys = selection.argsKeys;
  if (selection.metaKeys !== undefined) proto.metaKeys = selection.metaKeys;
  if (unique.period !== undefined) {
    proto.period = isoDurationToProtoDuration(unique.period, 'unique.period');
  }
  if (unique.on_conflict !== undefined) {
    proto.onConflict = toProtoUniqueConflictAction(unique.on_conflict, 'unique.on_conflict');
  }
  if (unique.states !== undefined) {
    proto.states = (unique.states as unknown[]).map((s, i) =>
      toProtoJobStateEnum(s, `unique.states[${i}]`),
    );
  }
  return proto;
}

/**
 * Converts one already-merged HTTP-wire `options` record (see
 * `mergeWireEnqueueOptions`) plus an optional envelope-level `meta`
 * source into a proto `EnqueueOptions` object, or `undefined` if nothing
 * ends up set. This is the single strict conversion every field goes
 * through — every caller below (`mapEnqueueOptions`, and
 * `grpcEnqueueBatch`'s upfront `default_options` validation) routes
 * through this one function so no field is ever mapped or validated in
 * more than one place.
 */
function buildProtoEnqueueOptions(
  wire: Record<string, unknown>,
  envelopeMeta?: unknown,
): Record<string, unknown> | undefined {
  assertKnownFields(wire, ENQUEUE_OPTION_FIELD_SET, 'options');
  const proto: Record<string, unknown> = {};

  if (wire.queue !== undefined) {
    const queue = requireNonEmptyString(wire.queue, 'queue');
    const queueError = validateQueueName(queue);
    if (queueError) {
      invalidEnqueueOption('queue', queueError.message);
    }
    proto.queue = queue;
  }
  // Priority MUST preserve an explicit `0` (NORMAL) — presence, not
  // truthiness, decides whether the field is set.
  if (wire.priority !== undefined) {
    proto.priority = requireInteger(wire.priority, 'priority', { min: -100, max: 100 });
  }
  if (wire.delay_until !== undefined) {
    proto.delayUntil = toProtoTimestamp(wire.delay_until, 'delay_until');
  }
  // timeout_ms MUST preserve an explicit `0` ("no timeout" per
  // job-options.schema.json) rather than treating it as unset.
  if (wire.timeout_ms !== undefined) {
    proto.timeout = msToProtoDuration(wire.timeout_ms, 'timeout_ms');
  }
  if (wire.expires_at !== undefined) {
    proto.ttl = expiresAtToProtoTtl(wire.expires_at, 'expires_at');
  }
  if (wire.retry !== undefined) {
    proto.retry = buildProtoRetryPolicy(wire.retry);
  }
  if (wire.unique !== undefined) {
    proto.unique = buildProtoUniquePolicy(wire.unique);
  }
  if (wire.tags !== undefined) {
    proto.tags = requireStringArray(wire.tags, 'tags', {
      nonEmpty: true,
      unique: true,
    });
  }
  if (wire.trace_id !== undefined) {
    proto.traceId = requireString(wire.trace_id, 'trace_id');
  }
  if (wire.max_attempts !== undefined) {
    proto.maxAttempts = requireInteger(wire.max_attempts, 'max_attempts', {
      min: 0,
      max: 2_147_483_647,
    });
  }
  if (wire.visibility_timeout_ms !== undefined) {
    proto.visibilityTimeout = msToProtoDuration(wire.visibility_timeout_ms, 'visibility_timeout_ms');
  }

  // job.proto's `EnqueueRequest`/`BatchJobEntry` have no top-level `meta`
  // field of their own (only `type`/`args`/`options`), so envelope-level
  // `meta` (a sibling of `options` on the wire, per
  // `toWireEnvelopeFields()` in src/job.ts) is threaded into
  // `EnqueueOptions.meta` here — the only meta carrier available over
  // gRPC. An explicit `options.meta` (a raw-transport-only shorthand;
  // the published options schema doesn't define it, but the proto field
  // supports it) takes precedence when both are supplied.
  const metaSource = wire.meta !== undefined ? wire.meta : envelopeMeta;
  if (metaSource !== undefined) {
    proto.meta = enqueueMetaToProtoStruct(metaSource);
  }

  return Object.keys(proto).length > 0 ? proto : undefined;
}

/**
 * Throws an explicit `unimplemented` `OJSError` if an envelope-level
 * `schema` (sibling of `type`/`args`/`options`, per
 * `enqueue-request.schema.json`) is present. job.proto's `EnqueueOptions`
 * — the only per-job configuration carrier `EnqueueRequest`/
 * `BatchJobEntry` expose — has no `schema` field at all, so there is
 * nowhere on the wire to put it; silently omitting it (as the previous
 * `mapEnqueueOptions()` effectively did, by never reading `body.schema`
 * in the first place) would let a caller believe schema validation is
 * requested when the server can never see it.
 */
function assertNoEnvelopeSchema(schema: unknown, context: string): void {
  if (schema === undefined) return;
  throw new OJSError(
    `gRPC ${context}: envelope-level 'schema' cannot be represented — ` +
      "job.proto's EnqueueOptions message has no schema field, so this " +
      'request cannot be sent over gRPC without silently dropping it.',
    'unimplemented',
    { retryable: false },
  );
}

/**
 * Converts a single job's HTTP-wire body — envelope-level `queue`/
 * `priority`/`meta`/`schema` (siblings of `type`/`args`/`options`) plus a
 * nested `options` object — into a job.proto `EnqueueOptions`-shaped
 * object, optionally merged over a batch's already wire-shaped
 * `default_options`/`defaultOptions` (per-job fields win — see
 * `mergeWireEnqueueOptions`). Neither `body` nor `defaultWireOptions` is
 * mutated. Returns `undefined` if the result would be an empty options
 * object (matching the previous behavior of omitting `options` entirely
 * rather than sending an empty message).
 */
function mapEnqueueOptions(
  body: Record<string, unknown>,
  defaultWireOptions?: Record<string, unknown>,
  context = 'enqueue request',
  allowAbsoluteExpiry = true,
): Record<string, unknown> | undefined {
  assertNoEnvelopeSchema(body.schema, context);

  const nestedOptions =
    body.options === undefined
      ? undefined
      : requireOptionsRecord(body.options, 'options');
  if (
    !allowAbsoluteExpiry &&
    (
      body.expires_at !== undefined ||
      body.expiresAt !== undefined ||
      nestedOptions?.expires_at !== undefined ||
      nestedOptions?.expiresAt !== undefined ||
      defaultWireOptions?.expires_at !== undefined ||
      defaultWireOptions?.expiresAt !== undefined
    )
  ) {
    throw new OJSValidationError(
      `${context}: expires_at/expiresAt is not supported for deferred job materialization because converting the absolute deadline to a relative TTL before the job is created would shift its expiration.`,
    );
  }
  if (nestedOptions) {
    assertKnownFields(nestedOptions, ENQUEUE_OPTION_FIELD_SET, 'options');
  }

  // Backward-compatible top-level `queue`/`priority`, plus the
  // envelope-level `meta` field. Nested raw-transport `options` values
  // take precedence when both shapes supply the same field.
  const topLevelFields: Record<string, unknown> = {};
  if (body.queue !== undefined) topLevelFields.queue = body.queue;
  if (body.priority !== undefined) topLevelFields.priority = body.priority;
  if (body.meta !== undefined) topLevelFields.meta = body.meta;
  if (Object.keys(topLevelFields).length > 0) {
    // Validate every supplied compatibility/envelope field even if a
    // nested option later overrides it; invalid caller input must never
    // become silently acceptable merely because another source wins.
    buildProtoEnqueueOptions(topLevelFields);
  }

  const ownWireOptions = mergeWireEnqueueOptions(topLevelFields, nestedOptions);
  const wireOptions = defaultWireOptions
    ? mergeWireEnqueueOptions(defaultWireOptions, ownWireOptions)
    : ownWireOptions;

  return buildProtoEnqueueOptions(wireOptions);
}


/**
 * Maps a value synchronously thrown by a generated unary method (rather
 * than passed to its callback) the same way an asynchronous gRPC error is
 * mapped, so `call()`'s caller always rejects with a real `Error` and,
 * where identifiable, a consistent `OJSError` subtype:
 *
 *   - An already-mapped `OJSError` is returned as-is.
 *   - A thrown value that looks like a `GrpcServiceError` (an `Error` with
 *     a numeric gRPC status `code`) is run through the same `mapGrpcError`
 *     used for the async path.
 *   - Any other `Error` is returned as-is — `GrpcTransport.request()`'s
 *     catch-all already wraps a non-`OJSError` rejection from `call()` in
 *     an `OJSConnectionError`.
 *   - A non-`Error` throw (a client-side anti-pattern this transport
 *     cannot prevent) is wrapped in a real `Error`, preserving the
 *     original value as `cause` — mirroring `abortReasonAsError` in
 *     transport/http.ts, which normalizes `AbortSignal.reason` for the
 *     same reason: `reject()`ing with a non-`Error` silently breaks
 *     `instanceof Error`/stack-trace expectations downstream.
 */
function mapSyncThrow(err: unknown): Error {
  if (err instanceof OJSError) return err;
  if (err instanceof Error) {
    return typeof (err as GrpcServiceError).code === 'number'
      ? mapGrpcError(err as GrpcServiceError)
      : err;
  }
  return new Error('gRPC call failed synchronously', { cause: err });
}

/** Maps a gRPC error to the appropriate OJS error type. */
function mapGrpcError(err: GrpcServiceError): OJSError {
  const code = err.code ?? GRPC_STATUS.INTERNAL;
  const message = err.details ?? err.message ?? 'Unknown gRPC error';

  switch (code) {
    case GRPC_STATUS.INVALID_ARGUMENT:
      return new OJSValidationError(message);
    case GRPC_STATUS.NOT_FOUND:
      return new OJSNotFoundError('resource', 'unknown');
    case GRPC_STATUS.ALREADY_EXISTS:
      return new OJSDuplicateError(message);
    case GRPC_STATUS.FAILED_PRECONDITION:
      return new OJSConflictError(message);
    case GRPC_STATUS.RESOURCE_EXHAUSTED:
      return new OJSRateLimitError(message);
    case GRPC_STATUS.UNAVAILABLE:
      return new OJSConnectionError(message, err);
    case GRPC_STATUS.DEADLINE_EXCEEDED:
      return new OJSConnectionError(`Deadline exceeded: ${message}`, err);
    case GRPC_STATUS.CANCELLED:
      return new OJSConnectionError(`Request cancelled: ${message}`, err);
    case GRPC_STATUS.PERMISSION_DENIED:
      return new OJSError(message, 'permission_denied', { retryable: false });
    case GRPC_STATUS.UNIMPLEMENTED:
      return new OJSError(message, 'unimplemented', { retryable: false });
    case GRPC_STATUS.INTERNAL:
    default:
      return new OJSServerError(message, 500);
  }
}

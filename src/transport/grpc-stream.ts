/**
 * Reconnecting server-streaming RPC consumer used by `GrpcTransport`'s
 * `streamJobs()`/`streamEvents()` (see ojs-grpc-binding.md section 10 and
 * service.proto's `StreamJobs`/`StreamEvents` RPCs).
 *
 * This is a single, narrow actor — "keep a server-streaming gRPC call
 * alive across transient failures, with bounded buffering and clean
 * cancellation" — factored out of `transport/grpc.ts` because that file
 * already owns unary-call plumbing, deadline/cancellation, and HTTP-path
 * routing; streaming reconnect/backoff/backpressure is a materially
 * different responsibility with its own failure modes (see
 * ojs-grpc-binding.md section 10.1.1/10.2.1's reconnection policy).
 *
 * Not part of the package's public surface: this is a module-level export
 * for `transport/grpc.ts` and this module's own tests to import, not
 * re-exported from `src/index.ts`.
 *
 * @internal
 */

import { OJSConnectionError } from '../errors.js';

/**
 * Minimal structural shape of a grpc-js server-streaming call this module
 * depends on. `@grpc/grpc-js`'s `ClientReadableStream<T>` extends Node's
 * `Readable` (which implements `Symbol.asyncIterator`) and has `cancel()`
 * — defined locally, like `transport/grpc.ts`'s other structural types, so
 * this module never references `@grpc/grpc-js`'s own types directly and
 * stays usable even when that optional peer dependency is absent.
 */
export interface GrpcServerStreamCall<T = unknown> extends AsyncIterable<T> {
  cancel(): void;
  /**
   * Optional structural EventEmitter surface real `@grpc/grpc-js`
   * `ClientReadableStream` calls provide (they extend Node's `Readable`,
   * itself an `EventEmitter`). When present, this module's bounded-setup
   * timeout (see `GrpcStreamOptions.timeout` in `transport/grpc.ts`) uses
   * the `'metadata'`/`'status'`/`'error'` events as the earliest reliable
   * "this attempt reached the server, or failed trying" signal — the
   * earliest point at which it is safe to stop bounding this attempt and
   * let a since-opened, healthy stream run indefinitely, per
   * ojs-grpc-binding.md sections 10.1.1/10.2.1. A call implementation
   * without this surface (e.g. a minimal test fake) is always treated as
   * "open" immediately once `connect()` returns, so the setup timeout has
   * no observable effect for such implementations beyond
   * `GrpcTransport`'s own client/proto initialization bound.
   */
  on?(
    event: 'metadata' | 'status' | 'error' | 'end',
    listener: (...args: unknown[]) => void,
  ): unknown;
  off?(
    event: 'metadata' | 'status' | 'error' | 'end',
    listener: (...args: unknown[]) => void,
  ): unknown;
}

/**
 * Reconnect/backoff policy for a reconnecting server stream. All fields
 * are optional; unset fields use the ojs-grpc-binding.md-specified
 * defaults (section 10.1.1/10.2.1: "start at 100ms, double each attempt,
 * cap at 30s, with ±25% jitter").
 */
export interface GrpcStreamReconnectOptions {
  /** Whether to automatically reconnect on transient errors. Default: `true`. */
  enabled?: boolean | undefined;
  /** Initial backoff delay in milliseconds. Default: `100`. */
  initialDelayMs?: number | undefined;
  /** Maximum backoff delay in milliseconds. Default: `30_000`. */
  maxDelayMs?: number | undefined;
  /** Maximum number of consecutive reconnect attempts (reset to 0 once a
   * stream delivers at least one message) before giving up and throwing
   * the last error. Default: `Infinity` (retry forever). */
  maxAttempts?: number | undefined;
}

const DEFAULT_INITIAL_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 30_000;
/** ±25% jitter, per ojs-grpc-binding.md section 10.1.1/10.2.1. */
const JITTER_RATIO = 0.25;

/** gRPC status codes this module treats as transient/retryable for a
 * stream reconnect (mirrors `transport/grpc.ts`'s own `GRPC_STATUS`
 * constants without importing them, keeping this module self-contained). */
const GRPC_STATUS_CANCELLED = 1;
const GRPC_STATUS_DEADLINE_EXCEEDED = 4;
const GRPC_STATUS_UNAVAILABLE = 14;
const DEFAULT_RETRYABLE_GRPC_CODES: ReadonlySet<number> = new Set([
  GRPC_STATUS_DEADLINE_EXCEEDED,
  GRPC_STATUS_UNAVAILABLE,
]);

/**
 * Computes the reconnect delay (in milliseconds) for a given attempt
 * number (1-indexed: `1` is the delay before the *first* reconnect),
 * per ojs-grpc-binding.md's reconnection policy: exponential backoff
 * starting at `initialDelayMs`, doubling each attempt, capped at
 * `maxDelayMs` — applied both before and after jitter (matching this
 * SDK's existing job-retry `computeBackoff` in `src/retry.ts`, which caps
 * both before *and* after jitter so the final value never exceeds the
 * cap) — with a uniform ±25% jitter multiplier.
 *
 * `random` is an injectable seam (defaults to `Math.random`) purely so
 * tests can assert exact, deterministic delays instead of a range; it is
 * not part of `GrpcStreamReconnectOptions` and is not exposed publicly.
 */
export function computeStreamBackoffMs(
  attempt: number,
  options?: Pick<GrpcStreamReconnectOptions, 'initialDelayMs' | 'maxDelayMs'>,
  random: () => number = Math.random,
): number {
  const initial = options?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const max = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const exponential = initial * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(exponential, max);
  const jitterMultiplier = 1 - JITTER_RATIO + random() * (2 * JITTER_RATIO); // [0.75, 1.25)
  return Math.min(Math.max(0, capped * jitterMultiplier), max);
}

/** An abortable delay: resolves after `ms`, or immediately once `signal` aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    // `onAbort` closes over `timer` before its `const` declaration below
    // has run — safe because `onAbort` is only ever *called* later (via
    // the 'abort' listener registered after `timer` is assigned), never
    // during this synchronous setup, so there is no temporal-dead-zone
    // access in practice.
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Minimal structural shape of a gRPC service error (mirrors
 * `transport/grpc.ts`'s own `GrpcServiceError`, redeclared locally so this
 * module has no dependency on that file).
 */
interface StreamServiceError extends Error {
  code?: number;
  grpcStatusCode?: number;
}

/** Reads a structural gRPC status code off an unknown thrown/rejected value. */
function grpcCodeOf(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;
  const streamError = err as StreamServiceError;
  const code = streamError.grpcStatusCode ?? streamError.code;
  return typeof code === 'number' ? code : undefined;
}

function isCancelledError(err: unknown): boolean {
  return grpcCodeOf(err) === GRPC_STATUS_CANCELLED;
}

function isRetryableStreamError(
  err: unknown,
  retryableStatusCodes: ReadonlySet<number>,
): boolean {
  const code = grpcCodeOf(err);
  return code !== undefined && retryableStatusCodes.has(code);
}

/**
 * Normalizes an unknown caught value into a real `Error` before
 * re-throwing it to this generator's consumer — mirrors `mapSyncThrow` in
 * `transport/grpc.ts` and `abortReasonAsError` in `transport/http.ts`:
 * `catch` variables are typed `unknown`, and throwing a non-`Error` value
 * would silently break `instanceof Error`/stack-trace expectations
 * downstream (and trips `@typescript-eslint/only-throw-error`).
 */
function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error('gRPC stream failed', { cause: err });
}

/**
 * Keeps one passive `'error'` listener attached for the call's entire live
 * lifetime. grpc-js may emit the client-side `CANCELLED` error asynchronously
 * after `cancel()` returns; removing the setup listener before that emission
 * would turn the otherwise-benign cancellation into an uncaught EventEmitter
 * error. The guard removes itself only once the call reports a definitive
 * `'end'` or `'status'`.
 */
function guardCallErrors(call: GrpcServerStreamCall): void {
  if (typeof call.on !== 'function') return;

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    call.off?.('error', onError);
    call.off?.('end', cleanup);
    call.off?.('status', cleanup);
  };
  const onError = (): void => {
    // Passive by design: the async iterator/setup waiter remains responsible
    // for surfacing the actual service error to the consumer.
  };

  call.on('error', onError);
  call.on('end', cleanup);
  call.on('status', cleanup);
}

/**
 * Waits until a just-`connect()`ed attempt's call has either reached the
 * server or failed trying — the bounded "setup" phase described on
 * `ReconnectingStreamOptions.connectTimeoutMs` — or rejects once
 * `timeoutMs` elapses first, whichever comes first.
 *
 * Deliberately narrow: this is a *setup* bound only, never an RPC-lifetime
 * deadline. Once this resolves (successfully or because the call itself
 * already failed), the caller proceeds to consume `call` via the normal
 * `for await`/error path with no further timer running — a healthy,
 * already-open stream can then run indefinitely, exactly matching
 * ojs-grpc-binding.md sections 10.1.1/10.2.1 ("a healthy stream is
 * expected to stay open indefinitely").
 *
 * `timeoutMs === undefined` (the caller did not request a setup bound) or
 * a `call` without the optional EventEmitter surface both resolve
 * immediately — the latter because there is no reliable, structural
 * "reached the server" signal to wait for from such an implementation, so
 * bounding it further here would require guessing based on data arrival
 * (which would incorrectly time out a legitimately idle-but-open stream).
 */
function waitForStreamOpen(
  call: GrpcServerStreamCall,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (timeoutMs === undefined) return Promise.resolve();
  if (typeof call.on !== 'function') return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    // Resolve immediately, before any listener/timer setup, if the signal
    // is already aborted — nothing to bound or clean up in that case.
    if (signal?.aborted) {
      resolve();
      return;
    }

    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      call.off?.('metadata', onOpen);
      call.off?.('status', onOpen);
      call.off?.('error', onError);
    };

    const onOpen = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const onAbort = (): void => onOpen();

    const onError = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(asError(error));
    };

    const onTimeout = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const error = new OJSConnectionError(
        `gRPC stream setup (connect) timed out after ${timeoutMs}ms`,
      );
      Object.defineProperty(error, 'grpcStatusCode', {
        configurable: false,
        enumerable: false,
        value: GRPC_STATUS_DEADLINE_EXCEEDED,
        writable: false,
      });
      reject(error);
    };

    const timer = setTimeout(onTimeout, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    call.on?.('metadata', onOpen);
    call.on?.('status', onOpen);
    call.on?.('error', onError);
  });
}

/** Options for {@link reconnectingServerStream}. */
interface ReconnectingStreamOptions<Raw, Mapped> {
  /**
   * Starts a new attempt at the underlying server-streaming RPC. Invoked
   * once for the initial connection and again for every reconnect — the
   * closure is responsible for supplying the same logical request
   * (queues, filters, worker ID, deadline, metadata) on every call, since
   * neither StreamJobs nor StreamEvents defines a resume cursor
   * (ojs-grpc-binding.md sections 10.1.1/10.2.1: "the client opens a
   * fresh stream").
   *
   * May return a `Promise`: `GrpcTransport` uses this to perform its own
   * client/proto initialization (`ensureClient()`) as part of *every*
   * connection attempt, not just the first, so an initialization failure
   * or timeout is classified and retried through this module's normal
   * backoff/`maxAttempts` machinery below exactly like any other
   * transient stream error, instead of bypassing it entirely (Finding:
   * stream initialization in reconnect engine). A synchronous return
   * (as every existing caller/test uses) keeps working unchanged —
   * `await`ing a non-`Promise` value is a no-op.
   */
  connect: () => GrpcServerStreamCall<Raw> | Promise<GrpcServerStreamCall<Raw>>;
  /**
   * Maps a raw decoded stream message to the public, typed shape.
   * Returning `undefined` filters the message out entirely — used to
   * drop the `stream.keepalive` sentinel messages both StreamJobs and
   * StreamEvents define (worker.proto/events.proto), which callers of
   * this module should never see as a real, actionable message.
   */
  map: (raw: Raw) => Mapped | undefined;
  /**
   * External cancellation signal. Aborting stops the stream permanently
   * (no further reconnect attempts) and unblocks any in-flight
   * iteration promptly by cancelling the current underlying call.
   */
  signal?: AbortSignal | undefined;
  /** Reconnect/backoff policy. */
  reconnect?: GrpcStreamReconnectOptions | undefined;
  /** Injectable RNG for deterministic backoff-jitter tests; defaults to `Math.random`. */
  random?: (() => number) | undefined;
  /**
   * Private transport policy: status codes that may reconnect. StreamJobs
   * and StreamEvents pass different sets; cancellation remains terminal
   * regardless of this set.
   */
  retryableStatusCodes?: ReadonlySet<number> | undefined;
  /**
   * Bounds *only* client/proto initialization and opening each attempt's
   * stream (the initial connection and every subsequent reconnect) —
   * sourced from `GrpcStreamOptions.timeout`. It is never applied as a
   * deadline for an already-open, healthy stream: once an attempt's call
   * signals it reached the server (see `GrpcServerStreamCall.on`'s
   * `'metadata'`/`'status'`/`'error'` events) or, for a call
   * implementation without that structural surface, immediately once
   * `connect()` returns, this timeout no longer applies to that attempt
   * for the rest of its lifetime. A setup that does not open in time is
   * treated exactly like a transient `DEADLINE_EXCEEDED` connectivity
   * failure — cancelled and retried through the normal backoff/
   * `maxAttempts` machinery, never left hanging indefinitely.
   */
  connectTimeoutMs?: number | undefined;
}

/**
 * The actual reconnect/backoff/backpressure engine, as a native async
 * generator. Not exported — {@link reconnectingServerStream} below wraps
 * this in a plain `AsyncIterableIterator` object so that consumer-driven
 * cancellation (`.return()`/`.throw()`, including the implicit calls a
 * `for await` early `break`/`return`/`throw` makes) is never queued behind
 * an in-flight `.next()`. A *native* async generator's own `.return()`/
 * `.throw()` are, per the ECMAScript spec, enqueued behind any
 * already-pending `.next()` call on the same generator and only actually
 * run once that pending step settles — which is exactly wrong for
 * cancellation, since the entire point is to interrupt a `.next()` that
 * may be pending indefinitely (blocked on network I/O or a reconnect
 * backoff sleep). Wrapping it lets the outer `.return()`/`.throw()` cancel
 * the *live* call (or abort an in-progress backoff) synchronously, the
 * moment they are invoked, regardless of what `.next()` is doing.
 *
 * Reconnects on the caller-supplied stream-specific transient statuses
 * with exponential backoff. The default policy retries `UNAVAILABLE` and
 * `DEADLINE_EXCEEDED`; `GrpcTransport` extends that private policy with
 * `INTERNAL` for both streams and `RESOURCE_EXHAUSTED` for StreamJobs only.
 * Both streams are ephemeral and have no resume cursor, so "reconnect"
 * always means "call `connect()` again with the same logical request."
 *
 * Responsibilities intentionally kept here (not in `transport/grpc.ts`):
 *
 *   - **Backpressure/buffering**: messages are `yield`ed directly as they
 *     are pulled from the underlying call's async iterator — there is no
 *     secondary queue anywhere in this module. `for await` consumes a
 *     Node.js `Readable` (which grpc-js's `ClientReadableStream` is) in
 *     paused mode, so the stream's own bounded internal buffer (grpc-js's
 *     default object-mode `highWaterMark`) provides backpressure for
 *     free: the server stops receiving read demand once that buffer
 *     fills, exactly like `stream.pause()`/`resume()`, without this
 *     module ever accumulating an unbounded queue on top of it.
 *   - **Cancellation**: aborting `signal` (or the consumer doing an early
 *     `break`/`return`/`throw`, which invokes this generator's own
 *     `.return()`/`.throw()`) always calls the *current* call's
 *     `cancel()` from a `finally` block. This is required, not
 *     cosmetic — merely letting a `for await` unwind destroys the local
 *     Node `Readable` but does **not** reliably notify the server (verified
 *     against a real `@grpc/grpc-js` server: it never observes a
 *     `'cancelled'` event without an explicit `cancel()` call).
 *   - **Reconnect decision**: stream-specific retryable statuses reconnect
 *     with backoff (reset once a message is delivered); a `CANCELLED`
 *     status or an aborted `signal` always stops the generator silently,
 *     even if a caller accidentally includes status 1 in its private retry
 *     set. A received `CANCELLED` status is only silent after a local
 *     caller/transport abort; otherwise it is a remote terminal error and
 *     is thrown. Any other error, or reconnect exhaustion, also throws.
 *   - **Cleanup**: every listener/timer/call created for one connection
 *     attempt is removed/cancelled before the next attempt or before this
 *     generator returns, in all three exit paths (normal completion,
 *     thrown error, or consumer-driven early return).
 */

/**
 * Races an in-flight `connect()` attempt against `signal` aborting, so a
 * `connect()` that never settles -- a blocked/slow client/proto
 * initialization, or simply an implementation that is not itself
 * abort-aware -- can never block this engine's own cancellation
 * indefinitely (Finding: stream initialization in reconnect engine).
 * `connectPromise`'s eventual settlement is always consumed via a
 * permanently-attached no-op rejection handler, regardless of which side
 * wins, so it can never surface as an unhandled promise rejection; if
 * `signal` wins, that settlement (success or failure) is otherwise
 * discarded entirely -- the surrounding loop's own
 * `if (signal?.aborted) return;` check (immediately after this rejects)
 * already treats *any* error as silent cancellation once the signal is
 * aborted, so the exact rejection reason here is unobservable to a real
 * caller. No second `connect()` call is ever made for an abandoned
 * attempt: cancelling here only stops *waiting*, it never retries.
 */
function connectOrAbort<Raw>(
  connectPromise: Promise<GrpcServerStreamCall<Raw>>,
  signal: AbortSignal | undefined,
): Promise<GrpcServerStreamCall<Raw>> {
  // Attached unconditionally and immediately (before any other branch),
  // so `connectPromise` is never the source of an unhandled rejection no
  // matter which path below is taken.
  connectPromise.catch(() => undefined);

  if (!signal) return connectPromise;
  if (signal.aborted) {
    return Promise.reject(
      new OJSConnectionError('gRPC stream connect() aborted before it settled'),
    );
  }

  return new Promise<GrpcServerStreamCall<Raw>>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(new OJSConnectionError('gRPC stream connect() aborted before it settled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    connectPromise.then(
      (call) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(call);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function* runReconnectingServerStream<Raw, Mapped>(
  options: ReconnectingStreamOptions<Raw, Mapped>,
): AsyncGenerator<Mapped, void, undefined> {
  const { connect, map, signal, random = Math.random } = options;
  const reconnect = options.reconnect ?? {};
  const reconnectEnabled = reconnect.enabled ?? true;
  const maxAttempts = reconnect.maxAttempts ?? Infinity;
  const retryableStatusCodes =
    options.retryableStatusCodes ?? DEFAULT_RETRYABLE_GRPC_CODES;
  const connectTimeoutMs = options.connectTimeoutMs;

  let attempt = 0;

  while (!signal?.aborted) {
    let streamError: unknown;

    try {
      // `await`ing a synchronously-returned (non-Promise) call inside
      // `connectOrAbort` is a no-op, so every existing synchronous
      // `connect` keeps behaving exactly as before; an async `connect`
      // (see its doc comment) can now fail or time out here and be
      // classified/retried below exactly like any other per-attempt
      // failure. `connectOrAbort` additionally races the wait itself
      // against `signal`, so an external/transport abort cancels this
      // wait promptly even if `connect()`'s own promise never settles.
      const call = await connectOrAbort(Promise.resolve(connect()), signal);
      guardCallErrors(call);

      const onAbort = (): void => {
        try {
          call.cancel();
        } catch {
          // Best-effort: the call may already be ended; a broken
          // implementation's cancel() must not become an unhandled
          // rejection from inside an event listener.
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        // Bounds only this attempt's setup (see `waitForStreamOpen`'s doc
        // comment) — a rejection here (setup timed out) is caught below
        // exactly like any other connectivity failure and goes through
        // the same cancel/backoff/retry machinery; it never becomes an
        // RPC-lifetime deadline on an already-open stream.
        await waitForStreamOpen(call, connectTimeoutMs, signal);
        for await (const raw of call) {
          const mapped = map(raw);
          if (mapped !== undefined) {
            // Reset backoff only once the stream delivers a *caller-visible*
            // message, per ojs-grpc-binding.md: "Reset the backoff after a
            // stream successfully delivers at least one job" (StreamEvents'
            // section 10.2.1 specifies the identical policy). A filtered
            // `stream.keepalive` sentinel — which `map()` drops by returning
            // `undefined` — is not such a delivery: it must not reset the
            // attempt counter, or a stream that only ever emits keepalives
            // between transient failures could reconnect forever and never
            // honor `maxAttempts`.
            attempt = 0;
            yield mapped;
          }
        }
      } finally {
        signal?.removeEventListener('abort', onAbort);
        try {
          call.cancel();
        } catch {
          // cancel() on an already-ended call is a documented no-op in
          // grpc-js; tolerate any other implementation doing the same.
        }
      }
    } catch (err) {
      streamError = err;
    }

    if (signal?.aborted) return;

    if (streamError === undefined) {
      // The stream ended without error. Both StreamJobs and StreamEvents
      // are documented as ephemeral with no distinct "permanent close"
      // signal, so this reconnects exactly like a transient failure would
      // (using the same backoff/attempt-count rules) unless the caller
      // disabled reconnection outright.
      if (!reconnectEnabled) return;
    } else if (isCancelledError(streamError)) {
      // A local caller/transport abort was handled above. Reaching this
      // branch with a live signal means the peer cancelled the RPC.
      throw asError(streamError);
    } else if (
      !reconnectEnabled ||
      !isRetryableStreamError(streamError, retryableStatusCodes)
    ) {
      throw asError(streamError);
    }

    attempt++;
    if (attempt > maxAttempts) {
      throw streamError === undefined
        ? new OJSConnectionError('gRPC stream reconnect attempts exhausted')
        : asError(streamError);
    }

    await delay(computeStreamBackoffMs(attempt, reconnect, random), signal);
  }
}

/**
 * Links an external `AbortSignal` into an internally-owned
 * `AbortController` (aborting the internal controller whenever the
 * external signal aborts), and returns a `cleanup()` to remove that
 * link once it is no longer needed. Unlike a symmetric two-way "combine"
 * (see `subscribe.ts`'s `combineSignals`), this is intentionally
 * one-directional: only the wrapper's own `internal` controller is ever
 * aborted here; the caller's external signal is never mutated. Attaches
 * exactly one listener to `external` for the wrapper's entire lifetime
 * (not per reconnect attempt), so a caller-supplied signal never
 * accumulates more than one outstanding listener from this module.
 */
function linkExternalAbort(
  internal: AbortController,
  external: AbortSignal | undefined,
): () => void {
  if (!external || internal.signal.aborted) {
    return () => undefined;
  }
  if (external.aborted) {
    internal.abort(external.reason);
    return () => undefined;
  }

  const onExternalAbort = (): void => {
    if (!internal.signal.aborted) {
      internal.abort(external.reason);
    }
  };
  external.addEventListener('abort', onExternalAbort, { once: true });

  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    external.removeEventListener('abort', onExternalAbort);
  };
}

/**
 * Consumes a server-streaming gRPC RPC as a cancellable
 * `AsyncIterableIterator`, automatically reconnecting per
 * {@link runReconnectingServerStream} (see its documentation for the
 * reconnect/backoff/backpressure/cleanup contract, which this wrapper
 * preserves unchanged).
 *
 * On top of that engine, this wrapper guarantees that calling `.return()`
 * or `.throw()` — including the implicit calls a consuming `for await`'s
 * early `break`/`return`/`throw` makes — **immediately** (synchronously,
 * the instant it is called) cancels whatever the *active* underlying call
 * is and aborts an in-progress reconnect backoff sleep, even while a
 * `.next()` call on this same iterator is still pending (e.g. blocked
 * waiting for the next message, or asleep during backoff). A bare native
 * async generator cannot give this guarantee: its `.return()`/`.throw()`
 * are queued behind any already-pending `.next()` per the AsyncGenerator
 * spec, so cancellation would otherwise wait for whatever the pending
 * step happens to be doing — which may be indefinite (network I/O) or
 * up to `maxDelayMs` long (a backoff sleep with no external `signal`).
 *
 * Ordinary external/transport cancellation (`options.signal` aborting) and
 * normal iteration continue to work exactly as {@link runReconnectingServerStream}
 * documents; this wrapper adds a second, consumer-driven cancellation path
 * without changing the first.
 */
export function reconnectingServerStream<Raw, Mapped>(
  options: ReconnectingStreamOptions<Raw, Mapped>,
): AsyncIterableIterator<Mapped> {
  const internalAbort = new AbortController();
  const unlinkExternalAbort = linkExternalAbort(internalAbort, options.signal);

  const inner = runReconnectingServerStream<Raw, Mapped>({
    ...options,
    signal: internalAbort.signal,
  });

  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    unlinkExternalAbort();
  };

  /**
   * Cancels the currently active call (if any) and aborts an in-progress
   * backoff sleep — both *synchronously*, before this function returns.
   * `AbortController.abort()` dispatches its `'abort'` event to listeners
   * synchronously (verified: it is not deferred to a microtask), so a
   * single `internalAbort.abort()` here is sufficient: it immediately
   * (same tick) runs `runReconnectingServerStream`'s own per-attempt
   * `onAbort` listener — which calls the active call's `cancel()` — if a
   * call is live, or immediately resolves its backoff `delay()` if it is
   * currently sleeping between reconnects. No separate call-tracking is
   * needed in this wrapper to get that immediacy.
   */
  const cancelActiveCallAndBackoffNow = (): void => {
    if (!internalAbort.signal.aborted) {
      internalAbort.abort(
        new OJSConnectionError('gRPC stream iterator cancelled by consumer'),
      );
    }
  };

  const iterator: AsyncIterableIterator<Mapped> = {
    async next(): Promise<IteratorResult<Mapped, void>> {
      try {
        const result = await inner.next();
        if (result.done) {
          finish();
        }
        return result;
      } catch (error) {
        finish();
        throw error;
      }
    },

    async return(value?: void | PromiseLike<void>): Promise<IteratorResult<Mapped, void>> {
      // Synchronous, immediate cancellation — see the function-level doc
      // comment above for why this cannot be left to `inner.return()`
      // alone (that call is still made below, but only to let the real
      // generator unwind its own finally blocks/listener cleanup once the
      // cancellation it now observes lets the pending step settle).
      cancelActiveCallAndBackoffNow();
      try {
        return await inner.return(value);
      } finally {
        finish();
      }
    },

    async throw(err?: unknown): Promise<IteratorResult<Mapped, void>> {
      cancelActiveCallAndBackoffNow();
      try {
        // Abort already delivered the immediate cancellation signal. Use
        // return(), not throw(), solely to let the native generator unwind
        // its finally blocks; injecting the marker into an aborting inner
        // generator can be swallowed by its clean signal-aborted return.
        await inner.return();
      } catch {
        // Cleanup is best-effort. AsyncIterator.throw(marker) must reject
        // with the exact consumer marker, including non-Error values.
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

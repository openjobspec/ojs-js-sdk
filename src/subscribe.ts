/**
 * Server-Sent Events (SSE) subscription for real-time OJS job events.
 *
 * Implements the SSE binding from ojs-realtime.md: per-job/per-queue
 * `GET .../events` endpoints, `Last-Event-ID`-based resumption, and
 * mandatory automatic reconnection with exponential backoff
 * (ojs-realtime.md section 9.3: "SDKs MUST implement automatic
 * reconnection with exponential backoff when the real-time connection
 * drops.").
 *
 * @example
 * ```ts
 * import { OJSClient } from '@openjobspec/sdk';
 * import { subscribe, subscribeJob, subscribeQueue } from '@openjobspec/sdk/subscribe';
 *
 * const client = new OJSClient({ url: 'http://localhost:8080' });
 *
 * // Subscribe to a specific job
 * const sub = subscribeJob(client, 'job-123', (event) => {
 *   console.log(`Job state: ${event.data?.to}`);
 * });
 *
 * // Later: unsubscribe (also stops any pending reconnect attempt)
 * sub.unsubscribe();
 * ```
 */

import { TERMINAL_STATES } from './job.js';

/** Represents a real-time event received from the SSE stream. */
export interface SSEEvent {
  /** SSE event ID (for resume with Last-Event-ID). */
  id?: string;
  /** Event type (e.g., 'job.state_changed', 'job.completed'). */
  type: string;
  /** Raw event data parsed as JSON. */
  data: Record<string, unknown>;
}

/** Callback invoked for each received SSE event. */
export type SSEEventHandler = (event: SSEEvent) => void;

/** Handle returned by subscribe functions. Call unsubscribe() to disconnect. */
export interface SSESubscription {
  /** Stop receiving events, cancel any pending reconnect, and close the SSE connection. */
  unsubscribe(): void;
}

/** Typed SSE connection failure with HTTP/retry metadata when available. */
export class SSEConnectionError extends Error {
  /** HTTP status for response failures; undefined for network/stream drops. */
  readonly status: number | undefined;
  /** Server-advised reconnect delay parsed from Retry-After, in milliseconds. */
  readonly retryAfterMs: number | undefined;
  /** Whether reconnecting this failure is safe. */
  readonly retryable: boolean;

  constructor(
    message: string,
    options: {
      status?: number | undefined;
      retryAfterMs?: number | undefined;
      retryable: boolean;
      cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SSEConnectionError';
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = options.retryable;
  }
}

class SSEHandlerError extends Error {
  declare readonly cause: unknown;
  readonly stopConnection: boolean;

  constructor(cause: unknown, stopConnection = false) {
    super('SSE event handler failed', { cause });
    this.name = 'SSEHandlerError';
    this.cause = cause;
    this.stopConnection = stopConnection;
  }
}

type EventDispatchControl = 'continue' | 'stop';
type ConnectResult = 'eof' | 'stopped';
type ConnectEventHandler = (
  event: SSEEvent,
) => EventDispatchControl | Promise<EventDispatchControl>;

export interface SubscribeOptions {
  /** Base URL of the OJS server. */
  url: string;
  /** ****** token (optional). */
  auth?: string | undefined;
  /**
   * SSE channel to subscribe to. Must be `job:<id>` (see ojs-realtime.md
   * section 2.1) or `queue:<name>` (section 2.2) — these are the only two
   * subscription endpoints the SSE binding defines. Prefer
   * {@link subscribeJob} / {@link subscribeQueue} over constructing this
   * string directly.
   */
  channel: string;
  /** AbortSignal for external cancellation. */
  signal?: AbortSignal;
  /**
   * Called whenever the underlying connection fails (initial connect,
   * mid-stream drop, or reconnect attempt). Errors are otherwise only
   * logged via `console.warn`. Does not fire for the abort caused by
   * calling `unsubscribe()`.
   */
  onError?: ((error: unknown) => void) | undefined;
  /**
   * Whether to automatically reconnect with exponential backoff when the
   * connection drops (per ojs-realtime.md section 9.3). Default: `true`.
   */
  reconnect?: boolean | undefined;
  /** Maximum consecutive reconnect attempts before giving up. Default: unlimited. */
  maxReconnectAttempts?: number | undefined;
}

/** Default reconnect delay, matching the spec's RECOMMENDED SSE `retry:` value (ojs-realtime.md section 2.3). */
const DEFAULT_RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 30_000;

const JOB_CHANNEL_RE = /^job:(.+)$/;
const QUEUE_CHANNEL_RE = /^queue:(.+)$/;

function isTransientHttpStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) {
    return Math.max(0, timestamp - Date.now());
  }
  return undefined;
}

class SSEChannelValidationError extends Error {
  constructor(channel: string) {
    super(
      `Unsupported SSE channel '${channel}'. Expected 'job:<id>' or 'queue:<name>' ` +
        '(see ojs-realtime.md sections 2.1/2.2); use subscribeJob()/subscribeQueue() ' +
        'or pass a channel in one of these two forms.',
    );
    this.name = 'SSEChannelValidationError';
  }
}

/**
 * Resolve the spec-defined HTTP path for a channel identifier.
 * See ojs-realtime.md sections 2.1 (`/jobs/{id}/events`) and
 * 2.2 (`/queues/{name}/events`) — the SSE binding defines no other
 * subscription endpoint.
 */
function resolveChannelPath(channel: string): string {
  const jobMatch = JOB_CHANNEL_RE.exec(channel);
  if (jobMatch?.[1]) {
    return `/ojs/v1/jobs/${encodeURIComponent(jobMatch[1])}/events`;
  }
  const queueMatch = QUEUE_CHANNEL_RE.exec(channel);
  if (queueMatch?.[1]) {
    return `/ojs/v1/queues/${encodeURIComponent(queueMatch[1])}/events`;
  }
  throw new SSEChannelValidationError(channel);
}

/**
 * Combines an internal AbortController's signal with an optional external
 * one, without `AbortSignal.any()` — that API requires Node.js >=20.3,
 * but this package supports Node.js >=18 (see package.json engines).
 */
function combineSignals(
  internal: AbortSignal,
  external: AbortSignal | undefined,
  onExternalStop?: () => void,
): { signal: AbortSignal; cleanup: () => void } {
  if (!external) {
    return { signal: internal, cleanup: () => undefined };
  }
  const externalSignal = external;

  const combined = new AbortController();
  let internalListenerAttached = false;
  let externalListenerAttached = false;
  let cleaned = false;

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (internalListenerAttached) {
      internal.removeEventListener('abort', onInternalAbort);
      internalListenerAttached = false;
    }
    if (externalListenerAttached) {
      externalSignal.removeEventListener('abort', onExternalAbort);
      externalListenerAttached = false;
    }
  };

  const propagate = (source: AbortSignal): void => {
    if (!combined.signal.aborted) {
      combined.abort(source.reason);
    }
    cleanup();
  };

  function onInternalAbort(): void {
    propagate(internal);
  }

  function onExternalAbort(): void {
    propagate(externalSignal);
    onExternalStop?.();
  }

  if (internal.aborted) {
    propagate(internal);
  } else {
    internal.addEventListener('abort', onInternalAbort, { once: true });
    internalListenerAttached = true;
  }

  if (!combined.signal.aborted) {
    if (externalSignal.aborted) {
      propagate(externalSignal);
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      externalListenerAttached = true;
    }
  }

  return { signal: combined.signal, cleanup };
}

/**
 * Subscribe to an SSE event stream from the OJS server.
 *
 * Works in both Node.js and browser environments using fetch streaming.
 * Automatically reconnects with exponential backoff on disconnection,
 * resuming via `Last-Event-ID` (per ojs-realtime.md sections 2.5 and 9.3),
 * unless `reconnect: false` is passed.
 */
export function subscribe(
  options: SubscribeOptions,
  handler: SSEEventHandler,
): SSESubscription {
  const ownController = new AbortController();
  let stop: (reason?: unknown) => void = () => undefined;
  const signalComposition = combineSignals(
    ownController.signal,
    options.signal,
    () => stop(options.signal?.reason),
  );
  const signal = signalComposition.signal;

  const shouldReconnect = options.reconnect ?? true;
  const maxAttempts = options.maxReconnectAttempts ?? Infinity;
  // Only a *per-job* subscription's stream can ever cleanly end because
  // the job reached a state from which it will never produce another
  // event (ojs-realtime.md section 2.1: "If the job is in a terminal
  // state..., the server SHOULD send a single job.state_changed event
  // reflecting the current state and then close the stream."). A queue
  // subscription has no such concept — many jobs continue to flow through
  // it indefinitely — so it must keep the existing reconnect-on-clean-close
  // behavior unconditionally.
  const isJobChannel = JOB_CHANNEL_RE.test(options.channel);

  let lastEventId: string | undefined;
  let baseReconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  // One-shot HTTP `Retry-After` override for the *next* scheduled reconnect
  // only (RFC 9110 section 10.2.3: it advises the wait before the client's
  // very next retry of this specific request, nothing beyond that). Unlike
  // the persistent SSE `retry:` hint (which updates `baseReconnectDelayMs`
  // for the life of the subscription), a `Retry-After` value must never
  // mutate `baseReconnectDelayMs` — otherwise a single transient 429/503
  // would permanently slow down (or speed up) every future reconnect,
  // including ones long after the server recovered. It is consumed
  // (cleared) the moment it is applied in `nextReconnectDelay()`, and it
  // still advances `reconnectAttempt` like any other scheduled reconnect
  // so the attempt budget (`maxReconnectAttempts`) is unaffected.
  let pendingRetryAfterMs: number | undefined;

  /**
   * Permanently and idempotently stops this subscription: cancels any
   * pending reconnect timer, aborts the internal controller (which tears
   * down an in-flight connection's reader/fetch), removes both signal
   * composition listeners, and marks it so no further reconnect is ever
   * scheduled. Used both by the caller-facing
   * `unsubscribe()` and internally once a per-job terminal state is
   * observed.
   */
  stop = (reason?: unknown): void => {
    if (stopped) return;
    stopped = true;
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    ownController.abort(reason);
    signalComposition.cleanup();
  };

  if (options.signal?.aborted) {
    stop(options.signal.reason);
  }

  const connectAndWait = (): void => {
    if (stopped || signal.aborted) return;

    const trackingHandler: ConnectEventHandler = async (event) => {
      const shouldStop =
        isJobChannel &&
        event.type === 'job.state_changed' &&
        isTerminalJobStateEvent(event.data);
      try {
        await invokeEventHandler(handler, event);
      } catch (cause: unknown) {
        // Preserve terminal control even when user delivery fails so
        // connectOnce can cancel the reader before surfacing the original
        // handler error to onError.
        throw new SSEHandlerError(cause, shouldStop);
      }
      return shouldStop ? 'stop' : 'continue';
    };

    connectOnce(options, signal, trackingHandler, {
      onEventId: (id) => {
        lastEventId = id;
      },
      onRetryHint: (ms) => {
        baseReconnectDelayMs = ms;
      },
      // Any real SSE-level activity on this connection — a heartbeat
      // comment or a fully parsed event, per `connectOnce`'s doc comment
      // on `ConnectCallbacks.onActivity` — proves it is genuinely live,
      // so the reconnect backoff counter resets. A no-op/empty chunk
      // read from the underlying stream never reaches this callback at
      // all (see `connectOnce`), so it can never reset the counter on
      // its own.
      onActivity: () => {
        reconnectAttempt = 0;
      },
      onStopRequested: (reason) => {
        stop(reason);
      },
      lastEventId,
    })
      .then((result) => {
        if (result === 'stopped') {
          // connectOnce already applied the handler's explicit stop control,
          // cancelled the active reader, and stopped this subscription.
          return;
        }
        // The stream ended (server closed it, or simply dropped) without
        // throwing, and this wasn't a per-job terminal completion. Per the
        // SSE model (matching browser EventSource semantics), any other
        // stream end is followed by a reconnect unless the caller opted
        // out or unsubscribed meanwhile.
        // Clean closure uses the same reconnect budget as errors.
        if (!shouldReconnect || reconnectAttempt >= maxAttempts) {
          stop();
          return;
        }
        scheduleReconnectIfNeeded(nextReconnectDelay());
      })
      .catch((err: unknown) => {
        const terminalHandlerFailure =
          err instanceof SSEHandlerError && err.stopConnection;
        if ((stopped || signal.aborted) && !terminalHandlerFailure) {
          return; // deliberate unsubscribe
        }
        const reportedError =
          err instanceof SSEHandlerError
            ? err.cause
            : err instanceof SSEConnectionError &&
                err.status === undefined &&
                err.cause !== undefined
              ? err.cause
              : err;

        // Isolate onError callback exceptions (Finding 4): never let a
        // user-provided callback crash reconnect/termination logic.
        try {
          const callbackResult = (
            options.onError as ((error: unknown) => unknown) | undefined
          )?.(reportedError);
          if (
            callbackResult !== null &&
            typeof callbackResult === 'object' &&
            'then' in callbackResult
          ) {
            void Promise.resolve(callbackResult).catch((cbErr: unknown) => {
              console.warn('[ojs-subscribe] onError callback rejected:', cbErr);
            });
          }
        } catch (cbErr) {
          console.warn('[ojs-subscribe] onError callback threw:', cbErr);
        }

        if (terminalHandlerFailure) {
          // Terminality is authoritative even when delivery to user code
          // fails. connectOnce has already stopped the subscription and
          // cancelled the reader; keep onError exactly-once and never
          // reconnect or replay the terminal event.
          stop(reportedError);
          return;
        }

        if (err instanceof SSEChannelValidationError) {
          console.warn('[ojs-subscribe] SSE subscription validation failed:', String(err));
          stop();
          return;
        }

        if (err instanceof SSEHandlerError) {
          console.warn('[ojs-subscribe] SSE event handler failed; subscription stopped:', String(reportedError));
          stop();
          return;
        }

        if (!(err instanceof SSEConnectionError) || !err.retryable) {
          console.warn('[ojs-subscribe] SSE connection failed permanently:', String(err));
          stop();
          return;
        }

        if (err.retryAfterMs !== undefined) {
          // Applies only to the very next scheduled reconnect below — see
          // the `pendingRetryAfterMs` declaration for why this must never
          // touch `baseReconnectDelayMs`.
          pendingRetryAfterMs = err.retryAfterMs;
        }

        if (!shouldReconnect || reconnectAttempt >= maxAttempts) {
          console.warn('[ojs-subscribe] SSE connection failed and will not be retried:', String(err));
          stop();
          return;
        }
        scheduleReconnectIfNeeded(nextReconnectDelay());
      });
  };

  const nextReconnectDelay = (): number => {
    // The attempt budget always advances, whether or not a one-shot
    // Retry-After override is present, so `maxReconnectAttempts` is
    // consumed uniformly regardless of which delay source is used.
    reconnectAttempt++;
    if (pendingRetryAfterMs !== undefined) {
      const overrideDelayMs = pendingRetryAfterMs;
      // Single-use: consumed immediately so it can never leak into any
      // later reconnect, including ones scheduled after this same
      // override is applied (e.g. a subsequent failure with no
      // Retry-After header falls straight back to `baseReconnectDelayMs`).
      pendingRetryAfterMs = undefined;
      // Honored exactly and uncapped (Finding: SSE Retry-After): RFC 9110
      // section 10.2.3 lets the server name any delay it wants before the
      // client's next retry of this exact request, including one longer
      // than this SDK's own local exponential-backoff ceiling
      // (`MAX_RECONNECT_DELAY_MS`) -- e.g. an hour during a maintenance
      // window. That ceiling exists only to bound *this client's own*
      // unbounded exponential growth; it was never meant to silently
      // override an explicit, authoritative server instruction with a
      // shorter wait, which would ignore the very back-pressure signal
      // Retry-After exists to provide.
      return overrideDelayMs;
    }
    return Math.min(
      baseReconnectDelayMs * Math.pow(2, reconnectAttempt - 1),
      MAX_RECONNECT_DELAY_MS,
    );
  };

  const scheduleReconnectIfNeeded = (delayMs: number): void => {
    if (stopped || signal.aborted || !shouldReconnect) return;
    reconnectTimer = setTimeout(connectAndWait, delayMs);
  };

  connectAndWait();

  return {
    unsubscribe() {
      stop();
    },
  };
}

/**
 * Detects a `job.state_changed` event whose `data.to` field (the job's new
 * state) is one of the OJS terminal states — `job.ts`'s `TERMINAL_STATES`
 * (completed/cancelled/discarded), this SDK's single source of truth for
 * that set, also part of its public API. Per ojs-realtime.md section 2.1,
 * the server sends exactly this event immediately before closing a
 * per-job SSE stream once the job can never produce further events.
 *
 * Defensive against malformed/fragmented data: `data` is whatever
 * `JSON.parse()` produced (see `connectOnce()`), which is not guaranteed
 * to actually be an object despite `SSEEvent.data`'s static type, and a
 * `to` that isn't a recognized terminal-state string safely reports
 * "not terminal" rather than throwing — reconnect-on-clean-close is the
 * safe default when terminality can't be confirmed.
 */
function isTerminalJobStateEvent(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false;
  const to = (data as Record<string, unknown>).to;
  if (typeof to !== 'string') return false;
  for (const terminal of TERMINAL_STATES) {
    if (terminal === to) return true;
  }
  return false;
}

/**
 * Subscribe to events for a specific job.
 * See ojs-realtime.md section 2.1 (`GET /ojs/v1/jobs/{id}/events`).
 */
export function subscribeJob(
  config: { url: string; auth?: string },
  jobId: string,
  handler: SSEEventHandler,
): SSESubscription {
  return subscribe(
    { url: config.url, auth: config.auth, channel: `job:${jobId}` },
    handler,
  );
}

/**
 * Subscribe to events for all jobs in a queue.
 * See ojs-realtime.md section 2.2 (`GET /ojs/v1/queues/{name}/events`).
 */
export function subscribeQueue(
  config: { url: string; auth?: string },
  queue: string,
  handler: SSEEventHandler,
): SSESubscription {
  return subscribe(
    { url: config.url, auth: config.auth, channel: `queue:${queue}` },
    handler,
  );
}

interface ConnectCallbacks {
  onEventId: (id: string) => void;
  onRetryHint: (ms: number) => void;
  /**
   * Invoked for any raw SSE-level activity that proves the connection is
   * genuinely live: a heartbeat/comment line (`:...`, ojs-realtime.md
   * section 9.2's keep-alive comment) or a fully parsed event frame,
   * *before* that event is dispatched to the caller's handler. Does
   * **not** fire for an empty/no-op chunk read from the underlying
   * stream (a chunk that decodes to no complete line) — only a
   * complete SSE line proves the peer is actively sending something,
   * not merely that the TCP connection is still technically open.
   * `subscribe()` uses this to reset its reconnect backoff counter; see
   * its `trackingHandler`/this callback's call sites below.
   */
  onActivity: () => void;
  /**
   * Applies an explicit stop requested by the event handler before
   * connectOnce awaits reader cancellation.
   */
  onStopRequested: (reason: unknown) => void;
  lastEventId: string | undefined;
}

function invokeEventHandler(
  handler: SSEEventHandler,
  event: SSEEvent,
): Promise<void> {
  const result = (handler as (event: SSEEvent) => unknown)(event);
  return Promise.resolve(result).then(() => undefined);
}

/**
 * Sentinel returned by {@link settleHandlerOrAbort} when `signal` aborts
 * before `handlerPromise` settles.
 */
const HANDLER_ABORTED = Symbol('ojs.sse.handler-aborted');

/**
 * Awaits `handlerPromise`, but resolves/rejects early with
 * {@link HANDLER_ABORTED} if `signal` aborts first (Finding: SSE
 * unsubscribe during async handler). `unsubscribe()` (or an external
 * `options.signal` abort) must be able to interrupt a handler that is
 * slow, or that never settles at all -- e.g. one awaiting some unrelated
 * external resource -- instead of blocking cancellation on it
 * indefinitely: the whole point of `unsubscribe()` is an immediate,
 * unconditional stop.
 *
 * `handlerPromise`'s *eventual* settlement is always consumed via a
 * permanently-attached no-op rejection handler, attached synchronously
 * before either race outcome is possible, so a handler that later
 * resolves or (especially) rejects can never surface as an unhandled
 * promise rejection even though nothing else ever awaits it again once
 * the signal has won the race — its result/error is simply discarded at
 * that point, since the subscription is already tearing down.
 */
function settleHandlerOrAbort(
  handlerPromise: Promise<EventDispatchControl>,
  signal: AbortSignal,
): Promise<EventDispatchControl | typeof HANDLER_ABORTED> {
  handlerPromise.catch(() => undefined);

  if (signal.aborted) {
    return Promise.resolve(HANDLER_ABORTED);
  }

  return new Promise<EventDispatchControl | typeof HANDLER_ABORTED>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(HANDLER_ABORTED);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    handlerPromise.then(
      (control) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(control);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- must preserve the handler's rejection reason by identity (including a non-Error value); the caller normalizes it (instanceof SSEHandlerError check, then `new SSEHandlerError(cause)`), exactly like this SDK's other pass-through rejection points (e.g. AsyncIterator.throw in transport/grpc-stream.ts).
        reject(error);
      },
    );
  });
}

async function connectOnce(
  options: SubscribeOptions,
  signal: AbortSignal,
  handler: ConnectEventHandler,
  callbacks: ConnectCallbacks,
): Promise<ConnectResult> {
  const path = resolveChannelPath(options.channel);
  const url = `${options.url.replace(/\/+$/, '')}${path}`;

  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    'Cache-Control': 'no-cache',
  };
  if (options.auth) {
    headers.Authorization = `Bearer ${options.auth}`;
  }
  if (callbacks.lastEventId !== undefined) {
    // Per ojs-realtime.md section 2.5/9.3: SSE clients MUST include
    // Last-Event-ID when reconnecting so the server can replay missed events.
    headers['Last-Event-ID'] = callbacks.lastEventId;
  }

  let response: Response;
  try {
    response = await fetch(url, { headers, signal });
  } catch (cause: unknown) {
    if (signal.aborted) throw cause;
    throw new SSEConnectionError('SSE network connection failed', {
      retryable: true,
      cause,
    });
  }

  if (!response.ok) {
    const retryAfterMs = parseRetryAfter(
      response.headers?.get('Retry-After') ?? null,
    );
    if (response.body) {
      void response.body.cancel().catch(() => {
        // Best-effort release of an unread error response body.
      });
    }
    throw new SSEConnectionError(
      `SSE connection failed: HTTP ${response.status}`,
      {
        status: response.status,
        retryable: isTransientHttpStatus(response.status),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      },
    );
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new SSEConnectionError('SSE response has no readable body', {
      retryable: true,
    });
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let eventType = '';
  let eventId = '';
  let eventData = '';

  const cancelReader = async (reason: unknown): Promise<void> => {
    try {
      await reader.cancel(reason);
    } catch {
      // Best-effort cleanup. A cancellation failure must never replace the
      // terminal control or original stream/handler failure.
    }
  };

  try {
    while (true) {
      // Pull-based reading is inherently backpressure-safe: another chunk
      // is only requested once the previous one has been fully processed
      // (parsed and dispatched to `handler`) below.
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await reader.read();
      } catch (cause: unknown) {
        throw new SSEConnectionError('SSE stream disconnected', {
          retryable: true,
          cause,
        });
      }
      const { done, value } = read;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const splitLine of lines) {
        // Splitting on LF leaves the CR from a CRLF delimiter attached to
        // the line. Remove exactly that one delimiter byte: this turns a
        // CRLF blank line into the same boundary as an LF blank line while
        // preserving any preceding carriage return that belongs to data.
        const line = splitLine.endsWith('\r') ? splitLine.slice(0, -1) : splitLine;
        if (line === '') {
          // Empty line = event boundary
          if (eventData) {
            // A fully parsed event frame is unambiguous proof of a live
            // connection — signal this *before* dispatching to the
            // caller's handler (matching the timing a plain event
            // delivery has always used to reset reconnect backoff), so a
            // handler that throws/rejects still counts as "the
            // connection was live," which is a fact about the transport,
            // not about the caller's own processing of it.
            callbacks.onActivity();
            if (eventId) callbacks.onEventId(eventId);
            const idField = eventId ? { id: eventId } : {};
            let data: Record<string, unknown>;
            try {
              data = JSON.parse(eventData) as Record<string, unknown>;
            } catch {
              data = { raw: eventData };
            }

            // `unsubscribe()`/an external abort may fire while this
            // handler is still pending -- including one that never
            // settles at all. Race its settlement against `signal`
            // (Finding: SSE unsubscribe during async handler) instead of
            // unconditionally `await`ing it, so cancellation is never
            // blocked on a slow or hung handler. Defensively re-checked
            // even before invoking the handler: if the signal happened
            // to already be aborted by this point (e.g. a prior event in
            // this same buffered chunk requested a stop -- itself
            // already handled below by an early `return` -- or some
            // other synchronous side effect), the handler is skipped
            // entirely rather than dispatched after the subscription was
            // already told to stop.
            if (signal.aborted) {
              await cancelReader(signal.reason);
              return 'stopped';
            }

            let outcome: EventDispatchControl | typeof HANDLER_ABORTED;
            try {
              // `handler(...)` itself stays *inside* this try: a
              // synchronous throw (before any Promise is ever created,
              // and so before `settleHandlerOrAbort` could ever register
              // its own abort listener) must be caught here exactly like
              // an asynchronous rejection is, not propagate past this
              // block unconverted.
              const handlerPromise = Promise.resolve(
                handler({
                  ...idField,
                  type: eventType || 'message',
                  data,
                }),
              );
              outcome = await settleHandlerOrAbort(handlerPromise, signal);
            } catch (cause: unknown) {
              if (cause instanceof SSEHandlerError) throw cause;
              throw new SSEHandlerError(cause);
            }

            if (outcome === HANDLER_ABORTED) {
              // The subscription was aborted while this handler was still
              // pending (possibly never settling at all). Stop waiting
              // for it immediately: cancel/release the reader now and
              // never dispatch any further lines already buffered from
              // this same chunk -- dispatching a second event after the
              // subscription has been told to stop would contradict the
              // "stop means stop" contract `unsubscribe()` promises. The
              // handler's own eventual resolution/rejection (if any) was
              // already wired to a no-op continuation inside
              // `settleHandlerOrAbort`, so it can never surface as an
              // unhandled promise rejection.
              await cancelReader(signal.reason);
              return 'stopped';
            }

            if (outcome === 'stop') {
              const reason = new Error(
                'Terminal job state received; SSE subscription completed',
              );
              // Start cancellation before aborting the composed fetch
              // signal, then synchronously mark the subscription stopped.
              // Returning here prevents dispatch of every later line/event
              // already buffered in this same chunk.
              const cancellation = cancelReader(reason);
              callbacks.onStopRequested(reason);
              await cancellation;
              return 'stopped';
            }
          }
          eventType = '';
          eventId = '';
          eventData = '';
        } else if (line.startsWith('event:')) {
          eventType = sseFieldValue(line, 6);
        } else if (line.startsWith('id:')) {
          eventId = sseFieldValue(line, 3);
        } else if (line.startsWith('data:')) {
          const chunk = sseFieldValue(line, 5);
          eventData = eventData ? eventData + '\n' + chunk : chunk;
        } else if (line.startsWith('retry:')) {
          // ojs-realtime.md section 2.3: advises the reconnection interval.
          const ms = parseInt(sseFieldValue(line, 6), 10);
          if (!isNaN(ms) && ms >= 0) callbacks.onRetryHint(ms);
        } else if (line.startsWith(':')) {
          // Comment line — the SSE keep-alive/heartbeat convention
          // (ojs-realtime.md section 9.2: "servers SHOULD send a comment
          // line... to keep the connection alive"). Content is
          // otherwise ignored, but receiving one is real proof the peer
          // is actively sending on this connection, unlike merely
          // reading an empty/no-op chunk with no complete line in it at
          // all (which never reaches this loop body to begin with).
          callbacks.onActivity();
        }
        // Any other unrecognized field is ignored.
      }
    }

    function sseFieldValue(line: string, prefixLength: number): string {
      const value = line.slice(prefixLength);
      return value.startsWith(' ') ? value.slice(1) : value;
    }
    return 'eof';
  } catch (err) {
    // Abnormal exit — a synchronous/asynchronous handler throw or
    // rejection (via invokeEventHandler above), a `reader.read()`
    // failure (including one caused by `signal` aborting mid-read), or
    // a decode/parse failure that escaped its own local try/catch.
    // Cancelling here (rather than merely releasing the lock) tells the
    // underlying source (the fetch response body) that no more data
    // will ever be read, letting it release any underlying connection
    // socket instead of leaving it half-read until GC. This is
    // best-effort only: `reader.cancel()` itself is not allowed to mask
    // or replace `err`, the original failure that triggered this exit,
    // so any cancellation failure is swallowed here.
    const cancellationReason =
      (err instanceof SSEHandlerError || err instanceof SSEConnectionError) &&
      err.cause !== undefined
        ? err.cause
        : err;
    const cancellation = cancelReader(cancellationReason);
    if (err instanceof SSEHandlerError && err.stopConnection) {
      callbacks.onStopRequested(cancellationReason);
    }
    await cancellation;
    throw err;
  } finally {
    // A clean EOF (`done === true` above, the `while` loop's normal
    // `break`) never throws and therefore never entered the `catch`
    // above — the stream already ended on its own, so no `cancel()` is
    // needed, only the lock release every exit path requires.
    reader.releaseLock();
  }
}

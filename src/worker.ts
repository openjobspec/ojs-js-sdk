/**
 * OJS Worker — the consumer-side API for processing jobs.
 *
 * The worker polls the server for jobs, executes registered handlers,
 * and sends ack/nack responses. All retry/scheduling intelligence
 * lives in the server.
 */

import { HttpTransport } from './transport/http.js';
import type { Transport, TransportRequestOptions } from './transport/types.js';
import {
  normalizeJobResponse,
  normalizeHandlerResult,
  type Job,
  type JsonValue,
  type JobError,
} from './job.js';
import {
  MiddlewareChain,
  composeExecution,
  type ExecutionMiddleware,
  type JobContext,
} from './middleware.js';
import { OJSEventEmitter, type OJSEvent, type JobCompletedData } from './events.js';
import { OJSError, OJSTimeoutError } from './errors.js';
import { DurableContext, type DurableJobHandler } from './durable.js';
import { TimeoutError } from './middleware/timeout.js';
import { generateUuidV4 } from './uuid.js';

/** Worker lifecycle state per the OJS Worker Protocol. */
export type WorkerState = 'running' | 'quiet' | 'terminate' | 'terminated';

/** A job handler function. */
export type JobHandler = (ctx: JobContext) => Promise<unknown>;

/** Configuration for OJSWorker. */
export interface OJSWorkerConfig {
  /** Base URL of the OJS server. */
  url: string;
  /** Queues to poll for jobs (in priority order). */
  queues?: string[];
  /** Maximum number of concurrent jobs. Default: 10. */
  concurrency?: number;
  /** Poll interval in milliseconds when no jobs are available. Default: 1000. */
  pollInterval?: number;
  /** Heartbeat interval in milliseconds. Default: 5000. */
  heartbeatInterval?: number;
  /** Grace period in milliseconds for shutdown. Default: 25000. */
  shutdownTimeout?: number;
  /** Visibility timeout requested per fetch in milliseconds. Default: 30000. */
  visibilityTimeout?: number;
  /** Authorization header value. */
  auth?: string;
  /** Custom headers. */
  headers?: Record<string, string>;
  /** Custom transport (for testing). */
  transport?: Transport;
  /** Worker labels for filtering and grouping. */
  labels?: string[];
  /**
   * Automatically handle SIGTERM and SIGINT for graceful shutdown.
   * When enabled, the worker installs process signal handlers on start()
   * and removes them on stop(). Set to false if you manage signals yourself.
   * Default: true (Node.js only; no-op in browsers).
   */
  handleSignals?: boolean;
}

export class OJSWorker {
  private readonly transport: Transport;
  private readonly handlers = new Map<string, JobHandler>();
  private readonly executionMiddleware = new MiddlewareChain<ExecutionMiddleware>();
  private readonly config: Required<
    Pick<
      OJSWorkerConfig,
      | 'queues'
      | 'concurrency'
      | 'pollInterval'
      | 'heartbeatInterval'
      | 'shutdownTimeout'
      | 'visibilityTimeout'
    >
  > & { labels: string[] };

  /** The unique worker ID for this instance. */
  readonly workerId: string;

  /** Event emitter for worker-side events. */
  readonly events = new OJSEventEmitter();

  private state: WorkerState = 'terminated';
  private activeJobs = new Map<string, AbortController>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private jobsCompleted = 0;
  private startedAt = 0;
  private consecutivePollErrors = 0;
  private shutdownPromise: Promise<void> | null = null;
  private shutdownResolve: (() => void) | null = null;
  private graceTimerId: ReturnType<typeof setTimeout> | null = null;
  private readonly handleSignals: boolean;
  private signalHandler: (() => void) | null = null;

  constructor(workerConfig: OJSWorkerConfig) {
    this.transport =
      workerConfig.transport ??
      new HttpTransport({
        url: workerConfig.url,
        auth: workerConfig.auth,
        headers: workerConfig.headers,
      });

    this.workerId = `worker_${generateUuidV4()}`;

    this.config = {
      queues: workerConfig.queues ?? ['default'],
      concurrency: workerConfig.concurrency ?? 10,
      pollInterval: workerConfig.pollInterval ?? 1000,
      heartbeatInterval: workerConfig.heartbeatInterval ?? 5000,
      shutdownTimeout: workerConfig.shutdownTimeout ?? 25000,
      visibilityTimeout: workerConfig.visibilityTimeout ?? 30000,
      labels: workerConfig.labels ?? [],
    };

    // Default to true in Node.js environments, false in browsers
    this.handleSignals =
      workerConfig.handleSignals ??
      (typeof process !== 'undefined' && typeof process.on === 'function');
  }

  /** Current worker lifecycle state. */
  get currentState(): WorkerState {
    return this.state;
  }

  /** Number of jobs currently being processed. */
  get activeJobCount(): number {
    return this.activeJobs.size;
  }

  // ---- Registration ----

  /**
   * Register a handler for a job type.
   *
   * @param type - The dot-namespaced job type (e.g., 'email.send').
   * @param handler - The async function that processes the job.
   *
   * @example
   * ```ts
   * worker.register('email.send', async (ctx) => {
   *   const { to, template } = ctx.job.args;
   *   await sendEmail(to, template);
   *   return { messageId: '...' };
   * });
   * ```
   */
  register(type: string, handler: JobHandler): this {
    this.handlers.set(type, handler);
    return this;
  }

  /**
   * Register a durable job handler with checkpoint support.
   *
   * The handler receives a {@link DurableContext} that provides deterministic
   * wrappers for non-deterministic operations (time, random, external calls).
   *
   * @example
   * ```ts
   * worker.registerDurable('etl.process', async (ctx, dc) => {
   *   const data = await dc.sideEffect('fetch', () => fetchFromAPI());
   *   await dc.checkpoint(1, { fetched: true });
   *   await dc.complete();
   * });
   * ```
   */
  registerDurable(type: string, handler: DurableJobHandler): this {
    this.handlers.set(type, async (ctx: JobContext) => {
      const dc = await DurableContext.create(this.transport, ctx.job.id, ctx.attempt);
      return handler(ctx, dc);
    });
    return this;
  }

  /**
   * Add execution middleware. Wraps job handler invocation
   * using the onion/next() pattern.
   *
   * @param fn - The middleware function, or a name + function.
   *
   * @example
   * ```ts
   * worker.use(async (ctx, next) => {
   *   console.log(`Processing ${ctx.job.type}`);
   *   const start = Date.now();
   *   await next();
   *   console.log(`Done in ${Date.now() - start}ms`);
   * });
   * ```
   */
  use(fn: ExecutionMiddleware): this;
  use(name: string, fn: ExecutionMiddleware): this;
  use(
    nameOrFn: string | ExecutionMiddleware,
    fn?: ExecutionMiddleware,
  ): this {
    if (typeof nameOrFn === 'function') {
      this.executionMiddleware.add(
        `middleware_${this.executionMiddleware.length}`,
        nameOrFn,
      );
    } else {
      this.executionMiddleware.add(nameOrFn, fn!);
    }
    return this;
  }

  /** Access the execution middleware chain for fine-grained control. */
  get middleware(): MiddlewareChain<ExecutionMiddleware> {
    return this.executionMiddleware;
  }

  // ---- Lifecycle ----

  /**
   * Start the worker. Begins polling for jobs and sending heartbeats.
   */
  async start(): Promise<void> {
    if (this.state === 'running' || this.state === 'quiet') {
      throw new Error(`Worker is already ${this.state}.`);
    }

    this.state = 'running';
    this.startedAt = Date.now();
    this.jobsCompleted = 0;
    this.consecutivePollErrors = 0;

    // Emit worker.started event
    await this.events.emit(
      OJSEventEmitter.createEvent(
        'worker.started',
        `ojs://sdk/workers/${this.workerId}`,
        {
          worker_id: this.workerId,
          queues: this.config.queues,
          concurrency: this.config.concurrency,
        },
      ),
    );

    // Start heartbeat loop
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat().catch((err) => {
        console.warn('[ojs-worker] heartbeat failed:', String(err));
      });
    }, this.config.heartbeatInterval);

    // Install process signal handlers for graceful shutdown in containers/K8s
    if (this.handleSignals && typeof process !== 'undefined' && typeof process.on === 'function') {
      this.signalHandler = () => {
        this.stop().catch((err) => {
          console.warn('[ojs-worker] shutdown error:', String(err));
        });
      };
      process.on('SIGTERM', this.signalHandler);
      process.on('SIGINT', this.signalHandler);
    }

    // Start poll loop
    this.poll();
  }

  /**
   * Gracefully stop the worker.
   * Stops fetching new jobs and waits for active jobs to complete
   * within the shutdown timeout.
   */
  async stop(): Promise<void> {
    if (this.state === 'terminated') return;

    if (this.state === 'running') {
      this.state = 'quiet';
    }

    // Transition to terminate
    this.state = 'terminate';

    // Stop polling
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Stop heartbeats
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Remove signal handlers to prevent memory leaks and duplicate triggers
    if (this.signalHandler && typeof process !== 'undefined' && typeof process.removeListener === 'function') {
      process.removeListener('SIGTERM', this.signalHandler);
      process.removeListener('SIGINT', this.signalHandler);
      this.signalHandler = null;
    }

    // Wait for active jobs with a timeout
    if (this.activeJobs.size > 0) {
      await Promise.race([
        this.waitForActiveJobs(),
        this.gracePeriodTimeout(),
      ]);
    }

    // Clean up grace timer if it's still running
    if (this.graceTimerId) {
      clearTimeout(this.graceTimerId);
      this.graceTimerId = null;
    }

    // Abort any remaining jobs after grace period
    for (const [, controller] of this.activeJobs) {
      controller.abort();
    }

    this.state = 'terminated';

    // Emit worker.stopped event
    await this.events.emit(
      OJSEventEmitter.createEvent(
        'worker.stopped',
        `ojs://sdk/workers/${this.workerId}`,
        {
          worker_id: this.workerId,
          reason: 'graceful_shutdown',
          jobs_completed: this.jobsCompleted,
          uptime_ms: Date.now() - this.startedAt,
        },
      ),
    );
  }

  // ---- Internal: Poll Loop ----

  private poll(): void {
    if (this.state !== 'running') return;
    if (this.activeJobs.size >= this.config.concurrency) {
      // At capacity, wait and try again
      this.pollTimer = setTimeout(() => this.poll(), this.config.pollInterval);
      return;
    }

    this.fetchAndProcess()
      .then((fetched) => {
        if (this.state !== 'running') return;

        this.consecutivePollErrors = 0;
        // If we got jobs, poll immediately for more. Otherwise, back off.
        const delay = fetched > 0 ? 0 : this.config.pollInterval;
        this.pollTimer = setTimeout(() => this.poll(), delay);
      })
      .catch(() => {
        // Exponential backoff on consecutive errors, capped at 30s
        if (this.state === 'running') {
          this.consecutivePollErrors++;
          const maxBackoff = 30_000;
          const delay = Math.min(
            this.config.pollInterval * Math.pow(2, this.consecutivePollErrors),
            maxBackoff,
          );
          this.pollTimer = setTimeout(() => this.poll(), delay);
        }
      });
  }

  private async fetchAndProcess(): Promise<number> {
    const slotsAvailable = this.config.concurrency - this.activeJobs.size;
    if (slotsAvailable <= 0) return 0;

    const response = await this.transport.request<{ jobs: Job[] }>({
      method: 'POST',
      path: '/workers/fetch',
      body: {
        queues: this.config.queues,
        count: Math.min(slotsAvailable, 10),
        worker_id: this.workerId,
        visibility_timeout_ms: this.config.visibilityTimeout,
      },
    });

    const jobs = (response.body.jobs ?? []).map(normalizeJobResponse);

    for (const job of jobs) {
      this.processJob(job);
    }

    return jobs.length;
  }

  // ---- Internal: Job Processing ----

  private processJob(job: Job): void {
    const controller = new AbortController();
    this.activeJobs.set(job.id, controller);
    const processingStartedAt = Date.now();

    // Find handler
    const handler = this.handlers.get(job.type);
    if (!handler) {
      // No handler registered — nack the job. Explicitly caught (rather than
      // left as a floating promise) since nack() can itself throw after
      // exhausting its own retries, which would otherwise surface as an
      // unhandled promise rejection in a long-running worker process.
      this.nack(job.id, {
        code: 'handler_not_found',
        message: `No handler registered for job type '${job.type}'.`,
        retryable: false,
      })
        .catch((err: unknown) => {
          console.warn(`[ojs-worker] failed to nack job ${job.id} (no handler registered):`, String(err));
        })
        .finally(() => {
          this.finishJob(job.id, null);
        });
      return;
    }

    // Set up job-level timeout if configured
    let jobTimeoutId: ReturnType<typeof setTimeout> | null = null;
    if (job.timeout && job.timeout > 0) {
      jobTimeoutId = setTimeout(() => {
        controller.abort(new OJSTimeoutError(job.id, job.timeout!));
      }, job.timeout);
    }

    // Build the job context
    const ctx: JobContext = {
      job,
      attempt: job.attempt ?? 1,
      queue: job.queue,
      workerId: this.workerId,
      metadata: new Map(),
      signal: controller.signal,
    };

    // Compose middleware + handler
    const execute = composeExecution(
      this.executionMiddleware.entries(),
      handler,
    );

    // Execute. `handleExecutionSuccess()`/`handleExecutionFailure()` below
    // never throw or reject — every failure they can encounter internally
    // (ack/nack delivery, event dispatch) is caught and logged inside them
    // — which is exactly why the *two-argument* form of `.then()` is used
    // here instead of a chained `.then().catch()`. With `.then().catch()`,
    // a failure raised *inside* the success callback (e.g. ack()
    // exhausting its own retries) would itself be caught by the following
    // `.catch()` and misreported as a *handler* failure, incorrectly
    // nacking a job whose handler actually succeeded. The two-argument
    // form only ever routes `execute(ctx)`'s own outcome to the matching
    // branch: handler/middleware success calls `handleExecutionSuccess`,
    // handler/middleware failure (including a timeout abort) calls
    // `handleExecutionFailure` — nothing else can trigger either one, so
    // ack failure can never be misread as a reason to nack, and exactly
    // one terminal outcome (ack or nack) is attempted per execution.
    execute(ctx)
      .then(
        (result) => this.handleExecutionSuccess(job, ctx, result, processingStartedAt),
        (error: unknown) => this.handleExecutionFailure(job, ctx, error, controller),
      )
      .finally(() => {
        this.finishJob(job.id, jobTimeoutId);
      });
  }

  /**
   * Handles a successful job execution: validates/normalizes the handler's
   * result, acks the job exactly once, then emits `job.completed` for
   * observability -- strictly in that order, and only as far as each step
   * actually succeeds.
   *
   * The result is first normalized through {@link normalizeHandlerResult}'s
   * exact JSON semantics (the same rules this SDK already applies to
   * enqueue `args`/`meta`). A result that is not representable on the wire
   * -- a `BigInt`, a non-finite number, a circular reference, or anything
   * else `JSON.stringify()` itself would reject -- is a deterministic
   * defect in the handler/result, not a transient failure: it is routed to
   * {@link handleInvalidResult} instead, which nacks exactly once with the
   * non-retryable `invalid_result` code. No ack, no `job.completed` event,
   * and no completion metric are ever produced for that job in this case.
   *
   * Once normalized, an ack delivery failure (the request itself failing,
   * or exhausting `requestWithRetry()`'s own retries) is logged as exactly
   * that, an ack delivery failure, and is NEVER converted into a nack: the
   * handler already completed successfully, so nacking here would
   * misreport a successfully-processed job as failed to the server.
   * Crucially, the `job.completed` event and the `jobsCompleted` counter
   * are only ever produced *after* the ack itself has actually succeeded --
   * an ack that failed to deliver must not be reported as a completion the
   * server never actually recorded. A failing `job.completed` listener
   * cannot affect this outcome either — event dispatch happens only after
   * the ack decision is already final, and `OJSEventEmitter.emit()` itself
   * never rejects (see events.ts), but the dispatch is wrapped defensively
   * anyway so that invariant holds even if that ever changes.
   */
  private async handleExecutionSuccess(
    job: Job,
    ctx: JobContext,
    result: unknown,
    processingStartedAt: number,
  ): Promise<void> {
    let normalizedResult: JsonValue | undefined;
    try {
      normalizedResult = normalizeHandlerResult(result);
    } catch (validationError) {
      await this.handleInvalidResult(job, ctx, validationError);
      return;
    }

    try {
      await this.ack(job.id, normalizedResult);
    } catch (ackError) {
      console.warn(
        `[ojs-worker] failed to ack job ${job.id} after successful execution ` +
          '(the server may still consider it outstanding even though it completed):',
        String(ackError),
      );
      // No completion event/metric without a successful ack: the server
      // was never actually told this job completed, so reporting it as
      // completed here would be observably false.
      return;
    }

    this.jobsCompleted++;

    // `JobCompletedData.result` is optional under `exactOptionalPropertyTypes`:
    // the key must be entirely absent for "no result", never explicitly
    // `result: undefined` -- mirrors `ack()`'s own `if (result !== undefined)
    // body.result = result;` handling of the identical normalized value.
    const completedData: JobCompletedData = {
      job_type: job.type,
      queue: job.queue,
      duration_ms: Date.now() - processingStartedAt,
      attempt: ctx.attempt,
    };
    if (normalizedResult !== undefined) completedData.result = normalizedResult;

    await this.safeEmit(
      OJSEventEmitter.createEvent(
        'job.completed',
        `ojs://sdk/workers/${this.workerId}`,
        completedData,
        job.id,
      ),
    );
  }

  /**
   * Handles a handler that resolved successfully but returned a result
   * that cannot be represented as OJS's canonical JSON wire format (see
   * {@link normalizeHandlerResult}). This is a deterministic defect in the
   * handler/result -- not a transient delivery failure -- so it nacks
   * exactly once with the non-retryable `invalid_result` code and then
   * emits `job.failed`, exactly like {@link handleExecutionFailure}. The
   * job is never acked, no `job.completed` event is ever emitted for it,
   * and the `jobsCompleted` counter is never incremented: from the
   * server's perspective this attempt failed, not completed.
   */
  private async handleInvalidResult(
    job: Job,
    ctx: JobContext,
    error: unknown,
  ): Promise<void> {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    const jobError: JobError = {
      code: 'invalid_result',
      message:
        `Handler for job type '${job.type}' resolved with a result that ` +
        `cannot be represented as JSON: ${normalizedError.message}`,
      retryable: false,
      details: { stack: normalizedError.stack },
    };

    try {
      await this.nack(job.id, jobError);
    } catch (nackError) {
      console.warn(
        `[ojs-worker] failed to nack job ${job.id} after an invalid handler result:`,
        String(nackError),
      );
    }

    await this.safeEmit(
      OJSEventEmitter.createEvent(
        'job.failed',
        `ojs://sdk/workers/${this.workerId}`,
        {
          job_type: job.type,
          queue: job.queue,
          attempt: ctx.attempt,
          error: jobError,
        },
        job.id,
      ),
    );
  }

  /**
   * Handles a failed job execution (handler/middleware threw, or the job
   * timed out): nacks the job exactly once, then emits `job.failed` for
   * observability. Never throws/rejects — a nack delivery failure
   * (exhausting `requestWithRetry()`'s own retries) is logged and stops
   * there rather than propagating as an unhandled rejection in a
   * long-running worker process; it is never retried as an ack, since the
   * handler did fail. As with the success path, a failing `job.failed`
   * listener cannot alter this outcome.
   */
  private async handleExecutionFailure(
    job: Job,
    ctx: JobContext,
    error: unknown,
    controller: AbortController,
  ): Promise<void> {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    const timeoutFailure = getTimeoutFailure(
      controller.signal.reason,
      normalizedError,
    );
    const jobError: JobError = timeoutFailure ?? {
      code: 'handler_error',
      message: normalizedError.message,
      retryable: normalizedError instanceof OJSError
        ? normalizedError.retryable
        : true,
      details: { stack: normalizedError.stack },
    };

    try {
      await this.nack(job.id, jobError);
    } catch (nackError) {
      console.warn(`[ojs-worker] failed to nack job ${job.id} after handler failure:`, String(nackError));
    }

    await this.safeEmit(
      OJSEventEmitter.createEvent(
        'job.failed',
        `ojs://sdk/workers/${this.workerId}`,
        {
          job_type: job.type,
          queue: job.queue,
          attempt: ctx.attempt,
          error: jobError,
        },
        job.id,
      ),
    );
  }

  /**
   * Emits a worker-side event without ever throwing/rejecting. Listener
   * failures are already isolated inside `OJSEventEmitter.emit()` itself
   * (see events.ts) so this never rejects in practice, but the ack/nack
   * decision above must never be reachable from an event-dispatch failure
   * of *any* kind — wrapping here keeps that true even if `emit()`'s own
   * contract ever changes, and gives a clear, distinct log line if it does.
   */
  private async safeEmit<T extends Record<string, unknown>>(event: OJSEvent<T>): Promise<void> {
    try {
      await this.events.emit(event);
    } catch (emitError) {
      console.warn(`[ojs-worker] event emission failed for '${event.type}':`, String(emitError));
    }
  }

  /**
   * Exactly-once terminal cleanup for a single job execution: clears the
   * job-level timeout (if any), releases its concurrency slot, and
   * unblocks a pending graceful shutdown if this was the last active job.
   * Runs regardless of the terminal outcome — ack, nack, or a nack/ack
   * that itself failed to deliver — so shutdown always completes rather
   * than waiting out the full grace-period timeout for a job that has, in
   * fact, already finished.
   */
  private finishJob(jobId: string, jobTimeoutId: ReturnType<typeof setTimeout> | null): void {
    if (jobTimeoutId) clearTimeout(jobTimeoutId);
    this.activeJobs.delete(jobId);
    this.resolveShutdownIfIdle();
  }

  // ---- Internal: ACK / NACK ----

  private static readonly ACK_NACK_MAX_RETRIES = 3;

  private async ack(jobId: string, result?: JsonValue): Promise<void> {
    const body: Record<string, unknown> = { job_id: jobId };
    if (result !== undefined) body.result = result;

    await this.requestWithRetry('ack', jobId, {
      method: 'POST',
      path: '/workers/ack',
      body,
    });
  }

  private async nack(jobId: string, error: JobError): Promise<void> {
    await this.requestWithRetry('nack', jobId, {
      method: 'POST',
      path: '/workers/nack',
      body: { job_id: jobId, error },
    });
  }

  private async requestWithRetry(
    operation: string,
    jobId: string,
    options: Pick<TransportRequestOptions, 'method' | 'path' | 'body'>,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < OJSWorker.ACK_NACK_MAX_RETRIES; attempt++) {
      try {
        await this.transport.request(options);
        return;
      } catch (err) {
        lastError = err;
        console.warn(
          `[ojs-worker] ${operation} attempt ${attempt + 1} failed for job ${jobId}:`,
          String(err),
        );
        if (attempt < OJSWorker.ACK_NACK_MAX_RETRIES - 1) {
          await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 500));
        }
      }
    }
    throw lastError;
  }

  // ---- Internal: Heartbeat ----

  private async sendHeartbeat(): Promise<void> {
    const activeJobIds = Array.from(this.activeJobs.keys());

    const response = await this.transport.request<{
      state?: string;
      server_time?: string;
    }>({
      method: 'POST',
      path: '/workers/heartbeat',
      body: {
        worker_id: this.workerId,
        state: this.state,
        active_jobs: activeJobIds.length,
        active_job_ids: activeJobIds,
        hostname: getHostname(),
        pid: getPid(),
        queues: this.config.queues,
        concurrency: this.config.concurrency,
        labels: this.config.labels,
      },
    });

    // Handle server-directed state changes
    const serverState = response.body.state;
    if (serverState && serverState !== this.state) {
      if (serverState === 'quiet' && this.state === 'running') {
        this.state = 'quiet';
        // Stop polling for new jobs
        if (this.pollTimer) {
          clearTimeout(this.pollTimer);
          this.pollTimer = null;
        }
      } else if (serverState === 'terminate') {
        this.stop().catch(() => {
          // Best effort shutdown
        });
      }
    }
  }

  // ---- Internal: Shutdown helpers ----

  private waitForActiveJobs(): Promise<void> {
    if (this.activeJobs.size === 0) return Promise.resolve();

    this.shutdownPromise = new Promise((resolve) => {
      this.shutdownResolve = resolve;
    });
    return this.shutdownPromise;
  }

  private gracePeriodTimeout(): Promise<void> {
    return new Promise((resolve) => {
      this.graceTimerId = setTimeout(resolve, this.config.shutdownTimeout);
    });
  }

  private resolveShutdownIfIdle(): void {
    if (
      this.activeJobs.size === 0 &&
      this.shutdownResolve &&
      (this.state === 'terminate' || this.state === 'quiet')
    ) {
      if (this.graceTimerId) {
        clearTimeout(this.graceTimerId);
        this.graceTimerId = null;
      }
      this.shutdownResolve();
      this.shutdownResolve = null;
      this.shutdownPromise = null;
    }
  }
}

/**
 * Returns the authoritative timeout/deadline contract for an execution.
 * The worker-owned abort reason is checked first because downstream work may
 * observe that timeout and reject later with a different, non-retryable error.
 */
function getTimeoutFailure(
  signalReason: unknown,
  executionError: Error,
): JobError | undefined {
  for (const candidate of [signalReason, executionError]) {
    if (candidate instanceof OJSTimeoutError) {
      return {
        code: candidate.code,
        message: candidate.message,
        retryable: candidate.retryable,
        ...(candidate.details !== undefined
          ? { details: candidate.details }
          : {}),
      };
    }

    if (candidate instanceof TimeoutError) {
      return {
        code: 'timeout',
        message: candidate.message,
        retryable: true,
        details: {
          job_id: candidate.jobId,
          timeout_ms: candidate.timeoutMs,
        },
      };
    }

    if (
      candidate instanceof OJSError &&
      (candidate.code === 'timeout' || candidate.code === 'deadline_exceeded')
    ) {
      return {
        code: candidate.code,
        message: candidate.message,
        retryable: candidate.retryable,
        ...(candidate.details !== undefined
          ? { details: candidate.details }
          : {}),
      };
    }
  }

  return undefined;
}

// ---- Platform helpers (avoid direct globalThis.process references) ----

function getHostname(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proc = (globalThis as any).process;
    if (proc?.env?.HOSTNAME) return proc.env.HOSTNAME;
  } catch { /* ignore */ }
  return 'unknown';
}

function getPid(): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proc = (globalThis as any).process;
    if (typeof proc?.pid === 'number') return proc.pid;
  } catch { /* ignore */ }
  return 0;
}

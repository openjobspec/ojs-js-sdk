/**
 * OJS Worker — the consumer-side API for processing jobs.
 *
 * The worker polls the server for jobs, executes registered handlers,
 * and sends ack/nack responses. All retry/scheduling intelligence
 * lives in the server.
 */

import { HttpTransport } from './transport/http.js';
import type { Transport } from './transport/types.js';
import type { Job, JsonValue, JobError } from './job.js';
import {
  MiddlewareChain,
  composeExecution,
  type ExecutionMiddleware,
  type JobContext,
} from './middleware.js';
import { OJSEventEmitter } from './events.js';
import { OJSTimeoutError } from './errors.js';
import { DurableContext, type DurableJobHandler } from './durable.js';

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
  private startedAt: number = 0;
  private consecutivePollErrors = 0;
  private shutdownPromise: Promise<void> | null = null;
  private shutdownResolve: (() => void) | null = null;
  private graceTimerId: ReturnType<typeof setTimeout> | null = null;

  constructor(workerConfig: OJSWorkerConfig) {
    this.transport =
      workerConfig.transport ??
      new HttpTransport({
        url: workerConfig.url,
        auth: workerConfig.auth,
        headers: workerConfig.headers,
      });

    this.workerId = `worker_${crypto.randomUUID()}`;

    this.config = {
      queues: workerConfig.queues ?? ['default'],
      concurrency: workerConfig.concurrency ?? 10,
      pollInterval: workerConfig.pollInterval ?? 1000,
      heartbeatInterval: workerConfig.heartbeatInterval ?? 5000,
      shutdownTimeout: workerConfig.shutdownTimeout ?? 25000,
      visibilityTimeout: workerConfig.visibilityTimeout ?? 30000,
      labels: workerConfig.labels ?? [],
    };
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
      this.sendHeartbeat().catch(() => {
        // Heartbeat failures are non-fatal (per spec)
      });
    }, this.config.heartbeatInterval);

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

    const jobs = response.body.jobs ?? [];

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
      // No handler registered — nack the job
      this.nack(job.id, {
        code: 'handler_not_found',
        message: `No handler registered for job type '${job.type}'.`,
        retryable: false,
      }).finally(() => {
        this.activeJobs.delete(job.id);
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

    // Execute
    execute(ctx)
      .then(async (result) => {
        await this.ack(job.id, result as JsonValue | undefined);
        this.jobsCompleted++;

        await this.events.emit(
          OJSEventEmitter.createEvent(
            'job.completed',
            `ojs://sdk/workers/${this.workerId}`,
            {
              job_type: job.type,
              queue: job.queue,
              duration_ms: Date.now() - processingStartedAt,
              attempt: ctx.attempt,
              result: result as JsonValue,
            },
            job.id,
          ),
        );
      })
      .catch(async (error: Error) => {
        const isTimeout = error instanceof OJSTimeoutError ||
          controller.signal.reason instanceof OJSTimeoutError;
        const jobError: JobError = {
          code: isTimeout ? 'timeout' : 'handler_error',
          message: error.message,
          retryable: true,
          details: isTimeout
            ? { job_id: job.id, timeout_ms: job.timeout }
            : { stack: error.stack },
        };

        await this.nack(job.id, jobError);

        await this.events.emit(
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
      })
      .finally(() => {
        if (jobTimeoutId) clearTimeout(jobTimeoutId);
        this.activeJobs.delete(job.id);
        this.resolveShutdownIfIdle();
      });
  }

  // ---- Internal: ACK / NACK ----

  private async ack(jobId: string, result?: JsonValue): Promise<void> {
    const body: Record<string, unknown> = { job_id: jobId };
    if (result !== undefined) body.result = result;

    await this.transport.request({
      method: 'POST',
      path: '/workers/ack',
      body,
    });
  }

  private async nack(jobId: string, error: JobError): Promise<void> {
    await this.transport.request({
      method: 'POST',
      path: '/workers/nack',
      body: { job_id: jobId, error },
    });
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

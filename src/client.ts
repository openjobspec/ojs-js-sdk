/**
 * OJS Client — the producer-side API for enqueuing jobs.
 *
 * The client is a thin HTTP wrapper. All intelligence lives in the server.
 */

import { HttpTransport } from './transport/http.js';
import type { Transport } from './transport/types.js';
import type { RetryConfig } from './rate-limiter.js';
import {
  createEnqueueEnvelope,
  normalizeArgs,
  normalizeJobResponse,
  toWireEnqueueRequest,
  type Job,
  type JobSpec,
  type EnqueueOptions,
  type JsonValue,
  type WireEnqueueRequest,
} from './job.js';
import {
  MiddlewareChain,
  composeEnqueue,
  type EnqueueMiddleware,
} from './middleware.js';
import { QueueOperations } from './queue.js';
import { CronOperations } from './cron.js';
import { SchemaOperations } from './schema.js';
import { OJSEventEmitter } from './events.js';
import type {
  WorkflowDefinition,
  WorkflowStatus,
} from './workflow.js';
import { normalizeWorkflowStatus, toWireWorkflow } from './workflow.js';
import {
  isTestMode,
  _recordEnqueueEnvelope,
  _toJob,
} from './testing.js';
import { OJSConnectionError } from './errors.js';

/** Configuration options for OJSClient. */
export interface OJSClientConfig {
  /** Base URL of the OJS server (e.g., 'http://localhost:8080'). */
  url: string;
  /** Authorization header value (e.g., 'Bearer <token>'). */
  auth?: string;
  /** Custom headers included in every request. */
  headers?: Record<string, string>;
  /** Default request timeout in milliseconds. */
  timeout?: number;
  /** Custom transport implementation (for testing or custom protocols). */
  transport?: Transport;
  /** Configuration for automatic retry on 429 rate-limit responses. */
  retryConfig?: Partial<RetryConfig>;
}

export class OJSClient {
  private readonly transport: Transport;
  private readonly enqueueMiddleware = new MiddlewareChain<EnqueueMiddleware>();

  /** Event emitter for client-side events. */
  readonly events = new OJSEventEmitter();

  /** Queue management operations. */
  readonly queues: QueueOperations;

  /** Cron job management operations. */
  readonly cron: CronOperations;

  /** Schema management operations. */
  readonly schemas: SchemaOperations;

  constructor(config: OJSClientConfig) {
    const transportConfig = {
      url: config.url,
      ...(config.auth !== undefined ? { auth: config.auth } : {}),
      ...(config.headers !== undefined ? { headers: config.headers } : {}),
      ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
      ...(config.retryConfig !== undefined ? { retryConfig: config.retryConfig } : {}),
    };

    this.transport =
      config.transport ??
      new HttpTransport(transportConfig);

    this.queues = new QueueOperations(this.transport);
    this.cron = new CronOperations(this.transport);
    this.schemas = new SchemaOperations(this.transport);
  }

  // ---- Enqueue ----

  /**
   * Enqueue a single job.
   *
   * @typeParam T - The type of the job arguments. Must be JSON-serializable.
   * @param type - The dot-namespaced job type (e.g., 'email.send').
   * @param args - The job arguments. Objects/primitives are wrapped in an array for the wire format.
   * @param options - Optional enqueue options (queue, retry, delay, etc.).
   * @returns The enqueued job, or `null` when enqueue middleware drops it.
   *
   * @example
   * ```ts
   * // Untyped (default)
   * const job = await client.enqueue('email.send', { to: 'user@example.com' });
   * if (job === null) console.log('Job was dropped by middleware');
   *
   * // Typed args for compile-time safety
   * interface EmailPayload { to: string; subject: string }
   * const job = await client.enqueue<EmailPayload>('email.send', { to: 'a@b.com', subject: 'Hi' });
   * ```
   */
  async enqueue<T extends JsonValue = JsonValue>(
    type: string,
    args: T | T[] = [] as unknown as T,
    options?: EnqueueOptions,
  ): Promise<Job | null> {
    const wireArgs = normalizeArgs(args);
    const envelope = createEnqueueEnvelope(type, wireArgs, options);
    const run = composeEnqueue(
      this.enqueueMiddleware.entries(),
      (job) => this.terminalEnqueue(job),
    );
    // The middleware onion terminates in the real transport/test-mode
    // enqueue, so `await next()` inside a middleware resolves to the actual
    // created Job (server-assigned id/state) — or rejects with the transport
    // error. Post-next mutations therefore only affect the value the
    // outermost middleware returns to the caller; they are never re-sent,
    // because serialization already happened when `next()` reached the
    // terminal below.
    return run(envelope);
  }

  /**
   * The terminal of the enqueue middleware onion: serialize/validate the
   * post-middleware envelope, then perform the single real enqueue (test
   * mode records in memory; otherwise one `POST /jobs`). Returns the actual
   * created Job. Validation runs first so an invalid post-middleware
   * envelope rejects `next()` before any transport or in-memory write.
   */
  private async terminalEnqueue(job: Job): Promise<Job> {
    const body = toWireEnqueueRequest(job);

    if (isTestMode()) {
      const fakeJob = await _recordEnqueueEnvelope(job);
      return _toJob(fakeJob);
    }

    const response = await this.transport.request<{ job: Job }>({
      method: 'POST',
      path: '/jobs',
      body,
    });

    return normalizeJobResponse(response.body.job);
  }

  /**
   * Enqueue multiple jobs in a single atomic operation.
   *
   * @param specs - Array of job specifications.
   * @returns Array of enqueued jobs as returned by the server.
   *
   * @example
   * ```ts
   * const jobs = await client.enqueueBatch([
   *   { type: 'email.send', args: { to: 'a@example.com' } },
   *   { type: 'email.send', args: { to: 'b@example.com' } },
   * ]);
   * ```
   */
  async enqueueBatch(specs: JobSpec[]): Promise<Job[]> {
    const envelopes = specs.map((spec) =>
      createEnqueueEnvelope(
        spec.type,
        normalizeArgs(spec.args ?? []),
        spec.options,
      ),
    );
    const n = envelopes.length;
    if (n === 0) return [];

    // Barrier/deferred orchestration: every per-job middleware chain runs
    // to a terminal decision (send / drop / error) *before* any transport
    // call, then one atomic batch request is issued, each chain's terminal
    // is resolved with its corresponding response Job in order, and finally
    // the chains are awaited so their post-next code observes the response.
    const terminals: (BatchTerminal | undefined)[] = new Array(n);
    const decided: boolean[] = new Array(n).fill(false);
    const dropped: boolean[] = new Array(n).fill(false);
    const chainError: unknown[] = new Array(n);
    const hasChainError: boolean[] = new Array(n).fill(false);
    const finalResults: (Job | null)[] = new Array(n);
    const gateResolvers: (() => void)[] = new Array(n);
    const gates: Promise<void>[] = [];
    const chains: Promise<void>[] = [];

    for (let i = 0; i < n; i++) {
      const idx = i;
      gates.push(
        new Promise<void>((resolve) => {
          gateResolvers[idx] = resolve;
        }),
      );

      // Each job's batch terminal is the single atomic-batch transport slot
      // for that item and may be *reached* only once. A retry-style enqueue
      // middleware that catches a validation or transport rejection and calls
      // next() again would otherwise re-enter this terminal. When that
      // happens the one atomic batch request was already attempted (or was
      // never issued because validation failed synchronously), so we must
      // NOT register a fresh deferred — doing so would hang forever waiting
      // for a second transport cycle that never comes and would strand
      // `Promise.allSettled(chains)`. Instead we reject immediately with the
      // ORIGINAL terminal error and never replace the recorded deferred.
      //
      // NOTE: whole-batch transport retry is intentionally unsupported (see
      // AUDIT.md §4ae). Middleware may retry its own pre-terminal handler
      // work, but it cannot retry an already-attempted atomic batch send.
      let terminalReached = false;
      let terminalError: unknown;
      let hasTerminalError = false;
      const recordTerminalError = (error: unknown): void => {
        if (!hasTerminalError) {
          hasTerminalError = true;
          terminalError = error;
        }
      };

      const terminal = (job: Job): Promise<Job> => {
        if (terminalReached) {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- forwards the ORIGINAL terminal error verbatim (an intentionally `unknown` thrown value from transport/validation) so a retry sees the identical failure object.
          return Promise.reject(
            hasTerminalError
              ? terminalError
              : new OJSConnectionError(
                  'Batch enqueue terminal re-invoked before its single ' +
                    'atomic transport attempt settled; whole-batch transport ' +
                    'retry is not supported.',
                ),
          );
        }
        terminalReached = true;

        // Serialize/validate now so a bad post-middleware envelope aborts
        // the whole batch before any transport call (the synchronous throw
        // rejects this chain, which the barrier below treats as an error).
        // Capture that validation failure as the original terminal error so
        // a retry re-invoking the terminal observes the same deterministic
        // rejection instead of re-running validation.
        let body: WireEnqueueRequest;
        try {
          body = toWireEnqueueRequest(job);
        } catch (error) {
          recordTerminalError(error);
          throw error;
        }
        return new Promise<Job>((resolve, reject) => {
          terminals[idx] = {
            job,
            body,
            resolve,
            reject: (error: unknown) => {
              recordTerminalError(error);
              // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the batch transport rejects each terminal with its ORIGINAL (`unknown`) error; forwarding it verbatim is required so callers observe the exact failure object.
              reject(error);
            },
          };
          decided[idx] = true;
          gateResolvers[idx]!();
        });
      };

      const run = composeEnqueue(this.enqueueMiddleware.entries(), terminal);
      chains.push(
        run(envelopes[idx]!).then(
          (result) => {
            finalResults[idx] = result;
            if (!decided[idx]) {
              // The chain settled without reaching the terminal: a drop
              // (returned null) or a short-circuit value never sent.
              dropped[idx] = result === null;
              decided[idx] = true;
              gateResolvers[idx]!();
            }
          },
          (error: unknown) => {
            hasChainError[idx] = true;
            chainError[idx] = error;
            decided[idx] = true;
            gateResolvers[idx]!();
          },
        ),
      );
    }

    // Wait until every chain has reached a terminal or settled.
    await Promise.all(gates);

    // Any middleware/validation error aborts the whole batch before any
    // transport call. Reject terminals still awaiting so their chains unwind.
    const firstError = hasChainError.findIndex((flag) => flag);
    if (firstError !== -1) {
      const error = chainError[firstError];
      for (const terminal of terminals) terminal?.reject(error);
      await Promise.allSettled(chains);
      throw error;
    }

    const sendIndices: number[] = [];
    for (let i = 0; i < n; i++) {
      if (terminals[i] && !dropped[i]) sendIndices.push(i);
    }

    if (sendIndices.length > 0) {
      if (isTestMode()) {
        for (const i of sendIndices) {
          const terminal = terminals[i]!;
          const fakeJob = await _recordEnqueueEnvelope(terminal.job);
          terminal.resolve(_toJob(fakeJob));
        }
      } else {
        let responseJobs: Job[];
        try {
          const response = await this.transport.request<{ jobs: Job[] }>({
            method: 'POST',
            path: '/jobs/batch',
            body: { jobs: sendIndices.map((i) => terminals[i]!.body) },
          });
          responseJobs = response.body.jobs.map(normalizeJobResponse);
          if (responseJobs.length !== sendIndices.length) {
            throw new OJSConnectionError(
              `Batch enqueue returned ${responseJobs.length} jobs for ${sendIndices.length} requests.`,
            );
          }
        } catch (error) {
          // A transport failure must be observable by every terminal's
          // post-next code and must reject the whole batch.
          for (const i of sendIndices) terminals[i]!.reject(error);
          await Promise.allSettled(chains);
          throw error;
        }
        sendIndices.forEach((i, position) => {
          terminals[i]!.resolve(responseJobs[position]!);
        });
      }
    }

    // Let each chain's post-next code run (observe the response Job, apply
    // return-only mutations) before assembling results.
    await Promise.allSettled(chains);

    const postError = hasChainError.findIndex((flag) => flag);
    if (postError !== -1) throw chainError[postError];

    const results: Job[] = [];
    for (let i = 0; i < n; i++) {
      if (dropped[i]) continue;
      const result = finalResults[i];
      if (result != null) results.push(result);
    }
    return results;
  }

  // ---- Job Info ----

  /**
   * Get the details of a job by ID.
   *
   * @param jobId - The UUIDv7 job identifier.
   * @returns The full job object.
   */
  async getJob(jobId: string): Promise<Job> {
    const response = await this.transport.request<{ job: Job }>({
      method: 'GET',
      path: `/jobs/${encodeURIComponent(jobId)}`,
    });
    return normalizeJobResponse(response.body.job);
  }

  /**
   * Cancel a job by ID.
   *
   * @param jobId - The UUIDv7 job identifier.
   * @returns The cancelled job.
   */
  async cancelJob(jobId: string): Promise<Job> {
    const response = await this.transport.request<{ job: Job }>({
      method: 'DELETE',
      path: `/jobs/${encodeURIComponent(jobId)}`,
    });
    return normalizeJobResponse(response.body.job);
  }

  // ---- Workflows ----

  /**
   * Create and start a workflow.
   *
   * @param definition - A workflow definition created with chain(), group(), or batch().
   * @returns The workflow status.
   *
   * @example
   * ```ts
   * import { chain } from '@openjobspec/sdk';
   *
   * await client.workflow(
   *   chain(
   *     { type: 'data.fetch', args: { url: '...' } },
   *     { type: 'data.transform', args: { format: 'csv' } },
   *     { type: 'data.load', args: { dest: 'warehouse' } },
   *   )
   * );
   * ```
   */
  async workflow(definition: WorkflowDefinition): Promise<WorkflowStatus> {
    const wire = toWireWorkflow(definition);

    const response = await this.transport.request<WorkflowResponseEnvelope>({
      method: 'POST',
      path: '/workflows',
      body: wire,
    });

    return unwrapWorkflowResponse(response.body);
  }

  /**
   * Get the status of a workflow.
   */
  async getWorkflow(workflowId: string): Promise<WorkflowStatus> {
    const response = await this.transport.request<WorkflowResponseEnvelope>({
      method: 'GET',
      path: `/workflows/${encodeURIComponent(workflowId)}`,
    });
    return unwrapWorkflowResponse(response.body);
  }

  /**
   * Cancel a workflow.
   */
  async cancelWorkflow(workflowId: string): Promise<void> {
    await this.transport.request({
      method: 'DELETE',
      path: `/workflows/${encodeURIComponent(workflowId)}`,
    });
  }

  // ---- Health ----

  /**
   * Check server health.
   */
  async health(): Promise<{
    status: string;
    version: string;
    backend?: { type: string; status: string };
  }> {
    const response = await this.transport.request<{
      status: string;
      version: string;
      backend?: { type: string; status: string };
    }>({
      method: 'GET',
      path: '/health',
    });
    return response.body;
  }

  /**
   * Fetch the server's conformance manifest.
   */
  async manifest(): Promise<Record<string, unknown>> {
    const response = await this.transport.request<Record<string, unknown>>({
      method: 'GET',
      path: '/ojs/manifest',
      rawPath: true,
    });
    return response.body;
  }

  // ---- Enqueue Middleware ----

  /**
   * Add enqueue middleware to the client.
   * Middleware runs before every enqueue operation.
   *
   * @param name - A unique name to identify this middleware.
   * @param fn - The middleware function.
   */
  useEnqueue(name: string, fn: EnqueueMiddleware): this {
    this.enqueueMiddleware.add(name, fn);
    return this;
  }

  /** Access the enqueue middleware chain for fine-grained control. */
  get middleware(): MiddlewareChain<EnqueueMiddleware> {
    return this.enqueueMiddleware;
  }

}

/**
 * One per-job entry of an in-flight batch: the post-middleware envelope, its
 * validated wire body, and the deferred `resolve`/`reject` that the shared
 * batch transport step calls with the item's corresponding response Job (or
 * the transport error) once all chains have reached a terminal decision.
 */
interface BatchTerminal {
  job: Job;
  body: WireEnqueueRequest;
  resolve: (job: Job) => void;
  reject: (error: unknown) => void;
}

// ---- Workflow response envelope ----
//
// Both `ojs-http-binding.md` §14.1/14.2 and the `GrpcTransport`'s
// `grpcCreateWorkflow`/`grpcGetWorkflow` (see src/transport/grpc.ts) wrap
// the workflow status in a `{ workflow: {...} }` envelope, matching the
// same shape as every other create/get response in the spec. A raw
// per-field `WorkflowStatus` (with no `workflow` wrapper) is also
// tolerated for backward compatibility with any server/test double that
// was built against the previous unwrapped behavior.

/** The `{ workflow: WorkflowStatus }` envelope both transports use for
 * `POST /workflows` and `GET /workflows/:id`. */
interface WorkflowResponseEnvelope {
  workflow?: WorkflowStatus;
}

/**
 * Unwraps a `{ workflow: WorkflowStatus }` envelope into the bare
 * `WorkflowStatus` the public `OJSClient.workflow()`/`getWorkflow()` API
 * returns. A response body without a `workflow` property is treated as
 * already being the flat `WorkflowStatus` itself — tolerated for
 * backward compatibility with servers/tests that predate the envelope.
 */
function unwrapWorkflowResponse(
  body: WorkflowResponseEnvelope | WorkflowStatus,
): WorkflowStatus {
  if (body && typeof body === 'object' && 'workflow' in body && body.workflow) {
    return normalizeWorkflowStatus(body.workflow);
  }
  return normalizeWorkflowStatus(body as WorkflowStatus);
}

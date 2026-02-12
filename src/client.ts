/**
 * OJS Client — the producer-side API for enqueuing jobs.
 *
 * The client is a thin HTTP wrapper. All intelligence lives in the server.
 */

import { HttpTransport } from './transport/http.js';
import type { Transport } from './transport/types.js';
import type {
  Job,
  JobSpec,
  EnqueueOptions,
  JsonValue,
} from './job.js';
import { normalizeArgs, toWireOptions } from './job.js';
import {
  MiddlewareChain,
  composeEnqueue,
  type EnqueueMiddleware,
} from './middleware.js';
import { QueueOperations } from './queue.js';
import { OJSEventEmitter } from './events.js';
import { validateEnqueueRequest } from './validation/schemas.js';
import { OJSValidationError } from './errors.js';
import type {
  WorkflowDefinition,
  WorkflowStatus,
} from './workflow.js';
import { toWireWorkflow } from './workflow.js';

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
}

export class OJSClient {
  private readonly transport: Transport;
  private readonly enqueueMiddleware = new MiddlewareChain<EnqueueMiddleware>();

  /** Event emitter for client-side events. */
  readonly events = new OJSEventEmitter();

  /** Queue management operations. */
  readonly queues: QueueOperations;

  constructor(config: OJSClientConfig) {
    this.transport =
      config.transport ??
      new HttpTransport({
        url: config.url,
        auth: config.auth,
        headers: config.headers,
        timeout: config.timeout,
      });

    this.queues = new QueueOperations(this.transport);
  }

  // ---- Enqueue ----

  /**
   * Enqueue a single job.
   *
   * @param type - The dot-namespaced job type (e.g., 'email.send').
   * @param args - The job arguments. Objects/primitives are wrapped in an array for the wire format.
   * @param options - Optional enqueue options (queue, retry, delay, etc.).
   * @returns The enqueued job as returned by the server.
   *
   * @example
   * ```ts
   * const job = await client.enqueue('email.send', { to: 'user@example.com' });
   * ```
   */
  async enqueue(
    type: string,
    args: JsonValue | JsonValue[] = [],
    options?: EnqueueOptions,
  ): Promise<Job> {
    const wireArgs = normalizeArgs(args);
    const wireOptions = toWireOptions(options);

    // Build the job envelope for middleware
    const jobEnvelope: Job = {
      specversion: '1.0',
      id: '', // Server assigns
      type,
      queue: options?.queue ?? 'default',
      args: wireArgs,
      meta: options?.meta,
    };

    // Run through enqueue middleware chain
    const composedEnqueue = composeEnqueue(
      this.enqueueMiddleware.entries(),
      async (job) => {
        // Client-side validation
        const errors = validateEnqueueRequest({
          type: job.type,
          args: job.args,
          options: wireOptions as { queue?: string } | undefined,
        });
        if (errors.length > 0) {
          throw new OJSValidationError(
            errors.map((e) => e.message).join('; '),
            { validation_errors: errors },
          );
        }

        // Build the wire request body
        const body: Record<string, unknown> = {
          type: job.type,
          args: job.args,
        };
        if (job.meta && Object.keys(job.meta).length > 0) body.meta = job.meta;
        if (wireOptions) body.options = wireOptions;

        const response = await this.transport.request<{ job: Job }>({
          method: 'POST',
          path: '/jobs',
          body,
        });

        return response.body.job;
      },
    );

    const result = await composedEnqueue(jobEnvelope);
    return result as Job;
  }

  /**
   * Enqueue multiple jobs in a single atomic operation.
   *
   * @param jobs - Array of job specifications.
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
    const wireJobs = specs.map((spec) => {
      const wireArgs = normalizeArgs(spec.args ?? []);
      const wireOptions = toWireOptions(spec.options);

      const body: Record<string, unknown> = {
        type: spec.type,
        args: wireArgs,
      };
      if (wireOptions) body.options = wireOptions;
      return body;
    });

    const response = await this.transport.request<{ jobs: Job[] }>({
      method: 'POST',
      path: '/jobs/batch',
      body: { jobs: wireJobs },
    });

    return response.body.jobs;
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
    return response.body.job;
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
    return response.body.job;
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

    const response = await this.transport.request<WorkflowStatus>({
      method: 'POST',
      path: '/workflows',
      body: wire,
    });

    return response.body;
  }

  /**
   * Get the status of a workflow.
   */
  async getWorkflow(workflowId: string): Promise<WorkflowStatus> {
    const response = await this.transport.request<WorkflowStatus>({
      method: 'GET',
      path: `/workflows/${encodeURIComponent(workflowId)}`,
    });
    return response.body;
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

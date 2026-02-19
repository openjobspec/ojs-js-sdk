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

/** Configuration for the gRPC transport. */
export interface GrpcTransportConfig {
  /** gRPC server address (e.g., 'localhost:9090'). */
  url: string;

  /** Optional API key for authentication (sent as x-ojs-api-key metadata). */
  apiKey?: string | undefined;

  /** Optional Bearer token for authentication (sent as authorization metadata). */
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

/**
 * gRPC transport for OJS.
 *
 * Implements the Transport interface by mapping HTTP-style path/method
 * combinations to the corresponding OJS gRPC service RPCs.
 */
export class GrpcTransport implements Transport {
  private client: any;
  private readonly config: GrpcTransportConfig;
  private readonly defaultTimeout: number;
  private readonly defaultMetadata: Record<string, string>;
  private initPromise: Promise<void> | null = null;

  constructor(config: GrpcTransportConfig) {
    this.config = config;
    this.defaultTimeout = config.timeout ?? 30_000;
    this.defaultMetadata = { ...config.metadata };

    if (config.apiKey) {
      this.defaultMetadata['x-ojs-api-key'] = config.apiKey;
    }
    if (config.auth) {
      this.defaultMetadata['authorization'] = config.auth;
    }
  }

  /**
   * Lazily initializes the gRPC client on first use.
   * This allows the transport to be created synchronously while
   * deferring the dynamic import of gRPC dependencies.
   */
  private async ensureClient(): Promise<void> {
    if (this.client) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.initClient();
    return this.initPromise;
  }

  private async initClient(): Promise<void> {
    let grpc: any;
    let protoLoader: any;

    try {
      grpc = await import('@grpc/grpc-js');
      protoLoader = await import('@grpc/proto-loader');
    } catch {
      throw new OJSConnectionError(
        'gRPC dependencies not found. Install @grpc/grpc-js and @grpc/proto-loader: ' +
          'npm install @grpc/grpc-js @grpc/proto-loader',
      );
    }

    const path = await import('path');
    const fs = await import('fs');

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
        if (fs.existsSync(candidate)) {
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

    const packageDefinition = protoLoader.loadSync(serviceProto, {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs: [protoDir],
    });

    const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
    const OJSService = (protoDescriptor as any).ojs.v1.OJSService;

    this.client = new OJSService(
      this.config.url,
      grpc.credentials.createInsecure(),
    );
  }

  /**
   * Creates gRPC metadata from default and per-request metadata.
   */
  private createMetadata(extra?: Record<string, string>): any {
    // We need to dynamically create Metadata since grpc-js is a peer dep
    const meta: Record<string, string> = {
      ...this.defaultMetadata,
      ...extra,
    };
    return meta;
  }

  /**
   * Wraps a gRPC unary call in a Promise with timeout and metadata support.
   */
  private call<T>(
    method: string,
    request: any,
    timeout?: number,
    extraMetadata?: Record<string, string>,
  ): Promise<T> {
    return new Promise(async (resolve, reject) => {
      try {
        await this.ensureClient();
      } catch (err) {
        return reject(err);
      }

      let grpc: any;
      try {
        grpc = await import('@grpc/grpc-js');
      } catch {
        return reject(
          new OJSConnectionError('Failed to import @grpc/grpc-js'),
        );
      }

      const metadata = new grpc.Metadata();
      const allMeta = this.createMetadata(extraMetadata);
      for (const [key, value] of Object.entries(allMeta)) {
        metadata.set(key, value);
      }

      const deadline = new Date(Date.now() + (timeout ?? this.defaultTimeout));

      const fn = this.client[method];
      if (!fn) {
        return reject(
          new OJSError(
            `Unsupported gRPC method: ${method}`,
            'unimplemented',
            { retryable: false },
          ),
        );
      }

      fn.call(
        this.client,
        request,
        metadata,
        { deadline },
        (err: any, response: T) => {
          if (err) {
            return reject(mapGrpcError(err));
          }
          resolve(response);
        },
      );
    });
  }

  async request<T = unknown>(
    options: TransportRequestOptions,
  ): Promise<TransportResponse<T>> {
    const { method, path, body, timeout } = options;
    const headers: OJSResponseHeaders = {};

    try {
      const result = await this.routeRequest(method, path, body, timeout);
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
    body: any,
    timeout?: number,
  ): Promise<unknown> {
    // Normalize: strip /ojs/v1 prefix if present
    const normalizedPath = path.replace(/^\/ojs\/v1/, '');
    const segments = normalizedPath.split('/');
    // segments[0] is '' (leading slash), segments[1] is resource, segments[2] is id, etc.

    // --- Job operations ---
    if (method === 'POST' && normalizedPath === '/jobs') {
      return this.grpcEnqueue(body, timeout);
    }
    if (method === 'POST' && normalizedPath === '/jobs/batch') {
      return this.grpcEnqueueBatch(body, timeout);
    }
    if (method === 'GET' && normalizedPath.match(/^\/jobs\/[^/]+$/)) {
      const jobId = segments[2]!;
      return this.grpcGetJob(jobId, timeout);
    }
    if (method === 'DELETE' && normalizedPath.match(/^\/jobs\/[^/]+$/)) {
      const jobId = segments[2]!;
      return this.grpcCancelJob(jobId, timeout);
    }

    // --- Worker operations ---
    if (method === 'POST' && normalizedPath === '/workers/fetch') {
      return this.grpcFetch(body, timeout);
    }
    if (method === 'POST' && normalizedPath === '/workers/ack') {
      return this.grpcAck(body, timeout);
    }
    if (method === 'POST' && normalizedPath === '/workers/nack') {
      return this.grpcNack(body, timeout);
    }
    if (method === 'POST' && normalizedPath === '/workers/heartbeat') {
      return this.grpcHeartbeat(body, timeout);
    }
    if (method === 'POST' && normalizedPath === '/workers/progress') {
      return this.grpcProgress(body, timeout);
    }

    // --- Queue operations ---
    if (method === 'GET' && normalizedPath === '/queues') {
      return this.grpcListQueues(timeout);
    }
    if (method === 'GET' && normalizedPath.match(/^\/queues\/[^/]+\/stats$/)) {
      const queueName = segments[2]!;
      return this.grpcQueueStats(queueName, timeout);
    }
    if (
      method === 'POST' &&
      normalizedPath.match(/^\/queues\/[^/]+\/pause$/)
    ) {
      const queueName = segments[2]!;
      return this.grpcPauseQueue(queueName, timeout);
    }
    if (
      method === 'POST' &&
      normalizedPath.match(/^\/queues\/[^/]+\/resume$/)
    ) {
      const queueName = segments[2]!;
      return this.grpcResumeQueue(queueName, timeout);
    }

    // --- Dead letter operations ---
    if (method === 'GET' && normalizedPath === '/dead-letter') {
      return this.grpcListDeadLetter(body, timeout);
    }
    if (
      method === 'POST' &&
      normalizedPath.match(/^\/dead-letter\/[^/]+\/retry$/)
    ) {
      const jobId = segments[2]!;
      return this.grpcRetryDeadLetter(jobId, timeout);
    }
    if (method === 'DELETE' && normalizedPath.match(/^\/dead-letter\/[^/]+$/)) {
      const jobId = segments[2]!;
      return this.grpcDeleteDeadLetter(jobId, timeout);
    }

    // --- Cron operations ---
    if (method === 'GET' && normalizedPath === '/cron') {
      return this.grpcListCron(timeout);
    }
    if (method === 'POST' && normalizedPath === '/cron') {
      return this.grpcRegisterCron(body, timeout);
    }
    if (method === 'DELETE' && normalizedPath.match(/^\/cron\/[^/]+$/)) {
      const name = segments[2]!;
      return this.grpcUnregisterCron(name, timeout);
    }

    // --- Workflow operations ---
    if (method === 'POST' && normalizedPath === '/workflows') {
      return this.grpcCreateWorkflow(body, timeout);
    }
    if (method === 'GET' && normalizedPath.match(/^\/workflows\/[^/]+$/)) {
      const workflowId = segments[2]!;
      return this.grpcGetWorkflow(workflowId, timeout);
    }
    if (method === 'DELETE' && normalizedPath.match(/^\/workflows\/[^/]+$/)) {
      const workflowId = segments[2]!;
      return this.grpcCancelWorkflow(workflowId, timeout);
    }

    // --- System operations ---
    if (method === 'GET' && normalizedPath === '/health') {
      return this.grpcHealth(timeout);
    }
    if (
      method === 'GET' &&
      (normalizedPath === '/manifest' || path === '/ojs/manifest')
    ) {
      return this.grpcManifest(timeout);
    }

    throw new OJSError(
      `Unsupported route: ${method} ${path}`,
      'unimplemented',
      { retryable: false },
    );
  }

  // --- gRPC method implementations ---

  private async grpcEnqueue(body: any, timeout?: number): Promise<unknown> {
    const request: any = {
      type: body.type,
      args: body.args?.map(toProtoValue) ?? [],
    };
    if (body.queue || body.priority !== undefined || body.options) {
      request.options = mapEnqueueOptions(body);
    }
    const response = await this.call<any>('enqueue', request, timeout);
    return { job: fromProtoJob(response.job) };
  }

  private async grpcEnqueueBatch(
    body: any,
    timeout?: number,
  ): Promise<unknown> {
    const request: any = {
      jobs: (body.jobs ?? []).map((j: any) => ({
        type: j.type,
        args: j.args?.map(toProtoValue) ?? [],
        options: j.queue || j.priority !== undefined ? mapEnqueueOptions(j) : undefined,
      })),
    };
    const response = await this.call<any>('enqueueBatch', request, timeout);
    return {
      jobs: (response.jobs ?? []).map(fromProtoJob),
    };
  }

  private async grpcGetJob(jobId: string, timeout?: number): Promise<unknown> {
    const response = await this.call<any>('getJob', { jobId }, timeout);
    return { job: fromProtoJob(response.job) };
  }

  private async grpcCancelJob(
    jobId: string,
    timeout?: number,
  ): Promise<unknown> {
    const response = await this.call<any>('cancelJob', { jobId }, timeout);
    return { job: fromProtoJob(response.job) };
  }

  private async grpcFetch(body: any, timeout?: number): Promise<unknown> {
    const request: any = {
      queues: body.queues,
      count: body.count ?? 1,
    };
    if (body.worker_id) {
      request.workerId = body.worker_id;
    }
    const response = await this.call<any>('fetch', request, timeout);
    return {
      jobs: (response.jobs ?? []).map(fromProtoJob),
    };
  }

  private async grpcAck(body: any, timeout?: number): Promise<unknown> {
    const request: any = { jobId: body.job_id };
    if (body.result !== undefined && body.result !== null) {
      request.result = body.result;
    }
    const response = await this.call<any>('ack', request, timeout);
    return { acknowledged: response.acknowledged ?? true };
  }

  private async grpcNack(body: any, timeout?: number): Promise<unknown> {
    const request: any = {
      jobId: body.job_id,
      error: {
        code: body.error?.code ?? '',
        message: body.error?.message ?? '',
        retryable: body.error?.retryable ?? false,
      },
    };
    const response = await this.call<any>('nack', request, timeout);
    return {
      state: mapJobState(response.state),
      next_attempt_at: response.nextAttemptAt ?? null,
    };
  }

  private async grpcHeartbeat(body: any, timeout?: number): Promise<unknown> {
    const request: any = {
      workerId: body.worker_id,
    };
    if (body.active_jobs) {
      request.id = body.active_jobs[0] ?? '';
    }
    const response = await this.call<any>('heartbeat', request, timeout);
    return {
      state: mapWorkerState(response.directedState),
    };
  }

  private async grpcProgress(_body: any, _timeout?: number): Promise<unknown> {
    // Progress is not a standard proto RPC — return empty acknowledgement
    return {};
  }

  private async grpcListQueues(timeout?: number): Promise<unknown> {
    const response = await this.call<any>('listQueues', {}, timeout);
    return {
      queues: (response.queues ?? []).map((q: any) => ({
        name: q.name,
        status: q.paused ? 'paused' : 'active',
        available_count: parseInt(q.availableCount ?? '0', 10),
      })),
    };
  }

  private async grpcQueueStats(
    queueName: string,
    timeout?: number,
  ): Promise<unknown> {
    const response = await this.call<any>(
      'queueStats',
      { queue: queueName },
      timeout,
    );
    const stats = response.stats ?? {};
    return {
      queue: response.queue ?? queueName,
      status: stats.paused ? 'paused' : 'active',
      stats: {
        available: parseInt(stats.available ?? '0', 10),
        active: parseInt(stats.active ?? '0', 10),
        scheduled: parseInt(stats.scheduled ?? '0', 10),
        retryable: parseInt(stats.retryable ?? '0', 10),
        dead: parseInt(stats.dead ?? '0', 10),
        completed_last_hour: parseInt(stats.completedLastHour ?? '0', 10),
        failed_last_hour: parseInt(stats.failedLastHour ?? '0', 10),
      },
    };
  }

  private async grpcPauseQueue(
    queueName: string,
    timeout?: number,
  ): Promise<unknown> {
    await this.call<any>('pauseQueue', { queue: queueName }, timeout);
    return { status: 'paused' };
  }

  private async grpcResumeQueue(
    queueName: string,
    timeout?: number,
  ): Promise<unknown> {
    await this.call<any>('resumeQueue', { queue: queueName }, timeout);
    return { status: 'active' };
  }

  private async grpcListDeadLetter(
    body: any,
    timeout?: number,
  ): Promise<unknown> {
    const request: any = {};
    if (body?.queue) request.queue = body.queue;
    if (body?.limit) request.limit = body.limit;
    const response = await this.call<any>('listDeadLetter', request, timeout);
    return {
      jobs: (response.jobs ?? []).map(fromProtoJob),
      pagination: {
        total: parseInt(response.totalCount ?? '0', 10),
      },
    };
  }

  private async grpcRetryDeadLetter(
    jobId: string,
    timeout?: number,
  ): Promise<unknown> {
    const response = await this.call<any>(
      'retryDeadLetter',
      { jobId },
      timeout,
    );
    return { job: fromProtoJob(response.job) };
  }

  private async grpcDeleteDeadLetter(
    jobId: string,
    timeout?: number,
  ): Promise<unknown> {
    await this.call<any>('deleteDeadLetter', { jobId }, timeout);
    return {};
  }

  private async grpcListCron(timeout?: number): Promise<unknown> {
    const response = await this.call<any>('listCron', {}, timeout);
    return {
      cron_jobs: (response.entries ?? []).map((e: any) => ({
        name: e.name,
        cron: e.cron,
        timezone: e.timezone,
        type: e.type,
      })),
    };
  }

  private async grpcRegisterCron(
    body: any,
    timeout?: number,
  ): Promise<unknown> {
    const request: any = {
      name: body.name,
      cron: body.cron,
      type: body.type,
      args: body.args?.map(toProtoValue) ?? [],
    };
    if (body.timezone) request.timezone = body.timezone;
    const response = await this.call<any>('registerCron', request, timeout);
    return { name: response.name };
  }

  private async grpcUnregisterCron(
    name: string,
    timeout?: number,
  ): Promise<unknown> {
    await this.call<any>('unregisterCron', { name }, timeout);
    return {};
  }

  private async grpcCreateWorkflow(
    body: any,
    timeout?: number,
  ): Promise<unknown> {
    const request: any = {
      name: body.name,
      steps: (body.steps ?? []).map((s: any) => ({
        id: s.id,
        type: s.type,
        args: s.args?.map(toProtoValue) ?? [],
        dependsOn: s.depends_on ?? [],
      })),
    };
    const response = await this.call<any>('createWorkflow', request, timeout);
    return { workflow: fromProtoWorkflow(response.workflow) };
  }

  private async grpcGetWorkflow(
    workflowId: string,
    timeout?: number,
  ): Promise<unknown> {
    const response = await this.call<any>(
      'getWorkflow',
      { workflowId },
      timeout,
    );
    return { workflow: fromProtoWorkflow(response.workflow) };
  }

  private async grpcCancelWorkflow(
    workflowId: string,
    timeout?: number,
  ): Promise<unknown> {
    await this.call<any>(
      'cancelWorkflow',
      { workflowId },
      timeout,
    );
    return { state: 'cancelled' };
  }

  private async grpcHealth(timeout?: number): Promise<unknown> {
    const response = await this.call<any>('health', {}, timeout);
    const statusMap: Record<string, string> = {
      HEALTH_STATUS_OK: 'ok',
      HEALTH_STATUS_DEGRADED: 'degraded',
      HEALTH_STATUS_UNHEALTHY: 'unhealthy',
    };
    return { status: statusMap[response.status] ?? 'ok' };
  }

  private async grpcManifest(timeout?: number): Promise<unknown> {
    const response = await this.call<any>('manifest', {}, timeout);
    return {
      ojs_version: response.ojsVersion,
      implementation: response.implementation,
      conformance_level: response.conformanceLevel,
      protocols: response.protocols,
      backend: response.backend,
      extensions: response.extensions,
    };
  }

  /** Close the underlying gRPC channel. */
  close(): void {
    if (this.client) {
      this.client.close();
      this.client = null;
      this.initPromise = null;
    }
  }
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
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      fields[k] = toProtoValue(v);
    }
    return { structValue: { fields } };
  }
  return { stringValue: String(value) };
}

/** Converts a proto Value back to a JS value. */
function fromProtoValue(value: any): unknown {
  if (!value) return null;
  if (value.stringValue !== undefined && value.stringValue !== '') return value.stringValue;
  if (value.numberValue !== undefined && value.numberValue !== 0) return value.numberValue;
  if (value.boolValue !== undefined && value.boolValue !== false) return value.boolValue;
  if (value.nullValue !== undefined) return null;
  if (value.listValue) {
    return (value.listValue.values ?? []).map(fromProtoValue);
  }
  if (value.structValue) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value.structValue.fields ?? {})) {
      result[k] = fromProtoValue(v);
    }
    return result;
  }
  // proto-loader with defaults may return the value directly
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return null;
}

/** Maps a proto Job to the JSON format expected by the SDK. */
function fromProtoJob(job: any): Record<string, unknown> {
  if (!job) return {};
  return {
    id: job.id ?? '',
    type: job.type ?? '',
    queue: job.queue ?? 'default',
    args: (job.args ?? []).map(fromProtoValue),
    state: mapJobState(job.state),
    priority: job.priority ?? 0,
    attempt: job.attempt ?? 0,
    max_attempts: job.maxAttempts ?? 0,
    created_at: job.createdAt ?? null,
    enqueued_at: job.enqueuedAt ?? null,
    scheduled_at: job.scheduledAt ?? null,
    started_at: job.startedAt ?? null,
    completed_at: job.completedAt ?? null,
    tags: job.tags ?? [],
    trace_id: job.traceId ?? '',
    workflow_id: job.workflowId ?? '',
    specversion: job.specversion ?? '1.0',
  };
}

/** Maps a proto Workflow to the JSON format. */
function fromProtoWorkflow(workflow: any): Record<string, unknown> {
  if (!workflow) return {};
  const stateMap: Record<string, string> = {
    WORKFLOW_STATE_RUNNING: 'running',
    WORKFLOW_STATE_COMPLETED: 'completed',
    WORKFLOW_STATE_FAILED: 'failed',
    WORKFLOW_STATE_CANCELLED: 'cancelled',
  };
  return {
    id: workflow.id ?? '',
    name: workflow.name ?? '',
    state: stateMap[workflow.state] ?? 'running',
    steps: (workflow.steps ?? []).map((s: any) => ({
      id: s.id ?? '',
      type: s.type ?? '',
      state: mapStepState(s.state),
      job_id: s.jobId ?? '',
      depends_on: s.dependsOn ?? [],
    })),
  };
}

/** Maps proto JobState enum string to lowercase state name. */
function mapJobState(state: string | number): string {
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

/** Maps proto WorkflowStepState to lowercase string. */
function mapStepState(state: string | number): string {
  const map: Record<string, string> = {
    WORKFLOW_STEP_STATE_WAITING: 'waiting',
    WORKFLOW_STEP_STATE_PENDING: 'pending',
    WORKFLOW_STEP_STATE_ACTIVE: 'active',
    WORKFLOW_STEP_STATE_COMPLETED: 'completed',
    WORKFLOW_STEP_STATE_FAILED: 'failed',
    WORKFLOW_STEP_STATE_CANCELLED: 'cancelled',
  };
  if (typeof state === 'string') {
    return map[state] ?? state.toLowerCase().replace('workflow_step_state_', '');
  }
  return 'pending';
}

/** Maps proto WorkerState to lowercase string. */
function mapWorkerState(state: string | number): string {
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

/** Maps enqueue body options to proto EnqueueOptions. */
function mapEnqueueOptions(body: any): any {
  const opts: any = {};
  if (body.queue) opts.queue = body.queue;
  if (body.priority !== undefined) opts.priority = body.priority;
  if (body.tags) opts.tags = body.tags;
  if (body.options) {
    Object.assign(opts, body.options);
  }
  return opts;
}

/** Maps a gRPC error to the appropriate OJS error type. */
function mapGrpcError(err: any): OJSError {
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

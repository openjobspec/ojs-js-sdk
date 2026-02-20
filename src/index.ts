/**
 * @openjobspec/sdk — Official Open Job Spec SDK for JavaScript and TypeScript.
 *
 * Zero dependencies. TypeScript-first. Full type safety.
 *
 * @example
 * ```ts
 * import { OJSClient, OJSWorker, chain, group, batch } from '@openjobspec/sdk';
 * ```
 *
 * @packageDocumentation
 */

// ---- Client (Producer) ----
export { OJSClient } from './client.js';
export type { OJSClientConfig } from './client.js';

// ---- Worker (Consumer) ----
export { OJSWorker } from './worker.js';
export type { OJSWorkerConfig, WorkerState, JobHandler } from './worker.js';

// ---- Job Types ----
export type {
  Job,
  JobState,
  JobSpec,
  JobError,
  JsonValue,
  EnqueueOptions,
  RetryOptions,
  UniqueOptions,
  RetryPolicy,
  UniquePolicy,
} from './job.js';
export { TERMINAL_STATES, normalizeArgs } from './job.js';

// ---- Workflow Builders ----
export { chain, group, batch } from './workflow.js';
export type {
  ChainDefinition,
  GroupDefinition,
  BatchDefinition,
  BatchCallbacks,
  WorkflowDefinition,
  WorkflowStatus,
  WorkflowState,
} from './workflow.js';

// ---- Middleware ----
export { MiddlewareChain } from './middleware.js';
export type {
  JobContext,
  NextFunction,
  ExecutionMiddleware,
  EnqueueMiddleware,
} from './middleware.js';

// ---- Retry Helpers ----
export {
  DEFAULT_RETRY_POLICY,
  computeBackoff,
  mergeWithDefaults,
  isNonRetryable,
  parseDurationToMs,
  msToIsoDuration,
} from './retry.js';
export type { BackoffStrategy } from './retry.js';

// ---- Rate Limit Retry ----
export { DEFAULT_RETRY_CONFIG } from './rate-limiter.js';
export type { RetryConfig } from './rate-limiter.js';

// ---- Events ----
export { OJSEventEmitter } from './events.js';
export type {
  OJSEvent,
  OJSEventType,
  OJSEventListener,
  OJSEventDataMap,
} from './events.js';

// ---- Errors ----
export {
  OJSError,
  OJSValidationError,
  OJSNotFoundError,
  OJSDuplicateError,
  OJSConflictError,
  OJSServerError,
  OJSConnectionError,
  OJSTimeoutError,
  OJSRateLimitError,
} from './errors.js';
export type { RateLimitInfo } from './errors.js';
export type { ErrorCodeEntry } from './error-codes.js';
export {
  ALL_ERROR_CODES,
  lookupByCanonicalCode,
  lookupByCode,
} from './error-codes.js';

// ---- Queue Operations ----
export { QueueOperations } from './queue.js';
export type { QueueInfo, QueueStats, DeadLetterJob } from './queue.js';

// ---- Cron Operations ----
export { CronOperations } from './cron.js';
export type {
  CronJobInfo,
  CronJobOptions,
  CronJobDefinition,
  CronListOptions,
} from './cron.js';

// ---- Schema Operations ----
export { SchemaOperations } from './schema.js';
export type {
  SchemaInfo,
  SchemaDefinition,
  SchemaListOptions,
} from './schema.js';

// ---- Progress Reporting ----
export { reportProgress } from './progress.js';
export type { ProgressReport } from './progress.js';

// ---- Transport ----
export { HttpTransport } from './transport/http.js';
export { GrpcTransport } from './transport/grpc.js';
export type { GrpcTransportConfig } from './transport/grpc.js';
export type {
  Transport,
  TransportConfig,
  TransportRequestOptions,
  TransportResponse,
} from './transport/types.js';

// ---- Validation ----
export {
  validateJobType,
  validateQueueName,
  validateArgs,
  validateUUIDv7,
  validateTimestamp,
  validateDuration,
  validateEnqueueRequest,
} from './validation/schemas.js';

// OpenTelemetry
export { openTelemetryMiddleware } from './otel.js';
export type { OpenTelemetryConfig } from './otel.js';

// ---- Serverless Adapters ----
export {
  createWorkerHandler,
  createEdgeHandler,
  createLambdaHandler,
} from './serverless/index.js';
export type {
  CloudflareWorkerOptions,
  CloudflareJobContext,
  CloudflareJobHandler,
  CloudflareWorkerHandler,
  VercelEdgeOptions,
  VercelJobContext,
  VercelJobHandler,
  VercelEdgeHandler,
  LambdaOptions,
  LambdaJobContext,
  LambdaJobHandler,
  LambdaHandler,
  SQSEvent,
  SQSRecord,
  SQSBatchResponse,
  DirectResponse,
} from './serverless/index.js';

// ---- ML/AI Resource Extension ----
export {
  GPUType,
  withGPU,
  withModel,
  withResources,
  withCheckpoint,
  withPreemption,
  mergeMLOptions,
} from './ml.js';
export type {
  GPUTypeValue,
  GPURequirements,
  CPURequirements,
  ResourceRequirements,
  ModelReference,
  CheckpointConfig,
  PreemptionConfig,
  MLEnqueueOptions,
} from './ml.js';

// ---- Testing Utilities ----
import * as testing from './testing.js';
export { testing };
export type { FakeJob, MatchOptions } from './testing.js';

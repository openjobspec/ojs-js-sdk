/**
 * Workflow primitives: chain, group, batch.
 * Following the OJS Workflow Primitives Specification.
 */

import type { JobSpec, JsonValue } from './job.js';
import { toWireOptions, toWireEnvelopeFields, isRelativeDelayString } from './job.js';
import { OJSValidationError } from './errors.js';

/** Workflow lifecycle states. */
export type WorkflowState =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Per-step lifecycle states across the HTTP binding and gRPC proto. */
export type WorkflowStepState =
  | 'waiting'
  | 'pending'
  | 'available'
  | 'active'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Per-step details returned when supported by the selected transport. */
export interface WorkflowStepStatus {
  /** Stable step ID when the transport exposes one (current gRPC proto). */
  id?: string;
  /** Stable zero-based order when the transport exposes or can derive it. */
  index?: number;
  type: string;
  args?: JsonValue[];
  options?: Record<string, unknown>;
  state: WorkflowStepState;
  /** Null until the step has been enqueued. */
  job_id: string | null;
  depends_on?: string[];
  result?: JsonValue;
  started_at?: string;
  completed_at?: string;
}

/** A chain (sequential execution) workflow definition. */
export interface ChainDefinition {
  type: 'chain';
  name?: string;
  steps: (JobSpec | GroupDefinition | BatchDefinition)[];
}

/** A group (parallel execution) workflow definition. */
export interface GroupDefinition {
  type: 'group';
  name?: string;
  jobs: (JobSpec | ChainDefinition)[];
}

/** Batch callback definitions. */
export interface BatchCallbacks {
  on_complete?: JobSpec;
  on_success?: JobSpec;
  on_failure?: JobSpec;
}

/** A batch (parallel with callbacks) workflow definition. */
export interface BatchDefinition {
  type: 'batch';
  name?: string;
  jobs: JobSpec[];
  callbacks: BatchCallbacks;
}

/** Union type for all workflow definitions. */
export type WorkflowDefinition =
  | ChainDefinition
  | GroupDefinition
  | BatchDefinition;

/**
 * Workflow status as returned by the server.
 *
 * `type`, when present, is exactly one of the three standard public
 * workflow primitives (`'chain' | 'group' | 'batch'`); there is no
 * non-standard fourth value. HTTP responses populate it because the HTTP
 * binding carries the originating primitive directly.
 *
 * The gRPC `Workflow` proto message carries no originating-primitive field
 * at all (only a flat step DAG with dependency edges). gRPC create responses
 * use the submitted primitive, and same-instance gets retain that hint.
 * A get from another process/transport infers only a strict multi-step
 * linear chain or a multi-step edge-free group. One-step workflows and
 * arbitrary DAGs omit `type` rather than fabricating a false value.
 */
export interface WorkflowStatus {
  id: string;
  type?: 'chain' | 'group' | 'batch';
  name?: string;
  state: WorkflowState;
  metadata: {
    created_at: string;
    started_at?: string;
    completed_at?: string;
    job_count: number;
    completed_count: number;
    failed_count: number;
  };
  /** Optional transport-specific step details, preserved for compatibility. */
  steps?: WorkflowStepStatus[];
}

/** Normalizes HTTP-compatible workflow step details without dropping fields. */
export function normalizeWorkflowStatus(
  status: WorkflowStatus,
): WorkflowStatus {
  if (!Array.isArray(status.steps)) return status;

  return {
    ...status,
    steps: status.steps.map((step) => {
      const normalized: WorkflowStepStatus = {
        ...step,
        job_id: typeof step.job_id === 'string' ? step.job_id : null,
      };
      if (step.depends_on !== undefined) {
        normalized.depends_on = Array.isArray(step.depends_on)
          ? step.depends_on.filter(
              (dependency): dependency is string =>
                typeof dependency === 'string',
            )
          : [];
      }
      return normalized;
    }),
  };
}

// ---- Builder Functions ----

/**
 * Create a chain workflow (sequential execution).
 * Jobs execute one after another; the result of step N feeds step N+1.
 *
 * @example
 * ```ts
 * const wf = chain(
 *   { type: 'data.fetch', args: { url: '...' } },
 *   { type: 'data.transform', args: { format: 'csv' } },
 *   { type: 'data.load', args: { dest: 'warehouse' } },
 * );
 * ```
 */
export function chain(
  ...steps: (JobSpec | GroupDefinition | BatchDefinition)[]
): ChainDefinition {
  if (steps.length === 0) {
    throw new Error('A chain must contain at least one step.');
  }
  return { type: 'chain', steps };
}

/**
 * Create a group workflow (parallel execution).
 * All jobs execute concurrently and independently.
 *
 * @example
 * ```ts
 * const wf = group(
 *   { type: 'export.csv', args: { reportId: 'rpt_456' } },
 *   { type: 'export.pdf', args: { reportId: 'rpt_456' } },
 *   { type: 'export.xlsx', args: { reportId: 'rpt_456' } },
 * );
 * ```
 */
export function group(
  ...jobs: (JobSpec | ChainDefinition)[]
): GroupDefinition {
  if (jobs.length === 0) {
    throw new Error('A group must contain at least one job.');
  }
  return { type: 'group', jobs };
}

/**
 * Create a batch workflow (parallel with callbacks).
 * Like a group, but fires callbacks based on the collective outcome.
 *
 * @example
 * ```ts
 * const wf = batch(
 *   [
 *     { type: 'email.send', args: ['user1@example.com'] },
 *     { type: 'email.send', args: ['user2@example.com'] },
 *   ],
 *   {
 *     on_complete: { type: 'batch.report', args: [] },
 *     on_failure: { type: 'batch.alert', args: [] },
 *   },
 * );
 * ```
 */
export function batch(
  jobs: JobSpec[],
  callbacks: BatchCallbacks,
): BatchDefinition {
  if (jobs.length === 0) {
    throw new Error('A batch must contain at least one job.');
  }
  if (!callbacks.on_complete && !callbacks.on_success && !callbacks.on_failure) {
    throw new Error(
      'A batch must have at least one callback (on_complete, on_success, or on_failure).',
    );
  }
  return { type: 'batch', jobs, callbacks };
}

/**
 * Convert a workflow definition to the wire format for the server.
 */
export function toWireWorkflow(
  definition: WorkflowDefinition,
): Record<string, unknown> {
  const wire: Record<string, unknown> = { type: definition.type };

  if (definition.name) wire.name = definition.name;

  switch (definition.type) {
    case 'chain':
      if (definition.steps.length === 0) {
        throw new OJSValidationError(
          'A workflow chain must contain at least one step, including when nested.',
        );
      }
      wire.steps = definition.steps.map(toWireStep);
      break;
    case 'group':
      if (definition.jobs.length === 0) {
        throw new OJSValidationError(
          'A workflow group must contain at least one job, including when nested.',
        );
      }
      wire.jobs = definition.jobs.map(toWireStep);
      break;
    case 'batch':
      wire.jobs = definition.jobs.map(toWireStep);
      wire.callbacks = toWireCallbacks(definition.callbacks);
      break;
  }

  return wire;
}

function toWireStep(
  step: JobSpec | ChainDefinition | GroupDefinition | BatchDefinition,
): Record<string, unknown> {
  // Discriminate workflow primitives by their structural properties,
  // not by the 'type' field value, since a JobSpec could have type: 'chain'.
  if ('steps' in step || 'jobs' in step || 'callbacks' in step) {
    return toWireWorkflow(step as WorkflowDefinition);
  }

  // Job spec
  const jobSpec = step as JobSpec;
  assertNoDeferredExpiresAt(jobSpec);
  assertNoRelativeDelay(jobSpec);
  const wire: Record<string, unknown> = {
    type: jobSpec.type,
    args: normalizeStepArgs(jobSpec.args),
    // `meta`/`schema` are job-envelope-level fields, siblings of `options`
    // — never nested inside it (see toWireEnvelopeFields()'s doc comment
    // for why: job-options.schema.json is additionalProperties:false and
    // doesn't define either field). A developer supplies them via
    // JobSpec.options (EnqueueOptions), the same ergonomic shape used for
    // top-level enqueue() — this relocates them to the step's top level
    // for the wire, exactly like OJSClient.enqueue() does for the
    // top-level request body.
    ...toWireEnvelopeFields(jobSpec.options),
  };

  // Reuse the same camelCase -> wire-format conversion used for top-level
  // enqueue() options (queue/priority/timeout/delay/expiresAt/retry/unique/
  // tags/visibilityTimeout). The previous hand-rolled mapping here only
  // handled queue/timeout/tags and passed `retry` through unconverted
  // (camelCase field names instead of the snake_case shape the wire format
  // and ojs-workflows.md examples require), silently dropping every other
  // option for workflow steps and callbacks.
  const wireOptions = toWireOptions(jobSpec.options);
  if (wireOptions) wire.options = wireOptions;

  return wire;
}

function assertNoDeferredExpiresAt(jobSpec: JobSpec): void {
  const rawJob = jobSpec as unknown as Record<string, unknown>;
  const rawOptions =
    typeof rawJob.options === 'object' &&
    rawJob.options !== null &&
    !Array.isArray(rawJob.options)
      ? (rawJob.options as Record<string, unknown>)
      : undefined;
  if (
    rawJob.expires_at !== undefined ||
    rawJob.expiresAt !== undefined ||
    rawOptions?.expires_at !== undefined ||
    rawOptions?.expiresAt !== undefined
  ) {
    throw new OJSValidationError(
      'Workflow steps and callbacks do not support expires_at/expiresAt: they may be materialized later, so converting an absolute deadline to a relative TTL now would shift the requested expiration.',
    );
  }
}

/**
 * Rejects a developer-friendly *relative* delay shorthand (`'5m'`, `'30s'`,
 * `'1h'`, ...) on a workflow step or batch callback, before this step is
 * ever serialized. The OJS wire protocol carries only an absolute
 * `delay_until` timestamp (ojs-http-binding.md/ojs-grpc-binding.md have no
 * relative delay field at all); `toWireOptions()`/`parseDuration()` would
 * otherwise convert a relative shorthand to `Date.now() + N` *at the
 * moment the workflow is submitted* -- correct for an immediate
 * `enqueue()`, but wrong here, because a non-first chain step, a group
 * member behind another chain, or any batch callback is only materialized
 * into a real job once its predecessors finish, at an unpredictable later
 * time. A `'5m'` delay written down when the workflow is submitted would
 * silently become "5 minutes after submission" instead of the developer's
 * actual intent of "5 minutes after this step becomes eligible to run."
 *
 * An explicit absolute RFC 3339 timestamp (e.g.
 * `'2030-01-01T00:00:00Z'`) is unaffected: it already names one exact
 * instant regardless of when this step materializes, so `parseDuration()`
 * passes it through unchanged and there is nothing ambiguous to reject.
 * This mirrors {@link assertNoDeferredExpiresAt}'s identical reasoning
 * for `expiresAt`, and is checked for the same raw camelCase/snake_case/
 * options-vs-top-level shapes for the same defensive reasons.
 */
function assertNoRelativeDelay(jobSpec: JobSpec): void {
  const rawJob = jobSpec as unknown as Record<string, unknown>;
  const rawOptions =
    typeof rawJob.options === 'object' &&
    rawJob.options !== null &&
    !Array.isArray(rawJob.options)
      ? (rawJob.options as Record<string, unknown>)
      : undefined;
  const delay = rawOptions?.delay ?? rawJob.delay;
  if (typeof delay === 'string' && isRelativeDelayString(delay)) {
    throw new OJSValidationError(
      `Workflow steps and callbacks do not support the relative delay shorthand '${delay}': ` +
        'the job may be materialized later (once its predecessors finish), so converting ' +
        '"N units from now" to an absolute delay_until at workflow-submission time would shift ' +
        'the requested delay. Pass an explicit RFC 3339 absolute timestamp instead (e.g. ' +
        "'2030-01-01T00:00:00Z'), computed relative to when the step is expected to run.",
    );
  }
}

function normalizeStepArgs(args?: JsonValue | JsonValue[]): JsonValue[] {
  if (args === undefined) return [];
  if (Array.isArray(args)) return args;
  return [args];
}

function toWireCallbacks(
  callbacks: BatchCallbacks,
): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  if (callbacks.on_complete) wire.on_complete = toWireStep(callbacks.on_complete);
  if (callbacks.on_success) wire.on_success = toWireStep(callbacks.on_success);
  if (callbacks.on_failure) wire.on_failure = toWireStep(callbacks.on_failure);
  return wire;
}

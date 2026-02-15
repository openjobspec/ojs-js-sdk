/**
 * Workflow primitives: chain, group, batch.
 * Following the OJS Workflow Primitives Specification.
 */

import type { JobSpec, JsonValue } from './job.js';

/** Workflow lifecycle states. */
export type WorkflowState =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

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

/** Workflow status as returned by the server. */
export interface WorkflowStatus {
  id: string;
  type: 'chain' | 'group' | 'batch';
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
      wire.steps = definition.steps.map(toWireStep);
      break;
    case 'group':
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
  const wire: Record<string, unknown> = {
    type: jobSpec.type,
    args: normalizeStepArgs(jobSpec.args),
  };

  if (jobSpec.options) {
    const opts: Record<string, unknown> = {};
    if (jobSpec.options.queue) opts.queue = jobSpec.options.queue;
    if (jobSpec.options.retry) opts.retry = jobSpec.options.retry;
    if (jobSpec.options.timeout) opts.timeout_ms = jobSpec.options.timeout;
    if (jobSpec.options.tags) opts.tags = jobSpec.options.tags;
    if (Object.keys(opts).length > 0) wire.options = opts;
  }

  return wire;
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

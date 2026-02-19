/**
 * ML/AI Resource Extension for OJS.
 *
 * Provides types and helpers for declaring GPU, CPU, memory, and storage
 * requirements on jobs, following the OJS ML Resource Extension Specification.
 *
 * Resource requirements are stored in the job's `meta` field and require
 * no changes to the core OJS specification.
 *
 * @example
 * ```ts
 * import { OJSClient } from '@openjobspec/sdk';
 * import { withGPU, withModel, GPUType } from '@openjobspec/sdk/ml';
 *
 * const opts = {
 *   ...withGPU(GPUType.NvidiaA100, 2, 80),
 *   ...withModel({ name: 'resnet50', version: '1.0.0' }),
 * };
 * await client.enqueue('ml.train', { model: 'resnet50' }, opts);
 * ```
 *
 * @packageDocumentation
 */

import type { EnqueueOptions, JsonValue } from './job.js';

// ---- GPU Type Constants ----

/** Well-known GPU type identifiers. */
export const GPUType = {
  NvidiaA100: 'nvidia-a100',
  NvidiaH100: 'nvidia-h100',
  NvidiaT4: 'nvidia-t4',
  NvidiaL4: 'nvidia-l4',
  NvidiaV100: 'nvidia-v100',
  AmdMI250: 'amd-mi250',
  AmdMI300X: 'amd-mi300x',
  GoogleTPUv5: 'google-tpu-v5',
} as const;

export type GPUTypeValue = (typeof GPUType)[keyof typeof GPUType];

// ---- Type Definitions ----

/** GPU resource requirements. */
export interface GPURequirements {
  /** Number of GPUs required (default: 0). */
  count: number;
  /** GPU model identifier (e.g., 'nvidia-a100'). */
  type?: string;
  /** Minimum GPU memory per device in GB. */
  memoryGB?: number;
}

/** CPU resource requirements. */
export interface CPURequirements {
  /** Minimum CPU cores required. */
  cores: number;
}

/** Compute resource requirements for a job. */
export interface ResourceRequirements {
  /** GPU resource needs. */
  gpu?: GPURequirements;
  /** CPU resource needs. */
  cpu?: CPURequirements;
  /** Minimum system memory in GB. */
  memoryGB?: number;
  /** Minimum scratch storage in GB. */
  storageGB?: number;
}

/** Reference to an ML model artifact. */
export interface ModelReference {
  /** Model name or identifier. */
  name: string;
  /** Model version string. */
  version?: string;
  /** Model registry (e.g., 'huggingface'). */
  registry?: string;
  /** Integrity checksum (e.g., 'sha256:abc123'). */
  checksum?: string;
}

/** Checkpoint configuration for long-running jobs. */
export interface CheckpointConfig {
  /** Whether checkpointing is enabled. */
  enabled: boolean;
  /** Checkpoint interval in seconds. */
  intervalSec?: number;
  /** URI prefix for checkpoint storage (s3://, gs://, file://). */
  storageURI?: string;
  /** Maximum checkpoints to retain (FIFO eviction). */
  maxCheckpoints?: number;
}

/** Preemption tolerance configuration. */
export interface PreemptionConfig {
  /** Whether the job can be preempted. */
  preemptible: boolean;
  /** Seconds of warning before preemption. */
  gracePeriodSec?: number;
  /** Whether to checkpoint before preemption. */
  checkpointOnPreempt?: boolean;
}

/** Enqueue options extended with ML resource metadata. */
export interface MLEnqueueOptions extends EnqueueOptions {
  meta?: Record<string, JsonValue> & {
    resources?: Record<string, JsonValue>;
    model?: Record<string, JsonValue>;
    checkpoint?: Record<string, JsonValue>;
    preemption?: Record<string, JsonValue>;
  };
}

// ---- Helper Functions ----

/**
 * Build EnqueueOptions with GPU resource requirements.
 * This is a convenience shorthand for `withResources` with only GPU fields.
 */
export function withGPU(
  gpuType: string,
  count: number,
  memoryGB?: number,
): Partial<EnqueueOptions> {
  const gpu: GPURequirements = { type: gpuType, count };
  if (memoryGB !== undefined) gpu.memoryGB = memoryGB;
  return withResources({ gpu });
}

/**
 * Build EnqueueOptions with full resource requirements in meta.resources.
 */
export function withResources(
  req: ResourceRequirements,
): Partial<EnqueueOptions> {
  const resources: Record<string, JsonValue> = {};

  if (req.gpu) {
    const gpu: Record<string, JsonValue> = { count: req.gpu.count };
    if (req.gpu.type) gpu.type = req.gpu.type;
    if (req.gpu.memoryGB !== undefined) gpu.memory_gb = req.gpu.memoryGB;
    resources.gpu = gpu as JsonValue;
  }
  if (req.cpu) {
    resources.cpu = { cores: req.cpu.cores } as JsonValue;
  }
  if (req.memoryGB !== undefined) {
    resources.memory_gb = req.memoryGB;
  }
  if (req.storageGB !== undefined) {
    resources.storage_gb = req.storageGB;
  }

  return { meta: { resources: resources as JsonValue } };
}

/**
 * Build EnqueueOptions with a model reference in meta.model.
 */
export function withModel(ref: ModelReference): Partial<EnqueueOptions> {
  const model: Record<string, JsonValue> = { name: ref.name };
  if (ref.version) model.version = ref.version;
  if (ref.registry) model.registry = ref.registry;
  if (ref.checksum) model.checksum = ref.checksum;

  return { meta: { model: model as JsonValue } };
}

/**
 * Build EnqueueOptions with checkpoint configuration in meta.checkpoint.
 */
export function withCheckpoint(
  cfg: CheckpointConfig,
): Partial<EnqueueOptions> {
  const checkpoint: Record<string, JsonValue> = { enabled: cfg.enabled };
  if (cfg.intervalSec !== undefined) checkpoint.interval_s = cfg.intervalSec;
  if (cfg.storageURI) checkpoint.storage_uri = cfg.storageURI;
  if (cfg.maxCheckpoints !== undefined)
    checkpoint.max_checkpoints = cfg.maxCheckpoints;

  return { meta: { checkpoint: checkpoint as JsonValue } };
}

/**
 * Build EnqueueOptions with preemption configuration in meta.preemption.
 */
export function withPreemption(
  cfg: PreemptionConfig,
): Partial<EnqueueOptions> {
  const preemption: Record<string, JsonValue> = {
    preemptible: cfg.preemptible,
  };
  if (cfg.gracePeriodSec !== undefined)
    preemption.grace_period_s = cfg.gracePeriodSec;
  if (cfg.checkpointOnPreempt !== undefined)
    preemption.checkpoint_on_preempt = cfg.checkpointOnPreempt;

  return { meta: { preemption: preemption as JsonValue } };
}

/**
 * Merge multiple ML option partials into a single EnqueueOptions object.
 * Use this to combine withGPU, withModel, withCheckpoint, etc.
 *
 * @example
 * ```ts
 * const opts = mergeMLOptions(
 *   withGPU(GPUType.NvidiaA100, 2, 80),
 *   withModel({ name: 'resnet50', version: '1.0.0' }),
 *   withCheckpoint({ enabled: true, intervalSec: 300 }),
 * );
 * await client.enqueue('ml.train', args, { queue: 'ml', ...opts });
 * ```
 */
export function mergeMLOptions(
  ...partials: Partial<EnqueueOptions>[]
): Partial<EnqueueOptions> {
  const merged: Partial<EnqueueOptions> = {};
  const meta: Record<string, JsonValue> = {};

  for (const p of partials) {
    if (p.meta) {
      Object.assign(meta, p.meta);
    }
    // Copy non-meta fields
    for (const [key, value] of Object.entries(p)) {
      if (key !== 'meta') {
        (merged as Record<string, unknown>)[key] = value;
      }
    }
  }

  if (Object.keys(meta).length > 0) {
    merged.meta = meta;
  }

  return merged;
}

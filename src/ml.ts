/**
 * ML/AI Resource Extension for OJS.
 *
 * Provides types and helpers for declaring GPU, TPU, CPU, memory, and storage
 * requirements on jobs, following the OJS ML Resource Extension Specification.
 *
 * Resource requirements are stored in the job's `meta` field and require
 * no changes to the core OJS specification.
 *
 * @example
 * ```ts
 * import { OJSClient } from '@openjobspec/sdk';
 * import { withGPU, withModel, GPUType, mergeMLOptions } from '@openjobspec/sdk/ml';
 *
 * const opts = mergeMLOptions(
 *   withGPU(GPUType.NvidiaA100, 2, 80),
 *   withModel({ name: 'resnet50', version: '1.0.0', format: 'safetensors' }),
 *   withCompute({ runtime: 'pytorch', precision: 'bf16', distributedStrategy: 'fsdp' }),
 * );
 * await client.enqueue('ml.train', { model: 'resnet50' }, { queue: 'ml', ...opts });
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
  NvidiaH200: 'nvidia-h200',
  NvidiaT4: 'nvidia-t4',
  NvidiaL4: 'nvidia-l4',
  NvidiaL40S: 'nvidia-l40s',
  NvidiaV100: 'nvidia-v100',
  NvidiaA10G: 'nvidia-a10g',
  NvidiaB200: 'nvidia-b200',
  AmdMI250: 'amd-mi250',
  AmdMI300X: 'amd-mi300x',
  GoogleTPUv5: 'google-tpu-v5',
} as const;

export type GPUTypeValue = (typeof GPUType)[keyof typeof GPUType];

/** Well-known TPU type identifiers. */
export const TPUType = {
  V4: 'v4',
  V5e: 'v5e',
  V5p: 'v5p',
  V6e: 'v6e',
} as const;

export type TPUTypeValue = (typeof TPUType)[keyof typeof TPUType];

/** Compute precision values. */
export const Precision = {
  FP32: 'fp32',
  FP16: 'fp16',
  BF16: 'bf16',
  FP8: 'fp8',
  INT8: 'int8',
  INT4: 'int4',
} as const;

export type PrecisionValue = (typeof Precision)[keyof typeof Precision];

/** ML runtime identifiers. */
export const MLRuntime = {
  PyTorch: 'pytorch',
  TensorFlow: 'tensorflow',
  ONNX: 'onnx',
  Triton: 'triton',
  VLLM: 'vllm',
  TGI: 'tgi',
  Custom: 'custom',
} as const;

export type MLRuntimeValue = (typeof MLRuntime)[keyof typeof MLRuntime];

/** Distributed strategy identifiers. */
export const DistributedStrategy = {
  None: 'none',
  DataParallel: 'data_parallel',
  TensorParallel: 'tensor_parallel',
  PipelineParallel: 'pipeline_parallel',
  FSDP: 'fsdp',
  DeepSpeed: 'deepspeed',
} as const;

export type DistributedStrategyValue =
  (typeof DistributedStrategy)[keyof typeof DistributedStrategy];

/** GPU interconnect types. */
export const Interconnect = {
  NVLink: 'nvlink',
  PCIe: 'pcie',
  Any: 'any',
} as const;

export type InterconnectValue = (typeof Interconnect)[keyof typeof Interconnect];

/** Model format identifiers. */
export const ModelFormat = {
  Safetensors: 'safetensors',
  GGUF: 'gguf',
  ONNX: 'onnx',
  TorchScript: 'torchscript',
  SavedModel: 'savedmodel',
  Custom: 'custom',
} as const;

export type ModelFormatValue = (typeof ModelFormat)[keyof typeof ModelFormat];

// ---- Type Definitions ----

/** GPU resource requirements. */
export interface GPURequirements {
  /** Number of GPUs required (default: 0). */
  count: number;
  /** GPU model identifier (e.g., 'nvidia-a100'). */
  type?: string;
  /** Minimum GPU VRAM per device in GB. */
  memoryGB?: number;
  /** Minimum NVIDIA compute capability (e.g., '8.0'). */
  computeCapability?: string;
  /** Required GPU interconnect: 'nvlink', 'pcie', 'any'. */
  interconnect?: string;
}

/** TPU resource requirements. */
export interface TPURequirements {
  /** TPU version: 'v4', 'v5e', 'v5p', 'v6e'. */
  type?: string;
  /** TPU pod slice topology (e.g., '2x4', '4x4'). */
  topology?: string;
  /** Number of TPU chips required. */
  chipCount?: number;
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
  /** TPU resource needs. */
  tpu?: TPURequirements;
  /** CPU resource needs. */
  cpu?: CPURequirements;
  /** Minimum system memory in GB. */
  memoryGB?: number;
  /** Minimum scratch storage in GB. */
  storageGB?: number;
  /** Minimum shared memory (/dev/shm) size in GB. */
  shmSizeGB?: number;
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
  /** Model format (e.g., 'safetensors', 'gguf', 'onnx'). */
  format?: string;
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

/** Compute constraints for ML jobs. */
export interface ComputeConfig {
  /** ML runtime (e.g., 'pytorch', 'vllm', 'onnx'). */
  runtime?: string;
  /** Compute precision (e.g., 'fp32', 'fp16', 'bf16', 'fp8'). */
  precision?: string;
  /** Distribution strategy (e.g., 'data_parallel', 'tensor_parallel', 'fsdp'). */
  distributedStrategy?: string;
  /** Maximum tokens for generation tasks. */
  maxTokens?: number;
  /** Maximum batch size for inference. */
  maxBatchSize?: number;
}

/** Affinity operator for scheduling rules. */
export type AffinityOperator =
  | 'In'
  | 'NotIn'
  | 'Exists'
  | 'DoesNotExist'
  | 'Gt'
  | 'Gte'
  | 'Lt'
  | 'Lte';

/** An affinity rule for scheduling constraints. */
export type AffinityRule = {
  /** Worker label key. */
  key: string;
  /** Comparison operator. */
  operator: AffinityOperator;
  /** Values to match. */
  values?: string[];
}

/** A weighted affinity rule for preferred scheduling. */
export type WeightedAffinityRule = AffinityRule & {
  /** Preference weight (0-100). */
  weight?: number;
}

/** Scheduling affinity configuration. */
export type AffinityConfig = {
  /** Hard constraints (required). */
  required?: AffinityRule[];
  /** Soft constraints (preferred). */
  preferred?: WeightedAffinityRule[];
}

/** Wire-format GPU requirements as they appear at `meta.resources.gpu`. */
export type MLGPUResourceMetadata = {
  count?: number;
  type?: string;
  memory_gb?: number;
  compute_capability?: string;
  interconnect?: string;
}

/** Wire-format TPU requirements as they appear at `meta.resources.tpu`. */
export type MLTPUResourceMetadata = {
  type?: string;
  topology?: string;
  chip_count?: number;
}

/** Wire-format CPU requirements as they appear at `meta.resources.cpu`. */
export type MLCPUResourceMetadata = {
  cores?: number;
}

/** Wire-format model reference as it appears at `meta.resources.model`. */
export type MLModelResourceMetadata = {
  name: string;
  version?: string;
  registry?: string;
  checksum?: string;
  format?: string;
}

/** Wire-format checkpoint config as it appears at `meta.resources.checkpoint`. */
export type MLCheckpointResourceMetadata = {
  enabled?: boolean;
  interval_s?: number;
  storage_uri?: string;
  max_checkpoints?: number;
}

/** Wire-format preemption config as it appears at `meta.resources.preemption`. */
export type MLPreemptionResourceMetadata = {
  preemptible?: boolean;
  grace_period_s?: number;
  checkpoint_on_preempt?: boolean;
}

/**
 * Typed shape of the `meta.resources` object defined by
 * `schemas/v1/ml-resources.schema.json`. This object is schema-closed
 * (`additionalProperties: false`): every property below is one this schema
 * actually defines, and nothing else may be added here (see
 * `withCompute`'s doc comment for why `ext_ml_max_tokens`/
 * `ext_ml_max_batch_size` are deliberately excluded and live at the
 * top-level `meta` object instead, not inside `resources`).
 */
/**
 * Typed shape of `meta.resources`. Defined as a type alias (not an
 * interface) so that a named variable of this type is directly assignable
 * to `MLEnqueueOptions.meta.resources` without casts (Finding 5).
 */
export type MLResourcesMetadata = {
  gpu?: MLGPUResourceMetadata;
  tpu?: MLTPUResourceMetadata;
  cpu?: MLCPUResourceMetadata;
  memory_gb?: number;
  storage_gb?: number;
  shm_size_gb?: number;
  model?: MLModelResourceMetadata;
  runtime?: string;
  precision?: string;
  distributed_strategy?: string;
  checkpoint?: MLCheckpointResourceMetadata;
  preemption?: MLPreemptionResourceMetadata;
  node_selector?: Record<string, string>;
  affinity?: AffinityConfig;
};

/**
 * Enqueue options extended with ML resource metadata.
 *
 * `meta.resources` is precisely typed as {@link MLResourcesMetadata},
 * matching `schemas/v1/ml-resources.schema.json` exactly. `ext_ml_max_tokens`
 * and `ext_ml_max_batch_size` are typed as top-level `meta` properties
 * because that is where `withCompute` actually emits them (the versioned
 * `resources` schema is closed and does not define either key — see F-36
 * in AUDIT.md). Everything else on `meta` remains ordinary arbitrary
 * metadata (`Record<string, JsonValue>`), so callers can still attach
 * unrelated application metadata alongside the typed ML fields.
 */
export interface MLEnqueueOptions extends EnqueueOptions {
  meta?: Record<string, JsonValue> & {
    resources?: MLResourcesMetadata;
    ext_ml_max_tokens?: number;
    ext_ml_max_batch_size?: number;
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
 * Build EnqueueOptions with detailed GPU resource requirements
 * including compute capability and interconnect.
 */
export function withGPUFull(
  gpuType: string,
  count: number,
  memoryGB: number,
  computeCapability?: string,
  interconnect?: string,
): Partial<EnqueueOptions> {
  const gpu: GPURequirements = { type: gpuType, count, memoryGB };
  if (computeCapability !== undefined)
    gpu.computeCapability = computeCapability;
  if (interconnect !== undefined) gpu.interconnect = interconnect;
  return withResources({ gpu });
}

/**
 * Build EnqueueOptions with TPU resource requirements.
 */
export function withTPU(
  tpuType: string,
  topology: string,
  chipCount: number,
): Partial<EnqueueOptions> {
  return withResources({
    tpu: { type: tpuType, topology, chipCount },
  });
}

/**
 * Build EnqueueOptions with full resource requirements in meta.resources.
 */
export function withResources(
  req: ResourceRequirements,
): Partial<EnqueueOptions> {
  // Built as a precisely-typed MLResourcesMetadata locally (catches
  // property-name typos against schemas/v1/ml-resources.schema.json at
  // compile time), then widened to a plain JsonValue bag for the actual
  // return value: EnqueueOptions.meta is intentionally the general
  // Record<string, JsonValue> shape, with MLEnqueueOptions (see its type
  // in this file) providing the precisely-typed view for callers who
  // choose to depend on it.
  const typedResources: MLResourcesMetadata = {};

  if (req.gpu) {
    const gpu: MLGPUResourceMetadata = { count: req.gpu.count };
    if (req.gpu.type) gpu.type = req.gpu.type;
    if (req.gpu.memoryGB !== undefined) gpu.memory_gb = req.gpu.memoryGB;
    if (req.gpu.computeCapability)
      gpu.compute_capability = req.gpu.computeCapability;
    if (req.gpu.interconnect) gpu.interconnect = req.gpu.interconnect;
    typedResources.gpu = gpu;
  }
  if (req.tpu) {
    const tpu: MLTPUResourceMetadata = {};
    if (req.tpu.type) tpu.type = req.tpu.type;
    if (req.tpu.topology) tpu.topology = req.tpu.topology;
    if (req.tpu.chipCount !== undefined) tpu.chip_count = req.tpu.chipCount;
    typedResources.tpu = tpu;
  }
  if (req.cpu) {
    typedResources.cpu = { cores: req.cpu.cores };
  }
  if (req.memoryGB !== undefined) {
    typedResources.memory_gb = req.memoryGB;
  }
  if (req.storageGB !== undefined) {
    typedResources.storage_gb = req.storageGB;
  }
  if (req.shmSizeGB !== undefined) {
    typedResources.shm_size_gb = req.shmSizeGB;
  }

  return { meta: { resources: typedResources } };
}

/**
 * Build EnqueueOptions with a model reference in meta.resources.model.
 *
 * Note: nested under `resources` (a sibling of `gpu`/`tpu`/`cpu`), matching
 * the `schemas/v1/ml-resources.schema.json` contract, which defines the
 * entire ML resource vocabulary — including `model`, `checkpoint`,
 * `preemption`, `runtime`/`precision`/`distributed_strategy`, `node_selector`,
 * and `affinity` — as properties of the single `meta.resources` object
 * rather than separate top-level `meta.*` keys.
 */
export function withModel(ref: ModelReference): Partial<EnqueueOptions> {
  const model: MLModelResourceMetadata = { name: ref.name };
  if (ref.version) model.version = ref.version;
  if (ref.registry) model.registry = ref.registry;
  if (ref.checksum) model.checksum = ref.checksum;
  if (ref.format) model.format = ref.format;

  return { meta: { resources: { model } } };
}

/**
 * Build EnqueueOptions with checkpoint configuration in
 * meta.resources.checkpoint.
 */
export function withCheckpoint(
  cfg: CheckpointConfig,
): Partial<EnqueueOptions> {
  const checkpoint: MLCheckpointResourceMetadata = { enabled: cfg.enabled };
  if (cfg.intervalSec !== undefined) checkpoint.interval_s = cfg.intervalSec;
  if (cfg.storageURI) checkpoint.storage_uri = cfg.storageURI;
  if (cfg.maxCheckpoints !== undefined)
    checkpoint.max_checkpoints = cfg.maxCheckpoints;

  return { meta: { resources: { checkpoint } } };
}

/**
 * Build EnqueueOptions with preemption configuration in
 * meta.resources.preemption.
 */
export function withPreemption(
  cfg: PreemptionConfig,
): Partial<EnqueueOptions> {
  const preemption: MLPreemptionResourceMetadata = {
    preemptible: cfg.preemptible,
  };
  if (cfg.gracePeriodSec !== undefined)
    preemption.grace_period_s = cfg.gracePeriodSec;
  if (cfg.checkpointOnPreempt !== undefined)
    preemption.checkpoint_on_preempt = cfg.checkpointOnPreempt;

  return { meta: { resources: { preemption } } };
}

/**
 * Build EnqueueOptions with compute constraints.
 *
 * `runtime`, `precision`, and `distributed_strategy` are direct
 * `meta.resources` properties in the versioned, schema-closed resource
 * object. Token and batch limits use the normative legacy extension keys
 * `meta.ext_ml_max_tokens` and `meta.ext_ml_max_batch_size`; putting
 * `max_tokens`/`max_batch_size` inside `resources` would violate that
 * object's `additionalProperties: false` contract.
 */
export function withCompute(cfg: ComputeConfig): Partial<EnqueueOptions> {
  const typedResources: MLResourcesMetadata = {};
  const meta: Record<string, JsonValue> = {};

  if (cfg.runtime) typedResources.runtime = cfg.runtime;
  if (cfg.precision) typedResources.precision = cfg.precision;
  if (cfg.distributedStrategy)
    typedResources.distributed_strategy = cfg.distributedStrategy;
  if (cfg.maxTokens !== undefined) {
    assertIntegerInRange('maxTokens', cfg.maxTokens, 1, 10_000_000);
    meta.ext_ml_max_tokens = cfg.maxTokens;
  }
  if (cfg.maxBatchSize !== undefined) {
    assertIntegerInRange('maxBatchSize', cfg.maxBatchSize, 1, 100_000);
    meta.ext_ml_max_batch_size = cfg.maxBatchSize;
  }

  if (Object.keys(typedResources).length > 0) {
    meta.resources = typedResources;
  }

  return Object.keys(meta).length > 0 ? { meta } : {};
}

/**
 * Build EnqueueOptions with node selector labels in
 * meta.resources.node_selector.
 * All labels must match for a worker to be eligible (AND semantics).
 */
export function withNodeSelector(
  labels: Record<string, string>,
): Partial<EnqueueOptions> {
  return { meta: { resources: { node_selector: labels } } };
}

/**
 * Build EnqueueOptions with scheduling affinity rules in
 * meta.resources.affinity.
 */
export function withAffinity(aff: AffinityConfig): Partial<EnqueueOptions> {
  return { meta: { resources: { affinity: aff } } };
}

/**
 * Merge multiple ML option partials into a single EnqueueOptions object.
 * Use this to combine withGPU, withModel, withCheckpoint, etc.
 *
 * @example
 * ```ts
 * const opts = mergeMLOptions(
 *   withGPU(GPUType.NvidiaA100, 2, 80),
 *   withModel({ name: 'resnet50', version: '1.0.0', format: 'safetensors' }),
 *   withCheckpoint({ enabled: true, intervalSec: 300 }),
 *   withCompute({ runtime: 'pytorch', precision: 'bf16', distributedStrategy: 'fsdp' }),
 *   withNodeSelector({ region: 'us-east-1', gpu_type: 'nvidia-a100' }),
 * );
 * await client.enqueue('ml.train', args, { queue: 'ml', ...opts });
 * ```
 */
export function mergeMLOptions(
  ...partials: Partial<EnqueueOptions>[]
): Partial<EnqueueOptions> {
  const merged: Partial<EnqueueOptions> = {};
  const meta: Record<string, JsonValue> = {};
  let resources: Record<string, JsonValue> | undefined;

  for (const p of partials) {
    if (p.meta) {
      for (const [key, value] of Object.entries(p.meta)) {
        if (key === 'resources' && isPlainObject(value)) {
          // Every with*() helper above nests its output under
          // meta.resources, so a shallow Object.assign here would let the
          // last partial's `resources` object silently clobber the ones
          // contributed by earlier calls (e.g. withGPU(...).gpu would be
          // lost once withModel(...) is merged in afterwards). Merge one
          // level deep instead so gpu/tpu/cpu/model/checkpoint/preemption/
          // node_selector/affinity/runtime/etc. all combine.
          resources = { ...resources, ...(value as Record<string, JsonValue>) };
        } else {
          meta[key] = value;
        }
      }
    }
    // Copy non-meta fields
    for (const [key, value] of Object.entries(p)) {
      if (key !== 'meta') {
        (merged as Record<string, unknown>)[key] = value;
      }
    }
  }

  if (resources) {
    meta.resources = resources as JsonValue;
  }

  if (Object.keys(meta).length > 0) {
    merged.meta = meta;
  }

  return merged;
}

function isPlainObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertIntegerInRange(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer between ${minimum} and ${maximum}; received ${String(value)}`,
    );
  }
}

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
export interface AffinityRule {
  /** Worker label key. */
  key: string;
  /** Comparison operator. */
  operator: AffinityOperator;
  /** Values to match. */
  values?: string[];
}

/** A weighted affinity rule for preferred scheduling. */
export interface WeightedAffinityRule extends AffinityRule {
  /** Preference weight (0-100). */
  weight?: number;
}

/** Scheduling affinity configuration. */
export interface AffinityConfig {
  /** Hard constraints (required). */
  required?: AffinityRule[];
  /** Soft constraints (preferred). */
  preferred?: WeightedAffinityRule[];
}

/** Enqueue options extended with ML resource metadata. */
export interface MLEnqueueOptions extends EnqueueOptions {
  meta?: Record<string, JsonValue> & {
    resources?: Record<string, JsonValue>;
    model?: Record<string, JsonValue>;
    checkpoint?: Record<string, JsonValue>;
    preemption?: Record<string, JsonValue>;
    compute?: Record<string, JsonValue>;
    node_selector?: Record<string, JsonValue>;
    affinity?: Record<string, JsonValue>;
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
  const resources: Record<string, JsonValue> = {};

  if (req.gpu) {
    const gpu: Record<string, JsonValue> = { count: req.gpu.count };
    if (req.gpu.type) gpu.type = req.gpu.type;
    if (req.gpu.memoryGB !== undefined) gpu.memory_gb = req.gpu.memoryGB;
    if (req.gpu.computeCapability)
      gpu.compute_capability = req.gpu.computeCapability;
    if (req.gpu.interconnect) gpu.interconnect = req.gpu.interconnect;
    resources.gpu = gpu as JsonValue;
  }
  if (req.tpu) {
    const tpu: Record<string, JsonValue> = {};
    if (req.tpu.type) tpu.type = req.tpu.type;
    if (req.tpu.topology) tpu.topology = req.tpu.topology;
    if (req.tpu.chipCount !== undefined) tpu.chip_count = req.tpu.chipCount;
    resources.tpu = tpu as JsonValue;
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
  if (req.shmSizeGB !== undefined) {
    resources.shm_size_gb = req.shmSizeGB;
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
  if (ref.format) model.format = ref.format;

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
 * Build EnqueueOptions with compute constraints in meta.compute.
 */
export function withCompute(cfg: ComputeConfig): Partial<EnqueueOptions> {
  const compute: Record<string, JsonValue> = {};
  if (cfg.runtime) compute.runtime = cfg.runtime;
  if (cfg.precision) compute.precision = cfg.precision;
  if (cfg.distributedStrategy)
    compute.distributed_strategy = cfg.distributedStrategy;
  if (cfg.maxTokens !== undefined) compute.max_tokens = cfg.maxTokens;
  if (cfg.maxBatchSize !== undefined)
    compute.max_batch_size = cfg.maxBatchSize;

  return { meta: { compute: compute as JsonValue } };
}

/**
 * Build EnqueueOptions with node selector labels in meta.node_selector.
 * All labels must match for a worker to be eligible (AND semantics).
 */
export function withNodeSelector(
  labels: Record<string, string>,
): Partial<EnqueueOptions> {
  return { meta: { node_selector: labels as unknown as JsonValue } };
}

/**
 * Build EnqueueOptions with scheduling affinity rules in meta.affinity.
 */
export function withAffinity(aff: AffinityConfig): Partial<EnqueueOptions> {
  return { meta: { affinity: aff as unknown as JsonValue } };
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

import { describe, it, expect } from 'vitest';
import {
  GPUType,
  TPUType,
  Precision,
  MLRuntime,
  DistributedStrategy,
  Interconnect,
  ModelFormat,
  withGPU,
  withGPUFull,
  withTPU,
  withResources,
  withModel,
  withCheckpoint,
  withPreemption,
  withCompute,
  withNodeSelector,
  withAffinity,
  mergeMLOptions,
} from '../src/ml.js';
import type { MLEnqueueOptions, MLResourcesMetadata } from '../src/ml.js';

describe('ML Resource Extension', () => {
  describe('Constants', () => {
    it('should define GPU type constants', () => {
      expect(GPUType.NvidiaA100).toBe('nvidia-a100');
      expect(GPUType.NvidiaH100).toBe('nvidia-h100');
      expect(GPUType.NvidiaH200).toBe('nvidia-h200');
      expect(GPUType.NvidiaT4).toBe('nvidia-t4');
      expect(GPUType.NvidiaL4).toBe('nvidia-l4');
      expect(GPUType.NvidiaL40S).toBe('nvidia-l40s');
      expect(GPUType.NvidiaV100).toBe('nvidia-v100');
      expect(GPUType.NvidiaA10G).toBe('nvidia-a10g');
      expect(GPUType.NvidiaB200).toBe('nvidia-b200');
      expect(GPUType.AmdMI250).toBe('amd-mi250');
      expect(GPUType.AmdMI300X).toBe('amd-mi300x');
    });

    it('should define TPU type constants', () => {
      expect(TPUType.V4).toBe('v4');
      expect(TPUType.V5e).toBe('v5e');
      expect(TPUType.V5p).toBe('v5p');
      expect(TPUType.V6e).toBe('v6e');
    });

    it('should define precision constants', () => {
      expect(Precision.FP32).toBe('fp32');
      expect(Precision.FP16).toBe('fp16');
      expect(Precision.BF16).toBe('bf16');
      expect(Precision.FP8).toBe('fp8');
      expect(Precision.INT8).toBe('int8');
      expect(Precision.INT4).toBe('int4');
    });

    it('should define ML runtime constants', () => {
      expect(MLRuntime.PyTorch).toBe('pytorch');
      expect(MLRuntime.TensorFlow).toBe('tensorflow');
      expect(MLRuntime.ONNX).toBe('onnx');
      expect(MLRuntime.Triton).toBe('triton');
      expect(MLRuntime.VLLM).toBe('vllm');
      expect(MLRuntime.TGI).toBe('tgi');
      expect(MLRuntime.Custom).toBe('custom');
    });

    it('should define distributed strategy constants', () => {
      expect(DistributedStrategy.None).toBe('none');
      expect(DistributedStrategy.DataParallel).toBe('data_parallel');
      expect(DistributedStrategy.TensorParallel).toBe('tensor_parallel');
      expect(DistributedStrategy.PipelineParallel).toBe('pipeline_parallel');
      expect(DistributedStrategy.FSDP).toBe('fsdp');
      expect(DistributedStrategy.DeepSpeed).toBe('deepspeed');
    });

    it('should define interconnect constants', () => {
      expect(Interconnect.NVLink).toBe('nvlink');
      expect(Interconnect.PCIe).toBe('pcie');
      expect(Interconnect.Any).toBe('any');
    });

    it('should define model format constants', () => {
      expect(ModelFormat.Safetensors).toBe('safetensors');
      expect(ModelFormat.GGUF).toBe('gguf');
      expect(ModelFormat.ONNX).toBe('onnx');
      expect(ModelFormat.TorchScript).toBe('torchscript');
      expect(ModelFormat.SavedModel).toBe('savedmodel');
      expect(ModelFormat.Custom).toBe('custom');
    });
  });

  describe('withGPU', () => {
    it('should create GPU resource options', () => {
      const opts = withGPU(GPUType.NvidiaA100, 2, 80);
      expect(opts.meta).toBeDefined();
      const resources = opts.meta!.resources as Record<string, unknown>;
      expect(resources).toBeDefined();
      const gpu = resources.gpu as Record<string, unknown>;
      expect(gpu.type).toBe('nvidia-a100');
      expect(gpu.count).toBe(2);
      expect(gpu.memory_gb).toBe(80);
    });

    it('should create GPU options without memory', () => {
      const opts = withGPU(GPUType.NvidiaT4, 1);
      const resources = opts.meta!.resources as Record<string, unknown>;
      const gpu = resources.gpu as Record<string, unknown>;
      expect(gpu.type).toBe('nvidia-t4');
      expect(gpu.count).toBe(1);
      expect(gpu.memory_gb).toBeUndefined();
    });
  });

  describe('withGPUFull', () => {
    it('should create GPU options with compute capability and interconnect', () => {
      const opts = withGPUFull(GPUType.NvidiaH100, 8, 80, '9.0', 'nvlink');
      const resources = opts.meta!.resources as Record<string, unknown>;
      const gpu = resources.gpu as Record<string, unknown>;
      expect(gpu.type).toBe('nvidia-h100');
      expect(gpu.count).toBe(8);
      expect(gpu.memory_gb).toBe(80);
      expect(gpu.compute_capability).toBe('9.0');
      expect(gpu.interconnect).toBe('nvlink');
    });
  });

  describe('withTPU', () => {
    it('should create TPU resource options', () => {
      const opts = withTPU(TPUType.V5e, '4x4', 16);
      const resources = opts.meta!.resources as Record<string, unknown>;
      const tpu = resources.tpu as Record<string, unknown>;
      expect(tpu.type).toBe('v5e');
      expect(tpu.topology).toBe('4x4');
      expect(tpu.chip_count).toBe(16);
    });
  });

  describe('withResources', () => {
    it('should create full resource requirements', () => {
      const opts = withResources({
        gpu: { count: 4, type: GPUType.NvidiaA100, memoryGB: 80 },
        cpu: { cores: 16 },
        memoryGB: 256,
        storageGB: 1000,
        shmSizeGB: 64,
      });
      const resources = opts.meta!.resources as Record<string, unknown>;
      const gpu = resources.gpu as Record<string, unknown>;
      expect(gpu.type).toBe('nvidia-a100');
      expect(gpu.count).toBe(4);
      expect(gpu.memory_gb).toBe(80);
      const cpu = resources.cpu as Record<string, unknown>;
      expect(cpu.cores).toBe(16);
      expect(resources.memory_gb).toBe(256);
      expect(resources.storage_gb).toBe(1000);
      expect(resources.shm_size_gb).toBe(64);
    });

    it('should omit empty fields', () => {
      const opts = withResources({});
      const resources = opts.meta!.resources as Record<string, unknown>;
      expect(resources.gpu).toBeUndefined();
      expect(resources.cpu).toBeUndefined();
      expect(resources.tpu).toBeUndefined();
      expect(resources.memory_gb).toBeUndefined();
    });
  });

  // Per schemas/v1/ml-resources.schema.json, model/checkpoint/preemption/
  // runtime/precision/distributed_strategy/node_selector/affinity are all
  // properties of the single meta.resources object (siblings of gpu/tpu/
  // cpu) rather than separate top-level meta.* keys.
  function resourcesOf(opts: Partial<{ meta?: Record<string, unknown> }>): Record<string, unknown> {
    return opts.meta!.resources as Record<string, unknown>;
  }

  describe('withModel', () => {
    it('should create model reference options nested under meta.resources.model', () => {
      const opts = withModel({
        name: 'llama-3.1-70b',
        version: 'v2.1',
        registry: 'huggingface',
        checksum: 'sha256:abc123',
        format: 'safetensors',
      });
      const model = resourcesOf(opts).model as Record<string, unknown>;
      expect(model.name).toBe('llama-3.1-70b');
      expect(model.version).toBe('v2.1');
      expect(model.registry).toBe('huggingface');
      expect(model.checksum).toBe('sha256:abc123');
      expect(model.format).toBe('safetensors');
      // Must not also appear as a top-level meta key.
      expect((opts.meta as Record<string, unknown>).model).toBeUndefined();
    });

    it('should create model options with only name', () => {
      const opts = withModel({ name: 'bert-base' });
      const model = resourcesOf(opts).model as Record<string, unknown>;
      expect(model.name).toBe('bert-base');
      expect(model.version).toBeUndefined();
      expect(model.registry).toBeUndefined();
    });
  });

  describe('withCheckpoint', () => {
    it('should create checkpoint options nested under meta.resources.checkpoint', () => {
      const opts = withCheckpoint({
        enabled: true,
        intervalSec: 300,
        storageURI: 's3://bucket/checkpoints/',
        maxCheckpoints: 5,
      });
      const checkpoint = resourcesOf(opts).checkpoint as Record<string, unknown>;
      expect(checkpoint.enabled).toBe(true);
      expect(checkpoint.interval_s).toBe(300);
      expect(checkpoint.storage_uri).toBe('s3://bucket/checkpoints/');
      expect(checkpoint.max_checkpoints).toBe(5);
    });

    it('should create minimal checkpoint options', () => {
      const opts = withCheckpoint({ enabled: false });
      const checkpoint = resourcesOf(opts).checkpoint as Record<string, unknown>;
      expect(checkpoint.enabled).toBe(false);
      expect(checkpoint.interval_s).toBeUndefined();
    });
  });

  describe('withPreemption', () => {
    it('should create preemption options nested under meta.resources.preemption', () => {
      const opts = withPreemption({
        preemptible: true,
        gracePeriodSec: 60,
        checkpointOnPreempt: true,
      });
      const preemption = resourcesOf(opts).preemption as Record<string, unknown>;
      expect(preemption.preemptible).toBe(true);
      expect(preemption.grace_period_s).toBe(60);
      expect(preemption.checkpoint_on_preempt).toBe(true);
    });
  });

  describe('withCompute', () => {
    it('should map resource fields and legacy extension limits to their exact normative locations', () => {
      const opts = withCompute({
        runtime: MLRuntime.VLLM,
        precision: Precision.FP16,
        distributedStrategy: DistributedStrategy.TensorParallel,
        maxTokens: 4096,
        maxBatchSize: 64,
      });

      expect(opts).toEqual({
        meta: {
          resources: {
            runtime: 'vllm',
            precision: 'fp16',
            distributed_strategy: 'tensor_parallel',
          },
          ext_ml_max_tokens: 4096,
          ext_ml_max_batch_size: 64,
        },
      });
    });

    it('should omit unset compute fields', () => {
      const opts = withCompute({ runtime: 'pytorch' });
      expect(opts).toEqual({ meta: { resources: { runtime: 'pytorch' } } });
    });

    it('should keep schema-closed resources free of legacy-only token and batch keys', () => {
      const opts = withCompute({
        runtime: 'vllm',
        precision: 'bf16',
        distributedStrategy: 'tensor_parallel',
        maxTokens: 4096,
        maxBatchSize: 32,
      });
      const resources = resourcesOf(opts);
      const schemaProperties = new Set([
        'gpu',
        'tpu',
        'cpu',
        'memory_gb',
        'storage_gb',
        'shm_size_gb',
        'model',
        'runtime',
        'precision',
        'distributed_strategy',
        'checkpoint',
        'preemption',
        'node_selector',
        'affinity',
      ]);

      expect(Object.keys(resources).filter((key) => !schemaProperties.has(key))).toEqual([]);
      expect(resources).not.toHaveProperty('max_tokens');
      expect(resources).not.toHaveProperty('max_batch_size');
      expect(resources).not.toHaveProperty('compute');
    });

    it.each([
      ['minimum', { maxTokens: 1, maxBatchSize: 1 }],
      ['maximum', { maxTokens: 10_000_000, maxBatchSize: 100_000 }],
    ])('should accept %s token and batch limits', (_label, cfg) => {
      expect(withCompute(cfg)).toEqual({
        meta: {
          ext_ml_max_tokens: cfg.maxTokens,
          ext_ml_max_batch_size: cfg.maxBatchSize,
        },
      });
    });

    it.each([0, -1, 1.5, 10_000_001, Number.NaN, Number.POSITIVE_INFINITY])(
      'should reject maxTokens outside the integer range: %s',
      (maxTokens) => {
        expect(() => withCompute({ maxTokens })).toThrow(
          /maxTokens must be an integer between 1 and 10000000/,
        );
      },
    );

    it.each([0, -1, 1.5, 100_001, Number.NaN, Number.POSITIVE_INFINITY])(
      'should reject maxBatchSize outside the integer range: %s',
      (maxBatchSize) => {
        expect(() => withCompute({ maxBatchSize })).toThrow(
          /maxBatchSize must be an integer between 1 and 100000/,
        );
      },
    );

    it('should return an empty partial for an empty compute config', () => {
      expect(withCompute({})).toEqual({});
    });
  });

  describe('withNodeSelector', () => {
    it('should create node selector options nested under meta.resources.node_selector', () => {
      const opts = withNodeSelector({
        gpu_type: 'nvidia-a100',
        region: 'us-east-1',
      });
      const selector = resourcesOf(opts).node_selector as Record<string, string>;
      expect(selector.gpu_type).toBe('nvidia-a100');
      expect(selector.region).toBe('us-east-1');
    });
  });

  describe('withAffinity', () => {
    it('should create affinity options nested under meta.resources.affinity', () => {
      const opts = withAffinity({
        required: [
          { key: 'gpu_type', operator: 'In', values: ['nvidia-a100', 'nvidia-h100'] },
          { key: 'compute_capability', operator: 'Gte', values: ['8.0'] },
        ],
        preferred: [
          { key: 'gpu_interconnect', operator: 'In', values: ['nvlink'], weight: 80 },
        ],
      });
      const affinity = resourcesOf(opts).affinity as Record<string, unknown>;
      const required = affinity.required as Array<Record<string, unknown>>;
      expect(required).toHaveLength(2);
      expect(required[0].key).toBe('gpu_type');
      expect(required[0].operator).toBe('In');
      const preferred = affinity.preferred as Array<Record<string, unknown>>;
      expect(preferred).toHaveLength(1);
      expect(preferred[0].weight).toBe(80);
    });
  });

  describe('mergeMLOptions', () => {
    it('should deep-merge multiple ML option partials into a single meta.resources object', () => {
      const merged = mergeMLOptions(
        withGPU(GPUType.NvidiaA100, 2, 80),
        withModel({ name: 'resnet50', version: '1.0.0', format: 'safetensors' }),
        withCompute({
          runtime: 'pytorch',
          precision: 'bf16',
          distributedStrategy: 'fsdp',
          maxTokens: 8192,
          maxBatchSize: 16,
        }),
        withCheckpoint({ enabled: true, intervalSec: 300 }),
      );

      expect(merged).toEqual({
        meta: {
          resources: {
            gpu: { count: 2, type: 'nvidia-a100', memory_gb: 80 },
            model: {
              name: 'resnet50',
              version: '1.0.0',
              format: 'safetensors',
            },
            runtime: 'pytorch',
            precision: 'bf16',
            distributed_strategy: 'fsdp',
            checkpoint: { enabled: true, interval_s: 300 },
          },
          ext_ml_max_tokens: 8192,
          ext_ml_max_batch_size: 16,
        },
      });
    });

    it('should preserve non-meta fields', () => {
      const merged = mergeMLOptions(
        { queue: 'ml-training' },
        withGPU(GPUType.NvidiaA100, 1),
      );
      expect(merged.queue).toBe('ml-training');
      expect(merged.meta).toBeDefined();
    });

    it('should handle empty options', () => {
      const merged = mergeMLOptions();
      expect(merged.meta).toBeUndefined();
    });

    it('should not let node_selector/affinity clobber gpu/model when merged after them', () => {
      const merged = mergeMLOptions(
        withGPU(GPUType.NvidiaH100, 4, 80),
        withNodeSelector({ zone: 'us-east-1a' }),
        withAffinity({ required: [{ key: 'gpu_type', operator: 'In', values: ['nvidia-h100'] }] }),
      );

      const resources = resourcesOf(merged);
      expect(resources.gpu).toEqual({ count: 4, type: 'nvidia-h100', memory_gb: 80 });
      expect(resources.node_selector).toEqual({ zone: 'us-east-1a' });
      expect(resources.affinity).toBeDefined();
    });

    // Finding: MLEnqueueOptions — meta.resources must be precisely typed
    // (MLResourcesMetadata) while meta itself still accepts arbitrary
    // application metadata, and merging a hand-built MLEnqueueOptions
    // value with with*() helper output must combine exactly as documented.
    it('merges a hand-constructed MLEnqueueOptions value (typed resources + arbitrary meta) with helper output', () => {
      const handBuilt: Partial<MLEnqueueOptions> = {
        queue: 'ml-training',
        meta: {
          // Ordinary arbitrary application metadata alongside the typed
          // ML fields — must survive the merge untouched.
          request_id: 'req-42',
          trace: { sampled: true },
          resources: {
            memory_gb: 128,
            storage_gb: 500,
          },
        },
      };

      const merged = mergeMLOptions(
        handBuilt,
        withGPU(GPUType.NvidiaA100, 2, 80),
        withModel({ name: 'resnet50', version: '1.0.0' }),
      );

      expect(merged.queue).toBe('ml-training');
      expect((merged.meta as Record<string, unknown>).request_id).toBe('req-42');
      expect((merged.meta as Record<string, unknown>).trace).toEqual({ sampled: true });

      const resources = resourcesOf(merged);
      // The hand-built resources (memory_gb/storage_gb) and the
      // helper-contributed resources (gpu/model) must all coexist —
      // proving the one-level-deep resources merge combines a directly
      // constructed MLEnqueueOptions value with with*() helper output,
      // not just multiple helper calls.
      expect(resources.memory_gb).toBe(128);
      expect(resources.storage_gb).toBe(500);
      expect(resources.gpu).toEqual({ count: 2, type: 'nvidia-a100', memory_gb: 80 });
      expect(resources.model).toEqual({ name: 'resnet50', version: '1.0.0' });
    });

    it('round-trips a fully-typed MLResourcesMetadata object through JSON exactly as declared', () => {
      // Constructed directly against the exported MLResourcesMetadata
      // type (not via any with*() helper) to prove the type export is a
      // faithful, standalone description of the meta.resources wire
      // format, not merely an internal implementation detail of ml.ts.
      const resources: MLResourcesMetadata = {
        gpu: { count: 4, type: 'nvidia-h100', memory_gb: 80, compute_capability: '9.0', interconnect: 'nvlink' },
        tpu: { type: 'v5e', topology: '4x4', chip_count: 16 },
        cpu: { cores: 32 },
        memory_gb: 256,
        storage_gb: 1000,
        shm_size_gb: 64,
        model: { name: 'llama-3.1-70b', version: 'v2.1', registry: 'huggingface', checksum: 'sha256:abc123', format: 'safetensors' },
        runtime: 'vllm',
        precision: 'bf16',
        distributed_strategy: 'fsdp',
        checkpoint: { enabled: true, interval_s: 300, storage_uri: 's3://bucket/', max_checkpoints: 3 },
        preemption: { preemptible: true, grace_period_s: 30, checkpoint_on_preempt: true },
        node_selector: { region: 'us-east-1' },
        affinity: { required: [{ key: 'gpu_type', operator: 'In', values: ['nvidia-h100'] }] },
      };

      const opts: MLEnqueueOptions = { queue: 'ml', meta: { resources } };
      const roundTripped = JSON.parse(JSON.stringify(opts)) as { meta: { resources: MLResourcesMetadata } };
      expect(roundTripped.meta.resources).toEqual(resources);
    });

    it('accepts schema-valid minimal nested resource objects with no required fields', () => {
      const resources: MLResourcesMetadata = {
        gpu: { type: 'nvidia-a100' },
        cpu: {},
        checkpoint: {},
        preemption: {},
      };

      const opts: MLEnqueueOptions = { meta: { resources } };
      expect(opts.meta?.resources).toEqual(resources);
    });
  });
});

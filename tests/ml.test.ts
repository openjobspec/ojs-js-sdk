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

  describe('withModel', () => {
    it('should create model reference options', () => {
      const opts = withModel({
        name: 'llama-3.1-70b',
        version: 'v2.1',
        registry: 'huggingface',
        checksum: 'sha256:abc123',
        format: 'safetensors',
      });
      const model = opts.meta!.model as Record<string, unknown>;
      expect(model.name).toBe('llama-3.1-70b');
      expect(model.version).toBe('v2.1');
      expect(model.registry).toBe('huggingface');
      expect(model.checksum).toBe('sha256:abc123');
      expect(model.format).toBe('safetensors');
    });

    it('should create model options with only name', () => {
      const opts = withModel({ name: 'bert-base' });
      const model = opts.meta!.model as Record<string, unknown>;
      expect(model.name).toBe('bert-base');
      expect(model.version).toBeUndefined();
      expect(model.registry).toBeUndefined();
    });
  });

  describe('withCheckpoint', () => {
    it('should create checkpoint options', () => {
      const opts = withCheckpoint({
        enabled: true,
        intervalSec: 300,
        storageURI: 's3://bucket/checkpoints/',
        maxCheckpoints: 5,
      });
      const checkpoint = opts.meta!.checkpoint as Record<string, unknown>;
      expect(checkpoint.enabled).toBe(true);
      expect(checkpoint.interval_s).toBe(300);
      expect(checkpoint.storage_uri).toBe('s3://bucket/checkpoints/');
      expect(checkpoint.max_checkpoints).toBe(5);
    });

    it('should create minimal checkpoint options', () => {
      const opts = withCheckpoint({ enabled: false });
      const checkpoint = opts.meta!.checkpoint as Record<string, unknown>;
      expect(checkpoint.enabled).toBe(false);
      expect(checkpoint.interval_s).toBeUndefined();
    });
  });

  describe('withPreemption', () => {
    it('should create preemption options', () => {
      const opts = withPreemption({
        preemptible: true,
        gracePeriodSec: 60,
        checkpointOnPreempt: true,
      });
      const preemption = opts.meta!.preemption as Record<string, unknown>;
      expect(preemption.preemptible).toBe(true);
      expect(preemption.grace_period_s).toBe(60);
      expect(preemption.checkpoint_on_preempt).toBe(true);
    });
  });

  describe('withCompute', () => {
    it('should create compute constraint options', () => {
      const opts = withCompute({
        runtime: MLRuntime.VLLM,
        precision: Precision.FP16,
        distributedStrategy: DistributedStrategy.TensorParallel,
        maxTokens: 4096,
        maxBatchSize: 64,
      });
      const compute = opts.meta!.compute as Record<string, unknown>;
      expect(compute.runtime).toBe('vllm');
      expect(compute.precision).toBe('fp16');
      expect(compute.distributed_strategy).toBe('tensor_parallel');
      expect(compute.max_tokens).toBe(4096);
      expect(compute.max_batch_size).toBe(64);
    });

    it('should omit unset compute fields', () => {
      const opts = withCompute({ runtime: 'pytorch' });
      const compute = opts.meta!.compute as Record<string, unknown>;
      expect(compute.runtime).toBe('pytorch');
      expect(compute.precision).toBeUndefined();
      expect(compute.max_tokens).toBeUndefined();
    });
  });

  describe('withNodeSelector', () => {
    it('should create node selector options', () => {
      const opts = withNodeSelector({
        gpu_type: 'nvidia-a100',
        region: 'us-east-1',
      });
      const selector = opts.meta!.node_selector as Record<string, string>;
      expect(selector.gpu_type).toBe('nvidia-a100');
      expect(selector.region).toBe('us-east-1');
    });
  });

  describe('withAffinity', () => {
    it('should create affinity options with required and preferred rules', () => {
      const opts = withAffinity({
        required: [
          { key: 'gpu_type', operator: 'In', values: ['nvidia-a100', 'nvidia-h100'] },
          { key: 'compute_capability', operator: 'Gte', values: ['8.0'] },
        ],
        preferred: [
          { key: 'gpu_interconnect', operator: 'In', values: ['nvlink'], weight: 80 },
        ],
      });
      const affinity = opts.meta!.affinity as Record<string, unknown>;
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
    it('should merge multiple ML options into one', () => {
      const merged = mergeMLOptions(
        withGPU(GPUType.NvidiaA100, 2, 80),
        withModel({ name: 'resnet50', version: '1.0.0', format: 'safetensors' }),
        withCompute({ runtime: 'pytorch', precision: 'bf16', distributedStrategy: 'fsdp' }),
        withCheckpoint({ enabled: true, intervalSec: 300 }),
      );

      expect(merged.meta).toBeDefined();
      const meta = merged.meta as Record<string, unknown>;
      expect(meta.resources).toBeDefined();
      expect(meta.model).toBeDefined();
      expect(meta.compute).toBeDefined();
      expect(meta.checkpoint).toBeDefined();
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
  });
});

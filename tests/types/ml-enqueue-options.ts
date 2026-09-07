/**
 * Compile-time type tests for the ML/AI Resource Extension (src/ml.ts).
 *
 * Verifies (Finding: MLEnqueueOptions):
 *  - `MLResourcesMetadata` is exported and covers gpu/tpu/cpu/memory/
 *    storage/model/checkpoint/preemption/runtime/precision/
 *    distributed_strategy/node_selector/affinity exactly as defined by
 *    `schemas/v1/ml-resources.schema.json`.
 *  - `MLEnqueueOptions.meta` no longer types the obsolete top-level
 *    `model`/`checkpoint`/`preemption`/`compute`/`node_selector`/`affinity`
 *    paths (they only ever existed nested under `meta.resources`).
 *  - `MLEnqueueOptions.meta` still accepts arbitrary application metadata
 *    alongside the typed `resources` (and legacy `ext_ml_max_tokens`/
 *    `ext_ml_max_batch_size`) fields.
 *  - Every with*() helper's output remains assignable wherever
 *    `MLEnqueueOptions`/`EnqueueOptions` is expected.
 *
 * This file is compiled (never executed) by `npm run test:types`
 * (tsconfig.type-tests.json); it has no runtime behavior.
 */
import type { EnqueueOptions, JsonValue } from '../../src/job.js';
import type {
  MLEnqueueOptions,
  MLResourcesMetadata,
  MLGPUResourceMetadata,
  MLTPUResourceMetadata,
  MLCPUResourceMetadata,
  MLModelResourceMetadata,
  MLCheckpointResourceMetadata,
  MLPreemptionResourceMetadata,
  AffinityConfig,
} from '../../src/ml.js';
import {
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
} from '../../src/ml.js';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Assert<Value extends true> = Value;

// ---- MLResourcesMetadata covers every schema-defined property ----

export type ResourcesHasGPU = Assert<
  Equal<NonNullable<MLResourcesMetadata['gpu']>, MLGPUResourceMetadata>
>;
export type ResourcesHasTPU = Assert<
  Equal<NonNullable<MLResourcesMetadata['tpu']>, MLTPUResourceMetadata>
>;
export type ResourcesHasCPU = Assert<
  Equal<NonNullable<MLResourcesMetadata['cpu']>, MLCPUResourceMetadata>
>;
export type ResourcesHasMemoryGB = Assert<
  Equal<NonNullable<MLResourcesMetadata['memory_gb']>, number>
>;
export type ResourcesHasStorageGB = Assert<
  Equal<NonNullable<MLResourcesMetadata['storage_gb']>, number>
>;
export type ResourcesHasShmSizeGB = Assert<
  Equal<NonNullable<MLResourcesMetadata['shm_size_gb']>, number>
>;
export type ResourcesHasModel = Assert<
  Equal<NonNullable<MLResourcesMetadata['model']>, MLModelResourceMetadata>
>;
export type ResourcesHasRuntime = Assert<
  Equal<NonNullable<MLResourcesMetadata['runtime']>, string>
>;
export type ResourcesHasPrecision = Assert<
  Equal<NonNullable<MLResourcesMetadata['precision']>, string>
>;
export type ResourcesHasDistributedStrategy = Assert<
  Equal<NonNullable<MLResourcesMetadata['distributed_strategy']>, string>
>;
export type ResourcesHasCheckpoint = Assert<
  Equal<
    NonNullable<MLResourcesMetadata['checkpoint']>,
    MLCheckpointResourceMetadata
  >
>;
export type ResourcesHasPreemption = Assert<
  Equal<
    NonNullable<MLResourcesMetadata['preemption']>,
    MLPreemptionResourceMetadata
  >
>;
export type ResourcesHasNodeSelector = Assert<
  Equal<NonNullable<MLResourcesMetadata['node_selector']>, Record<string, string>>
>;
export type ResourcesHasAffinity = Assert<
  Equal<NonNullable<MLResourcesMetadata['affinity']>, AffinityConfig>
>;

// `meta.resources` is precisely MLResourcesMetadata (not a loose
// `Record<string, JsonValue>` bag, and not `undefined`-only).
export type MetaResourcesIsTyped = Assert<
  Equal<NonNullable<MLEnqueueOptions['meta']>['resources'], MLResourcesMetadata | undefined>
>;

// The two legacy extension keys withCompute() actually emits are typed at
// the top level of `meta`, matching where they are actually written (see
// AUDIT.md F-36) — not fabricated into `resources`, which is schema-closed.
export type MetaHasExtMaxTokens = Assert<
  Equal<NonNullable<MLEnqueueOptions['meta']>['ext_ml_max_tokens'], number | undefined>
>;
export type MetaHasExtMaxBatchSize = Assert<
  Equal<NonNullable<MLEnqueueOptions['meta']>['ext_ml_max_batch_size'], number | undefined>
>;

// ---- Obsolete top-level meta.* paths must be gone ----
//
// `model`/`checkpoint`/`preemption`/`compute`/`node_selector`/`affinity`
// never had a schema-defined home at the top level of `meta` (only nested
// under `meta.resources`), but the old MLEnqueueOptions type wrongly
// declared them there as specifically-typed `Record<string, JsonValue>`
// properties. `meta` intentionally keeps a `Record<string, JsonValue>`
// index signature so callers can still attach arbitrary application
// metadata (see `acceptsArbitraryMetaAlongsideTypedResources` below) —
// which means the type system cannot forbid *writing* to a key spelled
// `model`, `checkpoint`, etc. under `meta` (any string key is a valid
// metadata key). What must be proven instead is that these keys are no
// longer specially/incorrectly typed: reading them now yields the generic
// `JsonValue` index-signature type, not the removed schema-shaped
// `Record<string, JsonValue>` sub-object the old type wrongly promised.
export type ObsoleteModelKeyIsPlainJsonValue = Assert<
  Equal<NonNullable<MLEnqueueOptions['meta']>['model'], JsonValue>
>;
export type ObsoleteCheckpointKeyIsPlainJsonValue = Assert<
  Equal<NonNullable<MLEnqueueOptions['meta']>['checkpoint'], JsonValue>
>;
export type ObsoletePreemptionKeyIsPlainJsonValue = Assert<
  Equal<NonNullable<MLEnqueueOptions['meta']>['preemption'], JsonValue>
>;
export type ObsoleteComputeKeyIsPlainJsonValue = Assert<
  Equal<NonNullable<MLEnqueueOptions['meta']>['compute'], JsonValue>
>;
export type ObsoleteNodeSelectorKeyIsPlainJsonValue = Assert<
  Equal<NonNullable<MLEnqueueOptions['meta']>['node_selector'], JsonValue>
>;
export type ObsoleteAffinityKeyIsPlainJsonValue = Assert<
  Equal<NonNullable<MLEnqueueOptions['meta']>['affinity'], JsonValue>
>;

// By contrast, `resources` — the one property the schema actually defines
// at this level — remains precisely typed (not a loose JsonValue bag).
// The schema has no nested `required` arrays for gpu/cpu/checkpoint/
// preemption, so minimal objects for those fields remain valid.
declare const optsWithTypedResources: MLEnqueueOptions;
optsWithTypedResources.meta = { resources: { gpu: { type: 'nvidia-a100' } } };
optsWithTypedResources.meta = { resources: { cpu: {} } };
optsWithTypedResources.meta = { resources: { checkpoint: {} } };
optsWithTypedResources.meta = { resources: { preemption: {} } };
// @ts-expect-error `max_tokens` is not part of the schema-closed `meta.resources` object (see MetaHasExtMaxTokens above for its real location).
optsWithTypedResources.meta = { resources: { max_tokens: 4096 } };
// @ts-expect-error `resources` itself must be an object matching MLResourcesMetadata, not an arbitrary string.
optsWithTypedResources.meta = { resources: 'not-an-object' };

// ---- meta still accepts ordinary arbitrary metadata ----

export function acceptsArbitraryMetaAlongsideTypedResources(): MLEnqueueOptions {
  return {
    queue: 'ml-training',
    meta: {
      // Arbitrary application-defined metadata, unrelated to the ML
      // resource extension, must still be permitted alongside the typed
      // fields below.
      request_id: 'abc-123',
      trace: { span_id: 'xyz', sampled: true },
      resources: {
        gpu: { count: 2, type: 'nvidia-a100', memory_gb: 80 },
        model: { name: 'llama-3.1-70b', format: 'safetensors' },
        runtime: 'vllm',
      },
      ext_ml_max_tokens: 4096,
      ext_ml_max_batch_size: 32,
    },
  };
}

// ---- Existing helpers remain assignable wherever EnqueueOptions/
// MLEnqueueOptions is expected ----

function acceptsEnqueueOptions(_o: EnqueueOptions): void {}
function acceptsMLEnqueueOptions(_o: MLEnqueueOptions): void {}

acceptsEnqueueOptions(withGPU('nvidia-a100', 2, 80));
acceptsEnqueueOptions(withGPUFull('nvidia-h100', 8, 80, '9.0', 'nvlink'));
acceptsEnqueueOptions(withTPU('v5e', '4x4', 16));
acceptsEnqueueOptions(withResources({ gpu: { count: 1 } }));
acceptsEnqueueOptions(withModel({ name: 'resnet50' }));
acceptsEnqueueOptions(withCheckpoint({ enabled: true }));
acceptsEnqueueOptions(withPreemption({ preemptible: true }));
acceptsEnqueueOptions(withCompute({ runtime: 'pytorch' }));
acceptsEnqueueOptions(withNodeSelector({ region: 'us-east-1' }));
acceptsEnqueueOptions(
  withAffinity({ required: [{ key: 'gpu_type', operator: 'In', values: ['nvidia-a100'] }] }),
);
acceptsEnqueueOptions(mergeMLOptions(withGPU('nvidia-a100', 2), withModel({ name: 'x' })));

acceptsMLEnqueueOptions(withGPU('nvidia-a100', 2, 80));
acceptsMLEnqueueOptions(withModel({ name: 'resnet50' }));
acceptsMLEnqueueOptions(mergeMLOptions(withGPU('nvidia-a100', 2), withModel({ name: 'x' })));

export async function usesMergedOptionsInEnqueueShape(): Promise<EnqueueOptions> {
  const opts = mergeMLOptions(
    withGPU('nvidia-a100', 2, 80),
    withModel({ name: 'resnet50', version: '1.0.0', format: 'safetensors' }),
    withCompute({ runtime: 'pytorch', precision: 'bf16', distributedStrategy: 'fsdp' }),
  );
  return { queue: 'ml', ...opts };
}

// ---- Finding 5: MLResourcesMetadata named variable is directly
// assignable to MLEnqueueOptions.meta.resources ----

export function namedMLResourcesMetadataAssignable(): MLEnqueueOptions {
  const resources: MLResourcesMetadata = {
    gpu: { count: 4, type: 'nvidia-h100', memory_gb: 80 },
    model: { name: 'llama-3.1-70b', format: 'safetensors' },
    runtime: 'vllm',
    precision: 'bf16',
  };

  // This must compile without any `as unknown as ...` cast.
  // Before Finding 5 fix, this would fail because MLResourcesMetadata
  // was not index-compatible with Record<string, JsonValue>.
  const opts: MLEnqueueOptions = { queue: 'ml', meta: { resources } };
  return opts;
}

export function nestedMetadataAlsoAssignable(): MLEnqueueOptions {
  const gpu: MLGPUResourceMetadata = { count: 2, type: 'nvidia-a100', memory_gb: 80 };
  const model: MLModelResourceMetadata = { name: 'resnet50', version: '1.0' };
  const checkpoint: MLCheckpointResourceMetadata = { enabled: true, interval_s: 300 };
  const preemption: MLPreemptionResourceMetadata = { preemptible: true };

  const resources: MLResourcesMetadata = { gpu, model, checkpoint, preemption };
  return { meta: { resources } };
}

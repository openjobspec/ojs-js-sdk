# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.0.0 (2026-02-19)


### Features

* **build:** add dual ESM/CJS output with size-limit ([e6d352c](https://github.com/openjobspec/ojs-js-sdk/commit/e6d352c11e9459fc057aa84831cb40daafeb9737))
* **client:** add OJSClient producer API ([9c147d3](https://github.com/openjobspec/ojs-js-sdk/commit/9c147d37dea3207f19a94413d5f8481a90335e79))
* **client:** integrate cron and schema operations into OJSClient ([c38df7d](https://github.com/openjobspec/ojs-js-sdk/commit/c38df7dda869f19e3a279190c12f55482a9fa6ae))
* **core:** add retry, middleware, events, queue, and workflow modules ([fadd5f1](https://github.com/openjobspec/ojs-js-sdk/commit/fadd5f15b69aa4fe0081ed12b38b6c52a0328a23))
* **cron:** add cron job operations module ([409e698](https://github.com/openjobspec/ojs-js-sdk/commit/409e69893fc886fdae9c9ac8265b019e2b03d27c))
* **errors:** add OJSRateLimitError with header parsing for 429 responses ([b353b0e](https://github.com/openjobspec/ojs-js-sdk/commit/b353b0e9c48b7195fa4ebbecb72dffb8bd4de90c))
* **errors:** add toJSON() for structured logging ([305e595](https://github.com/openjobspec/ojs-js-sdk/commit/305e5953fdf45734764536a886430e1cba5b4cd6))
* **middleware:** add built-in middleware implementations ([46e298e](https://github.com/openjobspec/ojs-js-sdk/commit/46e298e8e141f0d8ed11ab2154af8024ceeed06d))
* **ml:** add ML/AI resource extension with GPU and model helpers ([8b3094d](https://github.com/openjobspec/ojs-js-sdk/commit/8b3094d6407b8ac5ed70ad892c35a5d8687bebaf))
* **otel:** add OpenTelemetry middleware for job tracing and metrics ([b069f3a](https://github.com/openjobspec/ojs-js-sdk/commit/b069f3ac62f1824b5f9e9e021126eb22e390001f))
* **progress:** add worker progress reporting module ([a39b38f](https://github.com/openjobspec/ojs-js-sdk/commit/a39b38f9068e742883e5bfc78179808f29a83d73))
* **schema:** add schema operations module ([f609f6d](https://github.com/openjobspec/ojs-js-sdk/commit/f609f6d3223c4ef1e37eb02c2c7cf9653b7a2e16))
* **sdk:** add barrel exports and wire up public API ([fe59f23](https://github.com/openjobspec/ojs-js-sdk/commit/fe59f23cd5118f180aab74edab9295b59df340b6))
* **testing:** add testing module with fake mode and assertions ([880d4a0](https://github.com/openjobspec/ojs-js-sdk/commit/880d4a0d934470c5b7cf0c7b8cd5b027c2d203b8))
* **testing:** integrate fake mode into OJSClient and make handlers async ([a21800e](https://github.com/openjobspec/ojs-js-sdk/commit/a21800e2091e4592ea1e995ec75b5403937f6a94))
* **transport:** add HTTP transport layer ([4ee0236](https://github.com/openjobspec/ojs-js-sdk/commit/4ee0236e0e94fb997b30c6f1053c786726375098))
* **types:** add core job types, error hierarchy, and validation ([7b2770f](https://github.com/openjobspec/ojs-js-sdk/commit/7b2770f02c1a533da27db6bc994af9deec3d3fb7))
* **worker:** add OJSWorker consumer with polling and heartbeat ([37a9c54](https://github.com/openjobspec/ojs-js-sdk/commit/37a9c542dd99e736969b403326fcffcbdfcc0e7d))


### Bug Fixes

* **client:** use rawPath for manifest endpoint ([e643126](https://github.com/openjobspec/ojs-js-sdk/commit/e64312613871a4dda987863368975cad8b3b5294))
* **transport:** add rawPath option to skip /ojs/v1 prefix ([1d32fd9](https://github.com/openjobspec/ojs-js-sdk/commit/1d32fd9da0ac62438a922d854eae15574bf0474d))
* **worker:** add job-level timeout enforcement and fix duration_ms ([b8536c7](https://github.com/openjobspec/ojs-js-sdk/commit/b8536c7d20a31b0ecea60b092063f356a503c8e6))
* **worker:** prevent timer leak on graceful shutdown ([f2e7a54](https://github.com/openjobspec/ojs-js-sdk/commit/f2e7a5470074c8eabecc44c59a2984f78616bbfb))
* **worker:** use exponential backoff on consecutive poll errors ([e7b8bf9](https://github.com/openjobspec/ojs-js-sdk/commit/e7b8bf965b5d8bf7e4409a1b9feb380bd047c4fc))
* **workflow:** discriminate workflow primitives by structure, not type field ([ec46b1e](https://github.com/openjobspec/ojs-js-sdk/commit/ec46b1ec6d5a2238e1a9378c886133fd018fd29b))


### Performance Improvements

* **bench:** expand benchmark suite with error, middleware, and serialization benchmarks ([98881b8](https://github.com/openjobspec/ojs-js-sdk/commit/98881b80498d1486bc226ded21c3926a20591966))
* **validation:** add benchmark suite for validation and serialization ([6e1e30d](https://github.com/openjobspec/ojs-js-sdk/commit/6e1e30dd9550267b990abda6a050689cfe03a20a))

## [0.1.0] - 2024-12-01

### Added
- OJSClient producer API: `enqueue()`, `enqueueBatch()`, `getJob()`, `cancelJob()`
- OJSWorker consumer with poll-based job fetching, heartbeat, and graceful shutdown
- Workflow primitives: `chain()`, `group()`, `batch()`
- Middleware system with onion (execution) and linear (enqueue) patterns
- Retry policy helpers with exponential, linear, polynomial, and constant backoff
- CloudEvents-inspired event emitter with type-safe listeners
- Queue management operations (list, stats, pause, resume, dead letter)
- HTTP transport using built-in `fetch` (zero dependencies)
- Client-side validation for job types, queue names, and enqueue requests
- Structured error hierarchy with 7 error classes
- Full TypeScript type definitions with strict mode
- 5 example files covering all major features

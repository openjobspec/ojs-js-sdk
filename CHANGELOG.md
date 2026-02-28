# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0](https://github.com/openjobspec/ojs-js-sdk/compare/v0.1.0...v0.2.0) (2026-02-28)


### Features

* add AbortController support for cancellation ([1d9369b](https://github.com/openjobspec/ojs-js-sdk/commit/1d9369b846e2a82c6e4e9f5522e5400c8aeefe79))
* add batch enqueue support with validation ([7c50243](https://github.com/openjobspec/ojs-js-sdk/commit/7c502438f1938ea4856bcbe981931bb03eb41c87))
* add configurable request timeout option ([1eb3b8e](https://github.com/openjobspec/ojs-js-sdk/commit/1eb3b8efe26ba572ada155a58fc1e8f7ea8369e4))
* add context propagation to worker middleware ([c1ff47e](https://github.com/openjobspec/ojs-js-sdk/commit/c1ff47e966c4c5b02753f6103bae2d9e61092e51))
* add durable execution module for TypeScript SDK ([a21a48d](https://github.com/openjobspec/ojs-js-sdk/commit/a21a48d1cb57cc2ac3ffa23ecc07f1ae6d9885e5))


### Bug Fixes

* correct type inference in middleware chain ([ca8ec39](https://github.com/openjobspec/ojs-js-sdk/commit/ca8ec394cca2d03c7c741ef4c118aa1b39092c00))
* handle network errors during job polling ([fd7c7d4](https://github.com/openjobspec/ojs-js-sdk/commit/fd7c7d4f0f019624b8ee011af5d8f206de674795))

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

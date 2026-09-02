# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-09-02

### Changed

- **Breaking:** `OJSClient.enqueue()` now returns `Promise<Job | null>` instead
  of `Promise<Job>`. Enqueue middleware may intentionally drop a job by
  returning `null`; callers must handle that outcome before reading job fields.
- Added complete package export and consumer checks for ESM, CommonJS, and
  TypeScript resolution modes.
- Added `.d.cts` declarations for every CommonJS export, Node16/NodeNext
  CommonJS consumer fixtures, and `@arethetypeswrong/cli --pack` validation.

### Fixed

- Explicit invalid gRPC proto paths are now rejected before loading the large
  optional gRPC runtime, removing a cold-module-load timing dependency that
  could make the full-suite failure-path test exceed Vitest's timeout.

## [0.4.0] - 2026-04-20

### Changed

- Package and repository release metadata synchronized with the `v0.4.0` tag.

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

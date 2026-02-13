# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0](https://github.com/openjobspec/ojs-js-sdk/compare/v0.3.0...v0.4.0) (2026-04-20)


### Features

* add batch enqueue support ([76884fd](https://github.com/openjobspec/ojs-js-sdk/commit/76884fdf569bde1db94fd9defd3fd4a6ef4860b1))
* add graceful shutdown signal handler ([01bee8e](https://github.com/openjobspec/ojs-js-sdk/commit/01bee8ec4bd1b0562b8780a615c4308e5a840aec))
* add initial project structure ([9cdef6f](https://github.com/openjobspec/ojs-js-sdk/commit/9cdef6f0681e04a6c70e001e4696e49e12fb1448))
* add initial project structure ([4628dbc](https://github.com/openjobspec/ojs-js-sdk/commit/4628dbc40334bdf94d4adf139b4ec8b94a69da43))
* add retry backoff configuration ([d172ddb](https://github.com/openjobspec/ojs-js-sdk/commit/d172ddb31b74cab80666210110680a13cfd2ee5a))
* add retry backoff configuration to client ([8d165ec](https://github.com/openjobspec/ojs-js-sdk/commit/8d165ec668a55dd8b7af29af8114b0fd3c663e60))
* add TypeScript strict mode types for job handler context ([23884fc](https://github.com/openjobspec/ojs-js-sdk/commit/23884fc12fa856730a9fa5227deed725bc39e57e))
* add workflow chain primitive ([d79952b](https://github.com/openjobspec/ojs-js-sdk/commit/d79952b15fd20058256d7717f14f4344645bd774))
* expose batch enqueue endpoint ([c69f111](https://github.com/openjobspec/ojs-js-sdk/commit/c69f11175237a755cc76f9b8e3a7189c68a4a9fc))
* extend worker with improved job handling ([9375110](https://github.com/openjobspec/ojs-js-sdk/commit/9375110792b460cbe08797d14a0d5bb1344ccd2a))
* implement core handler interfaces ([adc27f8](https://github.com/openjobspec/ojs-js-sdk/commit/adc27f8174763caefbcbc27f88cf91acebcb9d03))
* implement core handler interfaces ([829173e](https://github.com/openjobspec/ojs-js-sdk/commit/829173e1c404f5202b7d687c73686305f1fb85e0))


### Bug Fixes

* correct job state transition guard ([64b928a](https://github.com/openjobspec/ojs-js-sdk/commit/64b928add22f13e3cee4682c0ebad09f51037dcc))
* correct timestamp serialization ([3567b02](https://github.com/openjobspec/ojs-js-sdk/commit/3567b02fd5cbefbf89c29cc65e0221c07bae39d3))
* correct timestamp serialization ([6ef3ba1](https://github.com/openjobspec/ojs-js-sdk/commit/6ef3ba18604e95394882e7efa5e423379f329fb5))
* handle nil pointer in middleware chain ([229d3ac](https://github.com/openjobspec/ojs-js-sdk/commit/229d3ac8ffa25b547cde978f1cfb672a13f2deeb))
* prevent double-close on worker pool ([a99fb68](https://github.com/openjobspec/ojs-js-sdk/commit/a99fb68d0d0af035006b8ec5b66beec809bce98b))
* resolve edge case in input validation ([d8da927](https://github.com/openjobspec/ojs-js-sdk/commit/d8da927b5fdb95b686f434ff714354c452e0cb6b))
* resolve edge case in input validation ([ed0b9fd](https://github.com/openjobspec/ojs-js-sdk/commit/ed0b9fdf1f7c2d84460a4fa8c7e86f1816928f41))
* update HTTP transport error handling ([36e91f0](https://github.com/openjobspec/ojs-js-sdk/commit/36e91f0853a26a481e388ab6fc777fbe878821c0))


### Performance Improvements

* cache compiled regex patterns ([4bb4a9b](https://github.com/openjobspec/ojs-js-sdk/commit/4bb4a9b6a92916bac0f7c242a5df9e79f63d207b))
* optimize data processing loop ([2090186](https://github.com/openjobspec/ojs-js-sdk/commit/209018685d1b07d0725393a9a70e3362fd7b2858))
* optimize data processing loop ([ae27790](https://github.com/openjobspec/ojs-js-sdk/commit/ae27790641f98672c024132228cf302f9a6eb10a))
* reduce allocations in hot path ([cad870c](https://github.com/openjobspec/ojs-js-sdk/commit/cad870c65d39e1617328a962e4727c3103666f9a))

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

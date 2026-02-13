# Contributing to @openjobspec/sdk

Thank you for your interest in contributing to the Open Job Spec JavaScript/TypeScript SDK.

## Development Setup

```bash
git clone https://github.com/openjobspec/ojs-js-sdk.git
cd ojs-js-sdk
npm install
npm run build
npm test
```

### Prerequisites

- Node.js 18 or later
- npm 9 or later

### Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm test` | Run unit tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with coverage report |
| `npm run lint` | Type-check without emitting |

## Making Changes

1. Fork the repository and create a feature branch from `main`.
2. Write your code following the existing patterns and conventions.
3. Add or update tests for any changed behavior.
4. Run `npm test` and `npm run lint` to verify everything passes.
5. Commit using [Conventional Commits](https://www.conventionalcommits.org/) format:
   - `feat:` for new features
   - `fix:` for bug fixes
   - `test:` for test-only changes
   - `docs:` for documentation changes
   - `chore:` for maintenance tasks

## Code Style

- TypeScript strict mode is enabled. All code must pass `tsc --noEmit`.
- Use camelCase for the SDK public API and snake_case for wire format fields.
- Keep zero runtime dependencies. Only use built-in APIs (`fetch`, `crypto`, `AbortController`).
- Add JSDoc comments for public APIs. Internal helpers do not require documentation.

## Tests

- Tests use [Vitest](https://vitest.dev/) and live in `tests/`.
- Use the mock transport pattern (see `tests/client.test.ts`) for unit tests.
- Integration tests go in `tests/integration/` and are excluded from the default test run.
- Aim for 80%+ line coverage on new code.

## Pull Requests

- Keep PRs focused on a single change.
- Include a clear description of what the PR does and why.
- Link related issues if applicable.

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.

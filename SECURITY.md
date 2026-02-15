# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in `@openjobspec/sdk`, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please email **openjobspec@googlegroups.com** with:

1. A description of the vulnerability
2. Steps to reproduce the issue
3. The potential impact
4. Any suggested fixes (optional)

### What to Expect

- **Acknowledgment**: We will acknowledge receipt within 48 hours.
- **Assessment**: We will assess the severity and impact within 5 business days.
- **Resolution**: We will work on a fix and coordinate disclosure with you.
- **Credit**: We will credit you in the release notes (unless you prefer anonymity).

### Scope

This policy covers the `@openjobspec/sdk` npm package and its source code. Issues in dependencies should be reported to the respective projects.

## Security Best Practices

When using this SDK:

- Keep the SDK updated to the latest version.
- Never hardcode credentials — use environment variables or secret managers for the `auth` option.
- Use HTTPS for all OJS server connections in production.
- Validate and sanitize job arguments before enqueuing if they originate from user input.

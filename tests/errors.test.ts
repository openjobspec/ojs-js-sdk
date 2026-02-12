import { describe, it, expect } from 'vitest';
import {
  OJSError,
  OJSValidationError,
  OJSNotFoundError,
  OJSDuplicateError,
  OJSConflictError,
  OJSServerError,
  OJSConnectionError,
  OJSTimeoutError,
  parseErrorResponse,
} from '../src/errors.js';

describe('OJSError', () => {
  it('sets message, code, and defaults', () => {
    const err = new OJSError('something broke', 'test_error');
    expect(err.message).toBe('something broke');
    expect(err.code).toBe('test_error');
    expect(err.retryable).toBe(false);
    expect(err.details).toBeUndefined();
    expect(err.requestId).toBeUndefined();
    expect(err.name).toBe('OJSError');
    expect(err).toBeInstanceOf(Error);
  });

  it('accepts all options', () => {
    const cause = new Error('root cause');
    const err = new OJSError('msg', 'code', {
      retryable: true,
      details: { key: 'value' },
      requestId: 'req-123',
      cause,
    });
    expect(err.retryable).toBe(true);
    expect(err.details).toEqual({ key: 'value' });
    expect(err.requestId).toBe('req-123');
    expect(err.cause).toBe(cause);
  });

  it('toJSON() returns serializable representation', () => {
    const err = new OJSError('msg', 'code', {
      retryable: true,
      details: { k: 'v' },
      requestId: 'req-1',
    });
    const json = err.toJSON();
    expect(json).toEqual({
      name: 'OJSError',
      code: 'code',
      message: 'msg',
      retryable: true,
      details: { k: 'v' },
      requestId: 'req-1',
    });
  });

  it('toJSON() is used by JSON.stringify', () => {
    const err = new OJSError('msg', 'code');
    const parsed = JSON.parse(JSON.stringify(err));
    expect(parsed.name).toBe('OJSError');
    expect(parsed.message).toBe('msg');
    expect(parsed.code).toBe('code');
  });
});

describe('OJSValidationError', () => {
  it('sets correct properties', () => {
    const err = new OJSValidationError('bad input', { field: 'type' }, 'req-1');
    expect(err.name).toBe('OJSValidationError');
    expect(err.code).toBe('invalid_request');
    expect(err.retryable).toBe(false);
    expect(err.details).toEqual({ field: 'type' });
    expect(err.requestId).toBe('req-1');
    expect(err).toBeInstanceOf(OJSError);
  });
});

describe('OJSNotFoundError', () => {
  it('formats message and stores resource info', () => {
    const err = new OJSNotFoundError('job', 'abc-123', 'req-2');
    expect(err.name).toBe('OJSNotFoundError');
    expect(err.code).toBe('not_found');
    expect(err.message).toBe("job 'abc-123' not found.");
    expect(err.retryable).toBe(false);
    expect(err.details).toEqual({ resource_type: 'job', resource_id: 'abc-123' });
    expect(err.requestId).toBe('req-2');
  });
});

describe('OJSDuplicateError', () => {
  it('sets existingJobId from details', () => {
    const err = new OJSDuplicateError('duplicate', { existing_job_id: 'job-1' }, 'req-3');
    expect(err.name).toBe('OJSDuplicateError');
    expect(err.code).toBe('duplicate');
    expect(err.retryable).toBe(false);
    expect(err.existingJobId).toBe('job-1');
  });

  it('handles missing existingJobId', () => {
    const err = new OJSDuplicateError('duplicate');
    expect(err.existingJobId).toBeUndefined();
  });
});

describe('OJSConflictError', () => {
  it('sets correct properties', () => {
    const err = new OJSConflictError('state conflict', { current_state: 'active' });
    expect(err.name).toBe('OJSConflictError');
    expect(err.code).toBe('conflict');
    expect(err.retryable).toBe(false);
    expect(err.details).toEqual({ current_state: 'active' });
  });
});

describe('OJSServerError', () => {
  it('sets statusCode and marks retryable', () => {
    const err = new OJSServerError('internal error', 503, 'req-4');
    expect(err.name).toBe('OJSServerError');
    expect(err.code).toBe('server_error');
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBe(503);
    expect(err.requestId).toBe('req-4');
  });
});

describe('OJSConnectionError', () => {
  it('wraps cause and marks retryable', () => {
    const cause = new TypeError('fetch failed');
    const err = new OJSConnectionError('connection failed', cause);
    expect(err.name).toBe('OJSConnectionError');
    expect(err.code).toBe('connection_error');
    expect(err.retryable).toBe(true);
    expect(err.cause).toBe(cause);
  });
});

describe('OJSTimeoutError', () => {
  it('formats message with job ID and timeout', () => {
    const err = new OJSTimeoutError('job-5', 30000);
    expect(err.name).toBe('OJSTimeoutError');
    expect(err.code).toBe('timeout');
    expect(err.retryable).toBe(true);
    expect(err.message).toBe("Job 'job-5' exceeded 30000ms timeout.");
    expect(err.details).toEqual({ job_id: 'job-5', timeout_ms: 30000 });
  });
});

describe('parseErrorResponse', () => {
  it('returns OJSValidationError for 400', () => {
    const err = parseErrorResponse(400, {
      error: { code: 'invalid_request', message: 'bad field', details: { field: 'type' }, request_id: 'r1' },
    });
    expect(err).toBeInstanceOf(OJSValidationError);
    expect(err.message).toBe('bad field');
    expect(err.requestId).toBe('r1');
  });

  it('returns OJSNotFoundError for 404', () => {
    const err = parseErrorResponse(404, {
      error: {
        message: 'not found',
        details: { resource_type: 'job', resource_id: 'abc-123' },
        request_id: 'r2',
      },
    });
    expect(err).toBeInstanceOf(OJSNotFoundError);
    expect(err.message).toContain('abc-123');
  });

  it('returns OJSNotFoundError with defaults when details missing', () => {
    const err = parseErrorResponse(404, { error: { message: 'missing' } });
    expect(err).toBeInstanceOf(OJSNotFoundError);
    expect(err.message).toContain('resource');
  });

  it('returns OJSDuplicateError for 409 with duplicate code', () => {
    const err = parseErrorResponse(409, {
      error: { code: 'duplicate', message: 'already exists', details: { existing_job_id: 'j1' } },
    });
    expect(err).toBeInstanceOf(OJSDuplicateError);
    expect((err as OJSDuplicateError).existingJobId).toBe('j1');
  });

  it('returns OJSConflictError for 409 without duplicate code', () => {
    const err = parseErrorResponse(409, {
      error: { code: 'conflict', message: 'state conflict' },
    });
    expect(err).toBeInstanceOf(OJSConflictError);
  });

  it('returns OJSServerError for 5xx', () => {
    const err = parseErrorResponse(500, { error: { message: 'internal' } });
    expect(err).toBeInstanceOf(OJSServerError);
    expect((err as OJSServerError).statusCode).toBe(500);
    expect(err.retryable).toBe(true);
  });

  it('returns OJSServerError for 503', () => {
    const err = parseErrorResponse(503, { error: { message: 'unavailable' } });
    expect(err).toBeInstanceOf(OJSServerError);
    expect((err as OJSServerError).statusCode).toBe(503);
  });

  it('returns generic OJSError for unknown status codes', () => {
    const err = parseErrorResponse(429, {
      error: { code: 'rate_limited', message: 'too many requests', retryable: true },
    });
    expect(err).toBeInstanceOf(OJSError);
    expect(err.code).toBe('rate_limited');
  });

  it('handles missing error body', () => {
    const err = parseErrorResponse(400, {});
    expect(err).toBeInstanceOf(OJSValidationError);
    expect(err.message).toBe('HTTP 400');
  });

  it('handles completely empty body', () => {
    const err = parseErrorResponse(500, {} as { error?: { message?: string } });
    expect(err).toBeInstanceOf(OJSServerError);
    expect(err.message).toBe('HTTP 500');
  });
});

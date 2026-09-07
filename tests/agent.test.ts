import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentClient, AgentError } from '../src/agent/index.js';

function mockResponse(body: unknown, init: { status?: number; statusText?: string } = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('AgentClient', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('strips trailing slashes from the base URL', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse({ branch_id: 'b1', content_id: 'c1' }));
    globalThis.fetch = fetchSpy;

    const client = new AgentClient({ baseUrl: 'http://agent.test///' });
    await client.fork('job-1', { atTurn: 3, branchName: 'b1' });

    expect(fetchSpy.mock.calls[0]![0]).toBe('http://agent.test/v1/agent/jobs/job-1/fork');
  });

  it('sends fork() options converted to snake_case in the body', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse({ branch_id: 'b1', content_id: 'c1' }));
    globalThis.fetch = fetchSpy;

    const client = new AgentClient({ baseUrl: 'http://agent.test' });
    const result = await client.fork('job-1', { atTurn: 3, branchName: 'my-branch' });

    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ at_turn: 3, branch_name: 'my-branch' });
    // Response converted back to camelCase.
    expect(result).toEqual({ branchId: 'b1', contentId: 'c1' });
  });

  it('sends merge() options and converts the response, including nested arrays', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      mockResponse({ merged_id: 'm1', conflicts: ['step_one', 'step_two'] }),
    );
    globalThis.fetch = fetchSpy;

    const client = new AgentClient({ baseUrl: 'http://agent.test' });
    const result = await client.merge('job-1', { branchA: 'a', branchB: 'b', strategy: 'union' });

    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse(init.body as string)).toEqual({ branch_a: 'a', branch_b: 'b', strategy: 'union' });
    expect(result).toEqual({ mergedId: 'm1', conflicts: ['step_one', 'step_two'] });
  });

  it('pause() sends a reason and resolves without a value on 204', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(undefined, { status: 204 }));
    globalThis.fetch = fetchSpy;

    const client = new AgentClient({ baseUrl: 'http://agent.test' });
    const result = await client.pause('job-1', 'needs human review');

    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse(init.body as string)).toEqual({ reason: 'needs human review' });
    expect(result).toBeUndefined();
  });

  it('resume() sends the decision object as-is (already a plain object)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(undefined, { status: 204 }));
    globalThis.fetch = fetchSpy;

    const client = new AgentClient({ baseUrl: 'http://agent.test' });
    await client.resume('job-1', { approved: true, comment: 'looks good', metadata: { reviewer: 'alice' } });

    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse(init.body as string)).toEqual({
      approved: true,
      comment: 'looks good',
      metadata: { reviewer: 'alice' },
    });
  });

  it('replay() sends options converted to snake_case and converts divergence results', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      mockResponse({
        steps: 12,
        divergences: [{ turn: 3, expected: 'a', actual: 'b' }],
      }),
    );
    globalThis.fetch = fetchSpy;

    const client = new AgentClient({ baseUrl: 'http://agent.test' });
    const result = await client.replay('job-1', { fromTurn: 2, mockProviders: { openai: 'stub' } });

    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse(init.body as string)).toEqual({ from_turn: 2, mock_providers: { openai: 'stub' } });
    expect(result).toEqual({ steps: 12, divergences: [{ turn: 3, expected: 'a', actual: 'b' }] });
  });

  it('merges custom headers with the default Content-Type', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(undefined, { status: 204 }));
    globalThis.fetch = fetchSpy;

    const client = new AgentClient({
      baseUrl: 'http://agent.test',
      headers: { Authorization: 'Bearer token123' },
    });
    await client.pause('job-1', 'x');

    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer token123',
    });
  });

  it('throws AgentError with status code and raw response body on a non-ok response', async () => {
    // A Response body can only be read once, so return a fresh instance per call.
    const fetchSpy = vi.fn().mockImplementation(() =>
      Promise.resolve(mockResponse({ error: 'not found' }, { status: 404, statusText: 'Not Found' })),
    );
    globalThis.fetch = fetchSpy;

    const client = new AgentClient({ baseUrl: 'http://agent.test' });

    await expect(client.pause('missing-job', 'x')).rejects.toBeInstanceOf(AgentError);
    await expect(client.pause('missing-job', 'x')).rejects.toMatchObject({
      statusCode: 404,
      responseBody: JSON.stringify({ error: 'not found' }),
    });
  });

  it('AgentError carries the status code, response body, and a descriptive message', () => {
    const err = new AgentError('Agent API error: 500 Internal Server Error', 500, '{"detail":"boom"}');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AgentError');
    expect(err.statusCode).toBe(500);
    expect(err.responseBody).toBe('{"detail":"boom"}');
  });
});

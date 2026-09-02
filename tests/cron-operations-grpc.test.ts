/**
 * Direct `CronOperations` tests against a real `GrpcTransport`, covering
 * the finding-3 fixes in `src/transport/grpc.ts`:
 *
 *   - Route matching now strips/parses the query string `CronOperations
 *     .list()` appends (e.g. `/cron?page=2&per_page=10`), which previously
 *     made every `GET /cron` route match fail past the point of routing
 *     at all.
 *   - `grpcListCron` validates/defaults `page`/`per_page` (1/25) and
 *     applies pagination client-side (service.proto's `ListCronRequest`
 *     carries none), over a deterministic name-sorted order, returning
 *     `{ cron_jobs, pagination }`.
 *   - `grpcRegisterCron` returns a full `{ cron_job: CronJobInfo }` built
 *     solely from the submitted definition plus the authoritative
 *     `RegisterCronResponse` `name`/`next_run_at` and a locally captured
 *     registration timestamp for `created_at` — with `status: 'active'`.
 *     It issues exactly one RPC (`registerCron`); it never performs a
 *     racy, O(n) follow-up `ListCron` lookup (a prior implementation did,
 *     and could observe a stale/not-yet-visible snapshot or a concurrent
 *     upsert of the same name, and mixed two different response
 *     revisions together).
 *
 * As in `tests/transport-grpc-workflow-cron-ack.test.ts`, a capturing fake
 * client records the exact gRPC method + request `GrpcTransport` issues.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { GrpcTransport, type GrpcTransportConfig } from '../src/transport/grpc.js';
import { CronOperations } from '../src/cron.js';
import { OJSValidationError } from '../src/errors.js';

interface CapturedCall {
  method: string;
  request: Record<string, unknown>;
}

afterEach(() => {
  vi.useRealTimers();
});

/** Proto-shaped CronEntry fixtures, as `@grpc/proto-loader` would decode
 * them (camelCase, `Value`-wrapped args) — matches the shape
 * `grpcListCron`/`grpcRegisterCron` actually receive from `this.call()`. */
function protoCronEntry(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    name: 'unnamed',
    cron: '@daily',
    timezone: 'UTC',
    type: 'noop',
    args: [],
    ...overrides,
  };
}

function createCapturingGrpcTransport(
  listCronEntries: unknown[] = [],
  configOverrides: Partial<GrpcTransportConfig> = {},
): { transport: GrpcTransport; calls: CapturedCall[] } {
  const transport = new GrpcTransport({ url: 'localhost:9090', ...configOverrides });
  const calls: CapturedCall[] = [];

  (transport as unknown as { client: unknown }).client = { close: () => {} };
  (transport as unknown as { initPromise: Promise<void> }).initPromise = Promise.resolve();
  (transport as unknown as { grpcModule: unknown }).grpcModule = {
    Metadata: class {
      entries: Record<string, string> = {};
      set(key: string, value: string): void {
        this.entries[key] = value;
      }
    },
    credentials: { createInsecure: () => ({}) },
    loadPackageDefinition: () => ({}),
  };

  (transport as unknown as {
    call: (method: string, request: unknown) => Promise<unknown>;
  }).call = async (method: string, request: unknown): Promise<unknown> => {
    calls.push({ method, request: request as Record<string, unknown> });
    switch (method) {
      case 'registerCron':
        return {
          name: (request as Record<string, unknown>).name,
          nextRunAt: { seconds: '1773567000', nanos: 0 },
        };
      case 'listCron':
        return { entries: listCronEntries };
      default:
        throw new Error(`unexpected method '${method}'`);
    }
  };

  return { transport, calls };
}

describe('CronOperations over GrpcTransport: list() routing/pagination', () => {
  it('routes a bare list() (no query string) to grpcListCron and defaults to page 1 / 25 per page', async () => {
    const { transport, calls } = createCapturingGrpcTransport([
      protoCronEntry({ name: 'a' }),
      protoCronEntry({ name: 'b' }),
    ]);
    const cron = new CronOperations(transport);

    const result = await cron.list();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('listCron');
    expect(result.cron_jobs.map((j) => j.name)).toEqual(['a', 'b']);
    expect(result.cron_jobs.every((job) => job.status === 'active')).toBe(true);
    expect(result.cron_jobs.every((job) => job.created_at === undefined)).toBe(
      true,
    );
    expect(result.pagination).toEqual({ page: 1, per_page: 25, total: 2 });
  });

  it('routes list({ page, per_page }) through the query string and slices the correct page', async () => {
    const entries = ['c', 'a', 'e', 'b', 'd'].map((name) => protoCronEntry({ name }));
    const { transport } = createCapturingGrpcTransport(entries);
    const cron = new CronOperations(transport);

    const page1 = await cron.list({ page: 1, per_page: 2 });
    expect(page1.cron_jobs.map((j) => j.name)).toEqual(['a', 'b']);
    expect(page1.pagination).toEqual({ page: 1, per_page: 2, total: 5 });

    const page2 = await cron.list({ page: 2, per_page: 2 });
    expect(page2.cron_jobs.map((j) => j.name)).toEqual(['c', 'd']);
    expect(page2.pagination).toEqual({ page: 2, per_page: 2, total: 5 });

    const page3 = await cron.list({ page: 3, per_page: 2 });
    expect(page3.cron_jobs.map((j) => j.name)).toEqual(['e']);
    expect(page3.pagination).toEqual({ page: 3, per_page: 2, total: 5 });
  });

  it('returns entries in a stable, deterministic (name-sorted) order regardless of RPC response order', async () => {
    const shuffled = ['zebra', 'apple', 'mango'].map((name) => protoCronEntry({ name }));
    const { transport: t1 } = createCapturingGrpcTransport(shuffled);
    const { transport: t2 } = createCapturingGrpcTransport([...shuffled].reverse());

    const r1 = await new CronOperations(t1).list();
    const r2 = await new CronOperations(t2).list();

    expect(r1.cron_jobs.map((j) => j.name)).toEqual(['apple', 'mango', 'zebra']);
    expect(r2.cron_jobs.map((j) => j.name)).toEqual(['apple', 'mango', 'zebra']);
  });

  it('an empty page beyond the last entry returns an empty array, not an error', async () => {
    const { transport } = createCapturingGrpcTransport([protoCronEntry({ name: 'only' })]);
    const result = await new CronOperations(transport).list({ page: 5, per_page: 10 });
    expect(result.cron_jobs).toEqual([]);
    expect(result.pagination).toEqual({ page: 5, per_page: 10, total: 1 });
  });

  it('rejects a non-positive-integer page/per_page sent directly through the transport', async () => {
    const { transport } = createCapturingGrpcTransport();
    await expect(
      transport.request({ method: 'GET', path: '/cron?page=0' }),
    ).rejects.toBeInstanceOf(OJSValidationError);
    await expect(
      transport.request({ method: 'GET', path: '/cron?per_page=abc' }),
    ).rejects.toBeInstanceOf(OJSValidationError);
    await expect(
      transport.request({ method: 'GET', path: '/cron?page=-1' }),
    ).rejects.toBeInstanceOf(OJSValidationError);
  });
});

describe('CronOperations over GrpcTransport: register()', () => {
  it('returns a full CronJobInfo reconstructed solely from the request and the registerCron response, with exactly one RPC call', async () => {
    const { transport, calls } = createCapturingGrpcTransport([]);
    const cron = new CronOperations(transport);

    const result = await cron.register({
      name: 'daily-report',
      cron: '0 9 * * *',
      timezone: 'America/New_York',
      type: 'report.generate',
      args: { format: 'pdf' },
      meta: { owner: 'analytics' },
      options: { queue: 'reports' },
    });

    // Finding 5: only the registerCron RPC is ever issued -- no racy,
    // O(n) follow-up ListCron lookup.
    expect(calls.map((c) => c.method)).toEqual(['registerCron']);

    expect(result.name).toBe('daily-report');
    expect(result.cron).toBe('0 9 * * *');
    expect(result.type).toBe('report.generate');
    expect(result.args).toEqual([{ format: 'pdf' }]);
    expect(result.timezone).toBe('America/New_York');
    expect(result.meta).toEqual({ owner: 'analytics' });
    expect(result.options).toEqual({ queue: 'reports' });
    expect(result.status).toBe('active');
    expect(typeof result.created_at).toBe('string');
    expect(new Date(result.created_at).toString()).not.toBe('Invalid Date');
    // RegisterCronResponse.next_run_at is the sole authoritative source.
    expect(result.next_run_at).toBe('2026-03-15T09:30:00.000Z');
    expect('last_run_at' in result).toBe(false);
  });

  it('never consults ListCron even when a conflicting/stale entry of the same name exists in the store', async () => {
    // Finding 5 regression: a prior implementation issued a best-effort
    // follow-up ListCron lookup and let its (possibly stale, or simply
    // differently-shaped) entry override parts of the just-submitted
    // definition. That lookup must not happen at all anymore -- the
    // response is built purely from what was submitted plus the
    // registerCron RPC's own name/next_run_at.
    const { transport, calls } = createCapturingGrpcTransport([
      protoCronEntry({
        name: 'daily-report',
        cron: '0 9 * * *',
        timezone: 'America/New_York',
        type: 'report.generate',
        args: [{ structValue: { fields: { format: { stringValue: 'stale-pdf' } } } }],
        options: {
          queue: 'stale-queue',
          priority: 99,
          meta: { fields: { owner: { stringValue: 'stale-server' } } },
        },
      }),
    ]);
    const cron = new CronOperations(transport);

    const result = await cron.register({
      name: 'daily-report',
      cron: '0 9 * * *',
      type: 'report.generate',
      args: { format: 'pdf' },
      options: { queue: 'reports' },
      meta: { owner: 'analytics' },
    });

    expect(calls.map((c) => c.method)).toEqual(['registerCron']);
    expect(result.args).toEqual([{ format: 'pdf' }]);
    expect(result.options).toEqual({ queue: 'reports' });
    expect(result.meta).toEqual({ owner: 'analytics' });
    expect(result.status).toBe('active');
    expect(result.next_run_at).toBe('2026-03-15T09:30:00.000Z');
  });

  it('omits options/meta entirely when the submitted definition did not include them', async () => {
    const { transport, calls } = createCapturingGrpcTransport([]);

    const result = await new CronOperations(transport).register({
      name: 'daily-report',
      cron: '0 9 * * *',
      type: 'report.generate',
      args: [],
    });

    expect(calls.map((c) => c.method)).toEqual(['registerCron']);
    expect('options' in result).toBe(false);
    expect('meta' in result).toBe(false);
  });

  it('keeps request options/meta exactly as submitted', async () => {
    const { transport } = createCapturingGrpcTransport([]);

    const result = await new CronOperations(transport).register({
      name: 'daily-report',
      cron: '0 9 * * *',
      type: 'report.generate',
      args: [],
      meta: { owner: 'request' },
      options: { queue: 'reports' },
    });

    expect(result.meta).toEqual({ owner: 'request' });
    expect(result.options).toEqual({ queue: 'reports' });
  });

  it('succeeds with a null/absent RegisterCronResponse.next_run_at by omitting next_run_at rather than failing', async () => {
    const transport = new GrpcTransport({ url: 'localhost:9090' });
    const calls: { method: string; request: Record<string, unknown> }[] = [];
    (transport as unknown as { client: unknown }).client = { close: () => {} };
    (transport as unknown as { initPromise: Promise<void> }).initPromise = Promise.resolve();
    (transport as unknown as { grpcModule: unknown }).grpcModule = {
      Metadata: class {
        set(): void {}
      },
      credentials: { createInsecure: () => ({}) },
      loadPackageDefinition: () => ({}),
    };
    (transport as unknown as {
      call: (method: string, request: unknown) => Promise<unknown>;
    }).call = async (method: string, request: unknown): Promise<unknown> => {
      calls.push({ method, request: request as Record<string, unknown> });
      return { name: (request as Record<string, unknown>).name, nextRunAt: null };
    };

    const cron = new CronOperations(transport);
    const result = await cron.register({
      name: 'ping',
      cron: '@hourly',
      type: 'ping',
      args: [],
    });

    // Exactly one RPC call -- no follow-up lookup of any kind.
    expect(calls.map((c) => c.method)).toEqual(['registerCron']);
    expect(result.name).toBe('ping');
    expect(result.cron).toBe('@hourly');
    expect(result.type).toBe('ping');
    expect(result.status).toBe('active');
    expect(typeof result.created_at).toBe('string');
    expect('next_run_at' in result).toBe(false);
  });

  it('uses the timestamp captured immediately before the registerCron RPC for created_at', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-08T00:00:00.000Z'));
    const { transport } = createCapturingGrpcTransport([]);
    const originalCall = (transport as unknown as {
      call: (method: string, request: unknown) => Promise<unknown>;
    }).call;
    (transport as unknown as {
      call: (method: string, request: unknown) => Promise<unknown>;
    }).call = async (method: string, request: unknown): Promise<unknown> => {
      if (method === 'registerCron') {
        vi.setSystemTime(new Date('2026-08-08T00:05:00.000Z'));
      }
      return originalCall(method, request);
    };

    const result = await new CronOperations(transport).register({
      name: 'captured-time',
      cron: '@daily',
      type: 'clock.tick',
      args: [],
    });

    expect(result.created_at).toBe('2026-08-08T00:00:00.000Z');
  });

  it('captures the exact registerCron request via the transport and issues no other RPC', async () => {
    const { transport, calls } = createCapturingGrpcTransport([]);
    await new CronOperations(transport).register({
      name: 'x',
      cron: '@daily',
      type: 'y',
      args: [],
      meta: { owner: 'ops' },
      options: { queue: 'q' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('registerCron');
    expect(calls[0]!.request.name).toBe('x');
    expect((calls[0]!.request.options as Record<string, unknown>).queue).toBe('q');
    expect((calls[0]!.request.options as Record<string, unknown>).meta).toEqual({
      fields: { owner: { stringValue: 'ops' } },
    });
  });

  it('handles concurrent register() calls for different names without cross-contaminating results (each response derived only from its own request/response pair)', async () => {
    const transport = new GrpcTransport({ url: 'localhost:9090' });
    const calls: { method: string; request: Record<string, unknown> }[] = [];
    (transport as unknown as { client: unknown }).client = { close: () => {} };
    (transport as unknown as { initPromise: Promise<void> }).initPromise = Promise.resolve();
    (transport as unknown as { grpcModule: unknown }).grpcModule = {
      Metadata: class {
        set(): void {}
      },
      credentials: { createInsecure: () => ({}) },
      loadPackageDefinition: () => ({}),
    };
    (transport as unknown as {
      call: (method: string, request: unknown) => Promise<unknown>;
    }).call = async (method: string, request: unknown): Promise<unknown> => {
      calls.push({ method, request: request as Record<string, unknown> });
      const req = request as Record<string, unknown>;
      // Simulate out-of-order server responses: the second call's
      // response resolves before the first's, despite being issued
      // second, to prove there is no shared/racy intermediate state
      // (like a shared follow-up ListCron result) that could leak
      // between concurrent registrations.
      const delayMs = req.name === 'first' ? 20 : 0;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        name: req.name,
        nextRunAt: { seconds: req.name === 'first' ? '1773567000' : '1773567100', nanos: 0 },
      };
    };

    const cron = new CronOperations(transport);
    const [first, second] = await Promise.all([
      cron.register({ name: 'first', cron: '@daily', type: 'a', args: [1] }),
      cron.register({ name: 'second', cron: '@hourly', type: 'b', args: [2] }),
    ]);

    expect(calls.map((c) => c.method)).toEqual(['registerCron', 'registerCron']);
    expect(first.name).toBe('first');
    expect(first.cron).toBe('@daily');
    expect(first.type).toBe('a');
    expect(first.args).toEqual([1]);
    expect(first.next_run_at).toBe('2026-03-15T09:30:00.000Z');
    expect(second.name).toBe('second');
    expect(second.cron).toBe('@hourly');
    expect(second.type).toBe('b');
    expect(second.args).toEqual([2]);
    expect(second.next_run_at).toBe('2026-03-15T09:31:40.000Z');
  });

  it('upserting the same cron name twice reflects only the latest submitted definition each time (no merge with a prior registration)', async () => {
    const { transport, calls } = createCapturingGrpcTransport([]);
    const cron = new CronOperations(transport);

    const initial = await cron.register({
      name: 'daily-report',
      cron: '0 9 * * *',
      type: 'report.generate',
      args: { format: 'pdf' },
      options: { queue: 'reports' },
    });
    expect(initial.args).toEqual([{ format: 'pdf' }]);
    expect(initial.options).toEqual({ queue: 'reports' });

    const upserted = await cron.register({
      name: 'daily-report',
      cron: '0 10 * * *',
      type: 'report.generate',
      args: { format: 'csv' },
      options: { queue: 'reports-v2' },
    });

    expect(calls.map((c) => c.method)).toEqual(['registerCron', 'registerCron']);
    expect(upserted.cron).toBe('0 10 * * *');
    expect(upserted.args).toEqual([{ format: 'csv' }]);
    expect(upserted.options).toEqual({ queue: 'reports-v2' });
    // The upsert's response must not retain anything from the initial
    // registration's options/args.
    expect(upserted.options).not.toEqual(initial.options);
    expect(upserted.args).not.toEqual(initial.args);
  });
});

import { describe, it, expect } from 'vitest';
import { reportProgress } from '../src/progress.js';
import type {
  ProgressReport,
  LegacyProgressReport,
} from '../src/progress.js';
import type { Transport, TransportRequestOptions, TransportResponse } from '../src/transport/types.js';

function createMockTransport() {
  const requests: TransportRequestOptions[] = [];
  const transport: Transport = {
    async request<T>(options: TransportRequestOptions): Promise<TransportResponse<T>> {
      requests.push(options);
      return { status: 200, headers: {}, body: {} as T };
    },
  };
  return { transport, requests };
}

describe('reportProgress', () => {
  it('sends a PUT to /jobs/{id}/progress with a 0-1 fraction', async () => {
    const { transport, requests } = createMockTransport();

    await reportProgress(transport, 'job-1', 50, 'Half done');

    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe('PUT');
    expect(requests[0]!.path).toBe('/jobs/job-1/progress');
    expect(requests[0]!.body).toEqual({
      progress: 0.5,
      data: { message: 'Half done' },
    });
  });

  it('sends progress with a data payload merged with the message', async () => {
    const { transport, requests } = createMockTransport();

    await reportProgress(transport, 'job-2', 75, 'Processing', { rows: 150 });

    expect(requests[0]!.body).toEqual({
      progress: 0.75,
      data: { rows: 150, message: 'Processing' },
    });
  });

  it('sends a data payload without a message unchanged', async () => {
    const { transport, requests } = createMockTransport();

    await reportProgress(transport, 'job-2b', 75, undefined, { rows: 150 });

    expect(requests[0]!.body).toEqual({
      progress: 0.75,
      data: { rows: 150 },
    });
  });

  it('sends minimal report (no message or data, no data field at all)', async () => {
    const { transport, requests } = createMockTransport();

    await reportProgress(transport, 'job-3', 100);

    expect(requests[0]!.body).toEqual({
      progress: 1,
    });
  });

  it('throws RangeError for percentage below 0', async () => {
    const { transport } = createMockTransport();

    await expect(reportProgress(transport, 'j', -1)).rejects.toThrow(RangeError);
    await expect(reportProgress(transport, 'j', -1)).rejects.toThrow(
      'Percentage must be between 0 and 100',
    );
  });

  it('throws RangeError for percentage above 100', async () => {
    const { transport } = createMockTransport();

    await expect(reportProgress(transport, 'j', 101)).rejects.toThrow(RangeError);
  });

  it('accepts boundary values 0 and 100', async () => {
    const { transport, requests } = createMockTransport();

    await reportProgress(transport, 'j', 0);
    await reportProgress(transport, 'j', 100);

    expect(requests).toHaveLength(2);
    expect((requests[0]!.body as { progress: number }).progress).toBe(0);
    expect((requests[1]!.body as { progress: number }).progress).toBe(1);
  });

  it('throws for empty job_id', async () => {
    const { transport } = createMockTransport();

    await expect(reportProgress(transport, '', 50)).rejects.toThrow(
      'job_id is required',
    );
  });

  it('URL-encodes the job ID in the path', async () => {
    const { transport, requests } = createMockTransport();

    await reportProgress(transport, 'job/needs-encoding', 10);

    expect(requests[0]!.path).toBe('/jobs/job%2Fneeds-encoding/progress');
  });
});

describe('ProgressReport (Finding: progress public type)', () => {
  it('represents progress-only, data-only, and optional-checkpoint runtime values', () => {
    const reports: ProgressReport[] = [
      { progress: 0 },
      { data: { rows: 10 } },
      {
        progress: 0.5,
        data: { rows: 5 },
        checkpoint: { cursor: 'row-5' },
      },
    ];

    expect(reports).toEqual([
      { progress: 0 },
      { data: { rows: 10 } },
      {
        progress: 0.5,
        data: { rows: 5 },
        checkpoint: { cursor: 'row-5' },
      },
    ]);
  });

  it('is the canonical wire shape { progress, data? }, exactly matching every request body reportProgress() actually sends', async () => {
    const { transport, requests } = createMockTransport();

    await reportProgress(transport, 'job-1', 50, 'Half done', { rows: 10 });

    // The exact request body reportProgress() sent must be assignable to
    // the public `ProgressReport` type — i.e. the type genuinely
    // describes the real wire shape, not merely a documentation fiction.
    const wireBody: ProgressReport = requests[0]!.body as ProgressReport;
    expect(wireBody.progress).toBe(0.5);
    expect(wireBody.data).toEqual({ rows: 10, message: 'Half done' });

    // `ProgressReport` has no `job_id`/`percentage`/`message` fields of
    // its own — the job ID lives in the URL, and `message` is folded into
    // `data` — so a real captured body only ever has these two keys.
    expect(Object.keys(wireBody).sort()).toEqual(['data', 'progress']);
  });

  it('minimal report (no message/data) still satisfies ProgressReport with only `progress` set', async () => {
    const { transport, requests } = createMockTransport();

    await reportProgress(transport, 'job-3', 100);

    const wireBody: ProgressReport = requests[0]!.body as ProgressReport;
    expect(wireBody).toEqual({ progress: 1 });
    expect(wireBody.data).toBeUndefined();
  });

  it('a value satisfying the canonical ProgressReport shape is NOT assignable to the deprecated LegacyProgressReport shape, and vice versa (compile-time type distinction)', () => {
    // This test's real assertion is at compile time (via `tsc --noEmit`):
    // if `ProgressReport` and `LegacyProgressReport` were ever merged
    // back into a single loose shape, one of the two `// @ts-expect-error`
    // annotations below would stop reporting an error and this file would
    // fail to typecheck. The runtime `expect` calls just document the
    // same fact for a reader skimming test output.
    const canonical: ProgressReport = { progress: 0.5, data: { rows: 1 } };
    // @ts-expect-error -- `job_id`/`percentage` are LegacyProgressReport-only fields, not part of the canonical wire type.
    const _notLegacy: LegacyProgressReport = canonical;

    const legacy: LegacyProgressReport = {
      job_id: 'job-1',
      percentage: 50,
      message: 'halfway',
    };
    // @ts-expect-error -- `progress` is required on the canonical type but absent from the legacy shape.
    const _notCanonical: ProgressReport = legacy;

    expect(canonical.progress).toBe(0.5);
    expect(legacy.percentage).toBe(50);
  });

  it('keeps the deprecated legacy runtime shape distinct and usable for migration', () => {
    const legacy: LegacyProgressReport = {
      job_id: 'job-legacy',
      percentage: 25,
      message: 'quarter done',
      data: { rows: 25 },
    };

    expect(legacy).toEqual({
      job_id: 'job-legacy',
      percentage: 25,
      message: 'quarter done',
      data: { rows: 25 },
    });
    expect(legacy).not.toHaveProperty('progress');
    expect(legacy).not.toHaveProperty('checkpoint');
  });
});

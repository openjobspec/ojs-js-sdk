import { describe, it, expect, vi } from 'vitest';
import { reportProgress } from '../src/progress.js';
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
  it('sends progress report to server', async () => {
    const { transport, requests } = createMockTransport();

    await reportProgress(transport, 'job-1', 50, 'Half done');

    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.path).toBe('/workers/progress');
    expect(requests[0]!.body).toEqual({
      job_id: 'job-1',
      percentage: 50,
      message: 'Half done',
    });
  });

  it('sends progress with data payload', async () => {
    const { transport, requests } = createMockTransport();

    await reportProgress(transport, 'job-2', 75, 'Processing', { rows: 150 });

    expect(requests[0]!.body).toEqual({
      job_id: 'job-2',
      percentage: 75,
      message: 'Processing',
      data: { rows: 150 },
    });
  });

  it('sends minimal report (no message or data)', async () => {
    const { transport, requests } = createMockTransport();

    await reportProgress(transport, 'job-3', 100);

    expect(requests[0]!.body).toEqual({
      job_id: 'job-3',
      percentage: 100,
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
    expect(requests[0]!.body.percentage).toBe(0);
    expect(requests[1]!.body.percentage).toBe(100);
  });

  it('throws for empty job_id', async () => {
    const { transport } = createMockTransport();

    await expect(reportProgress(transport, '', 50)).rejects.toThrow(
      'job_id is required',
    );
  });
});

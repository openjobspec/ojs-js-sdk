/**
 * OJS Progress Reporting — allows workers to report partial progress
 * from long-running jobs back to the server.
 */

import type { Transport } from './transport/types.js';

/** A progress report sent to the OJS server. */
export interface ProgressReport {
  job_id: string;
  percentage: number;
  message?: string;
  data?: Record<string, unknown>;
}

/**
 * Report progress for a job to the OJS server.
 *
 * @param transport - The transport to use for the HTTP request.
 * @param jobId - The ID of the job reporting progress.
 * @param percentage - Completion percentage (0–100).
 * @param message - Optional human-readable progress message.
 * @param data - Optional structured data with partial results.
 *
 * @example
 * ```ts
 * // Within a job handler:
 * worker.register('data.import', async (ctx) => {
 *   for (let i = 0; i < rows.length; i++) {
 *     await processRow(rows[i]);
 *     await reportProgress(transport, ctx.job.id, Math.round((i / rows.length) * 100), `Processed ${i} rows`);
 *   }
 * });
 * ```
 */
export async function reportProgress(
  transport: Transport,
  jobId: string,
  percentage: number,
  message?: string,
  data?: Record<string, unknown>,
): Promise<void> {
  if (percentage < 0 || percentage > 100) {
    throw new RangeError(
      `Percentage must be between 0 and 100, got ${percentage}`,
    );
  }
  if (!jobId) {
    throw new Error('job_id is required for progress reporting');
  }

  const body: ProgressReport = {
    job_id: jobId,
    percentage,
  };
  if (message !== undefined) body.message = message;
  if (data !== undefined) body.data = data;

  await transport.request({
    method: 'POST',
    path: '/workers/progress',
    body,
  });
}

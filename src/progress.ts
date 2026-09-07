/**
 * OJS Progress Reporting — allows workers to report partial progress
 * from long-running jobs back to the server.
 *
 * Wire format follows the HTTP binding in ojs-progress.md section 6.1:
 * `PUT /ojs/v1/jobs/{id}/progress` with a body containing at least one of
 * `progress` (0–1) or `data`, plus optional `checkpoint`.
 * `progress` on the wire is a 0–1 fraction, not a 0–100 percentage.
 *
 * `HttpTransport` forwards this call as the real HTTP request above.
 * `GrpcTransport` currently has no wire operation to forward it to at
 * all — the OJS gRPC proto (`service.proto`) defines no progress RPC —
 * so `reportProgress()` called with a `GrpcTransport` always rejects
 * with a non-retryable `unimplemented` `OJSError` rather than silently
 * discarding the report as if it had succeeded (see
 * `GrpcTransport`'s private `grpcProgress()` in `src/transport/grpc.ts`).
 */

import type { Transport } from './transport/types.js';

/**
 * The canonical wire-format progress report, exactly matching
 * ojs-progress.md section 6's `PUT /ojs/v1/jobs/{id}/progress` request
 * body: `progress` is a 0–1 fraction (not a 0–100 percentage — see
 * {@link reportProgress}'s own `percentage` parameter for the ergonomic
 * developer-facing form of that conversion), and the job ID is carried in
 * the URL, not the body, so it has no place here.
 *
 * Modeled as a union so the type enforces ojs-progress.md section 6.1's
 * "at least one of `progress` or `data` MUST be present in a progress
 * update" rule at compile time: either `progress` is set (with optional
 * `data`), or `data` is set (with optional `progress`). Either variant
 * may also carry an optional `checkpoint` (section 6.4).
 *
 * This type intentionally has **no** `job_id`/`percentage`/`message`
 * fields — those belonged to a pre-wire-alignment shape this SDK never
 * actually sent over the wire (see {@link LegacyProgressReport} for that
 * shape, kept only for callers migrating off it). `reportProgress()`'s
 * own function signature remains the ergonomic 0–100 `percentage` API;
 * only the *type* describing the wire body changes here.
 */
export type ProgressReport =
  | {
      /** Completion fraction in the inclusive range 0–1 (not 0–100). */
      progress: number;
      /** Optional structured data accompanying this progress report. */
      data?: Record<string, unknown>;
      /**
       * Optional recoverable state used to resume the job
       * (ojs-progress.md section 6.4).
       */
      checkpoint?: Record<string, unknown>;
    }
  | {
      /** Optional completion fraction in the inclusive range 0–1. */
      progress?: number;
      /** Structured data satisfying the union's required-field constraint. */
      data: Record<string, unknown>;
      /**
       * Optional recoverable state used to resume the job
       * (ojs-progress.md section 6.4).
       */
      checkpoint?: Record<string, unknown>;
    };

/**
 * @deprecated This is **not** the wire format `reportProgress()` actually
 * sends (see {@link ProgressReport} for that) — it is kept only for
 * callers/documentation that referred to the pre-wire-alignment shape
 * `{ job_id, percentage, message, data }` this SDK used internally before
 * `reportProgress()` was corrected to send ojs-progress.md's actual
 * `{ progress, data }` body. Do not use this type for new code; construct
 * a {@link ProgressReport} (or just call `reportProgress()`, which builds
 * the wire body internally) instead.
 */
export interface LegacyProgressReport {
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

  // The wire protocol has no `message` field (see ojs-progress.md section
  // 6.1/6.4: only `progress` and `data`/`checkpoint`) and identifies the job
  // via the URL, not the body — fold `message` into `data` rather than
  // silently discarding it, and omit `job_id` from the body.
  const wireData: Record<string, unknown> | undefined =
    message !== undefined || data !== undefined
      ? { ...data, ...(message !== undefined ? { message } : {}) }
      : undefined;

  const body: ProgressReport =
    wireData !== undefined
      ? { progress: percentage / 100, data: wireData }
      : { progress: percentage / 100 };

  await transport.request({
    method: 'PUT',
    path: `/jobs/${encodeURIComponent(jobId)}/progress`,
    body,
  });
}

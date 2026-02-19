/**
 * OJS adapter for Vercel Edge Functions.
 *
 * @example
 * ```typescript
 * // app/api/ojs/route.ts (Next.js App Router)
 * import { createEdgeHandler } from '@openjobspec/sdk/serverless/vercel';
 *
 * const handler = createEdgeHandler({
 *   url: process.env.OJS_URL!,
 * });
 *
 * handler.register('notification.send', async (ctx) => {
 *   await sendNotification(ctx.job.args[0]);
 * });
 *
 * export const POST = handler.handleRequest;
 * export const runtime = 'edge';
 * ```
 */

import type { Job } from '../job.js';

export interface VercelEdgeOptions {
  /** OJS server URL. */
  url: string;
  /** API key for OJS server authentication. */
  apiKey?: string;
}

export interface VercelJobContext {
  job: Job;
  request: Request;
}

export type VercelJobHandler = (ctx: VercelJobContext) => Promise<void>;

export interface VercelEdgeHandler {
  register(jobType: string, handler: VercelJobHandler): void;
  handleRequest(request: Request): Promise<Response>;
}

/**
 * Creates a Vercel Edge Function handler for OJS jobs.
 */
export function createEdgeHandler(
  options: VercelEdgeOptions,
): VercelEdgeHandler {
  const handlers = new Map<string, VercelJobHandler>();

  return {
    register(jobType: string, handler: VercelJobHandler): void {
      handlers.set(jobType, handler);
    },

    async handleRequest(request: Request): Promise<Response> {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
      }

      let job: Job;
      try {
        job = (await request.json()) as Job;
      } catch {
        return new Response('Invalid JSON', { status: 400 });
      }

      const handler = handlers.get(job.type);
      if (!handler) {
        return new Response(
          JSON.stringify({ error: `No handler for job type: ${job.type}` }),
          { status: 422, headers: { 'Content-Type': 'application/json' } },
        );
      }

      try {
        await handler({ job, request });

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (options.apiKey) {
          headers['Authorization'] = `Bearer ${options.apiKey}`;
        }
        await fetch(`${options.url}/ojs/v1/jobs/${job.id}/ack`, {
          method: 'POST',
          headers,
        });

        return new Response(
          JSON.stringify({ status: 'completed', job_id: job.id }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      } catch (err: unknown) {
        const errorMessage =
          err instanceof Error ? err.message : 'Unknown error';

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (options.apiKey) {
          headers['Authorization'] = `Bearer ${options.apiKey}`;
        }
        await fetch(`${options.url}/ojs/v1/jobs/${job.id}/nack`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ error: errorMessage }),
        });

        return new Response(
          JSON.stringify({
            status: 'failed',
            job_id: job.id,
            error: errorMessage,
          }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        );
      }
    },
  };
}

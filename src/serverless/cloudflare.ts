/**
 * OJS adapter for Cloudflare Workers.
 *
 * Handles incoming requests from an OJS backend configured to
 * dispatch jobs via HTTP webhooks to a Cloudflare Worker.
 *
 * @example
 * ```typescript
 * import { createWorkerHandler } from '@openjobspec/sdk/serverless/cloudflare';
 *
 * const handler = createWorkerHandler({
 *   url: 'https://ojs.example.com',
 * });
 *
 * handler.register('email.send', async (ctx) => {
 *   const [to, subject, body] = ctx.job.args;
 *   await sendEmail(to, subject, body);
 * });
 *
 * export default {
 *   async fetch(request: Request, env: Env): Promise<Response> {
 *     return handler.handleRequest(request);
 *   },
 * };
 * ```
 */

import type { Job } from '../job.js';

export interface CloudflareWorkerOptions {
  /** OJS server URL for ack/fail callbacks. */
  url: string;
  /** API key for OJS server authentication. */
  apiKey?: string;
}

export interface CloudflareJobContext {
  job: Job;
  request: Request;
}

export type CloudflareJobHandler = (ctx: CloudflareJobContext) => Promise<void>;

export interface CloudflareWorkerHandler {
  register(jobType: string, handler: CloudflareJobHandler): void;
  handleRequest(request: Request): Promise<Response>;
}

/**
 * Creates a Cloudflare Worker handler for processing OJS jobs.
 */
export function createWorkerHandler(
  options: CloudflareWorkerOptions,
): CloudflareWorkerHandler {
  const handlers = new Map<string, CloudflareJobHandler>();

  return {
    register(jobType: string, handler: CloudflareJobHandler): void {
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

        await ackJob(options, job.id);

        return new Response(
          JSON.stringify({ status: 'completed', job_id: job.id }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      } catch (err: unknown) {
        const errorMessage =
          err instanceof Error ? err.message : 'Unknown error';
        await failJob(options, job.id, errorMessage);

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

async function ackJob(
  options: CloudflareWorkerOptions,
  jobId: string,
): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (options.apiKey) {
    headers['Authorization'] = `Bearer ${options.apiKey}`;
  }

  await fetch(`${options.url}/ojs/v1/jobs/${jobId}/ack`, {
    method: 'POST',
    headers,
  });
}

async function failJob(
  options: CloudflareWorkerOptions,
  jobId: string,
  error: string,
): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (options.apiKey) {
    headers['Authorization'] = `Bearer ${options.apiKey}`;
  }

  await fetch(`${options.url}/ojs/v1/jobs/${jobId}/nack`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ error }),
  });
}

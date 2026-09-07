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
 *   signingSecret: env.OJS_SIGNING_SECRET,
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
import type { PushAuthOptions } from './push-auth.js';
import {
  readBoundedRequestBody,
  verifyPushAuth,
} from './push-auth.js';

export interface CloudflareWorkerOptions extends PushAuthOptions {
  /**
   * OJS server URL.
   *
   * @deprecated No longer used by `handleRequest()`. The HTTP push protocol
   * response (this handler's returned `Response`) is now the sole signal the
   * OJS backend uses to derive the job's state transition; the handler no
   * longer performs a follow-up ACK/NACK callback request. Retained only for
   * backward compatibility with existing configuration objects.
   */
  url?: string;
  /**
   * API key for OJS server authentication.
   *
   * @deprecated Unused; see `url`.
   */
  apiKey?: string;
  /**
   * Maximum total ACK/NACK callback delivery time. Defaults to 5000ms.
   *
   * @deprecated Unused; see `url`.
   */
  callbackTimeoutMs?: number;
}

/** Push delivery envelope: {job, worker_id?, delivery_id?}. */
export interface PushEnvelope {
  job: Job;
  worker_id?: string;
  delivery_id?: string;
}

export interface CloudflareJobContext {
  job: Job;
  request: Request;
  /** Worker ID from the push envelope, if provided. */
  workerId?: string | undefined;
  /** Delivery ID from the push envelope, if provided. */
  deliveryId?: string | undefined;
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

      const bodyResult = await readBoundedRequestBody(request, options);
      if (!bodyResult.ok) {
        return new Response(
          JSON.stringify({ error: bodyResult.error }),
          {
            status: bodyResult.status,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      const { rawBody } = bodyResult;

      // Push auth verification
      const authResult = verifyPushAuth(
        rawBody,
        request.headers.get('x-ojs-timestamp'),
        request.headers.get('x-ojs-signature'),
        options,
      );

      if (!authResult.ok) {
        return new Response(
          JSON.stringify({ error: authResult.error }),
          { status: authResult.status, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // Parse envelope
      let envelope: PushEnvelope;
      try {
        const parsed = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(rawBody),
        ) as Record<string, unknown>;
        if (parsed.job && typeof parsed.job === 'object') {
          envelope = parsed as unknown as PushEnvelope;
        } else if (options.allowInsecurePush && parsed.type && typeof parsed.type === 'string') {
          // Legacy: direct Job body permitted only under insecure mode
          envelope = { job: parsed as unknown as Job };
        } else {
          return new Response(
            JSON.stringify({ error: 'Invalid push envelope: missing "job" field' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }
      } catch {
        return new Response('Invalid JSON', { status: 400 });
      }

      const { job } = envelope;

      // The HTTP push protocol response below is the sole state-transition
      // signal for this delivery: a handler that resolves returns the
      // "completed" response and a handler that throws returns an HTTP 200
      // "failed" response, both derived purely from local handler outcome.
      // Neither path performs a follow-up OJS `/workers/ack` or
      // `/workers/nack` callback request; the backend that pushed this job
      // derives the state transition from this response.
      try {
        const handler = handlers.get(job.type);
        if (!handler) {
          throw new Error(`No handler registered for job type: ${job.type}`);
        }
        await handler({
          job,
          request,
          workerId: envelope.worker_id,
          deliveryId: envelope.delivery_id,
        });
      } catch (err: unknown) {
        const errorMessage =
          err instanceof Error ? err.message : 'Unknown error';

        return new Response(
          JSON.stringify({
            status: 'failed',
            job_id: job.id,
            error: {
              code: 'handler_error',
              message: errorMessage,
              retryable: true,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response(
        JSON.stringify({ status: 'completed', job_id: job.id }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  };
}

/**
 * OJS adapter for AWS Lambda.
 *
 * Handles incoming requests from an OJS backend configured to dispatch
 * jobs via SQS triggers, HTTP push delivery (Function URL), or direct
 * Lambda invocation.
 *
 * @example
 * ```typescript
 * import { createLambdaHandler } from '@openjobspec/sdk/serverless/lambda';
 *
 * const handler = createLambdaHandler({
 *   url: process.env.OJS_URL!,
 *   signingSecret: process.env.OJS_SIGNING_SECRET,
 * });
 *
 * handler.register('email.send', async (ctx) => {
 *   const [to, subject] = ctx.job.args;
 *   await sendEmail(to, subject);
 * });
 *
 * export const lambdaHandler = handler.httpHandler;
 * ```
 */

import type { Job } from '../job.js';
import type { PushAuthOptions } from './push-auth.js';
import {
  resolveMaxBodyBytes,
  verifyPushAuth,
} from './push-auth.js';

export interface LambdaOptions extends PushAuthOptions {
  /**
   * OJS server URL.
   *
   * @deprecated No longer used by `httpHandler()`. The HTTP push protocol
   * response (this handler's returned payload) is now the sole signal the
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

export interface LambdaJobContext {
  job: Job;
  /** Worker ID from the push envelope, if provided. */
  workerId?: string | undefined;
  /** Delivery ID from the push envelope, if provided. */
  deliveryId?: string | undefined;
}

export type LambdaJobHandler = (ctx: LambdaJobContext) => Promise<void>;

/** SQS message record from a Lambda SQS event source mapping. */
export interface SQSRecord {
  messageId: string;
  body: string;
  attributes?: Record<string, string>;
  receiptHandle?: string;
}

/** SQS event delivered to a Lambda function. */
export interface SQSEvent {
  Records: SQSRecord[];
}

/** Partial batch failure response for SQS. */
export interface SQSBatchResponse {
  batchItemFailures: { itemIdentifier: string }[];
}

/** Push delivery envelope from an OJS server. */
export interface PushDeliveryRequest {
  job: Job;
  worker_id?: string;
  delivery_id?: string;
}

/** Response from direct invocation. */
export interface DirectResponse {
  status: 'completed' | 'failed';
  job_id: string;
  error?: string;
}

export interface LambdaHandler {
  register(jobType: string, handler: LambdaJobHandler): void;
  /** Handler for SQS event source mapping. Returns partial batch failures. */
  sqsHandler(event: SQSEvent, context?: unknown): Promise<SQSBatchResponse>;
  /** Handler for HTTP push delivery via Function URL or API Gateway. */
  httpHandler(
    event: Record<string, unknown>,
    context?: unknown,
  ): Promise<Record<string, unknown>>;
  /** Handler for direct Lambda invocation with a single job event. */
  directHandler(
    event: Record<string, unknown>,
    context?: unknown,
  ): Promise<DirectResponse>;
}

/**
 * Extracts raw body from a Lambda HTTP event, handling both raw and
 * base64-encoded bodies (API Gateway payload format v2).
 */
function extractRawBody(
  event: Record<string, unknown>,
  maxBodyBytes: number,
): Uint8Array {
  const body = event.body;
  if (body === undefined || body === null || body === '') {
    return new Uint8Array();
  }
  if (typeof body !== 'string') {
    throw new TypeError('Lambda HTTP event body must be a string');
  }
  if (event.isBase64Encoded === true) {
    if (
      body.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body)
    ) {
      throw new TypeError('Lambda HTTP event body is not valid base64');
    }
    const paddingBytes = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
    const decodedBytes = (body.length / 4) * 3 - paddingBytes;
    if (decodedBytes > maxBodyBytes) {
      throw new RangeError('Lambda HTTP event body is too large');
    }
    return Uint8Array.from(Buffer.from(body, 'base64'));
  }
  if (Buffer.byteLength(body, 'utf8') > maxBodyBytes) {
    throw new RangeError('Lambda HTTP event body is too large');
  }
  return new TextEncoder().encode(body);
}

/**
 * Case-insensitive header lookup for Lambda events.
 * Lambda API Gateway v2 lowercases headers; v1 may not.
 */
function getHeader(
  event: Record<string, unknown>,
  name: string,
): string | null {
  const headers = event.headers as Record<string, string> | undefined;
  if (!headers) return null;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}

/**
 * Creates an AWS Lambda handler for processing OJS jobs.
 *
 * Supports three invocation modes:
 * - **SQS trigger**: Use `handler.sqsHandler` as the Lambda entry point
 * - **HTTP push delivery**: Use `handler.httpHandler` for Function URL / API Gateway
 * - **Direct invocation**: Use `handler.directHandler` for `lambda.invoke()`
 */
export function createLambdaHandler(options: LambdaOptions): LambdaHandler {
  const handlers = new Map<string, LambdaJobHandler>();

  async function processJob(job: Job, workerId?: string, deliveryId?: string): Promise<void> {
    const handler = handlers.get(job.type);
    if (!handler) {
      throw new Error(`No handler registered for job type: ${job.type}`);
    }
    await handler({ job, workerId, deliveryId });
  }

  return {
    register(jobType: string, handler: LambdaJobHandler): void {
      handlers.set(jobType, handler);
    },

    async sqsHandler(event: SQSEvent): Promise<SQSBatchResponse> {
      const failures: { itemIdentifier: string }[] = [];

      for (const record of event.Records) {
        let job: Job;
        try {
          job = JSON.parse(record.body) as Job;
        } catch {
          failures.push({ itemIdentifier: record.messageId });
          continue;
        }

        try {
          await processJob(job);
        } catch {
          failures.push({ itemIdentifier: record.messageId });
        }
      }

      return { batchItemFailures: failures };
    },

    async httpHandler(
      event: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      const method =
        ((event.requestContext as Record<string, unknown>)?.http as Record<string, unknown>)
          ?.method ??
        (event.httpMethod as string) ??
        '';

      if (String(method).toUpperCase() !== 'POST') {
        return {
          statusCode: 405,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Method not allowed' }),
        };
      }

      // Extract raw body (handles base64 and raw)
      const bodyLimit = resolveMaxBodyBytes(options);
      if (typeof bodyLimit !== 'number') {
        return {
          statusCode: bodyLimit.status,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: bodyLimit.error }),
        };
      }

      let rawBody: Uint8Array;
      try {
        rawBody = extractRawBody(event, bodyLimit);
      } catch (error: unknown) {
        if (error instanceof RangeError) {
          return {
            statusCode: 413,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Request body too large' }),
          };
        }
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'failed',
            error: {
              code: 'invalid_request',
              message: 'Failed to decode request body',
              retryable: false,
            },
          }),
        };
      }

      // Push auth verification
      const authResult = verifyPushAuth(
        rawBody,
        getHeader(event, 'X-OJS-Timestamp'),
        getHeader(event, 'X-OJS-Signature'),
        options,
      );

      if (!authResult.ok) {
        return {
          statusCode: authResult.status,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: authResult.error }),
        };
      }

      // Parse envelope
      let requestData: PushDeliveryRequest;
      try {
        const parsed = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(rawBody),
        ) as Record<string, unknown>;
        if (parsed.job && typeof parsed.job === 'object') {
          requestData = parsed as unknown as PushDeliveryRequest;
        } else if (options.allowInsecurePush && parsed.type && typeof parsed.type === 'string') {
          // Legacy: direct Job body permitted only under insecure mode
          requestData = { job: parsed as unknown as Job };
        } else {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              error: 'Invalid push envelope: missing "job" field',
            }),
          };
        }
      } catch {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'failed',
            error: {
              code: 'invalid_request',
              message: 'Failed to decode request body',
              retryable: false,
            },
          }),
        };
      }

      const { job } = requestData;

      // The HTTP push protocol response below is the sole state-transition
      // signal for this delivery: a handler that resolves returns the
      // "completed" response and a handler that throws returns an HTTP 200
      // "failed" response, both derived purely from local handler outcome.
      // Neither path performs a follow-up OJS `/workers/ack` or
      // `/workers/nack` callback request; the backend that pushed this job
      // derives the state transition from this response.
      try {
        await processJob(job, requestData.worker_id, requestData.delivery_id);
      } catch (err: unknown) {
        const errorMessage =
          err instanceof Error ? err.message : 'Unknown error';

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'failed',
            job_id: job.id,
            error: {
              code: 'handler_error',
              message: errorMessage,
              retryable: true,
            },
          }),
        };
      }

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed', job_id: job.id }),
      };
    },

    async directHandler(
      event: Record<string, unknown>,
    ): Promise<DirectResponse> {
      const job = event as unknown as Job;

      try {
        await processJob(job);
        return { status: 'completed', job_id: job.id };
      } catch (err: unknown) {
        const errorMessage =
          err instanceof Error ? err.message : 'Unknown error';
        return { status: 'failed', job_id: job.id, error: errorMessage };
      }
    },
  };
}

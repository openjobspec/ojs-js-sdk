/**
 * OJS adapter for AWS Lambda.
 *
 * Handles incoming requests from an OJS backend configured to dispatch
 * jobs via SQS triggers, HTTP push delivery (Function URL), or direct
 * Lambda invocation.
 *
 * @example
 * ```typescript
 * // SQS trigger
 * import { createLambdaHandler } from '@openjobspec/sdk/serverless/lambda';
 *
 * const handler = createLambdaHandler({
 *   url: process.env.OJS_URL!,
 * });
 *
 * handler.register('email.send', async (ctx) => {
 *   const [to, subject] = ctx.job.args;
 *   await sendEmail(to, subject);
 * });
 *
 * export const handler = handler.sqsHandler;
 * ```
 */

import type { Job } from '../job.js';

export interface LambdaOptions {
  /** OJS server URL for ack/nack callbacks. */
  url: string;
  /** API key for OJS server authentication. */
  apiKey?: string;
}

export interface LambdaJobContext {
  job: Job;
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
  batchItemFailures: Array<{ itemIdentifier: string }>;
}

/** Push delivery request from an OJS server. */
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
 * Creates an AWS Lambda handler for processing OJS jobs.
 *
 * Supports three invocation modes:
 * - **SQS trigger**: Use `handler.sqsHandler` as the Lambda entry point
 * - **HTTP push delivery**: Use `handler.httpHandler` for Function URL / API Gateway
 * - **Direct invocation**: Use `handler.directHandler` for `lambda.invoke()`
 */
export function createLambdaHandler(options: LambdaOptions): LambdaHandler {
  const handlers = new Map<string, LambdaJobHandler>();

  async function processJob(job: Job): Promise<void> {
    const handler = handlers.get(job.type);
    if (!handler) {
      throw new Error(`No handler registered for job type: ${job.type}`);
    }
    await handler({ job });
  }

  function authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (options.apiKey) {
      headers['Authorization'] = `Bearer ${options.apiKey}`;
    }
    return headers;
  }

  return {
    register(jobType: string, handler: LambdaJobHandler): void {
      handlers.set(jobType, handler);
    },

    async sqsHandler(event: SQSEvent): Promise<SQSBatchResponse> {
      const failures: Array<{ itemIdentifier: string }> = [];

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
          ?.method ||
        (event.httpMethod as string) ||
        '';

      if (String(method).toUpperCase() !== 'POST') {
        return {
          statusCode: 405,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Method not allowed' }),
        };
      }

      let requestData: PushDeliveryRequest;
      try {
        const body =
          typeof event.body === 'string'
            ? JSON.parse(event.body)
            : event.body;
        requestData = body as PushDeliveryRequest;
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

      const job = requestData.job ?? (requestData as unknown as Job);

      try {
        await processJob(job);

        await fetch(`${options.url}/ojs/v1/jobs/${job.id}/ack`, {
          method: 'POST',
          headers: authHeaders(),
        });

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'completed', job_id: job.id }),
        };
      } catch (err: unknown) {
        const errorMessage =
          err instanceof Error ? err.message : 'Unknown error';

        await fetch(`${options.url}/ojs/v1/jobs/${job.id}/nack`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ error: errorMessage }),
        });

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'failed',
            error: {
              code: 'handler_error',
              message: errorMessage,
              retryable: true,
            },
          }),
        };
      }
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

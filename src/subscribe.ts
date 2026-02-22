/**
 * Server-Sent Events (SSE) subscription for real-time OJS job events.
 *
 * @example
 * ```ts
 * import { OJSClient } from '@openjobspec/sdk';
 * import { subscribe, subscribeJob, subscribeQueue } from '@openjobspec/sdk/subscribe';
 *
 * const client = new OJSClient({ url: 'http://localhost:8080' });
 *
 * // Subscribe to a specific job
 * const sub = subscribeJob(client, 'job-123', (event) => {
 *   console.log(`Job state: ${event.data?.to}`);
 * });
 *
 * // Later: unsubscribe
 * sub.unsubscribe();
 * ```
 */

/** Represents a real-time event received from the SSE stream. */
export interface SSEEvent {
  /** SSE event ID (for resume with Last-Event-ID). */
  id?: string;
  /** Event type (e.g., 'job.state_changed', 'job.completed'). */
  type: string;
  /** Raw event data parsed as JSON. */
  data: Record<string, unknown>;
}

/** Callback invoked for each received SSE event. */
export type SSEEventHandler = (event: SSEEvent) => void;

/** Handle returned by subscribe functions. Call unsubscribe() to disconnect. */
export interface SSESubscription {
  /** Stop receiving events and close the SSE connection. */
  unsubscribe(): void;
}

export interface SubscribeOptions {
  /** Base URL of the OJS server. */
  url: string;
  /** Bearer auth token (optional). */
  auth?: string | undefined;
  /** SSE channel to subscribe to (e.g., 'job:<id>', 'queue:<name>'). */
  channel: string;
  /** AbortSignal for external cancellation. */
  signal?: AbortSignal;
}

/**
 * Subscribe to an SSE event stream from the OJS server.
 * Works in both Node.js and browser environments using fetch streaming.
 */
export function subscribe(
  options: SubscribeOptions,
  handler: SSEEventHandler,
): SSESubscription {
  const controller = new AbortController();
  const combinedSignal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;

  const url = `${options.url.replace(/\/+$/, '')}/ojs/v1/events/stream?channel=${encodeURIComponent(options.channel)}`;

  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    'Cache-Control': 'no-cache',
  };
  if (options.auth) {
    headers['Authorization'] = `Bearer ${options.auth}`;
  }

  // Start the SSE connection
  readStream(url, headers, combinedSignal, handler).catch(() => {
    // Connection closed or errored — expected on unsubscribe
  });

  return {
    unsubscribe() {
      controller.abort();
    },
  };
}

/**
 * Subscribe to events for a specific job.
 */
export function subscribeJob(
  config: { url: string; auth?: string },
  jobId: string,
  handler: SSEEventHandler,
): SSESubscription {
  return subscribe(
    { url: config.url, auth: config.auth, channel: `job:${jobId}` },
    handler,
  );
}

/**
 * Subscribe to events for all jobs in a queue.
 */
export function subscribeQueue(
  config: { url: string; auth?: string },
  queue: string,
  handler: SSEEventHandler,
): SSESubscription {
  return subscribe(
    { url: config.url, auth: config.auth, channel: `queue:${queue}` },
    handler,
  );
}

async function readStream(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  handler: SSEEventHandler,
): Promise<void> {
  const response = await fetch(url, { headers, signal });

  if (!response.ok) {
    throw new Error(`SSE connection failed: ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('SSE response has no readable body');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let eventType = '';
  let eventId = '';
  let eventData = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line === '') {
          // Empty line = event boundary
          if (eventData) {
            try {
              const parsed = JSON.parse(eventData);
              handler({ id: eventId, type: eventType || 'message', data: parsed });
            } catch {
              handler({ id: eventId, type: eventType || 'message', data: { raw: eventData } });
            }
          }
          eventType = '';
          eventId = '';
          eventData = '';
        } else if (line.startsWith('event: ')) {
          eventType = line.slice(7);
        } else if (line.startsWith('id: ')) {
          eventId = line.slice(4);
        } else if (line.startsWith('data: ')) {
          eventData = line.slice(6);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

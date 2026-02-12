/**
 * Event types and listener following the OJS Events Vocabulary specification.
 */

import type { JobError, JsonValue } from './job.js';

/** All possible OJS event types. */
export type OJSEventType =
  // Core job events
  | 'job.enqueued'
  | 'job.started'
  | 'job.completed'
  | 'job.failed'
  | 'job.discarded'
  // Extended job events
  | 'job.retrying'
  | 'job.cancelled'
  | 'job.heartbeat'
  | 'job.scheduled'
  | 'job.expired'
  | 'job.progress'
  // Queue events
  | 'queue.paused'
  | 'queue.resumed'
  // Worker events
  | 'worker.started'
  | 'worker.stopped'
  | 'worker.quiet'
  | 'worker.heartbeat'
  // Workflow events
  | 'workflow.started'
  | 'workflow.step_completed'
  | 'workflow.completed'
  | 'workflow.failed'
  // Cron events
  | 'cron.triggered'
  | 'cron.skipped';

/** OJS event envelope following the CloudEvents-inspired format. */
export interface OJSEvent<T = Record<string, unknown>> {
  specversion: string;
  id: string;
  type: OJSEventType;
  source: string;
  time: string;
  subject?: string;
  datacontenttype?: string;
  data: T;
}

// ---- Event data type definitions ----

export interface JobEnqueuedData {
  job_type: string;
  queue: string;
  priority?: number;
  scheduled_at?: string;
  unique_key?: string;
  [key: string]: unknown;
}

export interface JobStartedData {
  job_type: string;
  queue: string;
  worker_id: string;
  attempt: number;
  [key: string]: unknown;
}

export interface JobCompletedData {
  job_type: string;
  queue: string;
  duration_ms: number;
  attempt: number;
  result?: JsonValue;
  [key: string]: unknown;
}

export interface JobFailedData {
  job_type: string;
  queue: string;
  attempt: number;
  error: JobError;
  duration_ms?: number;
  [key: string]: unknown;
}

export interface JobRetryingData {
  job_type: string;
  queue: string;
  attempt: number;
  max_attempts: number;
  next_retry_at: string;
  error: JobError;
  [key: string]: unknown;
}

export interface WorkerStartedData {
  worker_id: string;
  queues: string[];
  concurrency: number;
  [key: string]: unknown;
}

export interface WorkerStoppedData {
  worker_id: string;
  reason: string;
  jobs_completed: number;
  uptime_ms: number;
  [key: string]: unknown;
}

/** Event data type map for type-safe event handling. */
export interface OJSEventDataMap {
  'job.enqueued': JobEnqueuedData;
  'job.started': JobStartedData;
  'job.completed': JobCompletedData;
  'job.failed': JobFailedData;
  'job.retrying': JobRetryingData;
  'worker.started': WorkerStartedData;
  'worker.stopped': WorkerStoppedData;
  [key: string]: Record<string, unknown>;
}

/** Event listener callback type. */
export type OJSEventListener<T = Record<string, unknown>> = (
  event: OJSEvent<T>,
) => void | Promise<void>;

/**
 * A simple typed event emitter for OJS events.
 */
export class OJSEventEmitter {
  private listeners = new Map<string, Set<OJSEventListener>>();

  /**
   * Subscribe to an event type.
   * @returns An unsubscribe function.
   */
  on<E extends OJSEventType>(
    eventType: E,
    listener: OJSEventListener<OJSEventDataMap[E]>,
  ): () => void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    const set = this.listeners.get(eventType)!;
    set.add(listener as OJSEventListener);

    return () => {
      set.delete(listener as OJSEventListener);
    };
  }

  /**
   * Subscribe to all events.
   * @returns An unsubscribe function.
   */
  onAny(listener: OJSEventListener): () => void {
    return this.on('*' as OJSEventType, listener);
  }

  /**
   * Emit an event to all matching listeners.
   */
  async emit(event: OJSEvent): Promise<void> {
    const typeListeners = this.listeners.get(event.type);
    const allListeners = this.listeners.get('*');

    const promises: (void | Promise<void>)[] = [];

    if (typeListeners) {
      for (const listener of typeListeners) {
        promises.push(listener(event));
      }
    }
    if (allListeners) {
      for (const listener of allListeners) {
        promises.push(listener(event));
      }
    }

    await Promise.all(promises);
  }

  /** Remove all listeners. */
  removeAllListeners(): void {
    this.listeners.clear();
  }

  /** Create an OJS event with proper envelope. */
  static createEvent<E extends OJSEventType>(
    type: E,
    source: string,
    data: OJSEventDataMap[E],
    subject?: string,
  ): OJSEvent<OJSEventDataMap[E]> {
    return {
      specversion: '1.0',
      id: `evt_${crypto.randomUUID()}`,
      type,
      source,
      time: new Date().toISOString(),
      subject,
      data,
    };
  }
}

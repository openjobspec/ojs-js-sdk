/**
 * Queue operations for interacting with OJS queue endpoints.
 */

import type { Transport } from './transport/types.js';

/** Queue information returned by the server. */
export interface QueueInfo {
  name: string;
  paused?: boolean;
}

/** Queue statistics returned by the server. */
export interface QueueStats {
  name: string;
  available: number;
  active: number;
  scheduled: number;
  retryable: number;
  completed: number;
  discarded: number;
  paused: boolean;
}

/** Dead letter job entry. */
export interface DeadLetterJob {
  id: string;
  type: string;
  queue: string;
  args: unknown[];
  error?: {
    code: string;
    message: string;
  };
  discarded_at?: string;
  total_attempts?: number;
}

/**
 * Queue management operations.
 * These methods interact with the OJS queue and dead letter endpoints.
 */
export class QueueOperations {
  constructor(private readonly transport: Transport) {}

  /** List all queues. */
  async list(): Promise<QueueInfo[]> {
    const response = await this.transport.request<{ queues: QueueInfo[] }>({
      method: 'GET',
      path: '/queues',
    });
    return response.body.queues;
  }

  /** Get queue statistics (Level 4). */
  async stats(queueName: string): Promise<QueueStats> {
    const response = await this.transport.request<QueueStats>({
      method: 'GET',
      path: `/queues/${encodeURIComponent(queueName)}/stats`,
    });
    return response.body;
  }

  /** Pause a queue (Level 4). */
  async pause(queueName: string): Promise<void> {
    await this.transport.request({
      method: 'POST',
      path: `/queues/${encodeURIComponent(queueName)}/pause`,
    });
  }

  /** Resume a paused queue (Level 4). */
  async resume(queueName: string): Promise<void> {
    await this.transport.request({
      method: 'POST',
      path: `/queues/${encodeURIComponent(queueName)}/resume`,
    });
  }

  /** List dead letter jobs (Level 1). */
  async listDeadLetter(): Promise<DeadLetterJob[]> {
    const response = await this.transport.request<{ jobs: DeadLetterJob[] }>({
      method: 'GET',
      path: '/dead-letter',
    });
    return response.body.jobs;
  }

  /** Retry a dead letter job (Level 1). */
  async retryDeadLetter(jobId: string): Promise<void> {
    await this.transport.request({
      method: 'POST',
      path: `/dead-letter/${encodeURIComponent(jobId)}/retry`,
    });
  }

  /** Discard a dead letter job (Level 1). */
  async discardDeadLetter(jobId: string): Promise<void> {
    await this.transport.request({
      method: 'DELETE',
      path: `/dead-letter/${encodeURIComponent(jobId)}`,
    });
  }
}

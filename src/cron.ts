/**
 * Cron job operations for interacting with OJS cron endpoints.
 */

import type { Transport } from './transport/types.js';
import type { JsonValue } from './job.js';

/** Cron job options. */
export interface CronJobOptions {
  queue?: string;
  priority?: number;
  retry?: {
    max_attempts?: number;
    initial_interval?: string;
    backoff_coefficient?: number;
    max_interval?: string;
  };
  tags?: string[];
}

/** Cron job information returned by the server. */
export interface CronJobInfo {
  name: string;
  cron: string;
  timezone?: string;
  type: string;
  args: JsonValue[];
  options?: CronJobOptions;
  status: string;
  last_run_at?: string;
  next_run_at?: string;
  created_at: string;
}

/** Pagination information. */
export interface Pagination {
  total?: number;
  page?: number;
  per_page?: number;
}

/** Options for listing cron jobs. */
export interface CronListOptions {
  page?: number;
  per_page?: number;
}

/** Definition for registering a cron job. */
export interface CronJobDefinition {
  name: string;
  cron: string;
  timezone?: string;
  type: string;
  args: JsonValue | JsonValue[];
  meta?: Record<string, JsonValue>;
  options?: CronJobOptions;
}

/**
 * Cron job management operations.
 * These methods interact with the OJS cron endpoints.
 */
export class CronOperations {
  constructor(private readonly transport: Transport) {}

  /** List all cron jobs. */
  async list(opts?: CronListOptions): Promise<{ cron_jobs: CronJobInfo[]; pagination: Pagination }> {
    const params = new URLSearchParams();
    if (opts?.page !== undefined) params.set('page', String(opts.page));
    if (opts?.per_page !== undefined) params.set('per_page', String(opts.per_page));

    const query = params.toString();
    const path = `/cron${query ? `?${query}` : ''}`;

    const response = await this.transport.request<{ cron_jobs: CronJobInfo[]; pagination: Pagination }>({
      method: 'GET',
      path,
    });
    return response.body;
  }

  /** Register a new cron job. */
  async register(definition: CronJobDefinition): Promise<CronJobInfo> {
    const body: Record<string, unknown> = {
      name: definition.name,
      cron: definition.cron,
      type: definition.type,
      args: Array.isArray(definition.args) ? definition.args : [definition.args],
    };
    if (definition.timezone !== undefined) body.timezone = definition.timezone;
    if (definition.meta !== undefined) body.meta = definition.meta;
    if (definition.options !== undefined) body.options = definition.options;

    const response = await this.transport.request<{ cron_job: CronJobInfo }>({
      method: 'POST',
      path: '/cron',
      body,
    });
    return response.body.cron_job;
  }

  /** Unregister a cron job by name. */
  async unregister(name: string): Promise<void> {
    await this.transport.request({
      method: 'DELETE',
      path: `/cron/${encodeURIComponent(name)}`,
    });
  }
}

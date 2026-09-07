/**
 * Cron job operations for interacting with OJS cron endpoints.
 */

import type { Transport } from './transport/types.js';
import type { JsonValue } from './job.js';
import { OJSValidationError } from './errors.js';

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
  meta?: Record<string, JsonValue>;
  options?: CronJobOptions;
  /**
   * Current schedule status. HTTP responses provide this field; the current
   * gRPC proto omits it, but the SDK reports `active` where registration/list
   * semantics make that state certain.
   */
  status?: string;
  last_run_at?: string;
  next_run_at?: string;
  /**
   * Server-authoritative creation time when provided by the transport.
   * Current gRPC CronEntry/RegisterCronResponse messages omit this field;
   * registration returns the locally captured request time, while list omits it.
   */
  created_at?: string;
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
    assertNoDeferredExpiresAt(definition);

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

function assertNoDeferredExpiresAt(definition: CronJobDefinition): void {
  const rawDefinition = definition as unknown as Record<string, unknown>;
  const rawOptions =
    typeof rawDefinition.options === 'object' &&
    rawDefinition.options !== null &&
    !Array.isArray(rawDefinition.options)
      ? (rawDefinition.options as Record<string, unknown>)
      : undefined;
  if (
    rawDefinition.expires_at !== undefined ||
    rawDefinition.expiresAt !== undefined ||
    rawOptions?.expires_at !== undefined ||
    rawOptions?.expiresAt !== undefined
  ) {
    throw new OJSValidationError(
      'Cron registration does not support expires_at/expiresAt: a cron job is materialized later, so converting an absolute deadline to a relative TTL now would shift the requested expiration.',
    );
  }
}

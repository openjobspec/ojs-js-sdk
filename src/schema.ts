/**
 * Schema operations for interacting with OJS schema endpoints.
 */

import type { Transport } from './transport/types.js';
import type { JsonValue } from './job.js';

/** Schema information returned by the server. */
export interface SchemaInfo {
  uri: string;
  type: string;
  version: string;
  schema: Record<string, JsonValue>;
  created_at?: string;
  updated_at?: string;
}

/** Pagination information. */
export interface Pagination {
  total?: number;
  page?: number;
  per_page?: number;
}

/** Options for listing schemas. */
export interface SchemaListOptions {
  page?: number;
  per_page?: number;
}

/** Definition for registering a schema. */
export interface SchemaDefinition {
  uri: string;
  type: string;
  version: string;
  schema: Record<string, JsonValue>;
}

/**
 * Schema management operations.
 * These methods interact with the OJS schema endpoints.
 */
export class SchemaOperations {
  constructor(private readonly transport: Transport) {}

  /** List all schemas. */
  async list(opts?: SchemaListOptions): Promise<{ schemas: SchemaInfo[]; pagination: Pagination }> {
    const params = new URLSearchParams();
    if (opts?.page !== undefined) params.set('page', String(opts.page));
    if (opts?.per_page !== undefined) params.set('per_page', String(opts.per_page));

    const query = params.toString();
    const path = `/schemas${query ? `?${query}` : ''}`;

    const response = await this.transport.request<{ schemas: SchemaInfo[]; pagination: Pagination }>({
      method: 'GET',
      path,
    });
    return response.body;
  }

  /** Register a new schema. */
  async register(definition: SchemaDefinition): Promise<SchemaInfo> {
    const response = await this.transport.request<{ schema: SchemaInfo }>({
      method: 'POST',
      path: '/schemas',
      body: definition,
    });
    return response.body.schema;
  }

  /** Get a schema by URI. */
  async get(uri: string): Promise<SchemaInfo> {
    const response = await this.transport.request<{ schema: SchemaInfo }>({
      method: 'GET',
      path: `/schemas/${encodeURIComponent(uri)}`,
    });
    return response.body.schema;
  }

  /** Delete a schema by URI. */
  async delete(uri: string): Promise<void> {
    await this.transport.request({
      method: 'DELETE',
      path: `/schemas/${encodeURIComponent(uri)}`,
    });
  }
}

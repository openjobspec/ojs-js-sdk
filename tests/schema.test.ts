import { describe, it, expect, beforeEach } from 'vitest';
import { SchemaOperations } from '../src/schema.js';
import type { Transport, TransportRequestOptions, TransportResponse } from '../src/transport/types.js';

function createMockTransport() {
  const requests: TransportRequestOptions[] = [];
  const responses = new Map<string, TransportResponse>();

  const transport: Transport = {
    async request<T>(options: TransportRequestOptions): Promise<TransportResponse<T>> {
      requests.push(options);
      const key = `${options.method} ${options.path}`;
      const response = responses.get(key);
      if (response) return response as TransportResponse<T>;
      return { status: 200, headers: {}, body: {} as T };
    },
  };

  return {
    transport,
    requests,
    mockResponse(method: string, path: string, body: unknown, status = 200) {
      responses.set(`${method} ${path}`, { status, headers: {}, body });
    },
  };
}

describe('SchemaOperations', () => {
  let mock: ReturnType<typeof createMockTransport>;
  let schemas: SchemaOperations;

  beforeEach(() => {
    mock = createMockTransport();
    schemas = new SchemaOperations(mock.transport);
  });

  describe('list()', () => {
    it('returns all schemas', async () => {
      const responseBody = {
        schemas: [
          {
            uri: 'urn:ojs:schema:email.send:1',
            type: 'email.send',
            version: '1',
            schema: { type: 'object', properties: { to: { type: 'string' } } },
            created_at: '2024-01-01T00:00:00Z',
          },
        ],
        pagination: { total: 1, page: 1, per_page: 25 },
      };
      mock.mockResponse('GET', '/schemas', responseBody);

      const result = await schemas.list();
      expect(result.schemas).toHaveLength(1);
      expect(result.schemas[0].uri).toBe('urn:ojs:schema:email.send:1');
      expect(result.pagination.total).toBe(1);
      expect(mock.requests[0].method).toBe('GET');
      expect(mock.requests[0].path).toBe('/schemas');
    });

    it('passes pagination parameters', async () => {
      mock.mockResponse('GET', '/schemas?page=2&per_page=10', {
        schemas: [],
        pagination: { total: 0, page: 2, per_page: 10 },
      });

      await schemas.list({ page: 2, per_page: 10 });
      expect(mock.requests[0].path).toBe('/schemas?page=2&per_page=10');
    });
  });

  describe('register()', () => {
    it('registers a new schema', async () => {
      const schemaInfo = {
        uri: 'urn:ojs:schema:email.send:1',
        type: 'email.send',
        version: '1',
        schema: { type: 'object', properties: { to: { type: 'string' } } },
        created_at: '2024-01-01T00:00:00Z',
      };
      mock.mockResponse('POST', '/schemas', { schema: schemaInfo }, 201);

      const result = await schemas.register({
        uri: 'urn:ojs:schema:email.send:1',
        type: 'email.send',
        version: '1',
        schema: { type: 'object', properties: { to: { type: 'string' } } },
      });

      expect(result.uri).toBe('urn:ojs:schema:email.send:1');
      expect(mock.requests[0].method).toBe('POST');
      expect(mock.requests[0].path).toBe('/schemas');

      const body = mock.requests[0].body as Record<string, unknown>;
      expect(body.uri).toBe('urn:ojs:schema:email.send:1');
      expect(body.type).toBe('email.send');
      expect(body.version).toBe('1');
      expect(body.schema).toEqual({ type: 'object', properties: { to: { type: 'string' } } });
    });
  });

  describe('get()', () => {
    it('fetches a schema by URI', async () => {
      const uri = 'urn:ojs:schema:email.send:1';
      const schemaInfo = {
        uri,
        type: 'email.send',
        version: '1',
        schema: { type: 'object' },
        created_at: '2024-01-01T00:00:00Z',
      };
      mock.mockResponse('GET', `/schemas/${encodeURIComponent(uri)}`, { schema: schemaInfo });

      const result = await schemas.get(uri);
      expect(result.uri).toBe(uri);
      expect(mock.requests[0].method).toBe('GET');
      expect(mock.requests[0].path).toBe(`/schemas/${encodeURIComponent(uri)}`);
    });

    it('encodes URI in URL', async () => {
      const uri = 'https://example.com/schemas/email.send/v1';
      mock.mockResponse('GET', `/schemas/${encodeURIComponent(uri)}`, {
        schema: { uri, type: 'email.send', version: '1', schema: {} },
      });

      await schemas.get(uri);
      expect(mock.requests[0].path).toBe(`/schemas/${encodeURIComponent(uri)}`);
    });
  });

  describe('delete()', () => {
    it('sends DELETE to schema endpoint', async () => {
      const uri = 'urn:ojs:schema:email.send:1';
      await schemas.delete(uri);
      expect(mock.requests[0].method).toBe('DELETE');
      expect(mock.requests[0].path).toBe(`/schemas/${encodeURIComponent(uri)}`);
    });

    it('encodes URI in URL', async () => {
      const uri = 'https://example.com/schemas/test';
      await schemas.delete(uri);
      expect(mock.requests[0].path).toBe(`/schemas/${encodeURIComponent(uri)}`);
    });
  });
});

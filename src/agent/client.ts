import type {
  ForkOptions, ForkResult,
  MergeOptions, MergeResult,
  ResumeDecision,
  ReplayOptions, ReplayResult,
} from './types.js';

export interface AgentClientConfig {
  baseUrl: string;
  headers?: Record<string, string>;
}

export class AgentClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(config: AgentClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.headers = {
      'Content-Type': 'application/json',
      ...config.headers,
    };
  }

  async fork(jobId: string, options: ForkOptions): Promise<ForkResult> {
    return this.request<ForkResult>('POST', `/v1/agent/jobs/${jobId}/fork`, {
      at_turn: options.atTurn,
      branch_name: options.branchName,
    });
  }

  async merge(jobId: string, options: MergeOptions): Promise<MergeResult> {
    return this.request<MergeResult>('POST', `/v1/agent/jobs/${jobId}/merge`, {
      branch_a: options.branchA,
      branch_b: options.branchB,
      strategy: options.strategy,
    });
  }

  async pause(jobId: string, reason: string): Promise<void> {
    await this.request<void>('POST', `/v1/agent/jobs/${jobId}/pause`, { reason });
  }

  async resume(jobId: string, decision: ResumeDecision): Promise<void> {
    await this.request<void>('POST', `/v1/agent/jobs/${jobId}/resume`, decision);
  }

  async replay(jobId: string, options: ReplayOptions): Promise<ReplayResult> {
    return this.request<ReplayResult>('POST', `/v1/agent/jobs/${jobId}/replay`, {
      from_turn: options.fromTurn,
      mock_providers: options.mockProviders,
    });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method,
      headers: this.headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new AgentError(
        `Agent API error: ${response.status} ${response.statusText}`,
        response.status,
        text,
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const data = await response.json();
    // Convert snake_case response to camelCase
    return this.toCamelCase(data) as T;
  }

  private toCamelCase(obj: unknown): unknown {
    if (obj === null || obj === undefined || typeof obj !== 'object') {
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => this.toCamelCase(item));
    }
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const camelKey = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
      result[camelKey] = this.toCamelCase(value);
    }
    return result;
  }
}

export class AgentError extends Error {
  readonly statusCode: number;
  readonly responseBody: string;

  constructor(message: string, statusCode: number, responseBody: string) {
    super(message);
    this.name = 'AgentError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

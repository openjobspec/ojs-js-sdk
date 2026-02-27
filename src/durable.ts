/**
 * Durable Execution support for the OJS TypeScript SDK.
 *
 * Provides deterministic wrappers around non-deterministic operations
 * (time, randomness, external calls). On first execution, operations are
 * recorded. On retry after a crash, recorded values are replayed from the
 * checkpoint instead of re-executing.
 *
 * @example
 * ```ts
 * import { OJSWorker, DurableContext } from '@openjobspec/sdk';
 *
 * const worker = new OJSWorker({ url: 'http://localhost:8080' });
 *
 * worker.registerDurable('etl.process', async (ctx, dc) => {
 *   // Side effects are recorded for replay
 *   const data = await dc.sideEffect('fetch-data', async () => {
 *     return await fetch('https://api.example.com/data').then(r => r.json());
 *   });
 *   await dc.checkpoint(1, { fetched: true });
 *
 *   // Deterministic time
 *   const now = dc.now();
 *
 *   // Deterministic random
 *   const id = dc.random(16);
 *
 *   await dc.complete();
 * });
 * ```
 */

import type { Transport } from './transport/types.js';
import type { JobContext } from './middleware.js';

const BASE_PATH = '/ojs/v1';

/** Side effect entry recorded in the replay log. */
interface SideEffectEntry {
  seq: number;
  type: 'time' | 'random' | 'call';
  key?: string;
  result: unknown;
}

/** Resume info returned by the checkpoint API. */
interface ResumeInfo {
  has_checkpoint: boolean;
  checkpoint?: {
    metadata?: Record<string, string>;
  };
}

/**
 * DurableContext provides deterministic execution support within a job handler.
 *
 * Non-deterministic operations (time, randomness, external calls) are recorded
 * on first execution and replayed from the checkpoint on retry.
 */
export class DurableContext {
  private entries: SideEffectEntry[] = [];
  private cursor = 0;
  private replaying = false;

  private constructor(
    private readonly transport: Transport,
    private readonly jobId: string,
    private readonly attempt: number,
  ) {}

  /**
   * Create a DurableContext, loading any existing checkpoint from the server.
   */
  static async create(
    transport: Transport,
    jobId: string,
    attempt: number,
  ): Promise<DurableContext> {
    const dc = new DurableContext(transport, jobId, attempt);

    try {
      const resp = await transport.request<ResumeInfo>({
        method: 'GET',
        path: `${BASE_PATH}/checkpoints/${jobId}/resume`,
      });

      if (resp.body?.has_checkpoint && resp.body.checkpoint?.metadata?.['_replay_log']) {
        const entries = JSON.parse(resp.body.checkpoint.metadata['_replay_log']);
        if (Array.isArray(entries) && entries.length > 0) {
          dc.entries = entries;
          dc.replaying = true;
        }
      }
    } catch {
      // No checkpoint available — start in record mode
    }

    return dc;
  }

  /**
   * Returns the current time deterministically.
   * On first execution, records `Date.now()`. On replay, returns the recorded value.
   */
  now(): Date {
    if (this.replaying && this.cursor < this.entries.length) {
      const entry = this.entries[this.cursor]!;
      if (entry.type === 'time') {
        this.cursor++;
        this.checkReplayDone();
        return new Date(entry.result as string);
      }
    }

    const t = new Date();
    this.entries.push({ seq: this.entries.length, type: 'time', key: 'now', result: t.toISOString() });
    this.replaying = false;
    return t;
  }

  /**
   * Returns a deterministic random hex string.
   * @param bytes Number of random bytes (output will be 2x this in hex chars).
   */
  random(bytes: number): string {
    if (this.replaying && this.cursor < this.entries.length) {
      const entry = this.entries[this.cursor]!;
      if (entry.type === 'random') {
        this.cursor++;
        this.checkReplayDone();
        return entry.result as string;
      }
    }

    const arr = new Uint8Array(bytes);
    crypto.getRandomValues(arr);
    const hex = Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
    this.entries.push({ seq: this.entries.length, type: 'random', result: hex });
    this.replaying = false;
    return hex;
  }

  /**
   * Executes a function deterministically. On first execution, `fn` is called
   * and the result recorded. On replay, the recorded result is returned
   * without calling `fn`.
   *
   * @param key A unique key identifying this side effect.
   * @param fn The function to execute (must return a JSON-serializable value).
   * @returns The result of fn (or the replayed result).
   *
   * @example
   * ```ts
   * const price = await dc.sideEffect('fetch-price', async () => {
   *   const resp = await fetch('https://api.example.com/price');
   *   return resp.json();
   * });
   * ```
   */
  async sideEffect<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.replaying && this.cursor < this.entries.length) {
      const entry = this.entries[this.cursor]!;
      if (entry.type === 'call' && (!key || entry.key === key)) {
        this.cursor++;
        this.checkReplayDone();
        return entry.result as T;
      }
    }

    this.replaying = false;
    const result = await fn();
    this.entries.push({ seq: this.entries.length, type: 'call', key, result });
    return result;
  }

  /**
   * Saves the current execution state to the server as a checkpoint.
   * Call this after completing an important step to enable resume.
   *
   * @param stepIndex The step number (for ordering).
   * @param state Arbitrary state to save (must be JSON-serializable).
   */
  async checkpoint(stepIndex: number, state: unknown): Promise<void> {
    const replayLog = JSON.stringify(this.entries);

    await this.transport.request({
      method: 'POST',
      path: `${BASE_PATH}/checkpoints/${this.jobId}`,
      body: {
        state,
        step_index: stepIndex,
        metadata: {
          _replay_log: replayLog,
          attempt: String(this.attempt),
        },
      },
    });
  }

  /**
   * Clears the checkpoint after successful job completion.
   * Call this at the end of a successful durable handler.
   */
  async complete(): Promise<void> {
    await this.transport.request({
      method: 'DELETE',
      path: `${BASE_PATH}/checkpoints/${this.jobId}`,
    });
  }

  /** Returns true if the context is currently replaying from a checkpoint. */
  isReplaying(): boolean {
    return this.replaying && this.cursor < this.entries.length;
  }

  private checkReplayDone(): void {
    if (this.cursor >= this.entries.length) {
      this.replaying = false;
    }
  }
}

/** A durable job handler that receives a DurableContext. */
export type DurableJobHandler = (ctx: JobContext, dc: DurableContext) => Promise<unknown>;

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
import {
  OJSNotFoundError,
  OJSMethodNotAllowedError,
  OJSCheckpointLoadError,
  ReplayIntegrityError,
} from './errors.js';
import { getRandomBytes } from './crypto.js';

/** Side effect entry recorded in the replay log. */
interface SideEffectEntry {
  seq: number;
  type: 'time' | 'random' | 'call';
  key?: string;
  result: unknown;
}

/**
 * The OJS durable-execution checkpoint `state` field is an opaque JSON value
 * from the server/spec's point of view (see ojs-durable-execution.md section
 * 4 and the ojs-json-schema `checkpoint.schema.json` request/response
 * definitions, whose request/response objects only ever contain
 * `state`/`sequence`/`job_id`/`created_at` — there is no separate metadata
 * slot). DurableContext's replay log therefore travels *inside* the opaque
 * `state` value alongside the caller's own state, rather than in a sibling
 * field that the wire format has no room for.
 */
interface CheckpointWireState {
  /** SDK-internal replay log for deterministic replay of now()/random()/sideEffect(). */
  _ojsReplayLog: SideEffectEntry[];
  /** The step index passed to checkpoint(), preserved for debugging/forward use. */
  _ojsStepIndex: number;
  /** The attempt that wrote this checkpoint. */
  _ojsAttempt: number;
  /** The caller-supplied state value, verbatim. */
  value: unknown;
}

/** HTTP checkpoint record returned directly as the response body. */
interface CheckpointRecord {
  job_id: string;
  state: unknown;
  sequence: number;
  created_at: string | null;
}

interface LegacyCheckpointResponse {
  has_checkpoint: boolean;
  checkpoint?: {
    step_index?: number;
    state?: unknown;
    metadata?: Record<string, string>;
  };
}

/**
 * Checkpoint transports expose either the HTTP binding's flat record or the
 * canonical resource wrapper used by the gRPC transport.
 */
type CheckpointResponse =
  | CheckpointRecord
  | { checkpoint: CheckpointRecord };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkpointState(response: unknown): unknown {
  if (!isRecord(response)) {
    throw new Error('Invalid checkpoint response: expected an object');
  }

  if ('checkpoint' in response) {
    if (
      !isRecord(response.checkpoint) ||
      !Object.prototype.hasOwnProperty.call(response.checkpoint, 'state')
    ) {
      throw new Error('Invalid checkpoint response: missing checkpoint state');
    }
    return response.checkpoint.state;
  }

  if (!Object.prototype.hasOwnProperty.call(response, 'state')) {
    throw new Error('Invalid checkpoint response: missing state');
  }
  return response.state;
}

function replayEntriesFromState(value: unknown, source: string): SideEffectEntry[] {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${source} state: expected an SDK replay-log wrapper object`);
  }
  if (!Object.prototype.hasOwnProperty.call(value, '_ojsReplayLog')) {
    throw new Error(`Invalid ${source} state: missing _ojsReplayLog wrapper`);
  }
  if (!Array.isArray(value._ojsReplayLog)) {
    throw new Error(`Invalid ${source} replay log: expected an array`);
  }

  for (const [index, entry] of value._ojsReplayLog.entries()) {
    // `time`/`random` entries still require a `result` (a `time` result must
    // be a parseable ISO string; a `random` result a hex string), enforced by
    // their type-specific `typeof entry.result !== 'string'` checks below.
    //
    // A `call` entry, however, records the raw return value of a `sideEffect`
    // callback, which is legitimately allowed to be `undefined`. Because
    // `JSON.stringify` drops object properties whose value is `undefined`, a
    // `sideEffect` that resolved to `undefined` serializes to an entry with no
    // `result` key at all. The loader therefore accepts a missing `result` for
    // `call` entries (both the legacy and current on-wire shapes) and lets the
    // replay path interpret the absent key as `undefined`, rather than
    // rejecting an otherwise-valid, JSON-round-tripped checkpoint.
    if (
      !isRecord(entry) ||
      entry.seq !== index ||
      (entry.type !== 'time' && entry.type !== 'random' && entry.type !== 'call') ||
      (entry.key !== undefined && typeof entry.key !== 'string') ||
      (entry.type === 'time' &&
        (entry.key !== 'now' ||
          typeof entry.result !== 'string' ||
          !Number.isFinite(Date.parse(entry.result)))) ||
      (entry.type === 'random' &&
        (entry.key !== undefined || typeof entry.result !== 'string')) ||
      (entry.type === 'call' && typeof entry.key !== 'string')
    ) {
      throw new Error(`Invalid ${source} replay log entry at index ${index}`);
    }
  }

  return value._ojsReplayLog as SideEffectEntry[];
}

function canonicalReplayEntries(value: unknown): SideEffectEntry[] {
  const entries = replayEntriesFromState(value, 'checkpoint');
  const state = value as Record<string, unknown>;

  if (
    !Object.prototype.hasOwnProperty.call(state, '_ojsStepIndex') ||
    !Number.isSafeInteger(state._ojsStepIndex) ||
    (state._ojsStepIndex as number) < 0
  ) {
    throw new Error('Invalid checkpoint state: _ojsStepIndex must be a non-negative safe integer');
  }
  if (
    !Object.prototype.hasOwnProperty.call(state, '_ojsAttempt') ||
    !Number.isSafeInteger(state._ojsAttempt) ||
    (state._ojsAttempt as number) < 1
  ) {
    throw new Error('Invalid checkpoint state: _ojsAttempt must be a positive safe integer');
  }
  if (!Object.prototype.hasOwnProperty.call(state, 'value')) {
    throw new Error('Invalid checkpoint state: missing value');
  }

  return entries;
}

function legacyCheckpoint(
  response: unknown,
): { entries: SideEffectEntry[]; stepIndex: number; state: unknown } | undefined {
  if (!isRecord(response) || typeof response.has_checkpoint !== 'boolean') {
    throw new Error('Invalid legacy checkpoint response: missing has_checkpoint');
  }
  if (!response.has_checkpoint) {
    return undefined;
  }
  if (!isRecord(response.checkpoint)) {
    throw new Error('Invalid legacy checkpoint response: missing checkpoint data');
  }

  const metadata = response.checkpoint.metadata;
  if (metadata === undefined || !isRecord(metadata) || !('_replay_log' in metadata)) {
    throw new Error(
      'Invalid legacy checkpoint response: has_checkpoint is true but metadata._replay_log is missing',
    );
  }
  if (typeof metadata._replay_log !== 'string') {
    throw new Error('Invalid legacy checkpoint replay log: expected a JSON string');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(metadata._replay_log);
  } catch (error) {
    throw new Error('Failed to decode legacy checkpoint replay log', {
      cause: error,
    });
  }

  const entries = replayEntriesFromState({ _ojsReplayLog: decoded }, 'legacy checkpoint');
  return {
    entries,
    stepIndex: typeof response.checkpoint.step_index === 'number'
      ? response.checkpoint.step_index
      : 0,
    state: response.checkpoint.state ?? null,
  };
}

function legacyCheckpointUnavailable(error: unknown): boolean {
  if (
    error instanceof OJSNotFoundError ||
    error instanceof OJSMethodNotAllowedError
  ) {
    return true;
  }
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as Error & { code?: unknown }).code === 'string' &&
    (error as Error & { code: string }).code.toLowerCase() === 'method_not_allowed'
  ) {
    return true;
  }
  if (error instanceof Error && 'statusCode' in error) {
    return (error as Error & { statusCode?: unknown }).statusCode === 405;
  }
  return false;
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
  private migrationFailure: Error | undefined;

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
    const encodedJobId = encodeURIComponent(jobId);

    try {
      // Per the HTTP binding (ojs-durable-execution.md section 7), the
      // checkpoint resource lives at /jobs/{id}/checkpoint (relative — the
      // transport already prefixes /ojs/v1). The server returns 404 when no
      // checkpoint exists yet ("no checkpoint has ever been saved for this
      // job"), which is the *only* condition under which starting fresh in
      // record mode is safe.
      const resp = await transport.request<CheckpointResponse>({
        method: 'GET',
        path: `/jobs/${encodedJobId}/checkpoint`,
      });

      const entries = canonicalReplayEntries(checkpointState(resp.body));
      dc.entries = entries;
      dc.replaying = entries.length > 0;
    } catch (err) {
      // A 404 (no checkpoint yet) is the expected, common case on a job's
      // first attempt and is silently treated as "start in record mode".
      //
      // Any *other* failure — network/connection error, auth/authorization
      // failure, a malformed/undecodable response, or a server (5xx) error —
      // means the SDK genuinely does not know whether a checkpoint exists.
      // Silently falling back to record mode here would be unsafe: if a
      // checkpoint actually *does* exist (the lookup merely failed
      // transiently), starting fresh would re-execute already-recorded
      // side effects, breaking durable execution's core exactly-once
      // guarantee. So only OJSNotFoundError is treated as "first
      // execution"; everything else is propagated (wrapped with job/attempt
      // context, preserving the original error as `.cause`) so the caller —
      // typically `OJSWorker.registerDurable` — never invokes the user
      // handler and the job is nacked for retry instead of silently
      // corrupting replay state.
      if (!(err instanceof OJSNotFoundError)) {
        throw new OJSCheckpointLoadError(jobId, attempt, err);
      }
      if (transport.supportsLegacyCheckpointResume !== true) {
        return dc;
      }

      try {
        const legacyResponse = await transport.request<LegacyCheckpointResponse>({
          method: 'GET',
          path: `/checkpoints/${encodedJobId}/resume`,
        });
        const legacy = legacyCheckpoint(legacyResponse.body);
        if (!legacy) {
          return dc;
        }

        dc.entries = legacy.entries;
        dc.replaying = legacy.entries.length > 0;

        // The replay log is already safe to use. Rewriting it to the canonical
        // resource is best-effort and must not block this attempt.
        try {
          await dc.checkpoint(legacy.stepIndex, legacy.state);
        } catch (migrationError) {
          dc.migrationFailure = migrationError instanceof Error
            ? migrationError
            : new Error(String(migrationError));
        }
      } catch (legacyError) {
        if (legacyCheckpointUnavailable(legacyError)) {
          return dc;
        }
        throw new OJSCheckpointLoadError(jobId, attempt, legacyError, 'legacy');
      }
    }

    return dc;
  }

  /**
   * Returns the current time deterministically.
   * On first execution, records `Date.now()`. On replay, returns the recorded value.
   */
  now(): Date {
    const replayEntry = this.nextReplayEntry('time', 'now');
    if (replayEntry) {
      this.cursor++;
      this.checkReplayDone();
      return new Date(replayEntry.result as string);
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
    const replayEntry = this.nextReplayEntry('random');
    if (replayEntry) {
      this.cursor++;
      this.checkReplayDone();
      return replayEntry.result as string;
    }

    const arr = getRandomBytes(bytes);
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
    const replayEntry = this.nextReplayEntry('call', key);
    if (replayEntry) {
      this.cursor++;
      this.checkReplayDone();
      return replayEntry.result as T;
    }

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
    const wireState: CheckpointWireState = {
      _ojsReplayLog: this.entries,
      _ojsStepIndex: stepIndex,
      _ojsAttempt: this.attempt,
      value: state,
    };

    // Per the HTTP binding, the request body accepts only `state` (and an
    // optional `sequence`, which we omit and let the server track).
    await this.transport.request({
      method: 'POST',
      path: `/jobs/${encodeURIComponent(this.jobId)}/checkpoint`,
      body: { state: wireState },
    });
  }

  /**
   * Clears the checkpoint after successful job completion.
   * Call this at the end of a successful durable handler.
   */
  async complete(): Promise<void> {
    await this.transport.request({
      method: 'DELETE',
      path: `/jobs/${encodeURIComponent(this.jobId)}/checkpoint`,
    });
  }

  /** Returns true if the context is currently replaying from a checkpoint. */
  isReplaying(): boolean {
    return this.replaying && this.cursor < this.entries.length;
  }

  /** Returns a best-effort legacy migration failure, if one occurred. */
  migrationError(): Error | undefined {
    return this.migrationFailure;
  }

  private nextReplayEntry(
    expectedType: SideEffectEntry['type'],
    expectedKey?: string,
  ): SideEffectEntry | undefined {
    if (!this.replaying) {
      return undefined;
    }

    const entry = this.entries[this.cursor];
    if (!entry) {
      this.replaying = false;
      return undefined;
    }
    if (entry.type !== expectedType || expectedKey !== undefined && entry.key !== expectedKey) {
      throw new ReplayIntegrityError(
        this.jobId,
        this.attempt,
        this.cursor,
        expectedType,
        entry.type,
        expectedKey,
        entry.key,
      );
    }
    return entry;
  }

  private checkReplayDone(): void {
    if (this.cursor >= this.entries.length) {
      this.replaying = false;
    }
  }
}

/** A durable job handler that receives a DurableContext. */
export type DurableJobHandler = (ctx: JobContext, dc: DurableContext) => Promise<unknown>;

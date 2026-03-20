/**
 * OJS JS SDK Recorder — captures execution traces for job handlers.
 * Traces can be exported to the OJS Replay Studio.
 */

import type { SourceMap, TraceEntry } from "./types";

export type { SourceMap, TraceEntry } from "./types";

/**
 * Recorder captures execution traces for a single job handler invocation.
 *
 * @example
 * ```ts
 * const recorder = new Recorder();
 * const start = Date.now();
 * const result = await handler(args);
 * recorder.recordCall("handler", args, result, Date.now() - start);
 * recorder.attachSourceMap("abc123", "src/handler.ts", 42);
 * console.log(recorder.trace());
 * ```
 */
export class Recorder {
  private entries: TraceEntry[] = [];

  /** Record a successful function call. */
  recordCall(
    funcName: string,
    args: unknown,
    result: unknown,
    durationMs: number,
  ): void {
    this.entries.push({
      funcName,
      args: JSON.stringify(args),
      result: JSON.stringify(result),
      durationMs,
      timestamp: new Date().toISOString(),
    });
  }

  /** Record a failed function call. */
  recordError(
    funcName: string,
    args: unknown,
    error: Error | string,
    durationMs: number,
  ): void {
    this.entries.push({
      funcName,
      args: JSON.stringify(args),
      result: "",
      durationMs,
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
  }

  /** Attach source location to the most recent trace entry. */
  attachSourceMap(
    gitSHA: string,
    filePath: string,
    line: number,
    column?: number,
  ): void {
    if (this.entries.length === 0) return;
    const sm: SourceMap = { gitSHA, filePath, line };
    if (column !== undefined) sm.column = column;
    this.entries[this.entries.length - 1].sourceMap = sm;
  }

  /** Return a copy of all recorded trace entries. */
  trace(): TraceEntry[] {
    return [...this.entries];
  }

  /** Number of recorded entries. */
  get length(): number {
    return this.entries.length;
  }

  /** Clear all recorded entries. */
  reset(): void {
    this.entries = [];
  }

  /** Export the trace as a JSON string. */
  toJSON(): string {
    return JSON.stringify(this.entries);
  }
}

/**
 * Types for the OJS JS SDK execution recorder.
 */

/** Source code location for a trace entry. */
export interface SourceMap {
  gitSHA: string;
  filePath: string;
  line: number;
  column?: number;
}

/** A single recorded function call. */
export interface TraceEntry {
  funcName: string;
  args: string;
  result: string;
  durationMs: number;
  sourceMap?: SourceMap;
  timestamp: string;
  error?: string;
}

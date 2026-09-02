import { describe, it, expect } from 'vitest';
import { Recorder } from '../src/recorder/index.js';
import type { SourceMap, TraceEntry } from '../src/recorder/types.js';

describe('Recorder', () => {
  it('starts empty', () => {
    const recorder = new Recorder();
    expect(recorder.length).toBe(0);
    expect(recorder.trace()).toEqual([]);
  });

  it('records a successful call with JSON-serialized args/result', () => {
    const recorder = new Recorder();
    recorder.recordCall('handler', { to: 'a@b.com' }, { ok: true }, 12.5);

    expect(recorder.length).toBe(1);
    const [entry] = recorder.trace();
    expect(entry).toMatchObject({
      funcName: 'handler',
      args: JSON.stringify({ to: 'a@b.com' }),
      result: JSON.stringify({ ok: true }),
      durationMs: 12.5,
    });
    expect(entry!.error).toBeUndefined();
    expect(typeof entry!.timestamp).toBe('string');
    expect(() => new Date(entry!.timestamp)).not.toThrow();
    expect(new Date(entry!.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('records multiple calls in order', () => {
    const recorder = new Recorder();
    recorder.recordCall('a', [], 1, 1);
    recorder.recordCall('b', [], 2, 2);
    recorder.recordCall('c', [], 3, 3);

    expect(recorder.length).toBe(3);
    expect(recorder.trace().map((e) => e.funcName)).toEqual(['a', 'b', 'c']);
  });

  it('records a failed call with an Error, capturing only its message', () => {
    const recorder = new Recorder();
    recorder.recordError('handler', { id: 1 }, new Error('boom'), 5);

    const [entry] = recorder.trace();
    expect(entry!.error).toBe('boom');
    expect(entry!.result).toBe('');
    expect(entry!.args).toBe(JSON.stringify({ id: 1 }));
  });

  it('records a failed call with a plain string error', () => {
    const recorder = new Recorder();
    recorder.recordError('handler', [], 'plain failure', 3);

    const [entry] = recorder.trace();
    expect(entry!.error).toBe('plain failure');
  });

  it('attaches a source map to the most recently recorded entry', () => {
    const recorder = new Recorder();
    recorder.recordCall('a', [], 1, 1);
    recorder.recordCall('b', [], 2, 2);
    recorder.attachSourceMap('abc123', 'src/handler.ts', 42, 7);

    const entries = recorder.trace();
    expect(entries[0]!.sourceMap).toBeUndefined();
    const expected: SourceMap = { gitSHA: 'abc123', filePath: 'src/handler.ts', line: 42, column: 7 };
    expect(entries[1]!.sourceMap).toEqual(expected);
  });

  it('omits the column when not provided', () => {
    const recorder = new Recorder();
    recorder.recordCall('a', [], 1, 1);
    recorder.attachSourceMap('abc123', 'src/handler.ts', 42);

    expect(recorder.trace()[0]!.sourceMap).toEqual({
      gitSHA: 'abc123',
      filePath: 'src/handler.ts',
      line: 42,
    });
    expect('column' in recorder.trace()[0]!.sourceMap!).toBe(false);
  });

  it('is a no-op when attaching a source map with no recorded entries', () => {
    const recorder = new Recorder();
    expect(() => recorder.attachSourceMap('abc123', 'src/handler.ts', 1)).not.toThrow();
    expect(recorder.length).toBe(0);
  });

  it('trace() returns a defensive copy, not a live reference', () => {
    const recorder = new Recorder();
    recorder.recordCall('a', [], 1, 1);

    const snapshot = recorder.trace();
    recorder.recordCall('b', [], 2, 2);

    expect(snapshot).toHaveLength(1);
    expect(recorder.trace()).toHaveLength(2);
  });

  it('reset() clears all recorded entries', () => {
    const recorder = new Recorder();
    recorder.recordCall('a', [], 1, 1);
    recorder.recordCall('b', [], 2, 2);
    recorder.reset();

    expect(recorder.length).toBe(0);
    expect(recorder.trace()).toEqual([]);
  });

  it('toJSON() serializes the full trace as a JSON string', () => {
    const recorder = new Recorder();
    recorder.recordCall('a', [1, 2], 'result', 9.1);

    const parsed = JSON.parse(recorder.toJSON()) as TraceEntry[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.funcName).toBe('a');
    expect(parsed[0]!.durationMs).toBe(9.1);
  });

  it('handles non-JSON-serializable args/result gracefully by producing undefined-safe JSON', () => {
    const recorder = new Recorder();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    // JSON.stringify throws on circular structures — recordCall should
    // propagate that clearly rather than silently swallowing it or
    // corrupting the trace.
    expect(() => recorder.recordCall('a', circular, {}, 1)).toThrow(TypeError);
    expect(recorder.length).toBe(0);
  });
});

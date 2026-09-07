import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OJSClient } from '../src/client.js';
import * as testing from '../src/testing.js';
import { createEnqueueEnvelope } from '../src/job.js';
import type { Transport, TransportRequestOptions, TransportResponse } from '../src/transport/types.js';

function createMockTransport(): Transport {
  return {
    async request<T>(_options: TransportRequestOptions): Promise<TransportResponse<T>> {
      throw new Error('Transport should not be called in test mode');
    },
  };
}

describe('Testing Module', () => {
  afterEach(() => {
    testing.restore();
  });

  describe('fake()', () => {
    it('should activate fake mode', () => {
      testing.fake();
      expect(testing.isTestMode()).toBe(true);
      expect(testing.getMode()).toBe('fake');
    });

    it('should reset store on activation', () => {
      testing.fake();
      expect(testing.allEnqueued()).toEqual([]);
    });
  });

  describe('inline()', () => {
    it('should activate inline mode', () => {
      testing.inline();
      expect(testing.isTestMode()).toBe(true);
      expect(testing.getMode()).toBe('inline');
    });
  });

  describe('restore()', () => {
    it('should return to real mode', () => {
      testing.fake();
      testing.restore();
      expect(testing.isTestMode()).toBe(false);
      expect(testing.getMode()).toBe('real');
    });

    it('should throw on operations after restore', () => {
      testing.fake();
      testing.restore();
      expect(() => testing.allEnqueued()).toThrow('not in test mode');
    });
  });

  describe('OJSClient integration', () => {
    let client: OJSClient;

    beforeEach(() => {
      testing.fake();
      client = new OJSClient({ url: 'http://localhost:8080', transport: createMockTransport() });
    });

    it('should record enqueued jobs without hitting transport', async () => {
      const job = await client.enqueue('email.send', { to: 'user@example.com' });

      if (job === null) throw new Error('Expected enqueue result');
      expect(job.type).toBe('email.send');
      expect(job.queue).toBe('default');
      expect(job.args).toEqual([{ to: 'user@example.com' }]);
      expect(job.id).toBeTruthy();
      expect(job.specversion).toBe('1.0');
    });

    it('should record jobs with custom queue', async () => {
      await client.enqueue('report.generate', { id: 42 }, { queue: 'reports' });

      testing.assertEnqueued('report.generate', { queue: 'reports' });
    });

    it.each(['queue--name', 'queue.', 'queue-'])(
      'should record schema-valid queue name %s',
      async (queue) => {
        await client.enqueue('report.generate', { id: 42 }, { queue });

        testing.assertEnqueued('report.generate', { queue });
      },
    );

    it('should record batch enqueues', async () => {
      const jobs = await client.enqueueBatch([
        { type: 'email.send', args: { to: 'a@example.com' } },
        { type: 'email.send', args: { to: 'b@example.com' } },
      ]);

      expect(jobs).toHaveLength(2);
      testing.assertEnqueued('email.send', { count: 2 });
    });

    it('should record schema-valid separator forms in fake batches', async () => {
      const jobs = await client.enqueueBatch([
        { type: 'first.job', options: { queue: 'queue--name' } },
        { type: 'second.job', options: { queue: 'queue.' } },
        { type: 'third.job', options: { queue: 'queue-' } },
      ]);

      expect(jobs.map((job) => job.queue)).toEqual([
        'queue--name',
        'queue.',
        'queue-',
      ]);
    });

    it('should not call transport in test mode', async () => {
      // Transport throws if called — this proves interception works
      await client.enqueue('test.job', { key: 'value' });
      testing.assertEnqueued('test.job');
    });

    it('should apply middleware mutations before recording fake jobs', async () => {
      client.useEnqueue('mutate', async (job, next) => {
        job.type = 'mutated.job';
        job.queue = 'mutated';
        job.args = ['ciphertext'];
        job.priority = 0;
        job.timeout = 0;
        job.meta = { encrypted: true };
        return next(job);
      });

      const job = await client.enqueue('original.job', { plaintext: true });

      expect(job).toMatchObject({
        type: 'mutated.job',
        queue: 'mutated',
        args: ['ciphertext'],
        priority: 0,
        timeout: 0,
        meta: { encrypted: true },
      });
      testing.assertEnqueued('mutated.job', {
        args: ['ciphertext'],
        queue: 'mutated',
        meta: { encrypted: true },
      });
    });

    it('should omit middleware-dropped fake jobs', async () => {
      client.useEnqueue('drop', async () => null);

      await expect(client.enqueue('dropped.job', {})).resolves.toBeNull();
      expect(testing.allEnqueued()).toEqual([]);
    });

    it('should leave fake batches untouched when preparation throws', async () => {
      client.useEnqueue('throw', async (job, next) => {
        if (job.type === 'second.job') throw new Error('stop batch');
        return next(job);
      });

      await expect(client.enqueueBatch([
        { type: 'first.job' },
        { type: 'second.job' },
      ])).rejects.toThrow('stop batch');
      expect(testing.allEnqueued()).toEqual([]);
    });
  });

  describe('assertEnqueued()', () => {
    beforeEach(() => {
      testing.fake();
    });

    it('should pass when job of matching type exists', async () => {
      await testing._recordEnqueue('email.send', [{ to: 'user@example.com' }]);
      expect(() => testing.assertEnqueued('email.send')).not.toThrow();
    });

    it('should fail when no job of matching type exists', () => {
      expect(() => testing.assertEnqueued('email.send')).toThrow(
        "Expected at least one enqueued job of type 'email.send', found none.",
      );
    });

    it('should match by args', async () => {
      await testing._recordEnqueue('email.send', [{ to: 'user@example.com' }]);

      expect(() =>
        testing.assertEnqueued('email.send', { args: [{ to: 'user@example.com' }] }),
      ).not.toThrow();

      expect(() =>
        testing.assertEnqueued('email.send', { args: [{ to: 'other@example.com' }] }),
      ).toThrow();
    });

    it('should match by queue', async () => {
      await testing._recordEnqueue('email.send', [], { queue: 'email' });

      expect(() =>
        testing.assertEnqueued('email.send', { queue: 'email' }),
      ).not.toThrow();

      expect(() =>
        testing.assertEnqueued('email.send', { queue: 'default' }),
      ).toThrow();
    });

    it('should match by meta', async () => {
      await testing._recordEnqueue('email.send', [], { meta: { trace_id: 'abc' } });

      expect(() =>
        testing.assertEnqueued('email.send', { meta: { trace_id: 'abc' } }),
      ).not.toThrow();

      expect(() =>
        testing.assertEnqueued('email.send', { meta: { trace_id: 'xyz' } }),
      ).toThrow();
    });

    it('should match by exact count', async () => {
      await testing._recordEnqueue('email.send', []);
      await testing._recordEnqueue('email.send', []);

      expect(() => testing.assertEnqueued('email.send', { count: 2 })).not.toThrow();
      expect(() => testing.assertEnqueued('email.send', { count: 3 })).toThrow(
        "Expected 3 enqueued job(s) of type 'email.send', found 2.",
      );
    });

    it('should describe available types on mismatch', async () => {
      await testing._recordEnqueue('report.generate', []);

      expect(() => testing.assertEnqueued('email.send')).toThrow(
        'Enqueued types: report.generate',
      );
    });

    it('should throw when not in test mode', () => {
      testing.restore();
      expect(() => testing.assertEnqueued('email.send')).toThrow('not in test mode');
    });
  });

  describe('refuteEnqueued()', () => {
    beforeEach(() => {
      testing.fake();
    });

    it('should pass when no matching job exists', () => {
      expect(() => testing.refuteEnqueued('email.send')).not.toThrow();
    });

    it('should fail when matching job exists', async () => {
      await testing._recordEnqueue('email.send', []);
      expect(() => testing.refuteEnqueued('email.send')).toThrow(
        "Expected no enqueued jobs of type 'email.send', but found 1.",
      );
    });
  });

  describe('inline mode', () => {
    beforeEach(() => {
      testing.inline();
    });

    it('should execute handler immediately on enqueue', async () => {
      const results: string[] = [];
      testing.registerHandler('email.send', () => {
        results.push('executed');
      });

      await testing._recordEnqueue('email.send', []);

      expect(results).toEqual(['executed']);
      testing.assertPerformed('email.send');
      testing.assertCompleted('email.send');
    });

    it('should handle async handlers', async () => {
      testing.registerHandler('async.job', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      await testing._recordEnqueue('async.job', []);

      testing.assertPerformed('async.job');
      testing.assertCompleted('async.job');
    });

    it('should record failed handlers', async () => {
      testing.registerHandler('failing.job', () => {
        throw new Error('Handler failed');
      });

      await testing._recordEnqueue('failing.job', []);

      testing.assertPerformed('failing.job');
      testing.assertFailed('failing.job');
    });

    it('should capture the handler error message on the discarded FakeJob instead of swallowing it', async () => {
      testing.registerHandler('failing.job', () => {
        throw new Error('Handler failed: connection refused');
      });

      await testing._recordEnqueue('failing.job', []);

      const [performed] = testing.allEnqueued({ type: 'failing.job' });
      expect(performed!.state).toBe('discarded');
      expect(performed!.error).toBe('Handler failed: connection refused');
    });

    it('should capture a non-Error thrown value as a string', async () => {
      testing.registerHandler('throws-string.job', () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'plain string failure';
      });

      await testing._recordEnqueue('throws-string.job', []);

      const [performed] = testing.allEnqueued({ type: 'throws-string.job' });
      expect(performed!.error).toBe('plain string failure');
    });

    it('should leave error undefined for a successfully completed job', async () => {
      testing.registerHandler('ok.job', () => {});

      await testing._recordEnqueue('ok.job', []);

      const [performed] = testing.allEnqueued({ type: 'ok.job' });
      expect(performed!.state).toBe('completed');
      expect(performed!.error).toBeUndefined();
    });

    it('should not perform jobs without a handler', async () => {
      await testing._recordEnqueue('unregistered.job', []);

      testing.assertEnqueued('unregistered.job');
      expect(() => testing.assertPerformed('unregistered.job')).toThrow();
    });

    it('should run client middleware before selecting and invoking an inline handler', async () => {
      const client = new OJSClient({
        url: 'http://localhost:8080',
        transport: createMockTransport(),
      });
      const observed: unknown[] = [];
      testing.registerHandler('mutated.job', (job) => {
        observed.push(job.type, job.queue, job.args, job.meta);
      });
      client.useEnqueue('mutate', async (job, next) => {
        job.type = 'mutated.job';
        job.queue = 'inline';
        job.args = ['encoded'];
        job.meta = { codec: 'test' };
        return next(job);
      });

      await client.enqueue('original.job', { plaintext: true });

      expect(observed).toEqual([
        'mutated.job',
        'inline',
        ['encoded'],
        { codec: 'test' },
      ]);
      testing.assertCompleted('mutated.job');
    });
  });

  describe('drain()', () => {
    beforeEach(() => {
      testing.fake();
    });

    it('should process all available jobs', async () => {
      const processed: string[] = [];
      testing.registerHandler('task.a', () => { processed.push('a'); });
      testing.registerHandler('task.b', () => { processed.push('b'); });

      await testing._recordEnqueue('task.a', []);
      await testing._recordEnqueue('task.b', []);

      await testing.drain();

      expect(processed).toEqual(['a', 'b']);
      testing.assertCompleted('task.a');
      testing.assertCompleted('task.b');
    });

    it('should respect maxJobs limit', async () => {
      testing.registerHandler('task.job', () => {});

      await testing._recordEnqueue('task.job', []);
      await testing._recordEnqueue('task.job', []);
      await testing._recordEnqueue('task.job', []);

      await testing.drain({ maxJobs: 2 });

      const performed = testing.allEnqueued().filter((j) => j.state !== 'available');
      expect(performed).toHaveLength(2);
    });

    it('should mark failed handlers as discarded', async () => {
      testing.registerHandler('fail.job', () => { throw new Error('fail'); });

      await testing._recordEnqueue('fail.job', []);
      await testing.drain();

      testing.assertFailed('fail.job');
    });

    it('should capture the handler error message when draining, instead of swallowing it', async () => {
      testing.registerHandler('fail.job', () => { throw new Error('drain failure detail'); });

      await testing._recordEnqueue('fail.job', []);
      await testing.drain();

      const [performed] = testing.allEnqueued({ type: 'fail.job' });
      expect(performed!.error).toBe('drain failure detail');
    });

    it('should complete jobs without handlers', async () => {
      await testing._recordEnqueue('no.handler', []);
      await testing.drain();

      testing.assertCompleted('no.handler');
    });

    it('should handle async handlers correctly', async () => {
      const processed: string[] = [];
      testing.registerHandler('async.task', async () => {
        await new Promise((r) => setTimeout(r, 10));
        processed.push('async-done');
      });

      await testing._recordEnqueue('async.task', []);
      await testing.drain();

      expect(processed).toEqual(['async-done']);
      testing.assertCompleted('async.task');
    });

    it('should catch async handler errors', async () => {
      testing.registerHandler('async.fail', async () => {
        await new Promise((r) => setTimeout(r, 10));
        throw new Error('async failure');
      });

      await testing._recordEnqueue('async.fail', []);
      await testing.drain();

      testing.assertFailed('async.fail');
    });
  });

  describe('allEnqueued()', () => {
    beforeEach(() => {
      testing.fake();
    });

    it('should return all enqueued jobs', async () => {
      await testing._recordEnqueue('email.send', []);
      await testing._recordEnqueue('report.generate', []);

      expect(testing.allEnqueued()).toHaveLength(2);
    });

    it('should filter by type', async () => {
      await testing._recordEnqueue('email.send', []);
      await testing._recordEnqueue('report.generate', []);

      expect(testing.allEnqueued({ type: 'email.send' })).toHaveLength(1);
    });

    it('should filter by queue', async () => {
      await testing._recordEnqueue('task.a', [], { queue: 'default' });
      await testing._recordEnqueue('task.b', [], { queue: 'priority' });

      expect(testing.allEnqueued({ queue: 'priority' })).toHaveLength(1);
    });
  });

  describe('clearAll()', () => {
    it('should clear enqueued and performed jobs', async () => {
      testing.fake();
      await testing._recordEnqueue('email.send', []);

      testing.clearAll();

      expect(testing.allEnqueued()).toEqual([]);
    });
  });

  describe('describeEnqueued() error messages', () => {
    beforeEach(() => {
      testing.fake();
    });

    it('should indicate when no jobs were enqueued at all', () => {
      expect(() => testing.assertEnqueued('email.send')).toThrow(
        'No jobs were enqueued at all.',
      );
    });
  });

  describe('Finding 7: deep cloning of args/meta/options in fake mode', () => {
    beforeEach(() => {
      testing.fake();
    });

    it('client.enqueue() returned job mutations (post-next) cannot alter the recorded store', async () => {
      const client = new OJSClient({ url: 'http://localhost:8080', transport: createMockTransport() });

      const job = await client.enqueue('email.send', [{ to: 'user@example.com', nested: { count: 1 } }], {
        meta: { owner: 'team-a', nested: { level: 1 } },
      });
      expect(job).not.toBeNull();

      // Mutate the *returned* job's nested args/meta after next() -- this
      // must never reach the internally recorded FakeJob.
      const returnedArgs = job!.args as unknown as [{ to: string; nested: { count: number } }];
      returnedArgs[0].nested.count = 999;
      returnedArgs[0].to = 'tampered@example.com';
      const returnedMeta = job!.meta as unknown as { owner: string; nested: { level: number } };
      returnedMeta.owner = 'tampered';
      returnedMeta.nested.level = 999;
      (job!.args as unknown[]).push('extra');

      const [recorded] = testing.allEnqueued({ type: 'email.send' });
      expect(recorded!.args).toEqual([{ to: 'user@example.com', nested: { count: 1 } }]);
      expect(recorded!.meta).toEqual({ owner: 'team-a', nested: { level: 1 } });

      testing.assertEnqueued('email.send', {
        args: [{ to: 'user@example.com', nested: { count: 1 } }],
      });
    });

    it('mutating a job returned by allEnqueued() cannot alter the recorded store', async () => {
      await testing._recordEnqueue('report.generate', [{ scope: { region: 'us' } }], {
        meta: { owner: { team: 'analytics' } },
      });

      const [job] = testing.allEnqueued({ type: 'report.generate' });
      const args = job!.args as unknown as [{ scope: { region: string } }];
      args[0].scope.region = 'eu';
      const meta = job!.meta as unknown as { owner: { team: string } };
      meta.owner.team = 'tampered';
      job!.options.queue = 'tampered-queue';
      (job!.tags ??= []).push('tampered');

      const [again] = testing.allEnqueued({ type: 'report.generate' });
      expect(again!.args).toEqual([{ scope: { region: 'us' } }]);
      expect(again!.meta).toEqual({ owner: { team: 'analytics' } });
      expect(again!.options.queue).not.toBe('tampered-queue');
    });

    it('mutating a job returned by performed() cannot alter the recorded store', async () => {
      testing.registerHandler('worker.job', async () => undefined);
      await testing._recordEnqueue('worker.job', [{ payload: { value: 1 } }]);
      await testing.drain();

      const [job] = testing.performed({ type: 'worker.job' });
      expect(job!.state).toBe('completed');
      const args = job!.args as unknown as [{ payload: { value: number } }];
      args[0].payload.value = 999;

      const [again] = testing.performed({ type: 'worker.job' });
      expect(again!.args).toEqual([{ payload: { value: 1 } }]);
    });

    it('mutating the caller-supplied args/meta objects after enqueuing does not affect the recorded store', async () => {
      const args: [{ nested: { value: number } }] = [{ nested: { value: 1 } }];
      const meta: { tag: { value: string } } = { tag: { value: 'original' } };

      await testing._recordEnqueue('email.send', args, { meta });

      args[0].nested.value = 999;
      meta.tag.value = 'tampered';

      const [recorded] = testing.allEnqueued({ type: 'email.send' });
      expect(recorded!.args).toEqual([{ nested: { value: 1 } }]);
      expect(recorded!.meta).toEqual({ tag: { value: 'original' } });
    });

    it('two _toJob() calls for the same recorded job never share args/meta references', async () => {
      const fakeJob = await testing._recordEnqueue('email.send', [{ nested: { count: 1 } }], {
        meta: { owner: { team: 'a' } },
      });

      const jobA = testing._toJob(fakeJob);
      const jobB = testing._toJob(fakeJob);

      expect(jobA.args).not.toBe(jobB.args);
      expect(jobA.args[0]).not.toBe(jobB.args[0]);
      expect(jobA.meta).not.toBe(jobB.meta);

      (jobA.args[0] as { nested: { count: number } }).nested.count = 999;
      expect((jobB.args[0] as { nested: { count: number } }).nested.count).toBe(1);
      expect((fakeJob.args[0] as { nested: { count: number } }).nested.count).toBe(1);
    });

    it('real-mode parity: fake-mode recording normalizes a Date arg/meta value identically to createEnqueueEnvelope', async () => {
      const date = new Date('2024-06-15T12:00:00.000Z');

      // Real-mode reference: what createEnqueueEnvelope() (used by the
      // real transport path) produces for the same input.
      const realEnvelope = createEnqueueEnvelope(
        'email.send',
        [{ when: date } as unknown as Record<string, never>],
        { meta: { when: date } as unknown as Record<string, never> },
      );

      const fakeJob = await testing._recordEnqueue(
        'email.send',
        [{ when: date } as unknown as Record<string, never>],
        { meta: { when: date } as unknown as Record<string, never> },
      );

      expect(fakeJob.args).toEqual(realEnvelope.args);
      expect(fakeJob.meta).toEqual(realEnvelope.meta);
      expect(fakeJob.args).toEqual([{ when: '2024-06-15T12:00:00.000Z' }]);
      expect(fakeJob.meta).toEqual({ when: '2024-06-15T12:00:00.000Z' });
      // The original Date instance is untouched.
      expect(date instanceof Date).toBe(true);
    });

    it('real-mode parity: __proto__/constructor/prototype keys are preserved as ordinary data, matching createEnqueueEnvelope', async () => {
      const hostile = JSON.parse(
        '{"__proto__": {"polluted": true}, "constructor": 1, "prototype": 2}',
      ) as Record<string, never>;

      const realEnvelope = createEnqueueEnvelope('email.send', [hostile]);
      const fakeJob = await testing._recordEnqueue('email.send', [hostile]);

      expect(fakeJob.args).toEqual(realEnvelope.args);
      const cloned = fakeJob.args[0] as Record<string, unknown>;
      expect(Object.getOwnPropertyNames(cloned).sort()).toEqual(
        ['__proto__', 'constructor', 'prototype'].sort(),
      );
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.getPrototypeOf(cloned)).toBeNull();

      // The returned public Job (via _toJob) preserves the same shape.
      const job = testing._toJob(fakeJob);
      const jobArg = job.args[0] as Record<string, unknown>;
      expect(Object.getOwnPropertyNames(jobArg).sort()).toEqual(
        ['__proto__', 'constructor', 'prototype'].sort(),
      );
      expect(Object.getPrototypeOf(jobArg)).toBeNull();
    });

    it('real-mode parity: __proto__ key in meta is preserved as ordinary data without prototype pollution', async () => {
      const hostileMeta = JSON.parse('{"__proto__": {"polluted": true}}') as Record<
        string,
        never
      >;

      const realEnvelope = createEnqueueEnvelope('email.send', [], { meta: hostileMeta });
      const fakeJob = await testing._recordEnqueue('email.send', [], { meta: hostileMeta });

      expect(fakeJob.meta).toEqual(realEnvelope.meta);
      expect(Object.getOwnPropertyNames(fakeJob.meta)).toEqual(['__proto__']);
      expect(Object.getPrototypeOf(fakeJob.meta)).toBeNull();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  });
});

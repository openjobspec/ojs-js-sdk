import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OJSClient } from '../src/client.js';
import * as testing from '../src/testing.js';
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

    it('should record batch enqueues', async () => {
      const jobs = await client.enqueueBatch([
        { type: 'email.send', args: { to: 'a@example.com' } },
        { type: 'email.send', args: { to: 'b@example.com' } },
      ]);

      expect(jobs).toHaveLength(2);
      testing.assertEnqueued('email.send', { count: 2 });
    });

    it('should not call transport in test mode', async () => {
      // Transport throws if called — this proves interception works
      await client.enqueue('test.job', { key: 'value' });
      testing.assertEnqueued('test.job');
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

    it('should not perform jobs without a handler', async () => {
      await testing._recordEnqueue('unregistered.job', []);

      testing.assertEnqueued('unregistered.job');
      expect(() => testing.assertPerformed('unregistered.job')).toThrow();
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
});

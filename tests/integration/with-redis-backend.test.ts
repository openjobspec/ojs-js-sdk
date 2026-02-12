/**
 * Integration tests against a live OJS backend (ojs-backend-redis).
 *
 * These tests require a running OJS server. They are skipped by default
 * and can be enabled by setting the OJS_INTEGRATION_URL environment variable.
 *
 * Usage:
 *   OJS_INTEGRATION_URL=http://localhost:8080 npm test -- tests/integration/
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { OJSClient, OJSWorker, chain, group, batch } from '../../src/index.js';

const OJS_URL = process.env.OJS_INTEGRATION_URL;

const describeIntegration = OJS_URL ? describe : describe.skip;

describeIntegration('Integration: OJS with Redis Backend', () => {
  let client: OJSClient;
  let worker: OJSWorker;

  beforeAll(async () => {
    client = new OJSClient({ url: OJS_URL! });
    worker = new OJSWorker({
      url: OJS_URL!,
      queues: ['default', 'integration-test'],
      concurrency: 5,
    });
  });

  afterAll(async () => {
    if (worker.currentState !== 'terminated') {
      await worker.stop();
    }
  });

  describe('Health Check', () => {
    it('should report healthy', async () => {
      const health = await client.health();
      expect(health.status).toBe('ok');
      expect(health.version).toBeDefined();
    });
  });

  describe('Job Enqueue and Info', () => {
    it('should enqueue and retrieve a job', async () => {
      const job = await client.enqueue(
        'integration.test',
        { timestamp: Date.now() },
        { queue: 'integration-test' },
      );

      expect(job.id).toBeDefined();
      expect(job.type).toBe('integration.test');
      expect(job.state).toBe('available');

      // Retrieve the job
      const info = await client.getJob(job.id);
      expect(info.id).toBe(job.id);
      expect(info.type).toBe('integration.test');
    });

    it('should enqueue a batch of jobs', async () => {
      const jobs = await client.enqueueBatch([
        { type: 'integration.batch', args: { index: 0 } },
        { type: 'integration.batch', args: { index: 1 } },
        { type: 'integration.batch', args: { index: 2 } },
      ]);

      expect(jobs).toHaveLength(3);
      for (const job of jobs) {
        expect(job.state).toBe('available');
      }
    });

    it('should cancel a job', async () => {
      const job = await client.enqueue(
        'integration.cancel',
        {},
        { queue: 'integration-test' },
      );

      const cancelled = await client.cancelJob(job.id);
      expect(cancelled.state).toBe('cancelled');
    });
  });

  describe('Worker Processing', () => {
    it('should process a job end-to-end', async () => {
      // Enqueue a job
      const enqueued = await client.enqueue(
        'integration.echo',
        { message: 'hello' },
        { queue: 'integration-test' },
      );

      // Register handler and start worker
      let processedJobId: string | null = null;

      worker.register('integration.echo', async (ctx) => {
        processedJobId = ctx.job.id;
        const args = ctx.job.args[0] as { message: string };
        return { echo: args.message };
      });

      await worker.start();

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 3000));

      await worker.stop();

      // Verify the job was processed
      expect(processedJobId).toBe(enqueued.id);

      // Verify the job is completed
      const info = await client.getJob(enqueued.id);
      expect(info.state).toBe('completed');
    });
  });

  describe('Queue Operations', () => {
    it('should list queues', async () => {
      const queues = await client.queues.list();
      expect(Array.isArray(queues)).toBe(true);
    });
  });

  describe('Workflow', () => {
    it('should create a chain workflow', async () => {
      const status = await client.workflow(
        chain(
          { type: 'integration.step_a', args: { step: 1 } },
          { type: 'integration.step_b', args: { step: 2 } },
        ),
      );

      expect(status.id).toBeDefined();
      expect(status.type).toBe('chain');
      expect(['pending', 'running']).toContain(status.state);
    });
  });
});

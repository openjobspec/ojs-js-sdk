import { describe, it, expect } from 'vitest';
import { chain, group, batch, toWireWorkflow } from '../src/workflow.js';

describe('Workflow Builders', () => {
  describe('chain()', () => {
    it('should create a chain definition', () => {
      const wf = chain(
        { type: 'data.fetch', args: { url: 'http://example.com' } },
        { type: 'data.transform', args: { format: 'csv' } },
        { type: 'data.load', args: { dest: 'warehouse' } },
      );

      expect(wf.type).toBe('chain');
      expect(wf.steps).toHaveLength(3);
      expect(wf.steps[0].type).toBe('data.fetch');
    });

    it('should throw for empty chain', () => {
      expect(() => chain()).toThrow('at least one step');
    });

    it('should allow nested groups as steps', () => {
      const wf = chain(
        { type: 'order.validate', args: {} },
        group(
          { type: 'payment.charge', args: {} },
          { type: 'inventory.reserve', args: {} },
        ),
        { type: 'notification.send', args: {} },
      );

      expect(wf.steps).toHaveLength(3);
      expect(wf.steps[1].type).toBe('group');
    });
  });

  describe('group()', () => {
    it('should create a group definition', () => {
      const wf = group(
        { type: 'export.csv', args: { reportId: 'rpt_456' } },
        { type: 'export.pdf', args: { reportId: 'rpt_456' } },
        { type: 'export.xlsx', args: { reportId: 'rpt_456' } },
      );

      expect(wf.type).toBe('group');
      expect(wf.jobs).toHaveLength(3);
    });

    it('should throw for empty group', () => {
      expect(() => group()).toThrow('at least one job');
    });

    it('should allow nested chains as jobs', () => {
      const wf = group(
        chain(
          { type: 'task.a', args: [] },
          { type: 'task.b', args: [] },
        ),
        { type: 'task.c', args: [] },
      );

      expect(wf.jobs).toHaveLength(2);
      expect(wf.jobs[0].type).toBe('chain');
    });
  });

  describe('batch()', () => {
    it('should create a batch definition with callbacks', () => {
      const wf = batch(
        [
          { type: 'email.send', args: ['user1@example.com'] },
          { type: 'email.send', args: ['user2@example.com'] },
        ],
        {
          on_complete: { type: 'batch.report', args: [] },
          on_failure: { type: 'batch.alert', args: [] },
        },
      );

      expect(wf.type).toBe('batch');
      expect(wf.jobs).toHaveLength(2);
      expect(wf.callbacks.on_complete?.type).toBe('batch.report');
      expect(wf.callbacks.on_failure?.type).toBe('batch.alert');
    });

    it('should throw for empty batch', () => {
      expect(() =>
        batch([], { on_complete: { type: 'done', args: [] } }),
      ).toThrow('at least one job');
    });

    it('should throw for batch with no callbacks', () => {
      expect(() =>
        batch([{ type: 'test.job', args: [] }], {}),
      ).toThrow('at least one callback');
    });
  });

  describe('toWireWorkflow()', () => {
    it('should convert a chain to wire format', () => {
      const wf = chain(
        { type: 'data.fetch', args: { url: 'http://example.com' } },
        { type: 'data.load', args: [] },
      );

      const wire = toWireWorkflow(wf);

      expect(wire.type).toBe('chain');
      expect(wire.steps).toHaveLength(2);

      const steps = wire.steps as Array<Record<string, unknown>>;
      expect(steps[0].type).toBe('data.fetch');
      // Object args should be wrapped in array
      expect(steps[0].args).toEqual([{ url: 'http://example.com' }]);
      expect(steps[1].args).toEqual([]);
    });

    it('should convert a group to wire format', () => {
      const wf = group(
        { type: 'export.csv', args: ['report'] },
        { type: 'export.pdf', args: ['report'] },
      );

      const wire = toWireWorkflow(wf);

      expect(wire.type).toBe('group');
      const jobs = wire.jobs as Array<Record<string, unknown>>;
      expect(jobs).toHaveLength(2);
      expect(jobs[0].args).toEqual(['report']);
    });

    it('should convert a batch to wire format with callbacks', () => {
      const wf = batch(
        [{ type: 'email.send', args: ['user@example.com'] }],
        {
          on_complete: { type: 'batch.report', args: [] },
        },
      );

      const wire = toWireWorkflow(wf);

      expect(wire.type).toBe('batch');
      const callbacks = wire.callbacks as Record<string, Record<string, unknown>>;
      expect(callbacks.on_complete.type).toBe('batch.report');
    });

    it('should handle nested workflows in wire format', () => {
      const wf = chain(
        { type: 'step.one', args: [] },
        group(
          { type: 'parallel.a', args: [] },
          { type: 'parallel.b', args: [] },
        ),
      );

      const wire = toWireWorkflow(wf);
      const steps = wire.steps as Array<Record<string, unknown>>;

      expect(steps[1].type).toBe('group');
      expect(steps[1].jobs).toBeDefined();
    });

    it('should treat a JobSpec with type "chain" as a job, not a workflow', () => {
      const wf = chain(
        { type: 'chain', args: { input: 'data' } },
        { type: 'process.result', args: [] },
      );

      const wire = toWireWorkflow(wf);
      const steps = wire.steps as Array<Record<string, unknown>>;

      expect(steps[0].type).toBe('chain');
      expect(steps[0].args).toEqual([{ input: 'data' }]);
      // Should NOT have 'steps' or 'jobs' — it's a job, not a workflow
      expect(steps[0].steps).toBeUndefined();
      expect(steps[0].jobs).toBeUndefined();
    });
  });
});

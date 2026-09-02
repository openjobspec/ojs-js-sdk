import { describe, it, expect } from 'vitest';
import { chain, group, batch, toWireWorkflow } from '../src/workflow.js';
import { OJSValidationError } from '../src/errors.js';

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

    it.each([
      ['group', { type: 'group', jobs: [] }],
      ['chain', { type: 'chain', steps: [] }],
    ])('rejects A -> empty nested %s -> B instead of splicing the dependency', (_label, empty) => {
      const definition = {
        type: 'chain',
        steps: [
          { type: 'a', args: [] },
          empty,
          { type: 'b', args: [] },
        ],
      };

      expect(() => toWireWorkflow(definition as never)).toThrow(
        OJSValidationError,
      );
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

    it('should convert step retry options to snake_case wire format', () => {
      // Regression test: toWireStep previously passed camelCase RetryOptions
      // straight through as `options.retry` without converting to the
      // snake_case wire shape (max_attempts, backoff_coefficient, ...) that
      // ojs-workflows.md's job-option examples use.
      const wf = chain({
        type: 'payment.charge',
        args: [],
        options: {
          retry: {
            maxAttempts: 5,
            backoffCoefficient: 2.5,
            initialInterval: 'PT1S',
            maxInterval: 'PT1M',
            jitter: false,
            nonRetryableErrors: ['validation.*'],
            onExhaustion: 'dead_letter',
          },
        },
      });

      const wire = toWireWorkflow(wf);
      const steps = wire.steps as Array<Record<string, unknown>>;
      const options = steps[0].options as Record<string, unknown>;

      expect(options.retry).toEqual({
        max_attempts: 5,
        backoff_coefficient: 2.5,
        initial_interval: 'PT1S',
        max_interval: 'PT1M',
        jitter: false,
        non_retryable_errors: ['validation.*'],
        on_exhaustion: 'dead_letter',
      });
    });

    it('should convert all supported job options for a workflow step, not just queue/timeout/tags', () => {
      // `delay` uses an explicit absolute RFC 3339 timestamp, not the
      // relative '5m' shorthand: workflow steps/callbacks reject relative
      // delay strings (see the dedicated describe block below), since
      // they may be materialized well after workflow submission.
      const wf = chain({
        type: 'data.export',
        args: [],
        options: {
          queue: 'exports',
          priority: 5,
          timeout: 60_000,
          delay: '2030-06-15T12:00:00Z',
          tags: ['nightly'],
          meta: { correlation_id: 'abc' },
          schema: 'urn:ojs:schema:data.export:v1',
          visibilityTimeout: 45_000,
          unique: {
            keys: ['type', 'args'],
            argsKeys: ['tenant_id'],
            period: 'PT1H',
            onConflict: 'reject',
          },
        },
      });

      const wire = toWireWorkflow(wf);
      const steps = wire.steps as Array<Record<string, unknown>>;
      const options = steps[0].options as Record<string, unknown>;

      expect(options.queue).toBe('exports');
      expect(options.priority).toBe(5);
      expect(options.timeout_ms).toBe(60_000);
      // An absolute timestamp passes through parseDuration()/toWireOptions()
      // completely unchanged -- never reinterpreted relative to "now".
      expect(options.delay_until).toBe('2030-06-15T12:00:00Z');
      expect(options.tags).toEqual(['nightly']);
      expect(options.visibility_timeout_ms).toBe(45_000);
      expect(options.unique).toEqual({
        keys: ['type', 'args'],
        args_keys: ['tenant_id'],
        period: 'PT1H',
        on_conflict: 'reject',
      });
      expect(options.unique).not.toHaveProperty('key');
    });

    it('rejects expiresAt on a workflow step non-retryably', () => {
      expect(() =>
        toWireWorkflow(
          chain({
            type: 'data.export',
            args: [],
            options: { expiresAt: '2030-01-01T00:00:00Z' },
          }),
        ),
      ).toThrow(OJSValidationError);

      try {
        toWireWorkflow(
          chain({
            type: 'data.export',
            args: [],
            options: { expiresAt: '2030-01-01T00:00:00Z' },
          }),
        );
      } catch (error) {
        expect(error).toMatchObject({
          code: 'invalid_request',
          retryable: false,
          message: expect.stringMatching(/materialized later|shift/i),
        });
      }
    });

    it('rejects expiresAt on a batch callback non-retryably', () => {
      expect(() =>
        toWireWorkflow(
          batch(
            [{ type: 'email.send', args: [] }],
            {
              on_complete: {
                type: 'batch.complete',
                args: [],
                options: { expiresAt: '2030-01-01T00:00:00Z' },
              },
            },
          ),
        ),
      ).toThrow(OJSValidationError);
    });

    describe('relative delay rejection (Finding: workflow relative delay)', () => {
      // The wire protocol only ever carries an absolute delay_until
      // timestamp (ojs-http-binding.md/ojs-grpc-binding.md); workflow
      // steps/callbacks may materialize their underlying job well after
      // the workflow itself is submitted, so a relative shorthand like
      // '5m' would be silently computed from the *wrong* "now".

      it('rejects a relative delay shorthand on a single-step chain non-retryably', () => {
        expect(() =>
          toWireWorkflow(
            chain({
              type: 'data.export',
              args: [],
              options: { delay: '5m' },
            }),
          ),
        ).toThrow(OJSValidationError);

        try {
          toWireWorkflow(
            chain({ type: 'data.export', args: [], options: { delay: '5m' } }),
          );
          expect.unreachable('expected toWireWorkflow to throw');
        } catch (error) {
          expect(error).toMatchObject({
            code: 'invalid_request',
            retryable: false,
            message: expect.stringMatching(/materialized later|relative delay/i),
          });
          expect((error as Error).message).toContain("'5m'");
        }
      });

      it.each(['5m', '30s', '1h', '100ms', '2d'])(
        'rejects the relative shorthand %s on a batch callback',
        (delay) => {
          expect(() =>
            toWireWorkflow(
              batch(
                [{ type: 'email.send', args: [] }],
                {
                  on_complete: {
                    type: 'batch.complete',
                    args: [],
                    options: { delay },
                  },
                },
              ),
            ),
          ).toThrow(OJSValidationError);
        },
      );

      it('rejects a relative delay on a group member', () => {
        expect(() =>
          toWireWorkflow(
            group(
              { type: 'export.csv', args: [] },
              { type: 'export.pdf', args: [], options: { delay: '10m' } },
            ),
          ),
        ).toThrow(/relative delay/i);
      });

      it('allows an explicit RFC 3339 absolute timestamp unchanged, on both a step and a callback', () => {
        const wf = chain(
          { type: 'data.fetch', args: [], options: { delay: '2031-03-04T05:06:07Z' } },
        );
        const wire = toWireWorkflow(wf);
        const steps = wire.steps as Array<Record<string, unknown>>;
        expect((steps[0]!.options as Record<string, unknown>).delay_until).toBe(
          '2031-03-04T05:06:07Z',
        );

        const bwf = batch(
          [{ type: 'email.send', args: [] }],
          { on_complete: { type: 'batch.report', args: [], options: { delay: '2031-01-01T00:00:00.500Z' } } },
        );
        const bwire = toWireWorkflow(bwf);
        const callbacks = bwire.callbacks as Record<string, Record<string, unknown>>;
        expect((callbacks.on_complete!.options as Record<string, unknown>).delay_until).toBe(
          '2031-01-01T00:00:00.500Z',
        );
      });

      it('rejects a relative delay on a step deep behind several predecessors in a long chain, without materializing any of them (golden: 6-step chain, failure on step 5)', () => {
        // Predecessor steps 1-4 and the trailing step 6 are deliberately
        // ordinary (no delay at all) so the *only* reason this call can
        // throw is step 5's relative delay -- proving validation happens
        // eagerly, for every step, before the workflow is ever submitted
        // to a transport, regardless of how many predecessors stand
        // between "now" and when step 5 would actually materialize.
        expect(() =>
          toWireWorkflow(
            chain(
              { type: 'step.one', args: [{ n: 1 }] },
              { type: 'step.two', args: [{ n: 2 }] },
              { type: 'step.three', args: [{ n: 3 }] },
              { type: 'step.four', args: [{ n: 4 }] },
              { type: 'step.five', args: [{ n: 5 }], options: { delay: '15m' } },
              { type: 'step.six', args: [{ n: 6 }] },
            ),
          ),
        ).toThrow(/'15m'/);
      });

      it('golden: a 6-step chain with an absolute delay on the 5th step serializes the exact expected wire structure', () => {
        const wf = chain(
          { type: 'step.one', args: [{ n: 1 }] },
          { type: 'step.two', args: [{ n: 2 }] },
          { type: 'step.three', args: [{ n: 3 }] },
          { type: 'step.four', args: [{ n: 4 }] },
          {
            type: 'step.five',
            args: [{ n: 5 }],
            options: { delay: '2032-07-04T00:00:00Z' },
          },
          { type: 'step.six', args: [{ n: 6 }] },
        );

        expect(toWireWorkflow(wf)).toEqual({
          type: 'chain',
          steps: [
            { type: 'step.one', args: [{ n: 1 }] },
            { type: 'step.two', args: [{ n: 2 }] },
            { type: 'step.three', args: [{ n: 3 }] },
            { type: 'step.four', args: [{ n: 4 }] },
            {
              type: 'step.five',
              args: [{ n: 5 }],
              options: { delay_until: '2032-07-04T00:00:00Z' },
            },
            { type: 'step.six', args: [{ n: 6 }] },
          ],
        });
      });

      it('rejects a relative delay on a nested group buried inside a long chain', () => {
        // Predecessors: two ordinary steps, then a nested group whose
        // second job carries the offending relative delay, followed by
        // two more ordinary steps -- the deferred materialization concern
        // applies transitively through nesting, not just top-level steps.
        expect(() =>
          toWireWorkflow(
            chain(
              { type: 'step.one', args: [] },
              { type: 'step.two', args: [] },
              group(
                { type: 'branch.a', args: [] },
                { type: 'branch.b', args: [], options: { delay: '1h' } },
              ),
              { type: 'step.four', args: [] },
              { type: 'step.five', args: [] },
            ),
          ),
        ).toThrow(/'1h'/);
      });
    });

    describe('meta / schema placement for workflow steps', () => {
      // Regression coverage: meta/schema were previously silently dropped
      // for every workflow step (job.ts's toWireOptions() never mapped
      // them, and toWireStep() only ever forwarded toWireOptions()'s
      // result). They must appear at the *step's* top level — a sibling of
      // type/args/options — never nested inside options, per
      // job-options.schema.json's additionalProperties:false contract
      // (see toWireEnvelopeFields()'s doc comment in job.ts).

      it('places meta and schema at the top level of the step, not inside options', () => {
        const wf = chain({
          type: 'data.export',
          args: [],
          options: {
            queue: 'exports',
            meta: { correlation_id: 'abc' },
            schema: 'urn:ojs:schema:data.export:v1',
          },
        });

        const wire = toWireWorkflow(wf);
        const steps = wire.steps as Array<Record<string, unknown>>;

        expect(steps[0].meta).toEqual({ correlation_id: 'abc' });
        expect(steps[0].schema).toBe('urn:ojs:schema:data.export:v1');

        // Must NOT be duplicated inside options.
        const options = steps[0].options as Record<string, unknown>;
        expect(options).not.toHaveProperty('meta');
        expect(options).not.toHaveProperty('schema');
      });

      it('omits meta/schema from the step entirely when not provided', () => {
        const wf = chain({ type: 'data.export', args: [], options: { queue: 'exports' } });
        const wire = toWireWorkflow(wf);
        const steps = wire.steps as Array<Record<string, unknown>>;

        expect(steps[0]).not.toHaveProperty('meta');
        expect(steps[0]).not.toHaveProperty('schema');
      });

      it('preserves an explicitly-empty meta object on a step rather than dropping it', () => {
        const wf = chain({ type: 'data.export', args: [], options: { meta: {} } });
        const wire = toWireWorkflow(wf);
        const steps = wire.steps as Array<Record<string, unknown>>;

        expect(steps[0].meta).toEqual({});
      });

      it('preserves deeply nested meta values on a step exactly, without reshaping them', () => {
        const nested = {
          trace: { id: 'abc', span_ids: [1, 2, 3] },
          flags: { retryable: false, priority: 0 },
        };
        const wf = chain({ type: 'data.export', args: [], options: { meta: nested } });
        const wire = toWireWorkflow(wf);
        const steps = wire.steps as Array<Record<string, unknown>>;

        expect(steps[0].meta).toEqual(nested);
      });

      it('does not mutate the original JobSpec/options object when building the wire step', () => {
        const meta = { correlation_id: 'abc' };
        const spec = {
          type: 'data.export',
          args: [] as unknown[],
          options: { queue: 'exports', meta, schema: 'urn:ojs:schema:data.export:v1' },
        };
        const specCopy = JSON.parse(JSON.stringify(spec));

        const wf = chain(spec);
        toWireWorkflow(wf);

        expect(spec).toEqual(specCopy);
      });
    });

    it('should convert options in batch callbacks the same way as regular steps', () => {
      const wf = batch(
        [{ type: 'email.send', args: [] }],
        {
          on_failure: {
            type: 'batch.alert',
            args: [],
            options: { retry: { maxAttempts: 5 }, priority: 9 },
          },
        },
      );

      const wire = toWireWorkflow(wf);
      const callbacks = wire.callbacks as Record<string, Record<string, unknown>>;
      const options = callbacks.on_failure.options as Record<string, unknown>;

      expect(options.retry).toEqual({ max_attempts: 5 });
      expect(options.priority).toBe(9);
    });

    it('should place meta/schema at the top level of a batch callback too, not inside its options', () => {
      const wf = batch(
        [{ type: 'email.send', args: [] }],
        {
          on_failure: {
            type: 'batch.alert',
            args: [],
            options: {
              priority: 9,
              meta: { reason: 'batch_failed' },
              schema: 'urn:ojs:schema:batch.alert:v1',
            },
          },
        },
      );

      const wire = toWireWorkflow(wf);
      const callbacks = wire.callbacks as Record<string, Record<string, unknown>>;

      expect(callbacks.on_failure.meta).toEqual({ reason: 'batch_failed' });
      expect(callbacks.on_failure.schema).toBe('urn:ojs:schema:batch.alert:v1');
      const options = callbacks.on_failure.options as Record<string, unknown>;
      expect(options.priority).toBe(9);
      expect(options).not.toHaveProperty('meta');
      expect(options).not.toHaveProperty('schema');
    });

    it('should not create an options object on a callback when meta/schema are the only fields set', () => {
      // meta/schema alone must never populate the nested options object —
      // confirms they truly live only at the step/callback's top level.
      const wf = batch(
        [{ type: 'email.send', args: [] }],
        {
          on_failure: {
            type: 'batch.alert',
            args: [],
            options: { meta: { reason: 'batch_failed' }, schema: 'urn:ojs:schema:batch.alert:v1' },
          },
        },
      );

      const wire = toWireWorkflow(wf);
      const callbacks = wire.callbacks as Record<string, Record<string, unknown>>;

      expect(callbacks.on_failure.meta).toEqual({ reason: 'batch_failed' });
      expect(callbacks.on_failure.schema).toBe('urn:ojs:schema:batch.alert:v1');
      expect(callbacks.on_failure.options).toBeUndefined();
    });

    it('should omit the options field entirely when a step has no options', () => {
      const wf = chain({ type: 'noop', args: [] });
      const wire = toWireWorkflow(wf);
      const steps = wire.steps as Array<Record<string, unknown>>;

      expect(steps[0].options).toBeUndefined();
    });
  });
});

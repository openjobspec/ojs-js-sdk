import type { Job, OJSClient } from '../../src/index.js';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Assert<Value extends true> = Value;

export type EnqueueResultIsNullable = Assert<
  Equal<Awaited<ReturnType<OJSClient['enqueue']>>, Job | null>
>;

export async function consumeEnqueueResult(client: OJSClient): Promise<string | null> {
  const job = await client.enqueue('typed.job', {});
  return job === null ? null : job.id;
}

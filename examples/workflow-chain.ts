/**
 * Example: Workflow primitives — chain, group, and batch.
 *
 * Demonstrates building and submitting composite workflows.
 */

import { OJSClient, chain, group, batch } from '@openjobspec/sdk';

const client = new OJSClient({ url: 'http://localhost:8080' });

// --- Chain: Sequential ETL pipeline ---
const etl = await client.workflow(
  chain(
    { type: 'data.fetch', args: { url: 'https://api.example.com/data' } },
    { type: 'data.transform', args: { format: 'csv' } },
    { type: 'data.load', args: { dest: 'warehouse', table: 'events' } },
  ),
);
console.log(`ETL workflow started: ${etl.id} (${etl.state})`);

// --- Group: Parallel exports ---
const exports = await client.workflow(
  group(
    { type: 'export.csv', args: { reportId: 'rpt_456' } },
    { type: 'export.pdf', args: { reportId: 'rpt_456' } },
    { type: 'export.xlsx', args: { reportId: 'rpt_456' } },
  ),
);
console.log(`Export workflow started: ${exports.id} (${exports.state})`);

// --- Batch: Bulk email with callbacks ---
const bulkEmail = await client.workflow(
  batch(
    [
      { type: 'email.send', args: ['user1@example.com', 'welcome'] },
      { type: 'email.send', args: ['user2@example.com', 'welcome'] },
      { type: 'email.send', args: ['user3@example.com', 'welcome'] },
    ],
    {
      on_complete: { type: 'batch.report', args: { batchName: 'welcome-emails' } },
      on_failure: { type: 'batch.alert', args: { channel: '#ops' } },
    },
  ),
);
console.log(`Batch workflow started: ${bulkEmail.id} (${bulkEmail.state})`);

// --- Composed: Chain with a parallel group step ---
const composedWorkflow = await client.workflow(
  chain(
    { type: 'order.validate', args: { orderId: 'ord_789' } },
    group(
      { type: 'payment.charge', args: { orderId: 'ord_789' } },
      { type: 'inventory.reserve', args: { orderId: 'ord_789' } },
    ),
    { type: 'notification.send', args: { orderId: 'ord_789', event: 'confirmed' } },
  ),
);
console.log(`Composed workflow: ${composedWorkflow.id}`);

// --- Check workflow status ---
const status = await client.getWorkflow(etl.id);
console.log(`ETL status: ${status.state} (${status.metadata.completed_count}/${status.metadata.job_count})`);

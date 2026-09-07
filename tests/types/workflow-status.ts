import type { WorkflowStatus } from '../../src/workflow.js';

const grpcStatusWithoutType: WorkflowStatus = {
  id: 'wf-external',
  state: 'running',
  metadata: {
    created_at: '2026-01-01T00:00:00.000Z',
    job_count: 1,
    completed_count: 0,
    failed_count: 0,
  },
};

const httpStatusWithType: WorkflowStatus = {
  ...grpcStatusWithoutType,
  type: 'chain',
};

void grpcStatusWithoutType;
void httpStatusWithType;

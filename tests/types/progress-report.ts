/**
 * Compile-time type tests for the canonical `ProgressReport` wire union
 * and the deprecated `LegacyProgressReport` shape (Finding: progress
 * public type). These are validated by `npm run test:types`
 * (`tsc -p tsconfig.type-tests.json`), which typechecks `tests/types/**`.
 */
import type { ProgressReport, LegacyProgressReport } from '../../src/index.js';

// --- Valid canonical variants -------------------------------------------

// progress-only (data omitted) is valid.
export const progressOnly: ProgressReport = { progress: 0.5 };

// data-only (progress omitted) is valid — ojs-progress.md section 6.1
// allows "at least one of `progress` or `data`".
export const dataOnly: ProgressReport = { data: { rows: 10 } };

// both present is valid.
export const both: ProgressReport = { progress: 0.75, data: { rows: 10 } };

// optional `checkpoint` is allowed on either variant (section 6.4).
export const withCheckpointOnProgress: ProgressReport = {
  progress: 0.9,
  checkpoint: { cursor: 'row-9000' },
};
export const withCheckpointOnData: ProgressReport = {
  data: { rows: 9000 },
  checkpoint: { cursor: 'row-9000' },
};

// --- Invalid canonical values -------------------------------------------

// @ts-expect-error -- an empty update has neither `progress` nor `data`, violating the union.
export const empty: ProgressReport = {};

// @ts-expect-error -- `checkpoint` alone (no `progress`/`data`) is not a valid update.
export const checkpointOnly: ProgressReport = { checkpoint: { cursor: 'x' } };

// --- Distinct from the deprecated legacy shape --------------------------

const canonical: ProgressReport = { progress: 0.5, data: { rows: 1 } };
// @ts-expect-error -- the canonical wire shape has no `job_id`/`percentage`.
export const notLegacy: LegacyProgressReport = canonical;

const legacy: LegacyProgressReport = { job_id: 'job-1', percentage: 50 };
// @ts-expect-error -- the legacy shape has neither `progress` nor `data`.
export const notCanonical: ProgressReport = legacy;

export type MergeStrategy = 'ours' | 'theirs' | 'union';

export interface ForkOptions {
  atTurn: number;
  branchName: string;
}

export interface ForkResult {
  branchId: string;
  contentId: string;
}

export interface MergeOptions {
  branchA: string;
  branchB: string;
  strategy: MergeStrategy;
}

export interface MergeResult {
  mergedId: string;
  conflicts: string[];
}

export interface ResumeDecision {
  approved: boolean;
  comment: string;
  metadata?: Record<string, unknown>;
}

export interface ReplayOptions {
  fromTurn: number;
  mockProviders?: Record<string, string>;
}

export interface Divergence {
  turn: number;
  expected: string;
  actual: string;
}

export interface ReplayResult {
  steps: number;
  divergences: Divergence[];
}

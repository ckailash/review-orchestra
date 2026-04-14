// Severity axes
export type Confidence = "verified" | "likely" | "possible" | "speculative";
export type Impact = "critical" | "functional" | "quality" | "nitpick";
export type PLevel = "p0" | "p1" | "p2" | "p3";

export type FindingStatus = "new" | "persisting";

export interface Finding {
  id: string;
  file: string;
  line: number;
  confidence: Confidence;
  impact: Impact;
  severity: PLevel;
  category: string;
  title: string;
  description: string;
  suggestion: string;
  reviewer: string;
  pre_existing: boolean;
  status?: FindingStatus;
  expected?: string;
  observed?: string;
  evidence?: string[];
}

export interface ReviewMetadata {
  reviewer: string;
  round: number;
  timestamp: string;
  files_reviewed: number;
  diff_scope: string;
}

export interface ReviewOutput {
  findings: Finding[];
  metadata: ReviewMetadata;
}

// Scope detection
export type ScopeType = "uncommitted" | "branch" | "pr" | "commit";

export interface DiffScope {
  type: ScopeType;
  diff: string;
  files: string[];
  baseBranch: string;
  description: string;
  commitMessages?: string;
  baseCommitSha?: string;
}

// Round tracking
export type RoundPhase = "reviewing" | "consolidating" | "complete";

export interface Round {
  number: number;
  phase: RoundPhase;
  reviews: Record<string, ReviewOutput>;
  consolidated: Finding[];
  worktreeHash: string;
  startedAt: string;
  completedAt: string | null;
}

// Session state
export type SessionStatus = "active" | "expired" | "completed";

export interface SessionState {
  sessionId: string;
  status: SessionStatus;
  currentRound: number;
  rounds: Round[];
  scope: DiffScope | null;
  worktreeHash: string;
  startedAt: string;
  completedAt: string | null;
}

// Review result
export interface ReviewResult {
  sessionId: string;
  round: number;
  findings: Finding[];
  resolvedFindings: Finding[];
  reviewerErrors: Array<{ reviewer: string; error: string }>;
  worktreeHash: string;
  scope: DiffScope;
  thresholds: ThresholdConfig;
  metadata: ReviewMetadata;
}

// Configuration
export interface ReviewerConfig {
  enabled: boolean;
  command: string;
  outputFormat: "json" | "text";
  model?: string;
}

export interface ThresholdConfig {
  stopAt: PLevel;
}

export interface FindingComparisonConfig {
  method: "llm" | "heuristic";
  model: string;
  timeoutMs: number;
  fallback: "heuristic" | "error";
}

export interface Config {
  reviewers: Record<string, ReviewerConfig>;
  thresholds: ThresholdConfig;
  findingComparison?: FindingComparisonConfig;
}

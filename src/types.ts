// Severity axes
export type Confidence = "verified" | "likely" | "possible" | "speculative";
export type Impact = "critical" | "functional" | "quality" | "nitpick";
export type PLevel = "p0" | "p1" | "p2" | "p3";

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
export type ScopeType = "uncommitted" | "branch" | "pr";

export interface DiffScope {
  type: ScopeType;
  diff: string;
  files: string[];
  baseBranch: string;
  description: string;
}

// Round tracking
export type RoundPhase =
  | "reviewing"
  | "consolidating"
  | "checking"
  | "fixing"
  | "escalating"
  | "complete";

export interface Round {
  number: number;
  phase: RoundPhase;
  reviews: Record<string, ReviewOutput>;
  consolidated: Finding[];
  fixReport: FixReport | null;
  startedAt: string;
  completedAt: string | null;
}

export interface FixReport {
  fixed: string[];
  skipped: string[];
  escalated: EscalationItem[];
}

export interface EscalationItem {
  findingId: string;
  reason: string;
  options: string[];
}

// Orchestration state
export type OrchestratorStatus =
  | "idle"
  | "running"
  | "paused"
  | "completed"
  | "failed";

export interface OrchestratorState {
  status: OrchestratorStatus;
  currentRound: number;
  rounds: Round[];
  scope: DiffScope | null;
  startedAt: string;
  completedAt: string | null;
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
  maxRounds: number;
}

export interface EscalationConfig {
  pauseOnAmbiguity: boolean;
  pauseOnConflict: boolean;
}

export interface Config {
  reviewers: Record<string, ReviewerConfig>;
  thresholds: ThresholdConfig;
  escalation: EscalationConfig;
}

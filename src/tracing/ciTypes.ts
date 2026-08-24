/** Types for the CI/CD evaluation run endpoints (`/ingest/ci-runs`). */

export interface CITestCase {
  index: number;
  /** Undefined when the dataset's `ci.exposeTestInputs` is false. */
  query?: string;
}

export interface CIRun {
  runId: string;
  datasetId: string;
  totalQuestions: number;
  testCases: CITestCase[];
  expiresAt: string;
}

export interface CIQuestionScore {
  questionIndex: number;
  rating: number;
  justification: string;
  passed: boolean;
  /** True when failFast tripped - the run is already finalized server-side. */
  gateFired: boolean;
  input?: any;
  output?: any;
}

export interface ThresholdViolation {
  questionIndex: number;
  metric: string;
  threshold: number;
  actual: number;
  questionText: string;
}

export interface CIRunResult {
  runId: string;
  gate: "pass" | "fail";
  passRate: number;
  totalQuestions: number;
  passedQuestions: number;
  scores: CIQuestionScore[];
  violations: ThresholdViolation[];
  gitContext?: Record<string, any>;
  finalizedAt?: string;
}

export interface CIRunStatus {
  runId: string;
  status: "in_progress" | "completed" | "failed";
  gate?: "pass" | "fail";
  resultsSubmitted: number;
  totalQuestions: number;
  createdAt: string;
  expiresAt: string;
  finalizedAt?: string;
  gitContext?: Record<string, any>;
}

/** Result of scoring an already-ingested trace (`POST /ingest/traces/:id/evaluate`). */
export interface TraceEvaluationResult {
  run_id?: string;
  trace_id?: string;
  rating?: number;
  justification?: string;
  status?: string;
  [key: string]: any;
}

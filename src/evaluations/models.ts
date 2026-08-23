/**
 * Wire types for Custom Agent Evaluations.
 *
 * The API speaks camelCase, so these interfaces mostly mirror the payloads verbatim; the
 * `parse*` helpers only normalise what actually differs (`_id` -> `id`, the nested
 * `sovereigntyIndex` object, similarity metrics that may arrive at the top level).
 */

// ---------------------------------------------------------------------------
// Observable trace (the lightweight per-result event list)
// ---------------------------------------------------------------------------

export interface TraceEvent {
  type: string;
  name?: string;
  summary?: string;
  /** Sent on the wire as `latency_ms`, matching agentx-python's TraceEvent. */
  latencyMs?: number;
  metadata?: Record<string, any>;
}

export interface ObservableTrace {
  events: TraceEvent[];
}

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

export interface SmokeTestSettings {
  enabled: boolean;
  count: number;
  guidance?: string;
}

export interface TestCase {
  query: string;
  expectedResults?: string;
  expectedCapabilities?: string[];
  expectedKnowledgeBase?: string[];
  expectedDelegations?: string[];
  judgeGuideline?: string;
  smokeTest?: SmokeTestSettings;
  expectedTrajectory?: { tools: string[]; mode: string };
  expectedRetrievalContext?: string | string[];
}

export interface DatasetQuestion {
  main_question: TestCase;
  follow_up_questions: TestCase[];
}

export interface Dataset {
  id: string;
  name: string;
  description?: string;
  numberOfRequests: number;
  acceptanceCriteria?: string;
  rejectionCriteria?: string;
  evaluationCriteria?: string;
  questions: DatasetQuestion[];
  status: string;
  versionId?: string;
  /** Hoisted from the nested `sovereigntyIndex` object when enabled. */
  sovereigntyModels: string[];
  raw: Record<string, any>;
}

export interface EvaluationSettings {
  id: string;
  name: string;
  description?: string;
  numberOfRequests: number;
  acceptanceCriteria?: string;
  rejectionCriteria?: string;
  evaluationCriteria?: string;
  judgePrompt?: string;
  judgeModel?: string;
  status: string;
  sovereigntyModels: string[];
  raw: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Evaluation subject
// ---------------------------------------------------------------------------

export type FrameworkKind =
  | "raw_python"
  | "openai"
  | "anthropic"
  | "google"
  | "langchain"
  | "llamaindex"
  | "crewai"
  | "autogen"
  | "n8n"
  | "flowise"
  | "other";

export type RuntimeKind = "local" | "ci" | "customer_hosted" | "low_code";

export interface EvaluationSubject {
  kind?: "custom_agent" | "agentx_agent" | "agentx_team";
  displayName?: string;
  /** Free-form; the Python SDK's own literal set is exported as `FrameworkKind`. */
  framework?: FrameworkKind | string;
  frameworkVersion?: string;
  runtime?: RuntimeKind;
  agentInstructions?: string;
  metadata?: Record<string, string | number | boolean>;
}

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------

export interface ModelInfo {
  name: string;
  display?: string;
  provider?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputCost?: number;
  outputCost?: number;
  knowledgeCutOff?: string;
  legacy?: boolean;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export interface ServerLimits {
  maxBatchSize: number;
  maxTraceBytesPerResult: number;
  maxMetadataBytesPerResult: number;
}

/**
 * Rating aggregate computed server-side from submitted results - available as soon as
 * results are scored, independent of the `.analyze()` step.
 */
export interface LiveStatistics {
  averageRating?: number;
  minRating?: number;
  maxRating?: number;
  ratedCount: number;
}

export interface SmokeTestVariantGroup {
  questionIndex: number;
  variants: string[];
}

export interface EvaluationRun {
  runId: string;
  datasetId: string;
  datasetVersionId?: string;
  status: string;
  limits: ServerLimits;
  smokeTestVariants?: SmokeTestVariantGroup[];
}

// ---------------------------------------------------------------------------
// Case / result
// ---------------------------------------------------------------------------

export interface EvaluationCase {
  caseId: string;
  questionIndex: number;
  runNumber: number;
  query: string;
  expectedResults?: string;
  expectedCapabilities?: string[];
  expectedKnowledgeBase?: string[];
  expectedDelegations?: string[];
  /** Sovereignty & Portability: the model this case should run on, when configured. */
  model?: string;
  isSmokeTestVariant: boolean;
  smokeTestVariantText?: string;
}

export interface ResultError {
  type: string;
  message: string;
  retryable: boolean;
}

export interface ResultTimings {
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface EvaluationResult {
  caseId: string;
  questionIndex: number;
  runNumber: number;
  input: Record<string, any>;
  output?: Record<string, any>;
  observableTrace?: ObservableTrace;
  error?: ResultError;
  timings?: ResultTimings;
  metadata?: Record<string, any>;
  idempotencyKey?: string;
  /** Links this result to a trace ingested via `tracer.trace(name, { sync: true })`. */
  traceId?: string;
  /** What the agent actually retrieved for this case - the {context} RAG judges grade against. */
  retrievalContext?: string | string[];
  isSmokeTestVariant?: boolean;
  smokeTestVariantText?: string;
}

export interface ScoredResult {
  idempotencyKey: string;
  rating?: number;
  justification?: string;
}

export interface BatchAppendResponse {
  runId: string;
  batchId: string;
  accepted: number;
  duplicates: number;
  failedValidation: number;
  status: string;
  scoredResults: ScoredResult[];
  liveStatistics?: LiveStatistics;
}

// ---------------------------------------------------------------------------
// Analysis / report
// ---------------------------------------------------------------------------

export interface ReportStatistics {
  numberOfRuns: number;
  averageRating: number;
  minRating: number;
  maxRating: number;
  cosineSimilarity?: number;
  jaccardSimilarity?: number;
  bleuScore?: number;
  rougeScore?: number;
}

export interface ReportRecommendation {
  title?: string;
  description?: string;
  priority?: string;
  [key: string]: any;
}

export interface SovereigntyModelMetrics {
  model?: string;
  averageRating?: number;
  [key: string]: any;
}

export interface SovereigntyIndex {
  enabled: boolean;
  models: SovereigntyModelMetrics[];
}

export interface Report {
  runId: string;
  datasetId: string;
  status: string;
  summary?: string;
  consistencyScore?: number;
  instructionAdherence?: Record<string, any>;
  responsePatterns?: Record<string, any>;
  reasoningAnalysis?: Record<string, any>;
  toolUsageAnalysis?: Record<string, any>;
  strengths: string[];
  weaknesses: string[];
  overallRating?: string;
  recommendations: ReportRecommendation[];
  statistics?: ReportStatistics;
  lowScoringCases: Record<string, any>[];
  sovereigntyIndex?: SovereigntyIndex;
  dashboardUrl?: string;
  /** Convenience accessors, lifted from `statistics`. */
  averageRating?: number;
  cosineSimilarity?: number;
  jaccardSimilarity?: number;
  bleuScore?: number;
  rougeScore?: number;
  raw: Record<string, any>;
}

export interface AnalysisLevelProgress {
  total: number;
  completed: number;
  failed: number;
  percentage: number;
}

export interface AnalysisProgress {
  overallPercentage: number;
  currentLevel?: string;
  levels: Record<string, AnalysisLevelProgress>;
}

export interface AnalysisFailureReason {
  code: string;
  message: string;
  retryable: boolean;
}

export interface AnalysisStatus {
  jobId?: string;
  status: string;
  progress: AnalysisProgress;
  failureReason?: AnalysisFailureReason;
  warnings: Record<string, any>[];
  /** True once `status` is one of "completed", "partially_failed", "failed". */
  isTerminal: boolean;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function sovereigntyModels(data: any): string[] {
  const sov = data?.sovereigntyIndex || data?.sovereignty_index;
  if (sov && typeof sov === "object" && sov.enabled && Array.isArray(sov.models)) {
    return [...sov.models];
  }
  return [];
}

export function parseDataset(data: any): Dataset {
  return {
    id: data._id ?? data.id,
    name: data.name,
    description: data.description ?? undefined,
    numberOfRequests: data.numberOfRequests ?? 1,
    acceptanceCriteria: data.acceptanceCriteria ?? undefined,
    rejectionCriteria: data.rejectionCriteria ?? undefined,
    evaluationCriteria: data.evaluationCriteria ?? undefined,
    questions: data.questions ?? [],
    status: data.status ?? "published",
    versionId: data.versionId ?? undefined,
    sovereigntyModels: sovereigntyModels(data),
    raw: data,
  };
}

export function parseEvaluationSettings(data: any): EvaluationSettings {
  return {
    id: data._id ?? data.id,
    name: data.name,
    description: data.description ?? undefined,
    numberOfRequests: data.numberOfRequests ?? 1,
    acceptanceCriteria: data.acceptanceCriteria ?? undefined,
    rejectionCriteria: data.rejectionCriteria ?? undefined,
    evaluationCriteria: data.evaluationCriteria ?? undefined,
    judgePrompt: data.judgePrompt ?? undefined,
    judgeModel: data.judgeModel ?? undefined,
    status: data.status ?? "published",
    sovereigntyModels: sovereigntyModels(data),
    raw: data,
  };
}

export function parseEvaluationRun(data: any): EvaluationRun {
  const limits = data.limits ?? {};
  return {
    runId: data.runId,
    datasetId: data.datasetId,
    datasetVersionId: data.datasetVersionId ?? undefined,
    status: data.status ?? "in_progress",
    limits: {
      maxBatchSize: limits.maxBatchSize ?? 10,
      maxTraceBytesPerResult: limits.maxTraceBytesPerResult ?? 20000,
      maxMetadataBytesPerResult: limits.maxMetadataBytesPerResult ?? 4000,
    },
    smokeTestVariants: data.smokeTestVariants ?? undefined,
  };
}

export function parseLiveStatistics(data: any): LiveStatistics | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  return {
    averageRating: data.averageRating ?? undefined,
    minRating: data.minRating ?? undefined,
    maxRating: data.maxRating ?? undefined,
    ratedCount: data.ratedCount ?? 0,
  };
}

export function parseBatchAppendResponse(data: any): BatchAppendResponse {
  return {
    runId: data.runId,
    batchId: data.batchId,
    accepted: data.accepted ?? 0,
    duplicates: data.duplicates ?? 0,
    failedValidation: data.failedValidation ?? 0,
    status: data.status ?? "in_progress",
    scoredResults: data.scoredResults ?? [],
    liveStatistics: parseLiveStatistics(data.liveStatistics),
  };
}

export function parseModelInfo(data: any): ModelInfo {
  return {
    name: data.name,
    display: data.display ?? undefined,
    provider: data.provider ?? undefined,
    contextWindow: data.contextWindow ?? undefined,
    maxOutputTokens: data.maxOutputTokens ?? undefined,
    inputCost: data.inputCost ?? undefined,
    outputCost: data.outputCost ?? undefined,
    knowledgeCutOff: data.knowledgeCutOff ?? undefined,
    legacy: data.legacy ?? undefined,
  };
}

const SIMILARITY_KEYS: [string, string][] = [
  ["cosineSimilarity", "cosine_similarity"],
  ["jaccardSimilarity", "jaccard_similarity"],
  ["bleuScore", "bleu_score"],
  ["rougeScore", "rouge_score"],
];

export function parseReport(data: any): Report {
  const stats: Record<string, any> = { ...(data.statistics ?? {}) };
  // The backend may send similarity metrics at the top level or nested under statistics -
  // normalise so the nested form is always populated when either is present.
  for (const [camel, snake] of SIMILARITY_KEYS) {
    if (stats[camel] === undefined && stats[snake] !== undefined) {
      stats[camel] = stats[snake];
    }
    if (stats[camel] === undefined) {
      const top = data[camel] ?? data[snake];
      if (top !== undefined) {
        stats[camel] = top;
      }
    }
  }
  const statistics: ReportStatistics | undefined = Object.keys(stats).length
    ? {
        numberOfRuns: stats.numberOfRuns ?? 0,
        averageRating: stats.averageRating ?? 0,
        minRating: stats.minRating ?? 0,
        maxRating: stats.maxRating ?? 0,
        cosineSimilarity: stats.cosineSimilarity ?? undefined,
        jaccardSimilarity: stats.jaccardSimilarity ?? undefined,
        bleuScore: stats.bleuScore ?? undefined,
        rougeScore: stats.rougeScore ?? undefined,
      }
    : undefined;

  return {
    runId: data.runId,
    datasetId: data.datasetId ?? "",
    status: data.status ?? "completed",
    summary: data.summary ?? undefined,
    consistencyScore: data.consistencyScore ?? undefined,
    instructionAdherence: data.instructionAdherence ?? undefined,
    responsePatterns: data.responsePatterns ?? undefined,
    reasoningAnalysis: data.reasoningAnalysis ?? undefined,
    toolUsageAnalysis: data.toolUsageAnalysis ?? undefined,
    strengths: data.strengths ?? [],
    weaknesses: data.weaknesses ?? [],
    overallRating: data.overallRating ?? undefined,
    recommendations: data.recommendations ?? [],
    statistics,
    lowScoringCases: data.lowScoringCases ?? [],
    sovereigntyIndex: data.sovereigntyIndex ?? undefined,
    dashboardUrl: data.dashboardUrl ?? undefined,
    averageRating: statistics?.averageRating,
    cosineSimilarity: statistics?.cosineSimilarity,
    jaccardSimilarity: statistics?.jaccardSimilarity,
    bleuScore: statistics?.bleuScore,
    rougeScore: statistics?.rougeScore,
    raw: data,
  };
}

const TERMINAL_STATUSES = new Set(["completed", "partially_failed", "failed"]);

export function parseAnalysisStatus(data: any): AnalysisStatus {
  const progress = data?.progress ?? {};
  const status = data?.status ?? "not_started";
  return {
    jobId: data?.jobId ?? undefined,
    status,
    progress: {
      overallPercentage: progress.overallPercentage ?? 0,
      currentLevel: progress.currentLevel ?? undefined,
      levels: progress.levels ?? {},
    },
    failureReason: data?.failureReason ?? undefined,
    warnings: data?.warnings ?? [],
    isTerminal: TERMINAL_STATUSES.has(status),
  };
}

/** Serialise a result into the wire payload accepted by `POST /runs/:runId/results`. */
export function resultToPayload(result: EvaluationResult): Record<string, any> {
  const payload: Record<string, any> = {
    caseId: result.caseId,
    questionIndex: result.questionIndex,
    runNumber: result.runNumber,
    input: result.input,
  };
  if (result.output !== undefined) {
    payload.output = result.output;
  }
  if (result.observableTrace) {
    payload.observableTrace = {
      events: result.observableTrace.events.map((e) => ({
        type: e.type,
        ...(e.name !== undefined ? { name: e.name } : {}),
        ...(e.summary !== undefined ? { summary: e.summary } : {}),
        ...(e.latencyMs !== undefined ? { latency_ms: e.latencyMs } : {}),
        ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
      })),
    };
  }
  if (result.error) {
    payload.error = result.error;
  }
  if (result.timings) {
    const timings: Record<string, any> = {};
    if (result.timings.latencyMs !== undefined) {
      timings.latencyMs = result.timings.latencyMs;
    }
    if (result.timings.inputTokens !== undefined) {
      timings.inputTokens = result.timings.inputTokens;
    }
    if (result.timings.outputTokens !== undefined) {
      timings.outputTokens = result.timings.outputTokens;
    }
    if (Object.keys(timings).length) {
      payload.timings = timings;
    }
  }
  if (result.metadata) {
    payload.metadata = result.metadata;
  }
  if (result.idempotencyKey) {
    payload.idempotencyKey = result.idempotencyKey;
  }
  if (result.traceId) {
    payload.traceId = result.traceId;
  }
  if (result.retrievalContext !== undefined && result.retrievalContext !== null) {
    payload.retrievalContext = result.retrievalContext;
  }
  if (result.isSmokeTestVariant !== undefined) {
    payload.isSmokeTestVariant = result.isSmokeTestVariant;
  }
  if (result.smokeTestVariantText !== undefined) {
    payload.smokeTestVariantText = result.smokeTestVariantText;
  }
  return payload;
}

import { AgentX, AgentXOptions } from "./agentx";
import { Agent } from "./resources/agent";
import { Conversation, ChatResponse, Message } from "./resources/conversation";
import { Workforce, User } from "./resources/workforce";
import { VERSION } from "./version";

// Export the main class and version
export { AgentX, VERSION };

// Export types and interfaces
export type { ChatResponse, Message, AgentXOptions };
export { Agent, Conversation, Workforce, User };

// Errors
export {
  AgentXError,
  AgentXAuthError,
  AgentXConnectionError,
  AgentXAPIError,
  AgentXValidationError,
  DatasetNotFound,
  CINotEnabled,
  CIRunExpired,
  CIGateFailure,
} from "./errors";

// Utilities shared by the tracing and evaluations clients
export { apiBase, getHeaders, DEFAULT_API_BASE } from "./util";

// Tracing
export {
  Tracer,
  TraceSpan,
  ToolCallRecorder,
  RetrievalRecorder,
  IngestClient,
} from "./tracing";
export type {
  TraceOptions,
  ChildSpanOptions,
  ToolCallOptions,
  RetrievalOptions,
  LlmCallOptions,
  IngestClientOptions,
  CIRun,
  CIRunResult,
  CIRunStatus,
  CIQuestionScore,
  CITestCase,
  ThresholdViolation,
  TraceEvaluationResult,
} from "./tracing";

// Evaluations
export {
  EvaluationsClient,
  EvaluationsRunner,
  EvaluationRunContext,
  EvaluationRunChain,
  GateResult,
  DatasetBuilder,
  DatasetClient,
  EvaluationSettingsBuilder,
  EvaluationSettingsClient,
  RawCallableAdapter,
  PrecomputedAdapter,
  HttpEndpointAdapter,
  printReport,
  normalizeResult,
  normalizeError,
} from "./evaluations";
export type {
  AdapterLike,
  AgentFunction,
  AnalyzeOptions,
  ExecuteOptions,
  GateOptions,
  DatasetConfig,
  AddCaseOptions,
  EvaluationSettingsConfig,
  CodeScorer,
  EvaluationsClientOptions,
  Dataset,
  DatasetQuestion,
  TestCase,
  EvaluationSettings,
  EvaluationSubject,
  EvaluationRun,
  EvaluationCase,
  EvaluationResult,
  ResultError,
  ResultTimings,
  LiveStatistics,
  ModelInfo,
  Report,
  ReportStatistics,
  AnalysisStatus,
  ObservableTrace,
  TraceEvent,
  FrameworkKind,
  RuntimeKind,
} from "./evaluations";

// Export the default instance
export default AgentX;

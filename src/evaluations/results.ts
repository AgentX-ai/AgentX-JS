import { EvaluationCase, EvaluationResult, ResultError, ResultTimings } from "./models";
import { buildTrace } from "./observableTrace";
import { redact } from "./redaction";

function toInt(value: any): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

function isPreparedResult(raw: any): raw is EvaluationResult {
  return Boolean(raw) && typeof raw === "object" && typeof raw.caseId === "string" && raw.input !== undefined;
}

/**
 * Turn whatever the caller's function returned into a normalised EvaluationResult.
 *
 * Accepted shapes (same as agentx-python's `normalize_result`):
 *  - `string` - the agent's answer
 *  - `{ output | text | response, trace?, traceId?, retrievalContext?, metadata?, inputTokens?, outputTokens?, error? }`
 *  - a fully-formed `EvaluationResult` (detected by its `caseId`)
 */
export function normalizeResult(caseItem: EvaluationCase, raw: any, latencyMs?: number): EvaluationResult {
  if (isPreparedResult(raw)) {
    return {
      ...raw,
      caseId: caseItem.caseId,
      questionIndex: caseItem.questionIndex,
      runNumber: caseItem.runNumber,
      isSmokeTestVariant: caseItem.isSmokeTestVariant,
      smokeTestVariantText: caseItem.smokeTestVariantText,
    };
  }

  let output: Record<string, any> | undefined;
  let observableTrace;
  let traceId: string | undefined;
  let retrievalContext: string | string[] | undefined;
  let metadata: Record<string, any> | undefined;
  let error: ResultError | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  if (typeof raw === "string") {
    output = { text: raw };
  } else if (raw && typeof raw === "object") {
    const text = raw.output ?? raw.text ?? raw.response ?? "";
    if (text && typeof text === "object") {
      output = text;
    } else {
      output = text ? { text: String(text) } : undefined;
    }

    observableTrace = buildTrace(raw.trace ?? raw.observableTrace ?? raw.observable_trace);
    const rawTraceId = raw.traceId ?? raw.trace_id;
    traceId = rawTraceId ? String(rawTraceId) : undefined;
    retrievalContext = raw.retrievalContext ?? raw.retrieval_context;

    const rawMetadata = raw.metadata;
    if (rawMetadata && typeof rawMetadata === "object") {
      metadata = redact(rawMetadata);
    }

    // Top-level token counts win; metadata is the fallback.
    inputTokens = toInt(raw.inputTokens ?? raw.input_tokens);
    outputTokens = toInt(raw.outputTokens ?? raw.output_tokens);
    if (inputTokens === undefined && rawMetadata && typeof rawMetadata === "object") {
      inputTokens = toInt(rawMetadata.input_tokens ?? rawMetadata.inputTokens ?? rawMetadata.prompt_tokens);
    }
    if (outputTokens === undefined && rawMetadata && typeof rawMetadata === "object") {
      outputTokens = toInt(rawMetadata.output_tokens ?? rawMetadata.outputTokens ?? rawMetadata.completion_tokens);
    }

    const rawError = raw.error;
    if (rawError) {
      error =
        typeof rawError === "object"
          ? {
              type: rawError.type ?? "Error",
              message: rawError.message ?? String(rawError),
              retryable: rawError.retryable ?? false,
            }
          : { type: "Error", message: String(rawError), retryable: false };
      if (output === undefined) {
        output = { text: "" };
      }
    }
  } else {
    output = { text: raw === null || raw === undefined ? "" : String(raw) };
  }

  const hasTimings = latencyMs !== undefined || inputTokens !== undefined || outputTokens !== undefined;
  const timings: ResultTimings | undefined = hasTimings
    ? { latencyMs, inputTokens, outputTokens }
    : undefined;

  return {
    caseId: caseItem.caseId,
    questionIndex: caseItem.questionIndex,
    runNumber: caseItem.runNumber,
    input: { query: caseItem.query },
    output,
    observableTrace,
    error,
    timings,
    metadata,
    traceId,
    retrievalContext,
    isSmokeTestVariant: caseItem.isSmokeTestVariant,
    smokeTestVariantText: caseItem.smokeTestVariantText,
  };
}

/** Build a failed-case result from a thrown error. */
export function normalizeError(caseItem: EvaluationCase, err: unknown, latencyMs?: number): EvaluationResult {
  const error: ResultError = {
    type: err instanceof Error ? err.name : "Error",
    message: err instanceof Error ? err.message : String(err),
    retryable: false,
  };
  return {
    caseId: caseItem.caseId,
    questionIndex: caseItem.questionIndex,
    runNumber: caseItem.runNumber,
    input: { query: caseItem.query },
    output: { text: "" },
    error,
    timings: latencyMs !== undefined ? { latencyMs } : undefined,
    isSmokeTestVariant: caseItem.isSmokeTestVariant,
    smokeTestVariantText: caseItem.smokeTestVariantText,
  };
}

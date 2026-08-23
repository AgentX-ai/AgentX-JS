/**
 * AgentX SDK error types.
 *
 * Mirrors agentx-python's `agentx/exceptions.py` plus the evaluations-specific
 * errors that live in `agentx/evaluations/client.py`.
 *
 * Every error extends `Error`, so code that only ever caught `Error` keeps working.
 */

export class AgentXError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Invalid or missing API key. */
export class AgentXAuthError extends AgentXError {}

/** The AgentX API (or self-host engine) could not be reached at the configured baseUrl. */
export class AgentXConnectionError extends AgentXError {}

/** Unexpected API error. `statusCode` is undefined for transport failures. */
export class AgentXAPIError extends AgentXError {
  public statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** Request body was rejected by the API (HTTP 422). */
export class AgentXValidationError extends AgentXAPIError {}

/** Dataset ID does not exist or is not accessible from this API key. */
export class DatasetNotFound extends AgentXError {}

/** Dataset exists but `ci.enabled` is false. Enable CI in the dataset settings. */
export class CINotEnabled extends AgentXError {}

/** CI run was not finalized within the 2-hour window. */
export class CIRunExpired extends AgentXError {}

/** Gate result is "fail". Thrown when `failOnGate: true`. */
export class CIGateFailure extends AgentXError {
  public result: { runId: string; gate: string; passRate: number; passedQuestions: number; totalQuestions: number };

  constructor(result: {
    runId: string;
    gate: string;
    passRate: number;
    passedQuestions: number;
    totalQuestions: number;
  }) {
    super(
      `CI gate failed: ${Math.round(result.passRate * 100)}% passed ` +
        `(${result.passedQuestions}/${result.totalQuestions} questions)`
    );
    this.result = result;
  }
}

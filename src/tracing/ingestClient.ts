import axios, { AxiosInstance, AxiosResponse } from "axios";

import { apiBase, sleep, userAgent } from "../util";
import { AgentXAPIError, CINotEnabled, DatasetNotFound } from "../errors";
import {
  CIQuestionScore,
  CIRun,
  CIRunResult,
  CIRunStatus,
  CITestCase,
  ThresholdViolation,
  TraceEvaluationResult,
} from "./ciTypes";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = [1000, 2000, 4000];
const QUEUE_MAX = 500;

export interface IngestClientOptions {
  apiKey: string;
  sdkVersion?: string;
  baseUrl?: string;
  workspaceId?: string;
  /** Drain any queued traces when the event loop empties. Default true. */
  flushOnExit?: boolean;
}

/**
 * Non-blocking client for `POST /ingest/traces`.
 *
 * Traces are queued in memory and drained by a background task so they never block the
 * agent's critical path. The Python SDK uses a daemon thread; Node is single-threaded, so
 * this drains on the event loop instead - which means a process that exits immediately
 * after its last trace should `await client.tracer.flush()` (or leave `flushOnExit` on).
 */
export class IngestClient {
  private readonly apiKey: string;
  private readonly workspaceId?: string;
  private readonly endpoint: string;
  private readonly baseUrl: string;
  private readonly http: AxiosInstance;

  private queue: Record<string, any>[] = [];
  private draining: Promise<void> | null = null;
  private deliveryWarningEmitted = false;

  constructor(options: IngestClientOptions) {
    if (!options.apiKey) {
      throw new Error("AGENTX_API_KEY is required");
    }
    this.apiKey = options.apiKey;
    this.workspaceId = options.workspaceId || process.env.AGENTX_WORKSPACE_ID || undefined;
    this.baseUrl = apiBase(options.baseUrl);
    this.endpoint = `${this.baseUrl}/ingest/traces`;

    this.http = axios.create({
      headers: {
        "x-api-key": this.apiKey,
        "Content-Type": "application/json",
        "User-Agent": options.sdkVersion ? `agentx-js/${options.sdkVersion}` : userAgent(),
      },
      // Errors are handled explicitly, never thrown from the transport layer.
      validateStatus: () => true,
    });

    if (options.flushOnExit !== false && typeof process !== "undefined" && process.on) {
      process.on("beforeExit", () => {
        if (this.queue.length || this.draining) {
          void this.flush();
        }
      });
    }
  }

  // ------------------------------------------------------------------
  // Public
  // ------------------------------------------------------------------

  /** Add a trace payload to the send queue. Never blocks; drops silently on overflow. */
  enqueue(payload: Record<string, any>): void {
    if (this.queue.length >= QUEUE_MAX) {
      return; // queue full - trace dropped, same as the Python SDK
    }
    this.queue.push(this.withWorkspace(payload));
    void this.startDraining();
  }

  /** Resolve once every queued trace has been sent (or `timeoutMs` elapses). */
  async flush(timeoutMs = 5000): Promise<void> {
    const drain = this.startDraining();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
    });
    try {
      await Promise.race([drain, timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Send a trace synchronously and return the ingested trace's id (or undefined on failure).
   *
   * Used by `tracer.trace(name, { sync: true })` when the caller needs the trace id back
   * immediately - e.g. to attach it to an evaluation result. Never throws: a failed send
   * just means no trace id, it never breaks the caller's run over a tracing hiccup.
   */
  async sendTraceSync(payload: Record<string, any>): Promise<string | undefined> {
    const body = await this.sendTraceSyncDetailed(payload);
    return body?.trace_id;
  }

  /**
   * `sendTraceSync` returning the full response body - the engine includes `deduped: true`
   * for a span it had already ingested, which importers use to skip re-evaluating.
   */
  async sendTraceSyncDetailed(payload: Record<string, any>): Promise<Record<string, any> | undefined> {
    let resp: AxiosResponse;
    try {
      resp = await this.http.post(this.endpoint, this.withWorkspace(payload), { timeout: 10000 });
    } catch (err) {
      this.warnDelivery(describeTransportError(err));
      return undefined;
    }
    if (resp.status < 200 || resp.status >= 300) {
      this.warnDelivery(`HTTP ${Number(resp.status)}`, resp.status);
      return undefined;
    }
    const body = resp.data;
    return body && typeof body === "object" && body.trace_id ? body : undefined;
  }

  /**
   * Synchronously score a previously-ingested trace against a dataset. The trace's recorded
   * input/output are used as the pre-computed agent result - the agent is NOT re-run.
   */
  async evaluateTrace(
    traceId: string,
    datasetId: string,
    options: { questionIndex?: number } = {}
  ): Promise<TraceEvaluationResult> {
    const payload: Record<string, any> = { datasetId };
    if (options.questionIndex !== undefined) {
      payload.question_index = options.questionIndex;
    }
    const resp = await this.http.post(
      `${this.baseUrl}/ingest/traces/${traceId}/evaluate`,
      this.withWorkspace(payload),
      { timeout: 60000 }
    );
    this.raiseForCIStatus(resp);
    return resp.data;
  }

  // ------------------------------------------------------------------
  // CI/CD evaluation endpoints (synchronous)
  // ------------------------------------------------------------------

  async createCiRun(
    datasetId: string,
    options: {
      agentName?: string;
      passRateThreshold?: number;
      gitContext?: Record<string, any>;
      workspaceId?: string;
    } = {}
  ): Promise<CIRun> {
    const payload: Record<string, any> = { dataset_id: datasetId };
    if (options.agentName) {
      payload.agent_name = options.agentName;
    }
    if (options.passRateThreshold !== undefined) {
      payload.pass_rate_threshold = options.passRateThreshold;
    }
    if (options.gitContext) {
      payload.git_context = options.gitContext;
    }
    const workspace = options.workspaceId || this.workspaceId;
    if (workspace) {
      payload.workspaceId = workspace;
    }

    const resp = await this.http.post(`${this.baseUrl}/ingest/ci-runs`, payload, { timeout: 30000 });
    this.raiseForCIStatus(resp);
    const data = resp.data;
    const testCases: CITestCase[] = (data.test_cases || []).map((tc: any) => ({
      index: tc.index,
      query: tc.query ?? undefined,
    }));
    return {
      runId: data.run_id,
      datasetId: data.dataset_id,
      totalQuestions: data.total_questions,
      testCases,
      expiresAt: data.expires_at,
    };
  }

  async submitCiResult(
    runId: string,
    questionIndex: number,
    output: any,
    options: { input?: any; latencyMs?: number } = {}
  ): Promise<CIQuestionScore> {
    const payload: Record<string, any> = { question_index: questionIndex, output };
    if (options.input !== undefined) {
      payload.input = options.input;
    }
    if (options.latencyMs !== undefined) {
      payload.latency_ms = options.latencyMs;
    }
    const resp = await this.http.post(`${this.baseUrl}/ingest/ci-runs/${runId}/results`, payload, {
      timeout: 60000,
    });
    this.raiseForCIStatus(resp);
    const data = resp.data;
    return {
      questionIndex: data.question_index,
      rating: data.rating,
      justification: data.justification,
      passed: data.passed,
      gateFired: data.gate_fired ?? false,
    };
  }

  async finalizeCiRun(runId: string): Promise<CIRunResult> {
    const resp = await this.http.post(`${this.baseUrl}/ingest/ci-runs/${runId}/finalize`, {}, { timeout: 60000 });
    this.raiseForCIStatus(resp);
    return IngestClient.parseCiResult(resp.data);
  }

  async getCiRun(runId: string): Promise<CIRunStatus> {
    const resp = await this.http.get(`${this.baseUrl}/ingest/ci-runs/${runId}`, { timeout: 15000 });
    this.raiseForCIStatus(resp);
    const data = resp.data;
    return {
      runId: data.run_id,
      status: data.status,
      gate: data.gate ?? undefined,
      resultsSubmitted: data.results_submitted,
      totalQuestions: data.total_questions,
      createdAt: data.created_at,
      expiresAt: data.expires_at,
      finalizedAt: data.finalized_at ?? undefined,
      gitContext: data.git_context ?? undefined,
    };
  }

  /** Fetch test case queries for a dataset without creating a CI run. */
  async getDatasetTestCases(datasetId: string, options: { workspaceId?: string } = {}): Promise<any> {
    const workspace = options.workspaceId || this.workspaceId;
    const resp = await this.http.get(`${this.baseUrl}/ingest/datasets/${datasetId}/test-cases`, {
      params: workspace ? { workspaceId: workspace } : undefined,
      timeout: 15000,
    });
    this.raiseForCIStatus(resp);
    return resp.data;
  }

  // ------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------

  private withWorkspace(payload: Record<string, any>): Record<string, any> {
    return this.workspaceId ? { ...payload, workspaceId: this.workspaceId } : payload;
  }

  private startDraining(): Promise<void> {
    if (!this.draining) {
      this.draining = this.drain().finally(() => {
        this.draining = null;
      });
    }
    return this.draining;
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const payload = this.queue.shift()!;
      try {
        await this.send(payload);
      } catch {
        // fire-and-forget: a failed trace never propagates into the caller's code
      }
    }
  }

  private async send(payload: Record<string, any>): Promise<void> {
    let lastError = "";
    for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length + 1; attempt++) {
      if (attempt > 0) {
        await sleep(RETRY_BACKOFF_MS[attempt - 1]);
      }
      let resp: AxiosResponse;
      try {
        resp = await this.http.post(this.endpoint, payload, { timeout: 10000 });
      } catch (err) {
        lastError = describeTransportError(err);
        continue;
      }
      if (RETRYABLE_STATUS.has(resp.status) && attempt < MAX_RETRIES - 1) {
        lastError = `HTTP ${Number(resp.status)}`;
        continue;
      }
      if (resp.status < 200 || resp.status >= 300) {
        this.warnDelivery(`HTTP ${Number(resp.status)}`, resp.status);
      }
      return;
    }
    this.warnDelivery(lastError);
  }

  /**
   * First delivery failure logs a warning - the tracer is fire-and-forget by design, so a
   * wrong baseUrl or rejected key would otherwise fail silently forever with an empty
   * dashboard as the only symptom. `client.ping()` is the fail-fast startup check.
   *
   * `detail` is always one of the fixed labels from `describeTransportError` or an HTTP
   * status: raw error text is never logged, since an error raised by the HTTP client can
   * carry the request headers - and with them the API key.
   */
  private warnDelivery(detail: string, status?: number): void {
    if (this.deliveryWarningEmitted) {
      return;
    }
    this.deliveryWarningEmitted = true;
    const hint =
      status === 401 || status === 403
        ? "the API key was rejected - check apiKey / AGENTX_API_KEY (for self-host, copy the 'Default project API key' from the engine's startup log)"
        : "check baseUrl / AGENTX_API_BASE_URL (for self-host it should look like http://localhost:4700/api/v1)";
    console.warn(
      `[agentx] traces are NOT being delivered to ${redactUrl(this.endpoint)} (${detail}) - ${hint}. ` +
        "Call client.ping() at startup to fail fast on misconfiguration. This warning is only shown once."
    );
  }

  private static parseCiResult(data: any): CIRunResult {
    const scores: CIQuestionScore[] = (data.scores || []).map((s: any) => ({
      questionIndex: s.question_index,
      rating: s.rating,
      justification: s.justification,
      passed: s.passed,
      gateFired: s.gate_fired ?? false,
      input: s.input,
      output: s.output,
    }));
    const violations: ThresholdViolation[] = (data.violations || []).map((v: any) => ({
      questionIndex: v.question_index,
      metric: v.metric,
      threshold: v.threshold,
      actual: v.actual,
      questionText: v.question_text ?? "",
    }));
    return {
      runId: data.run_id,
      gate: data.gate,
      passRate: data.pass_rate,
      totalQuestions: data.total_questions,
      passedQuestions: data.passed_questions,
      scores,
      violations,
      finalizedAt: data.finalized_at ?? undefined,
    };
  }

  private raiseForCIStatus(resp: AxiosResponse): void {
    if (resp.status >= 200 && resp.status < 300) {
      return;
    }
    let message: string;
    const body = resp.data;
    if (body && typeof body === "object") {
      message = body.message || body.error || JSON.stringify(body).slice(0, 200);
    } else {
      message = String(body ?? "").slice(0, 200);
    }
    if (resp.status === 404) {
      throw new DatasetNotFound(message);
    }
    if (resp.status === 400 && message.toLowerCase().includes("ci")) {
      throw new CINotEnabled(message);
    }
    throw new AgentXAPIError(message, resp.status);
  }
}

/**
 * A fixed label for a transport failure, never the error's own text.
 *
 * An HTTP-client error carries the failed request's config, headers included, so
 * interpolating its message into a log risks printing the API key. Known Node/axios codes
 * are mapped to constants of their own so the useful signal survives without the payload.
 */
const TRANSPORT_LABELS: Record<string, string> = {
  ECONNREFUSED: "ECONNREFUSED",
  ECONNRESET: "ECONNRESET",
  ECONNABORTED: "ECONNABORTED",
  ENOTFOUND: "ENOTFOUND",
  ETIMEDOUT: "ETIMEDOUT",
  EHOSTUNREACH: "EHOSTUNREACH",
  ENETUNREACH: "ENETUNREACH",
  EAI_AGAIN: "EAI_AGAIN",
  EPIPE: "EPIPE",
  EPROTO: "EPROTO",
  CERT_HAS_EXPIRED: "CERT_HAS_EXPIRED",
  DEPTH_ZERO_SELF_SIGNED_CERT: "DEPTH_ZERO_SELF_SIGNED_CERT",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
};

function describeTransportError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return (typeof code === "string" && TRANSPORT_LABELS[code]) || "network error";
}

/**
 * The endpoint with any userinfo removed, for logging. A base URL of the
 * `https://user:secret@host` form would otherwise put a credential in the log line.
 */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      return `${parsed.origin}${parsed.pathname}`;
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "the configured endpoint";
  }
}

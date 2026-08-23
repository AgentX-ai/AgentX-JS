import axios, { AxiosInstance, AxiosResponse, Method } from "axios";

import { apiBase, sleep, userAgent, uuid4 } from "../util";
import { VERSION } from "../version";
import { AgentXAPIError, AgentXAuthError, AgentXValidationError } from "../errors";
import {
  AnalysisStatus,
  BatchAppendResponse,
  Dataset,
  EvaluationResult,
  EvaluationRun,
  EvaluationSettings,
  EvaluationSubject,
  ModelInfo,
  Report,
  parseAnalysisStatus,
  parseBatchAppendResponse,
  parseDataset,
  parseEvaluationRun,
  parseEvaluationSettings,
  parseModelInfo,
  parseReport,
  resultToPayload,
} from "./models";
import { DatasetClient } from "./datasets";
import { EvaluationSettingsClient } from "./evaluationSettings";

const EVAL_SUFFIX = "/custom-agent-evaluations";
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = [1000, 2000, 4000];
export const SDK_NAME = "agentx-js";

/**
 * The self-host analyze route judges every result before it responds, so the client has to
 * wait out the whole job on one connection. Matches the runner's own default timeout.
 */
const SELF_HOST_ANALYZE_TIMEOUT_MS = 1_800_000;

export interface EvaluationsClientOptions {
  apiKey: string;
  sdkVersion?: string;
  baseUrl?: string;
  workspaceId?: string;
}

interface RequestOptions {
  timeoutMs?: number;
  /** Overrides the `/custom-agent-evaluations` prefix for routes on the dashboard router. */
  base?: string;
  /** Disable the backoff loop - required for slow, billable endpoints. */
  retry?: boolean;
  params?: Record<string, any>;
  data?: any;
}

/** Low-level HTTP client for the Custom Agent Evaluations API. */
export class EvaluationsClient {
  public readonly datasets: DatasetClient;
  public readonly settings: EvaluationSettingsClient;

  private readonly baseUrl: string;
  private readonly workspaceId?: string;
  private readonly http: AxiosInstance;
  /** Undefined until an analysis call tells us which engine this is - see `apiRoot`. */
  private analysisOnDashboardRouter = false;

  constructor(options: EvaluationsClientOptions) {
    if (!options.apiKey) {
      throw new AgentXAuthError("AGENTX_API_KEY is required");
    }
    this.workspaceId = options.workspaceId;
    const base = apiBase(options.baseUrl);
    this.baseUrl = base.endsWith(EVAL_SUFFIX) ? base : `${base}${EVAL_SUFFIX}`;

    this.http = axios.create({
      headers: {
        "x-api-key": options.apiKey,
        "Content-Type": "application/json",
        "User-Agent": options.sdkVersion ? `${SDK_NAME}/${options.sdkVersion}` : userAgent(),
        accept: "*/*",
      },
      validateStatus: () => true,
    });

    this.datasets = new DatasetClient(this);
    this.settings = new EvaluationSettingsClient(this);
  }

  // ------------------------------------------------------------------
  // Low-level HTTP
  // ------------------------------------------------------------------

  /** Injects the client's workspaceId into a request payload unless one is already set. */
  private withWorkspace(payload: Record<string, any>): Record<string, any> {
    if (this.workspaceId && !payload.workspaceId) {
      return { ...payload, workspaceId: this.workspaceId };
    }
    return payload;
  }

  private workspaceParams(): Record<string, any> | undefined {
    return this.workspaceId ? { workspaceId: this.workspaceId } : undefined;
  }

  /** The API base with the `/custom-agent-evaluations` suffix removed. */
  private get apiRoot(): string {
    return this.baseUrl.endsWith(EVAL_SUFFIX) ? this.baseUrl.slice(0, -EVAL_SUFFIX.length) : this.baseUrl;
  }

  async request(method: Method, path: string, options: RequestOptions = {}): Promise<any> {
    const url = `${options.base ?? this.baseUrl}${path}`;
    const retry = options.retry !== false;
    const schedule = [0, ...(retry ? RETRY_BACKOFF_MS : [])];
    let lastError = "";

    for (let attempt = 0; attempt < schedule.length; attempt++) {
      if (schedule[attempt]) {
        await sleep(schedule[attempt]);
      }
      let resp: AxiosResponse;
      try {
        resp = await this.http.request({
          method,
          url,
          params: options.params,
          data: options.data,
          timeout: options.timeoutMs ?? 30000,
        });
      } catch (err: any) {
        lastError = `${err?.name || "Error"}: ${err?.message || err}`;
        continue;
      }

      if (resp.status === 401) {
        throw new AgentXAuthError("Invalid or missing API key");
      }
      if (resp.status === 422) {
        throw new AgentXValidationError(stringify(resp.data), 422);
      }
      if (RETRYABLE_STATUS.has(resp.status) && retry && attempt < MAX_RETRIES - 1) {
        lastError = `HTTP ${resp.status}`;
        continue;
      }
      if (resp.status < 200 || resp.status >= 300) {
        throw new AgentXAPIError(`HTTP ${resp.status}: ${stringify(resp.data)}`, resp.status);
      }
      return resp.data;
    }
    throw new AgentXAPIError(`Request failed after retries: ${lastError}`);
  }

  // ------------------------------------------------------------------
  // Model registry
  // ------------------------------------------------------------------

  /**
   * The LLM models AgentX supports - the same set selectable for the Sovereignty &
   * Portability Index. Pass a provider (e.g. "Google") to filter.
   */
  async listModels(provider?: string): Promise<ModelInfo[]> {
    const data = await this.request("GET", "/models", { params: provider ? { provider } : undefined });
    const items = Array.isArray(data) ? data : data?.models ?? [];
    return items.map(parseModelInfo);
  }

  // ------------------------------------------------------------------
  // Datasets
  // ------------------------------------------------------------------

  async createDataset(payload: Record<string, any>): Promise<Dataset> {
    return parseDataset(await this.request("POST", "/datasets", { data: this.withWorkspace(payload) }));
  }

  async listDatasets(): Promise<Dataset[]> {
    const data = await this.request("GET", "/datasets", { params: this.workspaceParams() });
    const items = Array.isArray(data) ? data : data?.datasets ?? [];
    return items.map(parseDataset);
  }

  async getDataset(datasetId: string): Promise<Dataset> {
    return parseDataset(await this.request("GET", `/datasets/${datasetId}`, { params: this.workspaceParams() }));
  }

  // ------------------------------------------------------------------
  // Evaluation settings - standalone grading config, reusable across datasets
  // ------------------------------------------------------------------

  async createEvaluationSettings(payload: Record<string, any>): Promise<EvaluationSettings> {
    return parseEvaluationSettings(
      await this.request("POST", "/evaluation-settings", { data: this.withWorkspace(payload) })
    );
  }

  async listEvaluationSettings(): Promise<EvaluationSettings[]> {
    const data = await this.request("GET", "/evaluation-settings", { params: this.workspaceParams() });
    const items = Array.isArray(data) ? data : data?.evaluationSettings ?? [];
    return items.map(parseEvaluationSettings);
  }

  async getEvaluationSettings(evaluationSettingsId: string): Promise<EvaluationSettings> {
    return parseEvaluationSettings(
      await this.request("GET", `/evaluation-settings/${evaluationSettingsId}`, {
        params: this.workspaceParams(),
      })
    );
  }

  // ------------------------------------------------------------------
  // Runs
  // ------------------------------------------------------------------

  async initRun(
    datasetId: string,
    subject: EvaluationSubject,
    options: { evaluationSettingsId?: string } = {}
  ): Promise<EvaluationRun> {
    const payload: Record<string, any> = {
      datasetId,
      evaluationSubject: compact({ kind: "custom_agent", runtime: "local", ...subject }),
      runSource: "sdk",
      sdk: {
        name: SDK_NAME,
        version: VERSION,
        runnerVersion: "1",
        nodeVersion: typeof process !== "undefined" ? process.version : undefined,
      },
    };
    if (options.evaluationSettingsId) {
      payload.evaluationSettingsId = options.evaluationSettingsId;
    }
    return parseEvaluationRun(await this.request("POST", "/runs", { data: this.withWorkspace(payload) }));
  }

  async appendResults(runId: string, batchId: string, results: EvaluationResult[]): Promise<BatchAppendResponse> {
    const data = await this.request("POST", `/runs/${runId}/results`, {
      data: { batchId: batchId || uuid4(), results: results.map(resultToPayload) },
      timeoutMs: 120000,
    });
    return parseBatchAppendResponse(data);
  }

  async finalizeRun(runId: string): Promise<Record<string, any>> {
    return this.request("POST", `/runs/${runId}/finalize`, { data: { status: "completed" } });
  }

  /**
   * CI gate (self-host): pass/fail a finalized run against an absolute rating floor and/or
   * the dataset's previous completed run. Recorded into gate history by default; pass
   * `record: false` for a preview that leaves no trace.
   */
  async gateRun(
    runId: string,
    options: {
      failUnder?: number;
      noRegression?: boolean;
      tolerance?: number;
      record?: boolean;
      caller?: string;
    } = {}
  ): Promise<Record<string, any>> {
    const params: Record<string, any> = {};
    if (options.failUnder !== undefined) {
      params.failUnder = options.failUnder;
    }
    if (options.noRegression) {
      params.noRegression = "true";
    }
    if (options.tolerance !== undefined) {
      params.tolerance = options.tolerance;
    }
    if (options.record !== false) {
      params.record = "true";
      params.caller = options.caller ?? "sdk";
    }
    return this.request("GET", `/runs/${runId}/gate`, { params });
  }

  /**
   * Start the durable analysis job. Returns immediately on hosted AgentX (poll
   * `getAnalysisStatus`); the self-host fallback route runs it synchronously.
   */
  async analyzeRun(
    runId: string,
    options: { mode?: string; qualityMode?: string; judges?: string[] } = {}
  ): Promise<Record<string, any>> {
    const payload: Record<string, any> = {};
    if (options.mode !== undefined) {
      payload.mode = options.mode;
    }
    if (options.qualityMode !== undefined) {
      payload.qualityMode = options.qualityMode;
    }
    if (options.judges !== undefined) {
      payload.judges = options.judges.map((model) => ({ model }));
    }

    if (!this.analysisOnDashboardRouter) {
      try {
        return await this.request("POST", `/runs/${runId}/analyze`, { data: payload, timeoutMs: 30000 });
      } catch (err) {
        if (!this.noteMissingAnalysisRoute(err, "analyze")) {
          throw err;
        }
      }
    }
    return this.request("POST", `/evaluate/analyze/${runId}`, {
      base: this.apiRoot,
      data: payload,
      timeoutMs: SELF_HOST_ANALYZE_TIMEOUT_MS,
      retry: false,
    });
  }

  async getAnalysisStatus(runId: string): Promise<AnalysisStatus> {
    if (!this.analysisOnDashboardRouter) {
      try {
        return parseAnalysisStatus(await this.request("GET", `/runs/${runId}/analyze-status`));
      } catch (err) {
        if (!this.noteMissingAnalysisRoute(err, "analyze-status")) {
          throw err;
        }
      }
    }
    return parseAnalysisStatus(
      await this.request("GET", `/evaluate/analyze/${runId}/status`, { base: this.apiRoot })
    );
  }

  /** Run summary plus per-result rows (rating, justification, trace ids, timings). */
  async getRun(runId: string): Promise<Record<string, any>> {
    return this.request("GET", `/runs/${runId}`);
  }

  async getReport(runId: string): Promise<Report> {
    if (!this.analysisOnDashboardRouter) {
      try {
        return parseReport(await this.request("GET", `/runs/${runId}/report`));
      } catch (err) {
        if (!this.noteMissingAnalysisRoute(err, "report")) {
          throw err;
        }
      }
    }
    return this.reportFromDashboard(runId);
  }

  async getMissingResults(runId: string): Promise<Record<string, any>[]> {
    const data = await this.request("GET", `/runs/${runId}/missing-results`);
    return Array.isArray(data) ? data : data?.missing ?? [];
  }

  /** Recorded CI gate verdicts, newest first (the dashboard's CI Gates history, self-host). */
  async listGates(): Promise<Record<string, any>[]> {
    const data = await this.request("GET", "/evaluate/ci/gates", { base: this.apiRoot });
    return Array.isArray(data) ? data : data?.gates ?? [];
  }

  /**
   * Persona-driven multi-turn simulation against a prompt (the Playground's "Simulate
   * conversation", self-host). Blocking and judge-billed: one LLM call per simulated turn
   * plus the closing judgment, so expect tens of seconds.
   */
  async simulateConversation(options: {
    model: string;
    systemPrompt: string;
    persona: string;
    goal: string;
    maxTurns?: number;
    tools?: Record<string, any>[];
    agentName?: string;
  }): Promise<Record<string, any>> {
    const payload: Record<string, any> = {
      model: options.model,
      messages: [{ role: "system", content: options.systemPrompt }],
      persona: options.persona,
      goal: options.goal,
      maxTurns: options.maxTurns ?? 5,
    };
    if (options.tools) {
      payload.tools = options.tools;
    }
    if (options.agentName) {
      payload.agentName = options.agentName;
    }
    return this.request("POST", "/evaluate/playground/simulate", {
      base: this.apiRoot,
      data: payload,
      timeoutMs: 600000,
      retry: false,
    });
  }

  // ------------------------------------------------------------------
  // Self-host analysis fallback
  //
  // The self-host engine mounts two routers: the SDK's /custom-agent-evaluations and
  // /evaluate for the dashboard. Its SDK router implements the run lifecycle but not
  // /analyze, /analyze-status or /report, which exist only on /evaluate. Hosted AgentX
  // serves all of them from the SDK router, so it never 404s and never falls back.
  // ------------------------------------------------------------------

  private noteMissingAnalysisRoute(err: unknown, route: string): boolean {
    if (!(err instanceof AgentXAPIError) || err.statusCode !== 404) {
      return false;
    }
    if (!this.analysisOnDashboardRouter) {
      // eslint-disable-next-line no-console
      console.info(
        `[agentx] ${route} is not served from ${this.baseUrl}; using the dashboard router at ` +
          `${this.apiRoot} (self-host engine)`
      );
    }
    this.analysisOnDashboardRouter = true;
    return true;
  }

  private async reportFromDashboard(runId: string): Promise<Report> {
    const record = await this.request("GET", `/evaluate/${runId}`, { base: this.apiRoot });
    const envelope = record?.analysis ?? {};
    const body = envelope?.analysis ?? {};
    if (!envelope || Object.keys(envelope).length === 0) {
      throw new AgentXAPIError(
        `Run ${runId} has no analysis to report. Nothing has analyzed it yet, or the analysis failed - ` +
          "call analyze() first."
      );
    }
    let datasetId = record?.datasetId;
    if (datasetId && typeof datasetId === "object") {
      datasetId = datasetId._id ?? datasetId.id;
    }
    return parseReport({
      ...body,
      runId,
      datasetId: datasetId ?? "",
      status: envelope.status ?? "completed",
      statistics: envelope.statistics,
    });
  }
}

function compact(obj: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}

function stringify(data: any): string {
  if (typeof data === "string") {
    return data.slice(0, 500);
  }
  try {
    return JSON.stringify(data).slice(0, 500);
  } catch {
    return String(data).slice(0, 500);
  }
}

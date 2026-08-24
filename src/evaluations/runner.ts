import { uuid4 } from "../util";
import { EvaluationsClient } from "./client";
import { HttpEndpointAdapter } from "./adapters/httpEndpoint";
import { PrecomputedAdapter } from "./adapters/precomputed";
import { AgentFunction, RawCallableAdapter } from "./adapters/raw";
import { DatasetClient } from "./datasets";
import { EvaluationSettingsClient } from "./evaluationSettings";
import { printReport } from "./reporting";
import { Spinner, bold, cyan, dim, green, red, yellow } from "./term";
import {
  AnalysisStatus,
  Dataset,
  EvaluationCase,
  EvaluationResult,
  EvaluationRun,
  EvaluationSettings,
  EvaluationSubject,
  LiveStatistics,
  ModelInfo,
  Report,
  parseLiveStatistics,
} from "./models";

const ANALYSIS_LEVEL_LABELS: Record<string, string> = {
  l1_score: "scoring responses",
  l2_question_reduce: "reducing questions",
  l3_cluster_reduce: "reducing clusters",
  l4_final_reduce: "writing final report",
};

const DEFAULT_JUDGE_MODEL = "gpt-5.5";

/** Anything that can answer evaluation cases. */
export type AdapterLike = AgentFunction | RawCallableAdapter | PrecomputedAdapter | HttpEndpointAdapter;

export interface ExecuteOptions {
  /**
   * Run this many cases at once. Default 1 (sequential), matching agentx-python. Raise it
   * for I/O-bound agents - results are still submitted in dataset order.
   */
  concurrency?: number;
}

export interface GateOptions {
  /** Fail when the run's average rating is below this floor. */
  failUnder?: number;
  /** Fail when the average dropped more than `tolerance` below the previous completed run. */
  noRegression?: boolean;
  tolerance?: number;
  record?: boolean;
  /** Free label shown in the dashboard's CI gate history ("sdk", "github-actions", ...). */
  caller?: string;
}

export interface AnalyzeOptions {
  /** "auto" (default), "sync", or "batch" - how item scoring executes server-side. */
  mode?: string;
  /** "quality_first" or "balanced" - how many items get a second/third judge. */
  qualityMode?: string;
  /** 1-3 model ids, e.g. ["gpt-5.5", "claude-opus-4-8"]. Defaults to a single judge. */
  judges?: string[];
  pollIntervalMs?: number;
  timeoutMs?: number;
}

/** Wire result of the CI gate, with the fields a CI script actually branches on. */
export class GateResult {
  public readonly raw: Record<string, any>;
  public readonly passed: boolean;
  public readonly averageRating?: number;
  public readonly baselineAverage?: number;
  public readonly baselineRunId?: string;
  public readonly checks: Record<string, any>[];

  constructor(data: Record<string, any>) {
    this.raw = data;
    this.passed = Boolean(data.passed);
    this.averageRating = data.averageRating;
    this.baselineAverage = data.baselineAverage;
    this.baselineRunId = data.baselineRunId;
    this.checks = data.checks ?? [];
  }

  get exitCode(): number {
    return this.passed ? 0 : 1;
  }
}

/**
 * Returned by `client.evaluations.run(...)`.
 *
 * Chains: `.execute(fn)` -> `.finalize()` -> `.analyze()` -> Report.
 */
export class EvaluationRunContext {
  private results: EvaluationResult[] = [];
  private liveStats?: LiveStatistics;
  private report?: Report;

  constructor(
    private readonly client: EvaluationsClient,
    private readonly dataset: Dataset,
    private readonly run: EvaluationRun,
    private readonly subject: EvaluationSubject,
    private readonly evaluationSettings?: EvaluationSettings
  ) {}

  /** The server-side run id - use it to fetch the run's results later. */
  get runId(): string {
    return this.run.runId;
  }

  /** Number of submitted results that have received a rating so far. */
  get ratedCount(): number {
    return this.liveStats?.ratedCount ?? 0;
  }

  /**
   * Live average rating across everything scored so far. Populated as soon as `.execute()`
   * submits batches - unlike `Report.averageRating`, it does not require `.analyze()`.
   */
  get averageRating(): number | undefined {
    return this.liveStats?.averageRating;
  }

  get minRating(): number | undefined {
    return this.liveStats?.minRating;
  }

  get maxRating(): number | undefined {
    return this.liveStats?.maxRating;
  }

  /** The results submitted from this process, before server-side scoring. */
  get submittedResults(): EvaluationResult[] {
    return this.results;
  }

  // ------------------------------------------------------------------
  // Step 1: execute
  // ------------------------------------------------------------------

  /** Run every case locally and submit batches to AgentX for scoring. */
  async execute(adapter: AdapterLike, options: ExecuteOptions = {}): Promise<EvaluationRunContext> {
    const runCase = wrapAdapter(adapter);
    const cases = buildCases(this.dataset, this.run, this.evaluationSettings);
    const maxBatch = this.run.limits.maxBatchSize;

    const sep = "-".repeat(60);
    const name = this.dataset.name || this.dataset.id;
    const framework = this.subject.framework || "custom";
    const runtime = this.subject.runtime || "local";
    const questionCount = this.dataset.questions.length;
    const requestCount = this.evaluationSettings?.numberOfRequests ?? this.dataset.numberOfRequests;
    const smokeCount = cases.filter((c) => c.isSmokeTestVariant).length;

    console.log(cyan(sep));
    console.log(`  ${bold("AgentX Evaluation")}  ${dim(" - ")}  ${name}`);
    console.log(cyan(sep));
    console.log(`  ${dim("Run   :")} ${dim(this.run.runId)}`);
    if (this.subject.displayName) {
      console.log(`  ${dim("Agent :")} ${this.subject.displayName}  ${dim(`(${framework} / ${runtime})`)}`);
    }
    console.log();
    let execLine =
      `${bold("Executing")}  ${questionCount} question${questionCount === 1 ? "" : "s"} ` +
      `x ${requestCount} run${requestCount === 1 ? "" : "s"}`;
    if (smokeCount) {
      execLine += `  ${dim(`(+${smokeCount} smoke-test ${smokeCount === 1 ? "variant" : "variants"})`)}`;
    }
    console.log(execLine);

    const concurrency = Math.max(options.concurrency ?? 1, 1);
    const total = cases.length;
    let batch: EvaluationResult[] = [];
    let index = 0;

    const handle = async (evaluationCase: EvaluationCase, position: number): Promise<void> => {
      const result = await runCase(evaluationCase);
      result.idempotencyKey = idemKey(this.run.runId, evaluationCase.caseId, evaluationCase.runNumber);
      if (evaluationCase.model) {
        // Tag the result with the case's model so the server can group it into the
        // Sovereignty & Portability matrix.
        const metadata = { ...(result.metadata ?? {}) };
        if (metadata.model === undefined) {
          metadata.model = evaluationCase.model;
        }
        result.metadata = metadata;
      }
      this.results.push(result);
      batch.push(result);
      printProgress(position, total, evaluationCase, result);
    };

    if (concurrency <= 1) {
      for (const evaluationCase of cases) {
        index += 1;
        await handle(evaluationCase, index);
        if (batch.length >= maxBatch) {
          const flushing = batch;
          batch = [];
          await this.flushBatch(flushing);
        }
      }
    } else {
      for (let start = 0; start < cases.length; start += concurrency) {
        const slice = cases.slice(start, start + concurrency);
        await Promise.all(slice.map((evaluationCase, offset) => handle(evaluationCase, start + offset + 1)));
        while (batch.length >= maxBatch) {
          const flushing = batch.slice(0, maxBatch);
          batch = batch.slice(maxBatch);
          await this.flushBatch(flushing);
        }
      }
    }

    if (batch.length) {
      await this.flushBatch(batch);
    }
    return this;
  }

  private async flushBatch(batch: EvaluationResult[]): Promise<void> {
    const batchId = uuid4();
    const n = batch.length;
    await Spinner.run(`Scoring - AI is rating ${n} result${n === 1 ? "" : "s"}`, async () => {
      try {
        const resp = await this.client.appendResults(this.run.runId, batchId, batch);
        if (resp.liveStatistics) {
          this.liveStats = resp.liveStatistics;
        }
        console.log(`  ${green("OK")}  Scored ${resp.accepted} result${resp.accepted === 1 ? "" : "s"}`);
      } catch (err) {
        console.log(`  ${red("x")}  Scoring failed: ${dim(errorText(err))}`);
      }
    });
  }

  // ------------------------------------------------------------------
  // Step 2: finalize
  // ------------------------------------------------------------------

  async finalize(): Promise<EvaluationRunContext> {
    console.log();
    await Spinner.run("Finalizing - submitting results", async () => {
      try {
        const data = await this.client.finalizeRun(this.run.runId);
        const stats = parseLiveStatistics(data?.liveStatistics);
        if (stats) {
          this.liveStats = stats;
        }
        console.log(`  ${green("OK")}  Finalized`);
      } catch (err) {
        console.log(`  ${red("x")}  Finalize failed: ${dim(errorText(err))}`);
      }
    });
    return this;
  }

  /**
   * CI gate (self-host): pass/fail this finalized run so a CI job can block a merge.
   *
   * ```ts
   * const gate = await client.evaluations.run({ ... }).execute(myAgent).finalize().gate({ failUnder: 7 });
   * if (!gate.passed) process.exit(1);
   * ```
   */
  async gate(options: GateOptions = {}): Promise<GateResult> {
    const data = await this.client.gateRun(this.run.runId, options);
    const result = new GateResult(data);
    console.log();
    for (const check of result.checks) {
      const mark = check.passed ? green("OK") : red("x");
      console.log(`  ${mark}  [${check.check}] ${check.detail}`);
    }
    console.log(`  ${result.passed ? green("GATE PASSED") : red("GATE FAILED")}`);
    return result;
  }

  /**
   * Per-result rows for this run (rating, justification, code scorer rows, trace ids,
   * latency/tokens, similarity metrics) - what the dashboard's run detail table shows.
   */
  async fetchResults(): Promise<Record<string, any>[]> {
    const detail = await this.client.getRun(this.runId);
    return detail?.results ?? [];
  }

  // ------------------------------------------------------------------
  // Step 3: analyze + report
  // ------------------------------------------------------------------

  /**
   * Generate the qualitative AI analysis report - the same durable, multi-stage pipeline as
   * the dashboard's "Analyze" button. Starts the job, polls until it finishes, prints the
   * report and returns it.
   */
  async analyze(options: AnalyzeOptions = {}): Promise<Report> {
    if (options.judges && (options.judges.length < 1 || options.judges.length > 3)) {
      throw new Error("judges must contain 1-3 model ids");
    }
    const judges = options.judges ?? [DEFAULT_JUDGE_MODEL];
    const pollIntervalMs = options.pollIntervalMs ?? 5000;
    const timeoutMs = options.timeoutMs ?? 1_800_000;

    console.log();
    await Spinner.run("Analyzing - AI is reviewing your results", async (spinner) => {
      try {
        await this.client.analyzeRun(this.run.runId, {
          mode: options.mode,
          qualityMode: options.qualityMode,
          judges,
        });
        const deadline = Date.now() + timeoutMs;
        let status: AnalysisStatus = await this.client.getAnalysisStatus(this.run.runId);
        while (!status.isTerminal && Date.now() < deadline) {
          const level = ANALYSIS_LEVEL_LABELS[status.progress.currentLevel ?? ""] ?? "";
          spinner.update(`Analyzing, ${level ? `${level} ` : ""}${status.progress.overallPercentage}%`);
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          status = await this.client.getAnalysisStatus(this.run.runId);
        }

        if (!status.isTerminal) {
          console.log(
            `  ${yellow("!")}  Still running after ${Math.round(timeoutMs / 1000)}s, check the dashboard for status`
          );
        } else if (status.status === "failed") {
          console.log(`  ${red("x")}  Analyze failed: ${dim(status.failureReason?.message ?? "unknown error")}`);
        } else {
          console.log(`  ${green("OK")}  Analysis complete`);
        }
      } catch (err) {
        console.log(`  ${red("x")}  Analyze failed: ${dim(errorText(err))}`);
      }
    });

    let report: Report;
    try {
      report = await this.client.getReport(this.run.runId);
    } catch (err) {
      // Deliberately not status "completed": a placeholder that claims completion is
      // indistinguishable from a real report of a run that scored nothing.
      console.log(`  ${red("x")}  Could not fetch the report: ${dim(errorText(err))}`);
      report = {
        runId: this.run.runId,
        datasetId: this.dataset.id,
        status: "unavailable",
        strengths: [],
        weaknesses: [],
        recommendations: [],
        lowScoringCases: [],
        raw: {},
      };
    }

    this.report = report;
    console.log();
    printReport(report);
    return report;
  }

  /** The report from the last `analyze()` call, if any. */
  get lastReport(): Report | undefined {
    return this.report;
  }
}

/**
 * Thenable wrapper that keeps the Python SDK's fluent chain readable in async JS:
 *
 * ```ts
 * const report = await client.evaluations
 *   .run({ datasetId, subject })
 *   .execute(myAgent)
 *   .finalize()
 *   .analyze();
 * ```
 */
export class EvaluationRunChain implements PromiseLike<EvaluationRunContext> {
  constructor(private readonly promise: Promise<EvaluationRunContext>) {}

  execute(adapter: AdapterLike, options?: ExecuteOptions): EvaluationRunChain {
    return new EvaluationRunChain(this.promise.then((ctx) => ctx.execute(adapter, options)));
  }

  finalize(): EvaluationRunChain {
    return new EvaluationRunChain(this.promise.then((ctx) => ctx.finalize()));
  }

  analyze(options?: AnalyzeOptions): Promise<Report> {
    return this.promise.then((ctx) => ctx.analyze(options));
  }

  gate(options?: GateOptions): Promise<GateResult> {
    return this.promise.then((ctx) => ctx.gate(options));
  }

  then<TResult1 = EvaluationRunContext, TResult2 = never>(
    onfulfilled?: ((value: EvaluationRunContext) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.promise.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null
  ): Promise<EvaluationRunContext | TResult> {
    return this.promise.catch(onrejected);
  }
}

/**
 * Entry point surfaced as `client.evaluations`.
 */
export class EvaluationsRunner {
  public readonly datasets: DatasetClient;
  public readonly settings: EvaluationSettingsClient;

  constructor(private readonly client: EvaluationsClient) {
    this.datasets = client.datasets;
    this.settings = client.settings;
  }

  /**
   * Start a run of `datasetId` against `subject`. Pass `evaluationSettingsId` to grade
   * against a standalone, reusable config instead of the dataset's own default.
   */
  run(options: {
    datasetId: string;
    subject: EvaluationSubject;
    evaluationSettingsId?: string;
  }): EvaluationRunChain {
    return new EvaluationRunChain(
      (async () => {
        const dataset = await this.client.getDataset(options.datasetId);
        const evaluationSettings = options.evaluationSettingsId
          ? await this.client.getEvaluationSettings(options.evaluationSettingsId)
          : undefined;
        const run = await this.client.initRun(options.datasetId, options.subject, {
          evaluationSettingsId: options.evaluationSettingsId,
        });
        return new EvaluationRunContext(this.client, dataset, run, options.subject, evaluationSettings);
      })()
    );
  }

  /** The LLM models AgentX supports - valid ids for judges and portability comparisons. */
  listModels(provider?: string): Promise<ModelInfo[]> {
    return this.client.listModels(provider);
  }

  /** Recorded CI gate verdicts, newest first (self-host). */
  listGates(): Promise<Record<string, any>[]> {
    return this.client.listGates();
  }

  /** Persona-driven multi-turn simulation against a prompt (self-host). */
  simulateConversation(options: Parameters<EvaluationsClient["simulateConversation"]>[0]): Promise<Record<string, any>> {
    return this.client.simulateConversation(options);
  }

  /** Run summary plus per-result rows by id, without the context that created it. */
  getRun(runId: string): Promise<Record<string, any>> {
    return this.client.getRun(runId);
  }

  /** Check on an in-progress `analyze()` job by run id (e.g. from another process). */
  getAnalysisStatus(runId: string): Promise<AnalysisStatus> {
    return this.client.getAnalysisStatus(runId);
  }

  /** Fetch a finished report by run id. */
  getReport(runId: string): Promise<Report> {
    return this.client.getReport(runId);
  }

  /**
   * CI-gate any finalized run by id - the standalone form of `EvaluationRunContext.gate()`,
   * for gating a run created elsewhere or re-checking one without re-running it.
   */
  async gateRun(runId: string, options: GateOptions = {}): Promise<GateResult> {
    return new GateResult(await this.client.gateRun(runId, options));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrapAdapter(adapter: AdapterLike): (evaluationCase: EvaluationCase) => Promise<EvaluationResult> {
  if (
    adapter instanceof RawCallableAdapter ||
    adapter instanceof PrecomputedAdapter ||
    adapter instanceof HttpEndpointAdapter
  ) {
    return (evaluationCase) => adapter.run(evaluationCase);
  }
  if (typeof adapter === "function") {
    const wrapped = new RawCallableAdapter(adapter);
    return (evaluationCase) => wrapped.run(evaluationCase);
  }
  throw new TypeError(`adapter must be a function or an Adapter instance, got ${typeof adapter}`);
}

export function buildCases(
  dataset: Dataset,
  run: EvaluationRun,
  evaluationSettings?: EvaluationSettings
): EvaluationCase[] {
  const cases: EvaluationCase[] = [];
  // An independently chosen evaluation settings takes precedence over the dataset's own
  // numberOfRequests / sovereignty models - that is the point of decoupling them.
  const runCount = Math.max(evaluationSettings?.numberOfRequests ?? dataset.numberOfRequests, 1);
  const sovereigntyModels = evaluationSettings?.sovereigntyModels ?? dataset.sovereigntyModels;
  const models: (string | undefined)[] = sovereigntyModels.length ? [...sovereigntyModels] : [undefined];

  // Smoke-test variants are generated and counted entirely server-side and handed back on
  // `run`; the SDK only turns what the server already decided into extra cases.
  const variantsByQuestion = new Map<number, string[]>(
    (run.smokeTestVariants ?? []).map((group) => [group.questionIndex, group.variants])
  );

  dataset.questions.forEach((question, questionIndex) => {
    const main = question.main_question;
    for (let runNumber = 1; runNumber <= runCount; runNumber++) {
      for (const model of models) {
        cases.push({
          caseId: `case-${questionIndex}${model ? `::${model}` : ""}`,
          questionIndex,
          runNumber,
          query: main.query,
          expectedResults: main.expectedResults,
          expectedCapabilities: main.expectedCapabilities,
          expectedKnowledgeBase: main.expectedKnowledgeBase,
          expectedDelegations: main.expectedDelegations,
          model,
          isSmokeTestVariant: false,
        });
      }
    }
    (variantsByQuestion.get(questionIndex) ?? []).forEach((variantText, variantIndex) => {
      cases.push({
        caseId: `case-${questionIndex}`,
        questionIndex,
        runNumber: runCount + variantIndex + 1,
        query: variantText,
        expectedResults: main.expectedResults,
        expectedCapabilities: main.expectedCapabilities,
        expectedKnowledgeBase: main.expectedKnowledgeBase,
        expectedDelegations: main.expectedDelegations,
        isSmokeTestVariant: true,
        smokeTestVariantText: variantText,
      });
    });
  });

  return cases;
}

function idemKey(runId: string, caseId: string, runNumber: number): string {
  return `${runId}:${caseId}:run-${runNumber}`;
}

function printProgress(index: number, total: number, evaluationCase: EvaluationCase, result: EvaluationResult): void {
  let tag: string;
  let suffix = "";
  if (result.error) {
    tag = red("x");
    suffix = red(`error: ${result.error.message.slice(0, 60)}`);
  } else {
    tag = green("OK");
    const parts: string[] = [];
    if (result.timings?.latencyMs !== undefined) {
      parts.push(dim(`${result.timings.latencyMs}ms`));
    }
    if (result.timings?.inputTokens !== undefined && result.timings?.outputTokens !== undefined) {
      parts.push(dim(`${result.timings.inputTokens}->${result.timings.outputTokens} tok`));
    }
    suffix = parts.join("  ");
  }
  const counter = dim(`[${index}/${total}]`);
  const label = dim(`Q${evaluationCase.questionIndex + 1} run #${evaluationCase.runNumber}`);
  const preview =
    evaluationCase.query.length > 55 ? `${evaluationCase.query.slice(0, 55)}...` : evaluationCase.query;
  let line = `  ${tag}  ${counter} ${label}  ${preview}`;
  if (suffix) {
    line += `  ${suffix}`;
  }
  console.log(line);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

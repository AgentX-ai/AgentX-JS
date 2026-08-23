import { AsyncLocalStorage } from "async_hooks";

import { hexId, safeSerialize } from "../util";
import { CIGateFailure } from "../errors";
import { IngestClient } from "./ingestClient";
import { CIQuestionScore, CIRun, CIRunResult, CIRunStatus, TraceEvaluationResult } from "./ciTypes";

export interface TraceOptions {
  /** Anything the span took as input. Also assignable later via `span.input = ...`. */
  input?: any;
  metadata?: Record<string, any>;
  framework?: string;
  model?: string;
  /** Groups spans into one run. Inherited from the parent span when omitted. */
  sessionId?: string;
  /**
   * Send the trace synchronously on `end()` so `span.traceId` is populated - e.g. to attach
   * the trace to an evaluation result. Default false (queued, fire-and-forget).
   */
  sync?: boolean;
  /**
   * `true` checks this trace against Monitor patterns immediately on ingest, no dashboard
   * profile required. `false` explicitly opts OUT of every ingest-time check (patterns,
   * built-ins, online evaluators, topics) - what eval-run traces should send, since the run's
   * own evaluator already judges each case. Omit to leave the server's standard behaviour.
   */
  monitor?: boolean;
  /** Restrict detection to exactly these Monitor pattern ids. */
  patternIds?: string[];
  /**
   * Disambiguator for when `name` alone isn't enough - pin this trace to an already-known
   * agent id. Omitted, the agent resolves from `name`, one stable agent per distinct name.
   */
  agentId?: string;
}

export interface ChildSpanOptions {
  /** Unix seconds (as `Date.now() / 1000`), matching the Python SDK's `time.time()` values. */
  startTime?: number;
  endTime?: number;
  durationMs?: number;
  input?: any;
  output?: any;
  model?: string;
  framework?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  error?: string;
  toolCalls?: Record<string, any>[];
  metadata?: Record<string, any>;
}

export interface ToolCallOptions {
  input?: any;
  output?: any;
  /**
   * `false` is what the engine's built-in "Tool failure" check and the dashboard's Tool
   * quality column read. Leaving it unset means "unknown" - the dashboard falls back to its
   * output-text heuristic rather than assuming the call passed.
   */
  success?: boolean;
  error?: string;
  latencyMs?: number;
  startTime?: number;
  endTime?: number;
}

export interface RetrievalOptions {
  query?: string;
  docCount?: number;
  output?: any;
  durationMs?: number;
  startTime?: number;
  endTime?: number;
}

export interface LlmCallOptions {
  durationMs: number;
  startTime?: number;
  endTime?: number;
  input?: any;
  output?: any;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

interface SpanStore {
  span: TraceSpan;
}

/**
 * One traced unit of work. Returned by `tracer.trace()` and handed to `tracer.withSpan()`.
 *
 * Nested spans link as real parent/child rows sharing a session id, so a multi-step run
 * shows up as a tree in the trace dialog's span panel.
 */
export class TraceSpan {
  public name: string;
  /** Reassignable while the span is open. */
  public input: any;
  public output: any;
  public toolCalls: Record<string, any>[] = [];

  private readonly tracer: Tracer;
  private readonly metadata?: Record<string, any>;
  private readonly framework?: string;
  private readonly model?: string;
  private readonly agentId?: string;
  private readonly sync: boolean;
  private readonly monitor?: boolean;
  private readonly patternIds?: string[];

  private readonly _spanId: string;
  private _parentSpanId?: string;
  private _sessionId?: string;
  private _traceId?: string;
  private childSpanCount = 0;

  private startedAt?: number;
  private errorMessage?: string;
  private capturedModel?: string;
  private capturedFramework?: string;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private ended = false;

  constructor(tracer: Tracer, name: string, options: TraceOptions = {}) {
    this.tracer = tracer;
    this.name = name;
    this.input = options.input;
    this.metadata = options.metadata;
    this.framework = options.framework;
    this.model = options.model;
    this.agentId = options.agentId;
    this.sync = options.sync ?? false;
    this.monitor = options.monitor;
    this.patternIds = options.patternIds;
    this._sessionId = options.sessionId;
    this._spanId = hexId();
  }

  /** This span's id - usable to parent a further span via `childSpan()`. */
  get spanId(): string {
    return this._spanId;
  }

  get sessionId(): string | undefined {
    return this._sessionId;
  }

  /**
   * The ingested trace's id. Only populated once the span has ended AND it was opened with
   * `{ sync: true }` - there is nothing to wait on for a same-call id in queued mode.
   */
  get traceId(): string | undefined {
    return this._traceId;
  }

  /** @internal Resolves parent/session linkage and starts the clock. */
  _start(parent?: TraceSpan): this {
    this.startedAt = Date.now();
    if (parent) {
      this._parentSpanId = parent.spanId;
      if (!this._sessionId) {
        this._sessionId = parent.sessionId;
      }
    } else if (!this._sessionId) {
      this._sessionId = `sdk_${hexId()}`;
    }
    return this;
  }

  /** Record a tool call made during this span. */
  addToolCall(name: string, options: ToolCallOptions = {}): void {
    const entry: Record<string, any> = {
      name,
      input: options.input !== undefined ? safeSerialize(options.input) : null,
      output: options.output !== undefined ? safeSerialize(options.output) : null,
      latency_ms: options.latencyMs ?? null,
    };
    if (options.success !== undefined) {
      entry.success = options.success;
    }
    if (options.error !== undefined) {
      entry.error = options.error;
    }
    this.toolCalls.push(entry);
  }

  /** Mark this span as failed with the given error message. */
  setError(message: string | Error): void {
    this.errorMessage = message instanceof Error ? message.message : message;
  }

  /**
   * Send one real child-span row parented to this span, with explicit timing.
   *
   * The child is dispatched immediately (the caller supplies finished timing) and is not
   * made the active span; its `spanId` can parent a further-nested grandchild.
   */
  async childSpan(name: string, options: ChildSpanOptions = {}): Promise<TraceSpan> {
    const child = new TraceSpan(this.tracer, name, {
      framework: options.framework || this.framework || this.capturedFramework,
      model: options.model,
      sessionId: this._sessionId,
    });
    child._parentSpanId = this._spanId;
    child.input = options.input;
    child.output = options.output;
    child.toolCalls = options.toolCalls || [];
    if (options.error) {
      child.setError(options.error);
    }

    const latencyMs =
      options.durationMs !== undefined
        ? Math.round(options.durationMs)
        : options.startTime !== undefined && options.endTime !== undefined
        ? Math.round((options.endTime - options.startTime) * 1000)
        : undefined;

    // Built directly rather than through `Tracer._send` so a child send never consumes the
    // pending-tool-call queue entries meant for a sibling or for the outer span.
    const wire: Record<string, any> = { name };
    if (options.input !== undefined && options.input !== null) {
      wire.input = safeSerialize(options.input);
    }
    if (options.output !== undefined && options.output !== null) {
      wire.output = safeSerialize(options.output);
    }
    if (latencyMs !== undefined) {
      wire.latency_ms = latencyMs;
    }
    if (child.errorMessage) {
      wire.error = child.errorMessage;
    }
    const childFramework = options.framework || this.framework || this.capturedFramework;
    if (childFramework) {
      wire.framework = childFramework;
    }
    if (options.model) {
      wire.model = options.model;
    }
    if (child.toolCalls.length) {
      wire.tool_calls = child.toolCalls;
    }
    if (options.metadata) {
      wire.metadata = safeSerialize(options.metadata);
    }
    if (child._sessionId) {
      wire.session_id = child._sessionId;
    }
    wire.span_id = child._spanId;
    if (child._parentSpanId) {
      wire.parent_span_id = child._parentSpanId;
    }
    if (options.startTime !== undefined) {
      wire.started_at_unix_nano = String(Math.round(options.startTime * 1_000_000_000));
    }
    if (options.inputTokens) {
      wire.input_tokens = options.inputTokens;
    }
    if (options.outputTokens) {
      wire.output_tokens = options.outputTokens;
    }
    if (options.cacheReadTokens) {
      wire.cache_read_tokens = options.cacheReadTokens;
    }
    if (options.cacheWriteTokens) {
      wire.cache_write_tokens = options.cacheWriteTokens;
    }
    child._traceId = await this.tracer._dispatch(wire, false);
    return child;
  }

  /**
   * Record one LLM-call child span under this span (e.g. one raw `fetch` to a provider),
   * and fold its model/token usage into this span's own summary.
   */
  async recordLlmCall(options: LlmCallOptions): Promise<void> {
    this.childSpanCount += 1;
    await this.childSpan(`LLM Call ${this.childSpanCount}`, {
      startTime: options.startTime,
      endTime: options.endTime,
      durationMs: options.durationMs,
      input: options.input,
      output: options.output,
      model: options.model,
      inputTokens: options.inputTokens,
      outputTokens: options.outputTokens,
      cacheReadTokens: options.cacheReadTokens,
      cacheWriteTokens: options.cacheWriteTokens,
    });
    if (this.input === undefined && options.input !== undefined) {
      this.input = options.input;
    }
    if (options.output !== undefined) {
      this.output = options.output;
    }
    if (options.model && !this.capturedModel) {
      this.capturedModel = options.model;
    }
    this.inputTokens += options.inputTokens || 0;
    this.outputTokens += options.outputTokens || 0;
    this.cacheReadTokens += options.cacheReadTokens || 0;
    this.cacheWriteTokens += options.cacheWriteTokens || 0;
  }

  /** @internal Next auto-numbered child index (used for "Retrieval N" naming). */
  _nextChildIndex(): number {
    this.childSpanCount += 1;
    return this.childSpanCount;
  }

  /**
   * Close the span and send it. Returns the trace id when the span was opened with
   * `{ sync: true }`, otherwise undefined (the trace is queued).
   */
  async end(error?: unknown): Promise<string | undefined> {
    if (this.ended) {
      return this._traceId;
    }
    this.ended = true;
    const latencyMs = this.startedAt !== undefined ? Date.now() - this.startedAt : undefined;
    if (error !== undefined && error !== null && !this.errorMessage) {
      this.errorMessage = error instanceof Error ? error.message : String(error);
    }

    this._traceId = await this.tracer._send({
      sync: this.sync,
      monitor: this.monitor,
      pattern_ids: this.patternIds,
      name: this.name,
      agent_id: this.agentId,
      input: this.input !== undefined && this.input !== null ? safeSerialize(this.input) : undefined,
      output: this.output !== undefined && this.output !== null ? safeSerialize(this.output) : undefined,
      latency_ms: latencyMs,
      error: this.errorMessage,
      metadata: this.metadata ? safeSerialize(this.metadata) : undefined,
      framework: this.framework || this.capturedFramework,
      model: this.model || this.capturedModel,
      tool_calls: this.toolCalls.length ? this.toolCalls : undefined,
      session_id: this._sessionId,
      input_tokens: this.inputTokens || undefined,
      output_tokens: this.outputTokens || undefined,
      cache_read_tokens: this.cacheReadTokens || undefined,
      cache_write_tokens: this.cacheWriteTokens || undefined,
      span_id: this._spanId,
      parent_span_id: this._parentSpanId,
      started_at_unix_nano: this.startedAt !== undefined ? String(this.startedAt * 1_000_000) : undefined,
    });
    return this._traceId;
  }
}

/** Handle passed to the `traceToolCall` callback - set `output`/`success`/`error` on it. */
export class ToolCallRecorder {
  public output: any;
  public success?: boolean;
  public error?: string;
}

/** Handle passed to the `traceRetrieval` callback - set `docCount`/`output` on it. */
export class RetrievalRecorder {
  public docCount?: number;
  public output: any;
}

/**
 * Production tracer, attached as `client.tracer`.
 *
 * ```ts
 * await client.tracer.withSpan("support-agent", { input: question }, async (span) => {
 *   const answer = await callLlm(question);
 *   span.output = answer;
 *   return answer;
 * });
 * ```
 */
export class Tracer {
  private readonly client: IngestClient;
  private readonly storage = new AsyncLocalStorage<SpanStore>();
  private pendingToolCalls: Record<string, any>[] = [];
  private pendingRetrievals: Record<string, any>[] = [];

  constructor(ingestClient: IngestClient) {
    this.client = ingestClient;
  }

  /** The innermost span active in the current async context, if any. */
  get currentSpan(): TraceSpan | undefined {
    return this.storage.getStore()?.span;
  }

  /**
   * Open a span. Nested `trace()`/`withSpan()` calls inside the same async context become
   * its children automatically.
   *
   * The returned span must be closed with `await span.end()` - prefer `withSpan()`, which
   * does that for you (including on a thrown error).
   */
  trace(name: string, options: TraceOptions = {}): TraceSpan {
    const previous = this.storage.getStore();
    const span = new TraceSpan(this, name, options)._start(previous?.span);
    // enterWith() makes the span current for the rest of this async context, so a later
    // `tracer.recordToolCall()` or nested trace attaches to it without a callback wrapper.
    this.storage.enterWith({ span });
    const endSpan = span.end.bind(span);
    span.end = async (error?: unknown) => {
      const traceId = await endSpan(error);
      // Restore whatever was current before, so sibling work after this span doesn't keep
      // parenting to a closed one.
      this.storage.enterWith(previous as SpanStore);
      return traceId;
    };
    return span;
  }

  /**
   * Run `fn` inside a span, closing it automatically (an exception is recorded on the span
   * and rethrown unchanged). Returns whatever `fn` returns.
   */
  async withSpan<T>(name: string, options: TraceOptions, fn: (span: TraceSpan) => Promise<T> | T): Promise<T>;
  async withSpan<T>(name: string, fn: (span: TraceSpan) => Promise<T> | T): Promise<T>;
  async withSpan<T>(
    name: string,
    optionsOrFn: TraceOptions | ((span: TraceSpan) => Promise<T> | T),
    maybeFn?: (span: TraceSpan) => Promise<T> | T
  ): Promise<T> {
    const options = typeof optionsOrFn === "function" ? {} : optionsOrFn;
    const fn = (typeof optionsOrFn === "function" ? optionsOrFn : maybeFn)!;
    const span = new TraceSpan(this, name, options)._start(this.currentSpan);
    return this.storage.run({ span }, async () => {
      try {
        const output = await fn(span);
        if (span.output === undefined && output !== undefined) {
          span.output = safeSerialize(output);
        }
        await span.end();
        return output;
      } catch (err) {
        span.setError(err as Error);
        await span.end(err);
        throw err;
      }
    });
  }

  /**
   * Wrap a function so every call is traced - the decorator equivalent of Python's
   * `@tracer.trace("name")`. Arguments are captured as the span input.
   */
  wrap<A extends any[], R>(
    name: string,
    fn: (...args: A) => Promise<R> | R,
    options: TraceOptions = {}
  ): (...args: A) => Promise<R> {
    return (...args: A) =>
      this.withSpan(name, { ...options, input: options.input ?? safeSerialize(args) }, () => fn(...args));
  }

  /**
   * Make `span` the active span for the duration of `fn` - for work started in a different
   * async context (a queue consumer, an event handler) that should still attach to it.
   */
  async useSpan<T>(span: TraceSpan, fn: () => Promise<T> | T): Promise<T> {
    return this.storage.run({ span }, async () => fn());
  }

  /**
   * Record a tool call the SDK can't see on its own - e.g. a hand-rolled tool-use loop where
   * the tool runs in plain code between two LLM calls.
   *
   * Sent as a real child-span row of the active span, plus a summary on the root's flat
   * `tool_calls` list (what the engine's "Tool failure" check and the dashboard's Tool
   * quality column read). With no active span it queues onto the next trace sent.
   */
  async recordToolCall(name: string, options: ToolCallOptions = {}): Promise<void> {
    const span = this.currentSpan;
    if (span) {
      await span.childSpan(name, {
        startTime: options.startTime,
        endTime: options.endTime,
        durationMs: options.latencyMs,
        input: options.input,
        output: options.output,
        error: options.error,
      });
      span.addToolCall(name, options);
      return;
    }
    const pending: Record<string, any> = {
      name,
      input: options.input !== undefined ? safeSerialize(options.input) : null,
      output: options.output !== undefined ? safeSerialize(options.output) : null,
      latency_ms: options.latencyMs ?? null,
    };
    if (options.success !== undefined) {
      pending.success = options.success;
    }
    if (options.error !== undefined) {
      pending.error = options.error;
    }
    this.pendingToolCalls.push(pending);
  }

  /**
   * Time a tool call and record it via `recordToolCall`.
   *
   * An exception escaping `fn` records the call as failed (`success: false` plus the error
   * text) and then propagates unchanged.
   */
  async traceToolCall<T>(
    name: string,
    options: { input?: any },
    fn: (recorder: ToolCallRecorder) => Promise<T> | T
  ): Promise<T>;
  async traceToolCall<T>(name: string, fn: (recorder: ToolCallRecorder) => Promise<T> | T): Promise<T>;
  async traceToolCall<T>(
    name: string,
    optionsOrFn: { input?: any } | ((recorder: ToolCallRecorder) => Promise<T> | T),
    maybeFn?: (recorder: ToolCallRecorder) => Promise<T> | T
  ): Promise<T> {
    const options = typeof optionsOrFn === "function" ? {} : optionsOrFn;
    const fn = (typeof optionsOrFn === "function" ? optionsOrFn : maybeFn)!;
    const recorder = new ToolCallRecorder();
    const start = Date.now();
    try {
      const value = await fn(recorder);
      if (recorder.output === undefined && value !== undefined) {
        recorder.output = value;
      }
      return value;
    } catch (err) {
      if (recorder.success === undefined) {
        recorder.success = false;
      }
      if (recorder.error === undefined) {
        recorder.error = err instanceof Error ? err.message : String(err);
      }
      throw err;
    } finally {
      const end = Date.now();
      await this.recordToolCall(name, {
        input: options.input,
        output: recorder.output,
        success: recorder.success,
        error: recorder.error,
        latencyMs: end - start,
        startTime: start / 1000,
        endTime: end / 1000,
      });
    }
  }

  /**
   * Record a knowledge-base / vector-store retrieval. Sent as a real child-span row of the
   * active span, marked as a retrieval so RAG judges and the references panel can find it.
   */
  async recordRetrieval(name = "Retrieval", options: RetrievalOptions = {}): Promise<void> {
    const span = this.currentSpan;
    if (!span) {
      const latencyMs =
        options.durationMs !== undefined
          ? Math.round(options.durationMs)
          : options.startTime !== undefined && options.endTime !== undefined
          ? Math.round((options.endTime - options.startTime) * 1000)
          : undefined;
      this.pendingRetrievals.push({
        name,
        query: options.query !== undefined ? safeSerialize(options.query) : null,
        output: options.output !== undefined ? safeSerialize(options.output) : null,
        duration_ms: latencyMs ?? null,
      });
      return;
    }
    await span.childSpan(name, {
      startTime: options.startTime,
      endTime: options.endTime,
      durationMs: options.durationMs,
      input: options.query,
      output: options.output,
      metadata: { kind: "retrieval", ...(options.docCount !== undefined ? { doc_count: options.docCount } : {}) },
    });
  }

  /** Time a retrieval and record it via `recordRetrieval`. */
  async traceRetrieval<T>(
    name: string,
    options: { query?: string },
    fn: (recorder: RetrievalRecorder) => Promise<T> | T
  ): Promise<T>;
  async traceRetrieval<T>(name: string, fn: (recorder: RetrievalRecorder) => Promise<T> | T): Promise<T>;
  async traceRetrieval<T>(
    name: string,
    optionsOrFn: { query?: string } | ((recorder: RetrievalRecorder) => Promise<T> | T),
    maybeFn?: (recorder: RetrievalRecorder) => Promise<T> | T
  ): Promise<T> {
    const options = typeof optionsOrFn === "function" ? {} : optionsOrFn;
    const fn = (typeof optionsOrFn === "function" ? optionsOrFn : maybeFn)!;
    const recorder = new RetrievalRecorder();
    const start = Date.now();
    try {
      const value = await fn(recorder);
      if (recorder.output === undefined && value !== undefined) {
        recorder.output = value;
      }
      if (recorder.docCount === undefined && Array.isArray(value)) {
        recorder.docCount = value.length;
      }
      return value;
    } finally {
      const end = Date.now();
      await this.recordRetrieval(name, {
        query: options.query,
        docCount: recorder.docCount,
        output: recorder.output,
        durationMs: end - start,
        startTime: start / 1000,
        endTime: end / 1000,
      });
    }
  }

  /** Resolve once all queued traces have been delivered. */
  async flush(timeoutMs = 5000): Promise<void> {
    await this.client.flush(timeoutMs);
  }

  // ------------------------------------------------------------------
  // CI/CD evaluation
  // ------------------------------------------------------------------

  /**
   * Run the full CI/CD evaluation lifecycle in one call: create a CI run, call
   * `agentFn(query)` for each test case, submit results for scoring, finalize, and return
   * the gate decision.
   */
  async runEval(
    datasetId: string,
    agentFn: (query: string) => Promise<string> | string,
    options: {
      agentName?: string;
      passRateThreshold?: number;
      gitContext?: Record<string, any>;
      concurrency?: number;
      failOnGate?: boolean;
      timeoutPerQuestionMs?: number;
    } = {}
  ): Promise<CIRunResult> {
    const run = await this.createCiRun(datasetId, {
      agentName: options.agentName,
      passRateThreshold: options.passRateThreshold,
      gitContext: options.gitContext,
    });

    const bail = async (): Promise<CIRunResult> => {
      const status = await this.getCiRun(run.runId);
      const final: CIRunResult = {
        runId: run.runId,
        gate: "fail",
        passRate: 0,
        totalQuestions: run.totalQuestions,
        passedQuestions: 0,
        scores: [],
        violations: [],
        finalizedAt: status.finalizedAt,
      };
      if (options.failOnGate) {
        throw new CIGateFailure(final);
      }
      return final;
    };

    const processCase = async (testCase: { index: number; query?: string }): Promise<CIQuestionScore> => {
      const query = testCase.query || "";
      const start = Date.now();
      let output: string | undefined;
      let errorOutput: string | undefined;
      try {
        output = await withTimeout(
          Promise.resolve(agentFn(query)),
          options.timeoutPerQuestionMs,
          `agentFn timed out after ${options.timeoutPerQuestionMs}ms`
        );
      } catch (err) {
        errorOutput = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
      }
      return this.submitResult(run.runId, testCase.index, errorOutput ?? output ?? "", {
        input: query,
        latencyMs: Date.now() - start,
      });
    };

    const concurrency = Math.max(options.concurrency ?? 1, 1);
    if (concurrency <= 1) {
      for (const testCase of run.testCases) {
        const score = await processCase(testCase);
        if (score.gateFired) {
          return bail();
        }
      }
    } else {
      const queue = [...run.testCases];
      let gateFired = false;
      const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        while (!gateFired) {
          const testCase = queue.shift();
          if (!testCase) {
            return;
          }
          const score = await processCase(testCase);
          if (score.gateFired) {
            gateFired = true;
          }
        }
      });
      await Promise.all(workers);
      if (gateFired) {
        return bail();
      }
    }

    const result = await this.finalizeCiRun(run.runId);
    if (options.failOnGate && result.gate === "fail") {
      throw new CIGateFailure(result);
    }
    return result;
  }

  /** Create a CI run and receive test cases from the dataset. */
  createCiRun(
    datasetId: string,
    options: {
      agentName?: string;
      passRateThreshold?: number;
      gitContext?: Record<string, any>;
      workspaceId?: string;
    } = {}
  ): Promise<CIRun> {
    return this.client.createCiRun(datasetId, options);
  }

  /** Submit an agent output for one CI run test case. */
  submitResult(
    runId: string,
    questionIndex: number,
    output: any,
    options: { input?: any; latencyMs?: number } = {}
  ): Promise<CIQuestionScore> {
    return this.client.submitCiResult(runId, questionIndex, output, options);
  }

  /** Finalize a CI run and return the gate result. */
  finalizeCiRun(runId: string): Promise<CIRunResult> {
    return this.client.finalizeCiRun(runId);
  }

  /** Poll the current status of a CI run. */
  getCiRun(runId: string): Promise<CIRunStatus> {
    return this.client.getCiRun(runId);
  }

  /**
   * Score a previously-ingested production trace against a dataset. The trace's recorded
   * input/output are used as-is - the agent is NOT re-run.
   */
  evaluateTrace(
    traceId: string,
    datasetId: string,
    options: { questionIndex?: number } = {}
  ): Promise<TraceEvaluationResult> {
    return this.client.evaluateTrace(traceId, datasetId, options);
  }

  // ------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------

  /** @internal */
  async _send(fields: Record<string, any> & { sync?: boolean }): Promise<string | undefined> {
    const { sync = false, ...rest } = fields;
    const wire: Record<string, any> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined && value !== null) {
        wire[key] = value;
      }
    }

    if (this.pendingToolCalls.length) {
      // Passed through whole rather than re-projected: `recordToolCall` may have attached
      // success/error, the exact fields the engine's tool-failure check reads.
      wire.tool_calls = [...(wire.tool_calls || []), ...this.pendingToolCalls];
      this.pendingToolCalls = [];
    }
    if (this.pendingRetrievals.length) {
      const summary = { ...(wire.performance_summary || {}) };
      summary.retrieval_steps = [...(summary.retrieval_steps || []), ...this.pendingRetrievals];
      wire.performance_summary = summary;
      this.pendingRetrievals = [];
    }

    return this._dispatch(wire, sync);
  }

  /** @internal Enqueue (or synchronously send) an already wire-shaped payload. */
  async _dispatch(wire: Record<string, any>, sync: boolean): Promise<string | undefined> {
    if (sync) {
      return this.client.sendTraceSync(wire);
    }
    this.client.enqueue(wire);
    return undefined;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, message: string): Promise<T> {
  if (!timeoutMs) {
    return promise;
  }
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

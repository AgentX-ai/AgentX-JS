/**
 * Hermetic test for the tracing + evaluations surfaces.
 *
 * Runs a stub AgentX API on localhost and asserts the exact wire payloads the SDK sends,
 * so it needs no credentials and no network: `npm test`.
 */
import * as assert from "assert";
import * as http from "http";
import { AddressInfo } from "net";

import { AgentX } from "./src/index";

interface Received {
  method: string;
  path: string;
  body: any;
  query: URLSearchParams;
}

const received: Received[] = [];
let traceCounter = 0;

function json(res: http.ServerResponse, status: number, body: any): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

function route(req: http.IncomingMessage, res: http.ServerResponse, body: any): void {
  const url = new URL(req.url || "/", "http://localhost");
  const path = url.pathname;
  received.push({ method: req.method || "", path, body, query: url.searchParams });

  // --- tracing -------------------------------------------------------
  if (path === "/api/v1/monitor/patterns") {
    return json(res, 200, []);
  }
  if (path === "/api/v1/ingest/traces" && req.method === "POST") {
    traceCounter += 1;
    return json(res, 200, { trace_id: `trace_${traceCounter}` });
  }
  if (/^\/api\/v1\/ingest\/traces\/[^/]+\/evaluate$/.test(path)) {
    return json(res, 200, { run_id: "run_1", trace_id: "trace_1", rating: 8, justification: "ok", status: "done" });
  }

  // --- CI/CD evaluation ----------------------------------------------
  if (path === "/api/v1/ingest/ci-runs" && req.method === "POST") {
    return json(res, 200, {
      run_id: "ci_1",
      dataset_id: body.dataset_id,
      total_questions: 2,
      test_cases: [
        { index: 0, query: "How do I reset my password?" },
        { index: 1, query: "What are your support hours?" },
      ],
      expires_at: "2030-01-01T00:00:00.000Z",
    });
  }
  if (/^\/api\/v1\/ingest\/ci-runs\/[^/]+\/results$/.test(path)) {
    return json(res, 200, {
      question_index: body.question_index,
      rating: 9,
      justification: "good",
      passed: true,
      gate_fired: false,
    });
  }
  if (/^\/api\/v1\/ingest\/ci-runs\/[^/]+\/finalize$/.test(path)) {
    return json(res, 200, {
      run_id: "ci_1",
      gate: "pass",
      pass_rate: 1,
      total_questions: 2,
      passed_questions: 2,
      scores: [{ question_index: 0, rating: 9, justification: "good", passed: true }],
      violations: [],
      finalized_at: "2026-01-01T00:00:00.000Z",
    });
  }

  // --- evaluations ----------------------------------------------------
  const evalRoot = "/api/v1/custom-agent-evaluations";
  if (path === `${evalRoot}/datasets` && req.method === "POST") {
    return json(res, 200, { _id: "ds_1", ...body, status: "published" });
  }
  if (path === `${evalRoot}/datasets/ds_1`) {
    return json(res, 200, {
      _id: "ds_1",
      name: "stub dataset",
      numberOfRequests: 2,
      questions: [
        { main_question: { query: "How do I reset my password?", expectedResults: "settings > security" } },
        { main_question: { query: "What are your support hours?", expectedResults: "9-5 weekdays" } },
      ],
    });
  }
  if (path === `${evalRoot}/runs` && req.method === "POST") {
    return json(res, 200, { runId: "run_1", datasetId: body.datasetId, limits: { maxBatchSize: 2 } });
  }
  if (path === `${evalRoot}/runs/run_1/results`) {
    return json(res, 200, {
      runId: "run_1",
      batchId: body.batchId,
      accepted: body.results.length,
      duplicates: 0,
      failedValidation: 0,
      liveStatistics: { averageRating: 8.5, minRating: 7, maxRating: 10, ratedCount: body.results.length },
    });
  }
  if (path === `${evalRoot}/runs/run_1/finalize`) {
    return json(res, 200, { status: "completed", liveStatistics: { averageRating: 8.5, ratedCount: 4 } });
  }
  if (path === `${evalRoot}/runs/run_1/analyze`) {
    return json(res, 200, { jobId: "job_1", status: "pending" });
  }
  if (path === `${evalRoot}/runs/run_1/analyze-status`) {
    return json(res, 200, { jobId: "job_1", status: "completed", progress: { overallPercentage: 100 } });
  }
  if (path === `${evalRoot}/runs/run_1/report`) {
    return json(res, 200, {
      runId: "run_1",
      datasetId: "ds_1",
      status: "completed",
      summary: "Solid.",
      strengths: ["clear answers"],
      weaknesses: [],
      recommendations: [{ priority: "high", category: "instructions", recommendation: "Add examples" }],
      statistics: { numberOfRuns: 4, averageRating: 8.5, minRating: 7, maxRating: 10 },
      cosineSimilarity: 0.91,
    });
  }
  if (path === `${evalRoot}/runs/run_1/gate`) {
    return json(res, 200, {
      passed: true,
      averageRating: 8.5,
      checks: [{ check: "failUnder", passed: true, detail: "8.5 >= 7" }],
    });
  }
  if (path === `${evalRoot}/models`) {
    return json(res, 200, [{ name: "gpt-5.5", provider: "OpenAI", contextWindow: 400000 }]);
  }

  return json(res, 404, { message: `no stub for ${req.method} ${path}` });
}

function startServer(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: any = undefined;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      route(req, res, body);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function sent(pathSuffix: string): Received[] {
  return received.filter((r) => r.path.endsWith(pathSuffix));
}

async function main(): Promise<void> {
  const server = await startServer();
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}/api/v1`;
  const client = new AgentX("test-key", { baseUrl });

  // ---- ping ---------------------------------------------------------
  assert.deepStrictEqual(await client.ping(), { ok: true, baseUrl });

  // ---- tracing ------------------------------------------------------
  const span = await client.tracer.withSpan(
    "smoke-agent",
    { input: { query: "hi" }, framework: "openai", sync: true, monitor: false },
    async (s) => {
      await client.tracer.traceRetrieval("kb_search", { query: "password" }, async (r) => {
        r.docCount = 2;
        return ["a", "b"];
      });
      await client.tracer.traceToolCall("policy_lookup", { input: { topic: "x" } }, async (t) => {
        t.output = { ok: true };
        return t.output;
      });
      await s.recordLlmCall({ durationMs: 12, model: "gpt-4o-mini", inputTokens: 10, outputTokens: 4 });
      s.addToolCall("failing_tool", { output: "boom", success: false, error: "boom" });
      s.output = "done";
      return s;
    }
  );
  assert.strictEqual(typeof span.traceId, "string", "sync span should return a trace id");
  // Child spans are queued (fire-and-forget); flush before inspecting what the server saw.
  await client.tracer.flush();

  const traces = sent("/ingest/traces").map((r) => r.body);
  const root = traces.find((t) => t.name === "smoke-agent");
  const retrieval = traces.find((t) => t.name === "kb_search");
  const tool = traces.find((t) => t.name === "policy_lookup");
  const llm = traces.find((t) => t.name === "LLM Call 1");

  assert.ok(root && retrieval && tool && llm, "root, retrieval, tool and llm spans should all be sent");
  assert.strictEqual(retrieval.parent_span_id, root.span_id, "retrieval parents to the root span");
  assert.strictEqual(tool.parent_span_id, root.span_id, "tool call parents to the root span");
  assert.strictEqual(llm.parent_span_id, root.span_id, "llm call parents to the root span");
  assert.strictEqual(retrieval.session_id, root.session_id, "children share the root's session");
  assert.strictEqual(retrieval.metadata.kind, "retrieval", "retrieval child carries the kind marker");
  assert.strictEqual(root.framework, "openai");
  assert.strictEqual(root.monitor, false);
  assert.strictEqual(root.input_tokens, 10);
  assert.strictEqual(root.output_tokens, 4);
  assert.strictEqual(typeof root.started_at_unix_nano, "string", "nano timestamps go over the wire as strings");
  const failing = root.tool_calls.find((t: any) => t.name === "failing_tool");
  assert.strictEqual(failing.success, false, "a failed tool call keeps success:false for the Tool failure check");
  assert.ok(
    root.tool_calls.some((t: any) => t.name === "policy_lookup"),
    "traceToolCall also mirrors onto the root's flat tool_calls list"
  );

  // Queued (fire-and-forget) span plus explicit flush
  const queued = client.tracer.trace("queued-agent");
  queued.output = "ok";
  assert.strictEqual(await queued.end(), undefined, "queued spans resolve without a trace id");
  await client.tracer.flush();
  assert.ok(sent("/ingest/traces").some((r) => r.body.name === "queued-agent"), "flush drains the queue");

  // Score an already-ingested trace
  const scored = await client.tracer.evaluateTrace("trace_1", "ds_1", { questionIndex: 0 });
  assert.strictEqual(scored.rating, 8);

  // ---- CI/CD lifecycle ----------------------------------------------
  const ci = await client.tracer.runEval("ds_1", (query) => `answer: ${query}`, { agentName: "ci-agent" });
  assert.strictEqual(ci.gate, "pass");
  assert.strictEqual(ci.passedQuestions, 2);
  assert.strictEqual(sent("/results").filter((r) => r.path.includes("ci-runs")).length, 2, "one submit per test case");

  // ---- evaluations ---------------------------------------------------
  const dataset = await client.evaluations.datasets
    .builder("stub dataset", { numberOfRequests: 2, judgeModel: "gpt-5.5" })
    .addCase("How do I reset my password?", { expectedResults: "settings > security", expectedTools: ["kb_search"] })
    .publish();
  assert.strictEqual(dataset.id, "ds_1");
  const createdDataset = sent("/datasets").find((r) => r.method === "POST")!.body;
  assert.strictEqual(createdDataset.questions[0].main_question.expectedTrajectory.mode, "strict");
  assert.strictEqual(createdDataset.judgeModel, "gpt-5.5");

  const report = await client.evaluations
    .run({ datasetId: "ds_1", subject: { displayName: "Stub agent", framework: "openai" } })
    .execute((c) => ({ output: `answer: ${c.query}`, traceId: "trace_1", inputTokens: 11, outputTokens: 5 }))
    .finalize()
    .analyze({ pollIntervalMs: 1 });

  assert.strictEqual(report.status, "completed");
  assert.strictEqual(report.averageRating, 8.5);
  assert.strictEqual(report.cosineSimilarity, 0.91, "top-level similarity metrics hoist into statistics");

  const initRun = sent("/runs").find((r) => r.method === "POST")!.body;
  assert.strictEqual(initRun.runSource, "sdk");
  assert.strictEqual(initRun.sdk.name, "agentx-js");
  assert.strictEqual(initRun.evaluationSubject.displayName, "Stub agent");
  assert.strictEqual(initRun.evaluationSubject.runtime, "local", "runtime defaults to local");

  const resultBatches = sent("/runs/run_1/results").map((r) => r.body);
  const submitted = resultBatches.flatMap((b) => b.results);
  assert.strictEqual(submitted.length, 4, "2 questions x numberOfRequests 2");
  assert.strictEqual(resultBatches.length, 2, "batches respect the server's maxBatchSize");
  assert.strictEqual(submitted[0].idempotencyKey, "run_1:case-0:run-1");
  assert.strictEqual(submitted[0].traceId, "trace_1", "trace linkage rides along on the result");
  assert.strictEqual(submitted[0].timings.inputTokens, 11);
  assert.strictEqual(submitted[0].input.query, "How do I reset my password?");

  const analyzeBody = sent("/runs/run_1/analyze").find((r) => r.method === "POST")!.body;
  assert.deepStrictEqual(analyzeBody.judges, [{ model: "gpt-5.5" }], "a single default judge, like the Python SDK");

  const gate = await client.evaluations.gateRun("run_1", { failUnder: 7, noRegression: true });
  assert.strictEqual(gate.passed, true);
  assert.strictEqual(gate.exitCode, 0);
  const gateQuery = sent("/runs/run_1/gate")[0].query;
  assert.strictEqual(gateQuery.get("failUnder"), "7");
  assert.strictEqual(gateQuery.get("noRegression"), "true");
  assert.strictEqual(gateQuery.get("caller"), "sdk");

  const models = await client.evaluations.listModels();
  assert.strictEqual(models[0].name, "gpt-5.5");

  server.close();
  console.log("\nAll tracing + evaluations checks passed.");
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});

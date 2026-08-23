import axios from "axios";

import { EvaluationCase, EvaluationResult } from "../models";
import { normalizeError, normalizeResult } from "../results";

/**
 * Calls a self-hosted HTTP endpoint for each evaluation case. The SDK (running locally)
 * makes the request - the AgentX API never touches your endpoint.
 *
 * The endpoint receives `{ query, case_id, question_index, run_number }` and should respond
 * with a JSON body containing at least `output` (or `text`), optionally `trace`, `traceId`,
 * `retrievalContext` and `metadata`.
 */
export class HttpEndpointAdapter {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly method: string;

  constructor(options: { url: string; headers?: Record<string, string>; timeoutMs?: number; method?: string }) {
    this.url = options.url;
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.method = (options.method ?? "POST").toUpperCase();
  }

  async run(evaluationCase: EvaluationCase): Promise<EvaluationResult> {
    const payload = {
      query: evaluationCase.query,
      case_id: evaluationCase.caseId,
      question_index: evaluationCase.questionIndex,
      run_number: evaluationCase.runNumber,
    };
    const start = Date.now();
    try {
      const resp = await axios.request({
        method: this.method,
        url: this.url,
        data: payload,
        headers: this.headers,
        timeout: this.timeoutMs,
      });
      return normalizeResult(evaluationCase, resp.data, Date.now() - start);
    } catch (err) {
      return normalizeError(evaluationCase, err, Date.now() - start);
    }
  }
}

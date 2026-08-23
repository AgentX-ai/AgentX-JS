import { EvaluationCase, EvaluationResult } from "../models";
import { normalizeError, normalizeResult } from "../results";

/** Anything that can answer one evaluation case. */
export type AgentFunction = (evaluationCase: EvaluationCase) => any | Promise<any>;

/**
 * Wraps any function that takes an EvaluationCase and returns
 * `string | object | EvaluationResult` (or a promise of one).
 */
export class RawCallableAdapter {
  constructor(private readonly fn: AgentFunction) {}

  async run(evaluationCase: EvaluationCase): Promise<EvaluationResult> {
    const start = Date.now();
    try {
      const raw = await this.fn(evaluationCase);
      return normalizeResult(evaluationCase, raw, Date.now() - start);
    } catch (err) {
      return normalizeError(evaluationCase, err, Date.now() - start);
    }
  }
}

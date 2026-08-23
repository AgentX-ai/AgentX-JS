import { EvaluationCase, EvaluationResult } from "../models";
import { normalizeResult } from "../results";

/**
 * Adapter for pre-computed outputs - when you already have agent responses and just want
 * AgentX to score them.
 *
 * ```ts
 * const adapter = new PrecomputedAdapter({
 *   "case-0": "You can reset your password from account settings.",
 *   "case-1": { output: "Contact support@example.com", metadata: { source: "kb" } },
 * });
 * ```
 */
export class PrecomputedAdapter {
  private readonly lookup: Record<string, any>;

  constructor(outputs: any[] | Record<string, any>) {
    if (Array.isArray(outputs)) {
      this.lookup = Object.fromEntries(outputs.map((value, index) => [String(index), value]));
    } else {
      this.lookup = Object.fromEntries(Object.entries(outputs).map(([key, value]) => [String(key), value]));
    }
  }

  async run(evaluationCase: EvaluationCase): Promise<EvaluationResult> {
    const raw = this.lookup[evaluationCase.caseId] ?? this.lookup[String(evaluationCase.questionIndex)] ?? "";
    return normalizeResult(evaluationCase, raw, 0);
  }
}

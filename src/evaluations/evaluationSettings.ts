import { EvaluationSettings } from "./models";
import type { EvaluationsClient } from "./client";
import type { DatasetConfig } from "./datasets";

export interface CodeScorer {
  name: string;
  enabled?: boolean;
  /**
   * A sandboxed JS function body receiving `(input, output, expected, toolCalls)` and
   * returning `{ score, reasoning }`. Runs per result alongside the judge.
   */
  code: string;
}

export interface EvaluationSettingsConfig extends DatasetConfig {
  codeScorers?: CodeScorer[];
}

/**
 * Fluent builder for a standalone, reusable grading config (no dataset/questions attached).
 * Run it against any dataset by passing its id as `evaluationSettingsId` to
 * `client.evaluations.run(...)`.
 */
export class EvaluationSettingsBuilder {
  private readonly payload: Record<string, any>;

  constructor(private readonly client: EvaluationsClient, name: string, config: EvaluationSettingsConfig = {}) {
    this.payload = {
      name,
      description: config.description ?? null,
      numberOfRequests: config.numberOfRequests ?? 1,
      acceptanceCriteria: config.acceptanceCriteria ?? null,
      rejectionCriteria: config.rejectionCriteria ?? null,
      evaluationCriteria: config.evaluationCriteria ?? null,
    };
    if (config.judgePrompt !== undefined) {
      this.payload.judgePrompt = config.judgePrompt;
    }
    if (config.judgeModel !== undefined) {
      this.payload.judgeModel = config.judgeModel;
    }
    if (config.vectorSimilarity) {
      this.payload.vectorSimilarity = config.similarityModel
        ? { enabled: true, model: config.similarityModel }
        : { enabled: true };
    }
    if (config.jaccardSimilarity) {
      this.payload.jaccardSimilarity = { enabled: true };
    }
    if (config.bleuScore) {
      this.payload.bleuScore = { enabled: true };
    }
    if (config.rougeScore) {
      this.payload.rougeScore = { enabled: true };
    }
    if (config.sovereigntyModels?.length) {
      this.payload.sovereigntyIndex = { enabled: true, models: [...config.sovereigntyModels] };
    }
    if (config.codeScorers?.length) {
      this.payload.codeScorers = config.codeScorers.map((scorer) => ({ enabled: true, ...scorer }));
    }
  }

  publish(): Promise<EvaluationSettings> {
    return this.client.createEvaluationSettings(this.payload);
  }
}

/** Thin wrapper surfaced as `client.evaluations.settings`. */
export class EvaluationSettingsClient {
  constructor(private readonly client: EvaluationsClient) {}

  builder(name: string, config: EvaluationSettingsConfig = {}): EvaluationSettingsBuilder {
    return new EvaluationSettingsBuilder(this.client, name, config);
  }

  get(evaluationSettingsId: string): Promise<EvaluationSettings> {
    return this.client.getEvaluationSettings(evaluationSettingsId);
  }

  list(): Promise<EvaluationSettings[]> {
    return this.client.listEvaluationSettings();
  }
}

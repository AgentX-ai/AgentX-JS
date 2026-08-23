import * as fs from "fs";

import { Dataset } from "./models";
import type { EvaluationsClient } from "./client";

export interface DatasetConfig {
  description?: string;
  /** How many times each question is asked per run. Default 1. */
  numberOfRequests?: number;
  acceptanceCriteria?: string;
  rejectionCriteria?: string;
  evaluationCriteria?: string;
  /** LLM-as-judge overrides. Omit to keep the server default. */
  judgePrompt?: string;
  judgeModel?: string;
  /** Opt-in similarity metrics, surfaced on the report. */
  vectorSimilarity?: boolean;
  jaccardSimilarity?: boolean;
  bleuScore?: boolean;
  rougeScore?: boolean;
  similarityModel?: string;
  /** Sovereignty & Portability - models to compare on this dataset. */
  sovereigntyModels?: string[];
}

export interface AddCaseOptions {
  expectedResults?: string;
  expectedCapabilities?: string[];
  expectedKnowledgeBase?: string[];
  expectedDelegations?: string[];
  followUpQuestions?: Record<string, any>[];
  /** Grading guidance specific to this question. */
  judgeGuideline?: string;
  /**
   * Ask this question `smokeTestCount` (1-10) extra ways each run, LLM-paraphrased
   * server-side, to catch agents that are brittle to phrasing rather than genuinely wrong.
   */
  smokeTestCount?: number;
  smokeTestGuidance?: string;
  /**
   * The tool calls a correct run of this case should make. Matched against the linked
   * trace's actual tool-call sequence and reported as a "Trajectory match" scorer row.
   */
  expectedTools?: string[];
  /** agentevals semantics: "strict" | "unordered" | "superset" | "subset". */
  trajectoryMatchMode?: "strict" | "unordered" | "superset" | "subset";
  /** What a correct retriever should have fetched - scored as "Context match (jaccard)". */
  expectedRetrievalContext?: string | string[];
}

/** Fluent builder for creating a Custom Agent Evaluations dataset. */
export class DatasetBuilder {
  private readonly payload: Record<string, any>;

  constructor(private readonly client: EvaluationsClient, name: string, config: DatasetConfig = {}) {
    this.payload = {
      name,
      description: config.description ?? null,
      numberOfRequests: config.numberOfRequests ?? 1,
      acceptanceCriteria: config.acceptanceCriteria ?? null,
      rejectionCriteria: config.rejectionCriteria ?? null,
      evaluationCriteria: config.evaluationCriteria ?? null,
      questions: [],
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
  }

  addCase(query: string, options: AddCaseOptions = {}): this {
    const main: Record<string, any> = { query };
    if (options.expectedResults) {
      main.expectedResults = options.expectedResults;
    }
    if (options.expectedCapabilities?.length) {
      main.expectedCapabilities = options.expectedCapabilities;
    }
    if (options.expectedKnowledgeBase?.length) {
      main.expectedKnowledgeBase = options.expectedKnowledgeBase;
    }
    if (options.expectedDelegations?.length) {
      main.expectedDelegations = options.expectedDelegations;
    }
    if (options.judgeGuideline) {
      main.judgeGuideline = options.judgeGuideline;
    }
    if (options.smokeTestCount) {
      main.smokeTest = { enabled: true, count: options.smokeTestCount };
      if (options.smokeTestGuidance) {
        main.smokeTest.guidance = options.smokeTestGuidance;
      }
    }
    if (options.expectedTools?.length) {
      main.expectedTrajectory = {
        tools: options.expectedTools,
        mode: options.trajectoryMatchMode ?? "strict",
      };
    }
    if (options.expectedRetrievalContext) {
      main.expectedRetrievalContext = options.expectedRetrievalContext;
    }
    this.payload.questions.push({
      main_question: main,
      follow_up_questions: options.followUpQuestions ?? [],
    });
    return this;
  }

  async publish(): Promise<Dataset> {
    if (!this.payload.questions.length) {
      throw new Error("Dataset must have at least one case before publishing");
    }
    return this.client.createDataset(this.payload);
  }

  /**
   * Load cases from a CSV file.
   *
   * Required column: `query`. Optional: `expected_results`, `expected_capabilities`,
   * `expected_knowledge_base`, `expected_delegations` (the list columns are
   * semicolon-separated).
   */
  static fromCsv(client: EvaluationsClient, path: string, name: string, config: DatasetConfig = {}): DatasetBuilder {
    if (!fs.existsSync(path)) {
      throw new Error(`CSV file not found: ${path}`);
    }
    const rows = parseCsv(fs.readFileSync(path, "utf8"));
    if (!rows.length) {
      throw new Error("CSV is missing required column(s): query");
    }
    if (!Object.prototype.hasOwnProperty.call(rows[0], "query")) {
      throw new Error("CSV is missing required column(s): query");
    }

    const builder = new DatasetBuilder(client, name, config);
    let skipped = 0;
    rows.forEach((row) => {
      const query = (row.query ?? "").trim();
      if (!query) {
        skipped += 1;
        return;
      }
      builder.addCase(query, {
        expectedResults: (row.expected_results ?? "").trim() || undefined,
        expectedCapabilities: splitSemi(row.expected_capabilities),
        expectedKnowledgeBase: splitSemi(row.expected_knowledge_base),
        expectedDelegations: splitSemi(row.expected_delegations),
      });
    });
    if (skipped) {
      console.warn(`[agentx] skipped ${skipped} CSV row(s) with an empty query`);
    }
    return builder;
  }

  /** Load cases from an array of row objects (the JS equivalent of `from_dataframe`). */
  static fromRows(
    client: EvaluationsClient,
    rows: Record<string, any>[],
    name: string,
    config: DatasetConfig = {}
  ): DatasetBuilder {
    const builder = new DatasetBuilder(client, name, config);
    for (const row of rows) {
      const query = String(row.query ?? "").trim();
      if (!query) {
        continue;
      }
      builder.addCase(query, {
        expectedResults: strOrUndefined(row.expected_results),
        expectedCapabilities: splitSemi(row.expected_capabilities),
        expectedKnowledgeBase: splitSemi(row.expected_knowledge_base),
        expectedDelegations: splitSemi(row.expected_delegations),
      });
    }
    return builder;
  }
}

/** Thin wrapper surfaced as `client.evaluations.datasets`. */
export class DatasetClient {
  constructor(private readonly client: EvaluationsClient) {}

  builder(name: string, config: DatasetConfig = {}): DatasetBuilder {
    return new DatasetBuilder(this.client, name, config);
  }

  fromCsv(path: string, name: string, config: DatasetConfig = {}): DatasetBuilder {
    return DatasetBuilder.fromCsv(this.client, path, name, config);
  }

  fromRows(rows: Record<string, any>[], name: string, config: DatasetConfig = {}): DatasetBuilder {
    return DatasetBuilder.fromRows(this.client, rows, name, config);
  }

  get(datasetId: string): Promise<Dataset> {
    return this.client.getDataset(datasetId);
  }

  list(): Promise<Dataset[]> {
    return this.client.listDatasets();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitSemi(value: any): string[] | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const s = String(value).trim();
  if (!s || s === "nan") {
    return undefined;
  }
  const parts = s
    .split(";")
    .map((v) => v.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}

function strOrUndefined(value: any): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const s = String(value).trim();
  return s && s !== "nan" ? s : undefined;
}

/** Minimal RFC4180 CSV reader - quoted fields, escaped quotes, embedded newlines. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") {
        i++;
      }
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  const nonEmpty = rows.filter((r) => r.some((cell) => cell.trim() !== ""));
  if (!nonEmpty.length) {
    return [];
  }
  const header = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    header.forEach((key, index) => {
      record[key] = cells[index] ?? "";
    });
    return record;
  });
}

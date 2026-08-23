import { Report } from "./models";
import { bold, cyan, dim, green, red, yellow } from "./term";

const SEP = "-".repeat(60);
const THIN = "-".repeat(40);

type Colorize = (s: string) => string;

const RATING_COLORS: Record<string, Colorize> = { high: green, medium: yellow, low: red };
const RATING_ICONS: Record<string, string> = { high: "H", medium: "M", low: "L" };
const PRIORITY_COLORS: Record<string, Colorize> = { high: red, medium: yellow, low: dim };
const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

function ratingBadge(rating?: string): string {
  const icon = RATING_ICONS[rating ?? ""] ?? "-";
  const color = RATING_COLORS[rating ?? ""] ?? dim;
  return rating ? color(`[${icon}] ${rating.toUpperCase()}`) : dim(icon);
}

function section(title: string, rating?: string): void {
  const badge = rating ? `  ${ratingBadge(rating)}` : "";
  console.log(`\n${bold(title)}${badge}`);
  console.log(dim(THIN));
}

function scaleColor(value: number, good: number, ok: number): Colorize {
  return value >= good ? green : value >= ok ? yellow : red;
}

function percentLine(label: string, value: number | undefined, note: string, good: number, ok: number): void {
  if (value === undefined || value === null) {
    return;
  }
  const color = scaleColor(value, good, ok);
  console.log(`  ${dim(label)} ${color(`${(value * 100).toFixed(1)}%`)}  ${dim(note)}`);
}

function list(items: any[] | undefined, marker: string, color: Colorize): void {
  for (const item of items ?? []) {
    console.log(`    ${color(marker)} ${item}`);
  }
}

/** Print a finished evaluation report to stdout - the JS twin of `print_report`. */
export function printReport(report: Report): void {
  console.log(cyan(SEP));
  console.log(`  ${bold("AgentX Evaluation Report")}`);
  console.log(cyan(SEP));
  console.log(`  ${dim("Run     :")} ${dim(report.runId)}`);
  console.log(`  ${dim("Dataset :")} ${dim(report.datasetId)}`);
  console.log(
    `  ${dim("Status  :")} ${report.status === "completed" ? green(report.status) : yellow(report.status)}`
  );

  const stats = report.statistics;
  if (stats) {
    const color = scaleColor(stats.averageRating, 7, 4);
    console.log(`  ${dim("Cases   :")} ${stats.numberOfRuns}`);
    console.log(
      `  ${dim("Rating  :")} ${color(`${stats.averageRating.toFixed(1)}/10`)}  ` +
        `${dim(`(min ${stats.minRating.toFixed(1)} / max ${stats.maxRating.toFixed(1)})`)}`
    );
  }

  percentLine("Cosine  :", report.cosineSimilarity, "(vector similarity)", 0.85, 0.6);
  percentLine("Jaccard :", report.jaccardSimilarity, "(token-set overlap)", 0.6, 0.3);
  percentLine("BLEU    :", report.bleuScore, "(n-gram precision)", 0.6, 0.3);
  percentLine("ROUGE-L :", report.rougeScore, "(longest common subsequence)", 0.6, 0.3);

  if (report.consistencyScore !== undefined && report.consistencyScore !== null) {
    const color = scaleColor(report.consistencyScore, 7, 4);
    console.log(`  ${dim("Consist :")} ${color(`${report.consistencyScore.toFixed(1)}/10`)}`);
  }
  if (report.overallRating) {
    console.log(`  ${dim("Overall :")} ${ratingBadge(report.overallRating)}`);
  }

  if (report.summary) {
    section("Summary");
    console.log(`  ${report.summary}`);
  }

  const adherence = report.instructionAdherence;
  if (adherence) {
    section("Instruction Adherence", adherence.rating);
    if (adherence.analysis) {
      console.log(`  ${adherence.analysis}`);
    }
    if (adherence.deviations?.length) {
      console.log(`  ${dim("Deviations:")}`);
      list(adherence.deviations, "!", yellow);
    }
  }

  const patterns = report.responsePatterns;
  if (patterns) {
    section("Response Patterns", patterns.rating);
    list(patterns.similarities, "=", dim);
    list(patterns.differences, "~", cyan);
    list(patterns.outliers, "*", yellow);
  }

  const reasoning = report.reasoningAnalysis;
  if (reasoning) {
    section("Reasoning Analysis", reasoning.rating);
    if (reasoning.cotQuality) {
      console.log(`  ${dim("CoT:")} ${reasoning.cotQuality}`);
    }
    list(reasoning.reasoningPatterns, "+", green);
    list(reasoning.reasoningGaps, "-", red);
  }

  const tools = report.toolUsageAnalysis;
  if (tools) {
    section("Tool Usage", tools.rating);
    if (tools.effectiveness) {
      console.log(`  ${tools.effectiveness}`);
    }
    list(tools.patterns, "+", green);
    list(tools.issues, "!", yellow);
  }

  if (report.strengths.length) {
    section("Strengths");
    for (const item of report.strengths) {
      console.log(`  ${green("+")} ${item}`);
    }
  }
  if (report.weaknesses.length) {
    section("Weaknesses");
    for (const item of report.weaknesses) {
      console.log(`  ${red("-")} ${item}`);
    }
  }

  if (report.recommendations.length) {
    section("Recommendations");
    const sorted = [...report.recommendations].sort(
      (a, b) => (PRIORITY_ORDER[a.priority ?? "low"] ?? 2) - (PRIORITY_ORDER[b.priority ?? "low"] ?? 2)
    );
    for (const rec of sorted) {
      const priorityColor = PRIORITY_COLORS[rec.priority ?? "low"] ?? dim;
      const priority = rec.priority ? priorityColor(`[${rec.priority.toUpperCase()}]`) : "";
      const category = rec.category ? dim(`(${rec.category})`) : "";
      console.log(`  ${priority} ${category} ${rec.recommendation ?? rec.title ?? ""}`);
      if (rec.reasoning) {
        console.log(`       ${dim("->")} ${dim(rec.reasoning)}`);
      }
    }
  }

  if (report.lowScoringCases.length) {
    section("Low-scoring Cases  (rating < 5)");
    for (const item of report.lowScoringCases.slice(0, 5)) {
      const query = String(item.query ?? item.questionText ?? "").slice(0, 80);
      console.log(`  ${red(`[${item.rating ?? "?"}]`)} ${query}`);
      if (item.justification) {
        console.log(`       ${dim(String(item.justification).slice(0, 120))}`);
      }
    }
  }

  if (report.dashboardUrl) {
    console.log();
    console.log(`  ${dim("Dashboard:")} ${cyan(report.dashboardUrl)}`);
  }

  console.log();
  console.log(cyan(SEP));
}

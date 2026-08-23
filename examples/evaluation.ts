/**
 * Evaluation example: publish a dataset, run an agent against it, gate the result.
 *
 *   AGENTX_API_KEY=... npx ts-node examples/evaluation.ts
 *   # self-hosted: AGENTX_API_BASE_URL=http://localhost:4700/api/v1
 */
import { AgentX, EvaluationCase } from "../src/index";

const client = new AgentX();

/** Your agent. Returning the trace id links each result to its full execution trace. */
async function myAgent(evaluationCase: EvaluationCase): Promise<Record<string, unknown>> {
  const span = client.tracer.trace("support-agent", { sync: true });
  const answer = `Here is how to handle: ${evaluationCase.query}`;
  span.output = answer;
  const traceId = await span.end();
  return { output: answer, traceId };
}

async function main(): Promise<void> {
  const dataset = await client.evaluations.datasets
    .builder("Support QA", { description: "Smoke suite", numberOfRequests: 2 })
    .addCase("How do I reset my password?", {
      expectedResults: "Point the user at Settings > Security.",
      judgeGuideline: "Reward concrete, clickable steps.",
    })
    .addCase("What are your support hours?", { expectedResults: "9-5 on weekdays." })
    .publish();

  const run = await client.evaluations
    .run({
      datasetId: dataset.id,
      subject: { displayName: "Support bot", framework: "openai", runtime: "local" },
    })
    .execute(myAgent)
    .finalize();

  console.log("run:", run.runId, "average rating:", run.averageRating);

  const gate = await run.gate({ failUnder: 7, noRegression: true });
  if (!gate.passed) {
    console.error("Quality gate failed");
    process.exitCode = gate.exitCode;
    return;
  }

  await run.analyze(); // prints the full qualitative report
  await client.tracer.flush();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Tracing example: one traced agent run with a retrieval, a tool call and an LLM call.
 *
 *   AGENTX_API_KEY=... npx ts-node examples/tracing.ts
 *   # self-hosted: AGENTX_API_BASE_URL=http://localhost:4700/api/v1
 */
import { AgentX } from "../src/index";

async function knowledgeBaseSearch(query: string): Promise<string[]> {
  return [`doc about ${query}`, "password policy v3"];
}

async function callLlm(question: string, context: string[]): Promise<string> {
  return `Based on ${context.length} documents: go to Settings > Security and click "Reset password". (${question})`;
}

async function main(): Promise<void> {
  const client = new AgentX();
  await client.ping(); // fail fast on a bad key or base URL

  const question = "How do I reset my password?";

  const span = client.tracer.trace("support-agent", {
    input: { query: question },
    framework: "openai",
    sync: true, // so span.end() gives us the trace id back
  });

  const docs = await client.tracer.traceRetrieval("kb_search", { query: question }, async (r) => {
    const found = await knowledgeBaseSearch(question);
    r.docCount = found.length;
    return found;
  });

  await client.tracer.traceToolCall("policy_lookup", { input: { topic: "password" } }, async (t) => {
    t.output = { policy: "self-serve reset" };
    return t.output;
  });

  const started = Date.now();
  const answer = await callLlm(question, docs);
  await span.recordLlmCall({
    durationMs: Date.now() - started,
    startTime: started / 1000,
    endTime: Date.now() / 1000,
    model: "gpt-4o-mini",
    input: question,
    output: answer,
    inputTokens: 128,
    outputTokens: 42,
  });

  span.output = answer;
  const traceId = await span.end();
  await client.tracer.flush();

  console.log("answer:", answer);
  console.log("trace:", traceId);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

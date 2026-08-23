![Logo](https://agentx-resources.s3.us-west-1.amazonaws.com/AgentX-logo-387x60.png)

[![npm version](https://img.shields.io/npm/v/@agentx-ai/agentx-js)](https://www.npmjs.com/package/@agentx-ai/agentx-js)

---

## Fast way to build AI Agents and create agent workforce

The official AgentX JavaScript/TypeScript SDK for [AgentX](https://www.agentx.so/)

Why build AI agent with AgentX?

- Simplicity, Agent - Conversation - Message structure.
- Include chain-of-thoughts.
- Choose from most open and closed sourced LLM vendors.
- Built-in Voice(ASR, TTS), Image Gen, Document, CSV/excel tool, OCR, etc.
- Support all running MCP (model context protocol).
- Support RAG with built-in re-rank.
- Multi-agent workforce orchestration.
- Multiple agents working together with a designated manager agent.
- Cross vendor LLM orchestration.

## Installation

```bash
npm install @agentx-ai/agentx-js
```

## Usage

Provide an `apiKey` inline or set `AGENTX_API_KEY` as an environment variable.
You can get an API key from https://app.agentx.so

### Agent

```typescript
import { AgentX } from '@agentx-ai/agentx-js';

const client = new AgentX(apiKey: "<your api key here>");

// Get the list of agents you have
const agents = await client.listAgents();
console.log(agents);
```

### Conversation

Each Conversation has `agents` and `users` tied to it.

```typescript
// get agent
const myAgent = await client.getAgent(id: "<agent id here>");

// Get the list of conversation from this agent
const existingConversations = await myAgent.listConversations();
console.log(existingConversations);

// Get the list of history messages from a conversation
const lastConversation = existingConversations[existingConversations.length - 1];
const msgs = await lastConversation.listMessages();
console.log(msgs);
```

### Chat

A `chat` needs to happen in the conversation. You can do `stream` response too, default `false`.

```typescript
const aConversation = await myAgent.getConversation(id: "<conversation id here>");

// Regular chat
const response = await aConversation.chat("Hello, what is your name?");

// Streaming chat
const stream = aConversation.chatStream("Hello, what is your name?");
for await (const chunk of stream) {
  console.log(chunk);
}
```

output looks like:

```
{ text: null, cot: 'The user is greeting and asking for my ', botId: 'xxx' }
{ text: null, cot: 'name, which are casual, straightforward questions.', botId: 'xxx' }
{ text: null, cot: ' I can answer these directly', botId: 'xxx' }
{ text: 'Hello', cot: null, botId: 'xxx' }
{ text: '!', cot: null, botId: 'xxx' }
{ text: ' I', cot: null, botId: 'xxx' }
{ text: ' am', cot: null, botId: 'xxx' }
{ text: ' AgentX', cot: null, botId: 'xxx' }
{ text: null, cot: null, botId: 'xxx' }
```

\*`cot` stands for chain-of-thoughts

### Workforce

A Workforce (team) consists of multiple agents working together with a designated manager agent.

```typescript
import { AgentX } from '@agentx-ai/agentx-js';

const client = new AgentX(apiKey: "<your api key here>");

// Get the list of workforces/teams you have
const workforces = await AgentX.listWorkforces();
console.log(workforces);

// Get a specific workforce
const workforce = workforces[0]; // or any specific workforce
console.log(`Workforce: ${workforce.name}`);
console.log(`Manager: ${workforce.manager.name}`);
console.log(`Agents: ${workforce.agents.map(agent => agent.name)}`);
```

#### Workforce Conversations

```typescript
// Create a new conversation with the workforce
const conversation = await workforce.newConversation();

// List all existing conversations for the workforce
const conversations = await workforce.listConversations();
console.log(conversations);
```

#### Chat with Workforce

Chat with the entire workforce team and get streaming responses from all agents.

```typescript
// Stream chat with the workforce
const stream = workforce.chatStream(
  conversation.id,
  "How can you help me with this project?"
);
for await (const chunk of stream) {
  if (chunk.text) {
    process.stdout.write(chunk.text);
  }
  if (chunk.cot) {
    console.log(` [COT: ${chunk.cot}]`);
  }
}
```

The workforce chat allows you to leverage multiple specialized agents working together to provide comprehensive responses to your queries.

## Tracing

Send agent runs to AgentX so they show up in Observe / Live Traces. Nested spans link into a
real tree (one row per LLM call, tool call and retrieval), so a multi-step run is inspectable
step by step.

```typescript
import { AgentX } from "@agentx-ai/agentx-js";

const client = new AgentX(); // reads AGENTX_API_KEY

const answer = await client.tracer.withSpan(
  "support-agent",
  { input: { query: question }, framework: "openai" },
  async (span) => {
    // Retrievals and tool calls made inside the block attach to it automatically
    const docs = await client.tracer.traceRetrieval("kb_search", { query: question }, async (r) => {
      r.docCount = 3;
      return knowledgeBase.search(question);
    });

    const policy = await client.tracer.traceToolCall("policy_lookup", { input: { topic } }, async (t) => {
      t.output = await lookupPolicy(topic);
      return t.output;
    });

    const reply = await callLlm(question, docs, policy);
    span.output = reply;
    return reply;
  }
);

await client.tracer.flush(); // traces are queued in the background - flush before exiting
```

Need the trace id back (for example to attach it to an evaluation result)? Open the span with
`sync: true`:

```typescript
const span = client.tracer.trace("support-agent", { sync: true });
span.output = await callLlm(question);
const traceId = await span.end(); // the ingested trace's id
```

Other tracing entry points:

- `client.tracer.wrap("name", fn)` - wrap a function so every call is traced
- `client.tracer.useSpan(span, fn)` - attach work started in another async context to a span
- `span.childSpan(name, { startTime, endTime, ... })` - emit a child row with your own timing
- `span.recordLlmCall({ durationMs, model, inputTokens, outputTokens })` - one LLM-call child row
- `client.tracer.evaluateTrace(traceId, datasetId)` - score an ingested trace, agent not re-run
- `client.ping()` - fail fast at startup on a bad key or base URL (trace delivery is silent)

## Evaluations

Build a dataset, run your own agent against it, and get it scored and analysed.

```typescript
const client = new AgentX();

const dataset = await client.evaluations.datasets
  .builder("Support QA", { numberOfRequests: 3, judgeModel: "gpt-5.5" })
  .addCase("How do I reset my password?", {
    expectedResults: "Point the user at Settings > Security.",
    expectedTools: ["kb_search"], // scored as a trajectory match against the linked trace
  })
  .addCase("What are your support hours?", { expectedResults: "9-5 on weekdays." })
  .publish();

const report = await client.evaluations
  .run({
    datasetId: dataset.id,
    subject: { displayName: "Support bot", framework: "openai", runtime: "local" },
  })
  .execute(async (evaluationCase) => {
    const span = client.tracer.trace("support-agent", { sync: true });
    span.output = await myAgent(evaluationCase.query);
    const traceId = await span.end();
    return { output: span.output, traceId }; // links the run's result to the full trace
  })
  .finalize()
  .analyze();

console.log(report.averageRating, report.recommendations);
```

Your `execute` function can return a plain string, an object
(`{ output, traceId, retrievalContext, metadata, inputTokens, outputTokens, error }`), or one of
the bundled adapters:

```typescript
import { HttpEndpointAdapter, PrecomputedAdapter } from "@agentx-ai/agentx-js";

// Call your own service for every case
.execute(new HttpEndpointAdapter({ url: "http://localhost:8080/eval" }))

// Or score answers you already have
.execute(new PrecomputedAdapter({ "case-0": "Go to Settings > Security." }))
```

Live rating stats are available as soon as results are submitted, without waiting for
`.analyze()`:

```typescript
const run = await client.evaluations.run({ datasetId, subject }).execute(myAgent).finalize();
console.log(run.runId, run.averageRating, run.ratedCount);
console.log(await run.fetchResults()); // per-result rows: rating, justification, trace ids
```

Datasets can also be loaded from CSV (`query`, `expected_results`, `expected_capabilities`,
`expected_knowledge_base`, `expected_delegations`; list columns are semicolon-separated):

```typescript
await client.evaluations.datasets.fromCsv("./cases.csv", "Support QA").publish();
```

Reusable grading configs live on `client.evaluations.settings` and can be pointed at any
dataset:

```typescript
const settings = await client.evaluations.settings
  .builder("Strict grading", { evaluationCriteria: "Answers must cite a policy.", judgeModel: "gpt-5.5" })
  .publish();

await client.evaluations
  .run({ datasetId, subject, evaluationSettingsId: settings.id })
  .execute(myAgent)
  .finalize();
```

## CI/CD gates

Block a merge when quality drops.

```typescript
// Gate a run you just executed (or any finalized run by id)
const gate = await client.evaluations
  .run({ datasetId, subject })
  .execute(myAgent)
  .finalize()
  .gate({ failUnder: 7, noRegression: true });

if (!gate.passed) {
  process.exit(gate.exitCode);
}
```

For CI-enabled datasets, the whole lifecycle is one call - it creates the run, asks your agent
each question, submits the answers for scoring and returns the gate decision:

```typescript
const result = await client.tracer.runEval(datasetId, (query) => myAgent(query), {
  agentName: "support-bot",
  concurrency: 4,
  failOnGate: true, // throws CIGateFailure when the gate fails
  gitContext: { branch: process.env.GITHUB_REF_NAME, commit_sha: process.env.GITHUB_SHA },
});

console.log(result.gate, result.passRate, result.violations);
```

## Self-hosted engines

Point the SDK at a self-hosted AgentX engine with `baseUrl` (or `AGENTX_API_BASE_URL`):

```typescript
const client = new AgentX(process.env.AGENTX_API_KEY, {
  baseUrl: "http://localhost:4700/api/v1",
  workspaceId: "optional-workspace-id",
});
await client.ping(); // verifies the URL and key before anything is traced
```

## TypeScript Support

This SDK is written in TypeScript and provides full type definitions. All classes, interfaces, and methods are properly typed for better development experience.

## API Reference

### AgentX

The main client class for interacting with the AgentX API.

#### Constructor

- `new AgentX(apiKey?: string)` - Creates a new AgentX client instance
- `new AgentX(apiKey?: string, options?: AgentXOptions)` - `{ baseUrl, workspaceId, flushTracesOnExit }`
- `AgentX.fromEnv(options?)` - Creates a client from `AGENTX_API_KEY` / `AGENTX_API_BASE_URL`

#### Methods

- `getAgent(id: string): Promise<Agent>` - Get a specific agent by ID
- `listAgents(): Promise<Agent[]>` - List all agents
- `getProfile(): Promise<any>` - Get the current user's profile
- `listWorkforces(): Promise<Workforce[]>` - List all workforces
- `ping(): Promise<{ ok: true; baseUrl: string }>` - Verify the base URL and API key

#### Properties

- `tracer: Tracer` - Tracing (see [Tracing](#tracing))
- `evaluations: EvaluationsRunner` - Evaluations (see [Evaluations](#evaluations))

### Tracer

- `withSpan(name, options?, fn)` - Run `fn` inside a span, closing it automatically
- `trace(name, options?): TraceSpan` - Open a span you close yourself with `span.end()`
- `wrap(name, fn, options?)` - Wrap a function so every call is traced
- `useSpan(span, fn)` - Attach work from another async context to a span
- `traceToolCall(name, options?, fn)` / `recordToolCall(name, options?)` - Record a tool call
- `traceRetrieval(name, options?, fn)` / `recordRetrieval(name, options?)` - Record a retrieval
- `flush(timeoutMs?)` - Wait for queued traces to be delivered
- `evaluateTrace(traceId, datasetId, options?)` - Score an ingested trace against a dataset
- `runEval(datasetId, agentFn, options?)` - Full CI/CD evaluation lifecycle in one call
- `createCiRun` / `submitResult` / `finalizeCiRun` / `getCiRun` - The CI lifecycle, step by step

### EvaluationsRunner (`client.evaluations`)

- `run({ datasetId, subject, evaluationSettingsId? })` - Start a run; chain `.execute(fn)`,
  `.finalize()`, `.analyze()`, `.gate()`
- `datasets.builder(name, config?)` / `datasets.fromCsv(path, name, config?)` /
  `datasets.fromRows(rows, name, config?)` / `datasets.get(id)` / `datasets.list()`
- `settings.builder(name, config?)` / `settings.get(id)` / `settings.list()`
- `listModels(provider?)` - Model ids valid for judges and portability comparisons
- `getRun(runId)` / `getReport(runId)` / `getAnalysisStatus(runId)` / `gateRun(runId, options?)`
- `listGates()` / `simulateConversation(options)` - self-hosted engines

### Agent

Represents an individual AI agent.

#### Properties

- `id: string` - Agent ID
- `name: string` - Agent name
- `avatar?: string` - Agent avatar URL
- `createdAt?: string` - Creation timestamp
- `updatedAt?: string` - Last update timestamp

#### Methods

- `getConversation(id: string): Promise<Conversation>` - Get a specific conversation
- `listConversations(): Promise<Conversation[]>` - List all conversations

### Conversation

Represents a conversation between users and agents.

#### Properties

- `id: string` - Conversation ID
- `title?: string` - Conversation title
- `users: string[]` - User IDs in the conversation
- `agents: string[]` - Agent IDs in the conversation
- `createdAt?: string` - Creation timestamp
- `updatedAt?: string` - Last update timestamp

#### Methods

- `newConversation(): Promise<Conversation>` - Create a new conversation
- `listMessages(): Promise<Message[]>` - List all messages in the conversation
- `chat(message: string, context?: number): Promise<any>` - Send a message
- `chatStream(message: string, context?: number): AsyncGenerator<ChatResponse>` - Stream chat responses

### Workforce

Represents a team of agents working together.

#### Properties

- `id: string` - Workforce ID
- `name: string` - Workforce name
- `agents: Agent[]` - List of agents in the workforce
- `manager: Agent` - Manager agent
- `description: string` - Workforce description
- `image: string` - Workforce image URL

#### Methods

- `newConversation(): Promise<Conversation>` - Create a new workforce conversation
- `listConversations(): Promise<Conversation[]>` - List all workforce conversations
- `chatStream(conversationId: string, message: string, context?: number): AsyncGenerator<ChatResponse>` - Stream chat with workforce

## Error Handling

The SDK throws descriptive errors for various failure scenarios:

- Missing API key
- Network errors
- API errors (with status codes)
- Invalid data

Tracing and evaluations calls throw typed errors that all extend `Error`, so existing
`catch (error)` blocks keep working: `AgentXAuthError`, `AgentXConnectionError`,
`AgentXAPIError` (carries `statusCode`), `AgentXValidationError`, `DatasetNotFound`,
`CINotEnabled` and `CIGateFailure`.

```typescript
try {
  const agent = await client.getAgent("invalid-id");
} catch (error) {
  console.error("Error:", error.message);
}
```

## Environment Variables

- `AGENTX_API_KEY` - Your AgentX API key (optional if passed to constructor)
- `AGENTX_API_BASE_URL` - API base URL, e.g. `http://localhost:4700/api/v1` for a self-hosted
  engine (optional; defaults to `https://api.agentx.so/api/v1`)
- `AGENTX_WORKSPACE_ID` - Scope datasets, runs and traces to a workspace (optional)

## Automated Publishing

This package uses GitHub Actions for automated publishing to npm. The workflow automatically:

1. **Checks for version changes**: If `src/version.ts` is manually modified, it uses that version
2. **Auto-bumps version**: If `src/version.ts` hasn't changed, it automatically bumps the patch version by 0.0.1
3. **Builds and publishes**: Compiles TypeScript and publishes to npm
4. **Creates releases**: Creates GitHub releases for manual version changes

### Setup Required

To enable automated publishing, you need to set up the following secrets in your GitHub repository:

1. **NPM_TOKEN**: Your npm authentication token

   - Go to npmjs.com → Account → Access Tokens
   - Create a new token with "Automation" type
   - Add it as a repository secret named `NPM_TOKEN`

2. **GITHUB_TOKEN**: This is automatically provided by GitHub Actions

### How It Works

- **Manual version bump**: Edit `src/version.ts` and push to main → triggers publish with your version
- **Automatic version bump**: Push any changes to main without touching `src/version.ts` → automatically bumps patch version and publishes
- **Manual trigger**: You can also manually trigger the workflow from the GitHub Actions tab

### Version Management

- The workflow reads the version from `package.json` and `src/version.ts`
- When auto-bumping, it updates both files and commits the changes
- The `[skip ci]` tag in commit messages prevents infinite loops

## License

MIT License

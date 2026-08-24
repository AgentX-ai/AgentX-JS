## To Test locally

Get credentials and IDs from AgentX dashboard and replace those in `test` files

```
API_KEY
AGENT_ID
CONVERSATION_ID
```

## Quick Test

Run the basic connectivity test:

```bash
npx ts-node test-streaming.ts
```

This will test:

- ✅ API connection
- ✅ Agents listing
- ✅ Workforces listing
- ✅ Profile retrieval

## Testing the Streaming Functionality

```bash
npx ts-node test-streaming.ts
```

## Expected Output

If the streaming is working correctly, you should see output like:

```
📦 Chunk 1 (150ms)
  Text: null
  CoT: The user's question 'How can you help me?' is a ge
  Bot ID: 6862e8d0414914e72f4f77c2

📦 Chunk 2 (200ms)
  Text: null
  CoT: neral inquiry about the capabilities of the AI age
  Bot ID: 6862e8d0414914e72f4f77c2

📦 Chunk 3 (250ms)
  Text: Hello
  CoT: null
  Bot ID: 6862e8d0414914e72f4f77c2
```

## Tracing + Evaluations (no credentials needed)

`npm test` runs `test-tracing-eval.ts`, which starts a stub AgentX API on localhost and asserts
the exact payloads the tracing and evaluations clients send - span trees, tool calls,
retrievals, result batches, the analyze poll loop and the CI gate.

```bash
npm test
```

To run the same surfaces against a real engine, point the SDK at it and use your own key:

```bash
AGENTX_API_KEY=... AGENTX_API_BASE_URL=http://localhost:4700/api/v1 npx ts-node examples/tracing.ts
```

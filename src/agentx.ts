import axios, { AxiosResponse } from "axios";

import { apiBase, getHeaders } from "./util";
import { VERSION } from "./version";
import { AgentXAPIError, AgentXAuthError, AgentXConnectionError } from "./errors";
import { Agent } from "./resources/agent";
import { Workforce } from "./resources/workforce";
import { IngestClient } from "./tracing/ingestClient";
import { Tracer } from "./tracing/tracer";
import { EvaluationsClient } from "./evaluations/client";
import { EvaluationsRunner } from "./evaluations/runner";

export interface AgentXOptions {
  /** Overrides `AGENTX_API_BASE_URL`. For self-host, e.g. `http://localhost:4700/api/v1`. */
  baseUrl?: string;
  /** Scopes datasets, runs and traces to a workspace instead of the key's default one. */
  workspaceId?: string;
  /** Drain queued traces when the event loop empties. Default true. */
  flushTracesOnExit?: boolean;
}

export class AgentX {
  private apiKey: string;
  private baseUrl?: string;
  private workspaceId?: string;
  private options: AgentXOptions;

  private _tracer?: Tracer;
  private _evaluations?: EvaluationsRunner;

  /**
   * @param apiKey  API key. Falls back to `AGENTX_API_KEY`.
   * @param options Base URL / workspace overrides. Use `AgentX.fromEnv(options)` to pass
   *                options while taking the key from the environment.
   */
  constructor(apiKey?: string, options: AgentXOptions = {}) {
    const opts: AgentXOptions = options;

    this.apiKey = apiKey || process.env.AGENTX_API_KEY || "";
    if (!this.apiKey) {
      throw new Error(
        "API key is required. Set AGENTX_API_KEY environment variable or pass apiKey parameter."
      );
    } else {
      process.env.AGENTX_API_KEY = this.apiKey;
    }

    this.options = opts;
    // baseUrl overrides AGENTX_API_BASE_URL (and the SDK default) for every request made
    // through this process, so the plain resource calls below pick it up too.
    this.baseUrl = opts.baseUrl || process.env.AGENTX_API_BASE_URL;
    if (this.baseUrl) {
      process.env.AGENTX_API_BASE_URL = this.baseUrl;
    }
    this.workspaceId = opts.workspaceId || process.env.AGENTX_WORKSPACE_ID;
  }

  /** Create a client from `AGENTX_API_KEY` (and optionally `AGENTX_API_BASE_URL`). */
  static fromEnv(options: AgentXOptions = {}): AgentX {
    return new AgentX(undefined, options);
  }

  /**
   * Trace agent runs into AgentX (Observe / Live Traces).
   *
   * ```ts
   * await client.tracer.withSpan("support-agent", { input: question }, async (span) => {
   *   span.output = await callLlm(question);
   * });
   * await client.tracer.flush();
   * ```
   */
  get tracer(): Tracer {
    if (!this._tracer) {
      this._tracer = new Tracer(
        new IngestClient({
          apiKey: this.apiKey,
          sdkVersion: VERSION,
          baseUrl: this.baseUrl,
          workspaceId: this.workspaceId,
          flushOnExit: this.options.flushTracesOnExit,
        })
      );
    }
    return this._tracer;
  }

  /**
   * Custom Agent Evaluations: datasets, grading configs, runs, gates and reports.
   *
   * ```ts
   * const report = await client.evaluations
   *   .run({ datasetId, subject: { displayName: "Support bot", framework: "openai" } })
   *   .execute(myAgent)
   *   .finalize()
   *   .analyze();
   * ```
   */
  get evaluations(): EvaluationsRunner {
    if (!this._evaluations) {
      this._evaluations = new EvaluationsRunner(
        new EvaluationsClient({
          apiKey: this.apiKey,
          sdkVersion: VERSION,
          baseUrl: this.baseUrl,
          workspaceId: this.workspaceId,
        })
      );
    }
    return this._evaluations;
  }

  /**
   * Verify the client can reach AgentX and that the API key is accepted.
   *
   * Construction is deliberately lazy (no network call) and trace delivery is
   * fire-and-forget, so a wrong `baseUrl` or `apiKey` otherwise surfaces only as a one-time
   * warning while traces silently go nowhere. Call this once at startup to fail fast.
   */
  async ping(): Promise<{ ok: true; baseUrl: string }> {
    const base = apiBase(this.baseUrl);
    // /monitor/patterns: the cheapest key-authenticated endpoint that exists on both the
    // hosted API and the self-host engine's SDK-facing router.
    let response: AxiosResponse;
    try {
      response = await axios.get(`${base}/monitor/patterns`, {
        headers: getHeaders(this.apiKey),
        timeout: 10000,
        validateStatus: () => true,
      });
    } catch (err: any) {
      throw new AgentXConnectionError(
        `Cannot reach AgentX at ${base} (${err?.name || "Error"}: ${err?.message || err}). ` +
          "Check baseUrl / AGENTX_API_BASE_URL - for self-host it should look like " +
          "http://localhost:4700/api/v1."
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new AgentXAuthError(
        `AgentX at ${base} rejected the API key (HTTP ${response.status}). Check apiKey / ` +
          "AGENTX_API_KEY - for self-host, copy the 'Default project API key' from the engine's startup log."
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new AgentXAPIError(
        `AgentX at ${base} responded HTTP ${response.status} to the health probe.`,
        response.status
      );
    }
    return { ok: true, baseUrl: base };
  }

  async getAgent(id: string): Promise<Agent> {
    const url = `${apiBase()}/access/agents/${id}`;
    const response: AxiosResponse = await axios.get(url, {
      headers: getHeaders(),
    });

    if (response.status === 200) {
      const agentRes = response.data;
      return new Agent({
        id: agentRes._id,
        name: agentRes.name,
        avatar: agentRes.avatar,
        createdAt: agentRes.createdAt,
        updatedAt: agentRes.updatedAt,
      });
    } else {
      throw new Error(`Failed to retrieve agent: ${response.statusText}`);
    }
  }

  async listAgents(): Promise<Agent[]> {
    const url = `${apiBase()}/access/agents`;
    const response: AxiosResponse = await axios.get(url, {
      headers: getHeaders(),
    });

    if (response.status === 200) {
      return response.data.map(
        (agent: any) =>
          new Agent({
            id: agent._id,
            name: agent.name,
            avatar: agent.avatar,
            createdAt: agent.createdAt,
            updatedAt: agent.updatedAt,
          })
      );
    } else {
      throw new Error(`Failed to list agents: ${response.statusText}`);
    }
  }

  async listWorkforces(): Promise<Workforce[]> {
    const url = `${apiBase()}/access/teams`;
    const response: AxiosResponse = await axios.get(url, {
      headers: getHeaders(),
    });

    if (response.status === 200) {
      return response.data.map(
        (workforce: any) =>
          new Workforce({
            id: workforce._id,
            agents: workforce.agents.map(
              (agent: any) =>
                new Agent({
                  id: agent._id,
                  name: agent.name,
                  avatar: agent.avatar,
                  createdAt: agent.createdAt,
                  updatedAt: agent.updatedAt,
                })
            ),
            name: workforce.name,
            image: workforce.image,
            description: workforce.description,
            manager: new Agent({
              id: workforce.manager._id,
              name: workforce.manager.name,
              avatar: workforce.manager.avatar,
              createdAt: workforce.manager.createdAt,
              updatedAt: workforce.manager.updatedAt,
            }),
            creator: workforce.creator,
            context: workforce.context,
            references: workforce.references,
            workspace: workforce.workspace,
            createdAt: workforce.createdAt,
            updatedAt: workforce.updatedAt,
          })
      );
    } else {
      throw new Error(
        `Failed to list workforces: ${response.status} - ${response.statusText}`
      );
    }
  }

  async getProfile(): Promise<any> {
    const url = `${apiBase()}/access/getProfile`;
    const response: AxiosResponse = await axios.get(url, {
      headers: getHeaders(),
    });

    if (response.status === 200) {
      return response.data;
    } else {
      throw new Error(
        `Failed to get profile: ${response.status} - ${response.statusText}`
      );
    }
  }
}

import { VERSION } from "./version";

export const DEFAULT_API_BASE = "https://api.agentx.so/api/v1";

const EVAL_SUFFIX = "/custom-agent-evaluations";

/**
 * Base URL for all AgentX API calls.
 *
 * Priority: explicit argument > `AGENTX_API_BASE_URL` env var > the hosted default.
 * Point it at a self-host engine with e.g. `http://localhost:4700/api/v1`.
 *
 * The evaluations-specific `/custom-agent-evaluations` suffix is stripped if present,
 * so one override works for every route (same behaviour as `agentx.util.api_base`).
 */
export function apiBase(baseUrl?: string): string {
  let base = (baseUrl || process.env.AGENTX_API_BASE_URL || "").replace(/\/+$/, "");
  if (!base) {
    return DEFAULT_API_BASE;
  }
  if (base.endsWith(EVAL_SUFFIX)) {
    base = base.slice(0, -EVAL_SUFFIX.length);
  }
  return base;
}

export function getHeaders(apiKey?: string): Record<string, string> {
  return {
    accept: "*/*",
    "x-api-key": apiKey || process.env.AGENTX_API_KEY || "",
  };
}

/** User-Agent sent by the tracing/evaluations HTTP clients. */
export function userAgent(): string {
  return `agentx-js/${VERSION}`;
}

/** Best-effort conversion to a JSON-safe structure, truncated to avoid huge payloads. */
export function safeSerialize(value: any, depth = 0): any {
  if (depth > 3) {
    return String(value).slice(0, 200);
  }
  if (value === null || value === undefined) {
    return value ?? null;
  }
  const t = typeof value;
  if (t === "boolean" || t === "number" || t === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((v) => safeSerialize(v, depth + 1));
  }
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  if (t === "object") {
    // Class instances with a toJSON()/model_dump()-style hook
    if (typeof value.toJSON === "function") {
      try {
        return safeSerialize(value.toJSON(), depth + 1);
      } catch {
        /* fall through */
      }
    }
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value).slice(0, 30)) {
      out[String(k)] = safeSerialize(v, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, 200);
}

/** Sleep helper used by the retry loops. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** RFC4122-ish hex id, matching the Python SDK's `uuid4().hex` span ids. */
export function hexId(): string {
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}

/** RFC4122 v4 UUID (used for evaluation batch ids). */
export function uuid4(): string {
  const h = hexId();
  return [h.slice(0, 8), h.slice(8, 12), `4${h.slice(13, 16)}`, `a${h.slice(17, 20)}`, h.slice(20, 32)].join("-");
}

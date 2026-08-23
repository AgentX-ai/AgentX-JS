import { randomBytes, randomUUID } from "crypto";

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
  let base = stripTrailingSlashes(baseUrl || process.env.AGENTX_API_BASE_URL || "");
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

/**
 * Trailing-slash trim without a regex - a `/+$` pattern backtracks on input with many
 * repeated slashes, and this runs on a caller-supplied base URL.
 */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* "/" */) {
    end -= 1;
  }
  return value.slice(0, end);
}

/**
 * 32-char hex id, matching the Python SDK's `uuid4().hex` span ids. Crypto-backed rather
 * than Math.random(): span and session ids end up addressing real records.
 */
export function hexId(): string {
  return randomBytes(16).toString("hex");
}

/** RFC4122 v4 UUID (used for evaluation batch ids). */
export function uuid4(): string {
  return randomUUID();
}

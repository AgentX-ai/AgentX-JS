/** Best-effort scrubbing of secrets from result metadata before it leaves the process. */

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{20,}/g, // OpenAI / Anthropic style keys
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /(password|passwd|secret|token|api[_-]?key)\s*[=:]\s*\S+/gi,
  /[A-Za-z0-9+/]{40,}={0,2}/g, // long base64-like strings
];

const REDACTED = "[REDACTED]";

const SENSITIVE_KEYS = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "api_key",
  "apikey",
  "authorization",
  "auth",
  "cookie",
  "session",
  "credential",
  "private_key",
  "privatekey",
  "access_key",
  "accesskey",
]);

export function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

export function redact(value: any, depth = 0): any {
  if (depth > 10) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : redact(item, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") {
    return redactString(value);
  }
  return value;
}

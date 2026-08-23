import { ObservableTrace, TraceEvent } from "./models";

/** Hard ceiling on the trace payload attached to a single result (bytes of JSON). */
export const MAX_TRACE_BYTES = 20_000;

/** Convert whatever a caller returns as `trace` into an ObservableTrace. */
export function buildTrace(raw: any): ObservableTrace | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  if (Array.isArray(raw)) {
    return bound({ events: raw.filter((e) => e !== null && e !== undefined).map(coerceEvent) });
  }
  if (typeof raw === "object") {
    const events = Array.isArray(raw.events) ? raw.events : [];
    return bound({ events: events.filter((e: any) => e !== null && e !== undefined).map(coerceEvent) });
  }
  return undefined;
}

function coerceEvent(event: any): TraceEvent {
  if (event && typeof event === "object") {
    return {
      type: event.type ?? "unknown",
      name: event.name,
      summary: event.summary,
      latencyMs: event.latencyMs ?? event.latency_ms,
      metadata: event.metadata,
    };
  }
  return { type: "unknown", summary: String(event) };
}

/** Drop events until the serialised payload fits within MAX_TRACE_BYTES. */
function bound(trace: ObservableTrace): ObservableTrace {
  if (byteLength(trace) <= MAX_TRACE_BYTES) {
    return trace;
  }
  const kept: TraceEvent[] = [];
  let size = 2; // for "[]"
  for (const event of trace.events) {
    const chunk = byteLength(event) + 1;
    if (size + chunk > MAX_TRACE_BYTES) {
      break;
    }
    kept.push(event);
    size += chunk;
  }
  return { events: kept };
}

function byteLength(value: any): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

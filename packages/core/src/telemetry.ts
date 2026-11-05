import { metrics, SpanStatusCode, trace } from "@opentelemetry/api";

const SCOPE = "agent-memory";

/**
 * Spans and metrics may hold operation names, durations and error class names
 * only. Memory text, topics, queries and user names must never be added here:
 * traces usually leave the machine for a collector.
 */
export async function traced<T>(
  operation: string,
  fn: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  return trace.getTracer(SCOPE).startActiveSpan(operation, async (span) => {
    try {
      return await fn();
    } catch (error) {
      // The name only: a message could quote content.
      const name = error instanceof Error ? error.name : "Error";
      span.setStatus({ code: SpanStatusCode.ERROR, message: name });
      throw error;
    } finally {
      span.end();
      metrics
        .getMeter(SCOPE)
        .createHistogram("memory.operation.duration", { unit: "ms" })
        .record(performance.now() - started, { operation });
    }
  });
}

/** Off unless a collector is configured, so local mode stays silent. */
export async function startTelemetry(serviceName: string): Promise<void> {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  process.env.OTEL_SERVICE_NAME ??= serviceName;
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  new NodeSDK().start();
}

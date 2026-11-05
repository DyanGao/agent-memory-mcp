import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeEmbedder } from "./embedder.js";
import { ingestEvents } from "./events.js";
import { executeForget } from "./forget.js";
import { MemoryStore } from "./store.js";
import { startTestDb } from "./testing.js";
import type { TestDb } from "./testing.js";
import { traced } from "./telemetry.js";

describe("telemetry", () => {
  const exporter = new InMemorySpanExporter();
  const scope = {
    user: "telemetrycanaryuser",
    project: "telemetrycanaryproject",
  };
  let db: TestDb;

  beforeAll(async () => {
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      }),
    );
    db = await startTestDb();
  });
  afterAll(async () => {
    await db?.stop();
  });

  it("traces each operation with no content, topic or identity", async () => {
    const embedder = new FakeEmbedder();
    const store = new MemoryStore(db.app, embedder);
    await ingestEvents(
      db.app,
      scope,
      "telemetrycanarysession",
      [{ seq: 1, kind: "user_text", text: "telemetrycanarytext" }],
      { retentionDays: 30 },
    );
    await store.write(scope, { content: "telemetrycanarytext", type: "fact" });
    await store.search(scope, "telemetrycanaryquery");
    await store.contextFor(scope, "telemetrycanarytask");
    await executeForget(db.app, embedder, scope, {
      topic: "telemetrycanarytext",
    });

    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual(
      expect.arrayContaining([
        "memory.write",
        "memory.search",
        "memory.context_for",
        "memory.forget",
      ]),
    );
    const everything = JSON.stringify(
      spans.map(({ name, attributes, events, status }) => ({
        name,
        attributes,
        events,
        status,
      })),
    );
    expect(everything).not.toContain("telemetrycanary");
  });

  it("records a failure by class name, without its message", async () => {
    exporter.reset();
    await expect(
      traced("memory.fail", async () => {
        throw new TypeError("telemetrycanary in a message");
      }),
    ).rejects.toThrow();
    const [span] = exporter.getFinishedSpans();
    expect(span?.status.message).toBe("TypeError");
    expect(JSON.stringify(span?.events)).not.toContain("telemetrycanary");
  });
});

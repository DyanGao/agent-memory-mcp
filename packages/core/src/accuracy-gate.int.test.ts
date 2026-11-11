import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSION } from "./embedder.js";
import type { Embedder } from "./embedder.js";
import { estimateP95Ms } from "./percentile.js";
import { MemoryStore } from "./store.js";
import { startTestDb } from "./testing.js";
import type { TestDb } from "./testing.js";

// Regression gates from EVAL_PLAN.md section 7, on recorded real bge-m3
// vectors, so CI needs no model. Retrieval accuracy may not drop more than 3
// points below the committed baseline; changing the baseline is a reviewed
// edit. Search p95 more than 30% above the CI baseline only warns: runners vary.
const fixture = JSON.parse(
  readFileSync(
    new URL("../../../eval/fixtures/deletion-gate.json", import.meta.url),
    "utf8",
  ),
) as {
  keepers: string[];
  facts: { statement: string; probes: string[] }[];
  vectors: Record<string, string>;
};
const baseline = JSON.parse(
  readFileSync(
    new URL("../../../eval/fixtures/accuracy-baseline.json", import.meta.url),
    "utf8",
  ),
) as { firstPlace: number; inTop5: number; ciSearchP95Ms: number };

const MAX_DROP = 0.03;
const SLOWER = 1.3;

const cachedEmbedder: Embedder = {
  model: "bge-m3-cached",
  embed: async (texts) =>
    texts.map((text) => {
      const encoded = fixture.vectors[text];
      if (encoded === undefined) {
        throw new Error(`No cached vector. Rebuild the fixture for: ${text}`);
      }
      const bytes = Buffer.from(encoded, "base64");
      return Array.from({ length: EMBEDDING_DIMENSION }, (_, index) =>
        bytes.readFloatLE(index * 4),
      );
    }),
};

describe("accuracy and latency gates, on recorded real embeddings", () => {
  const scope = { user: "gate", project: "accuracy" };
  let db: TestDb;
  const measured = { firstPlace: 0, inTop5: 0, searchP95Ms: 0 };

  beforeAll(async () => {
    db = await startTestDb();
    const store = new MemoryStore(db.app, cachedEmbedder);
    for (const keeper of fixture.keepers) {
      await store.write(scope, { content: keeper, type: "fact" });
    }
    for (const fact of fixture.facts) {
      await store.write(scope, { content: fact.statement, type: "fact" });
    }
    const probes = fixture.facts.flatMap((fact) =>
      fact.probes.map((probe) => ({ probe, statement: fact.statement })),
    );
    // One untimed pass warms the connection pool and the index.
    await store.search(scope, probes[0]!.probe, { limit: 5 });
    const timings: number[] = [];
    let first = 0;
    let top5 = 0;
    for (const { probe, statement } of probes) {
      const started = performance.now();
      const hits = await store.search(scope, probe, { limit: 5 });
      timings.push(performance.now() - started);
      first += Number(hits[0]?.content === statement);
      top5 += Number(hits.some((hit) => hit.content === statement));
    }
    measured.firstPlace = first / probes.length;
    measured.inTop5 = top5 / probes.length;
    measured.searchP95Ms = estimateP95Ms(timings);
    // Written directly: Vitest hides console output from passing tests.
    process.stdout.write(
      `accuracy gate measured ${JSON.stringify(measured)}\n`,
    );
  });
  afterAll(async () => {
    await db?.stop();
  });

  it.each(["firstPlace", "inTop5"] as const)(
    "keeps %s within 3 points of the baseline",
    (metric) => {
      expect(measured[metric]).toBeGreaterThanOrEqual(
        baseline[metric] - MAX_DROP,
      );
    },
  );

  it("warns, without failing, when search is over 30% slower in CI", () => {
    if (
      process.env.CI &&
      measured.searchP95Ms > baseline.ciSearchP95Ms * SLOWER
    ) {
      // A GitHub Actions annotation: shown on the run, does not fail it.
      process.stdout.write(
        `::warning::Search p95 ${measured.searchP95Ms.toFixed(1)} ms is over 30% above the CI baseline of ${baseline.ciSearchP95Ms} ms\n`,
      );
    }
    expect(measured.searchP95Ms).toBeGreaterThan(0);
  });
});

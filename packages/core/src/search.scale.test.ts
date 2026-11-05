import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSION } from "./embedder.js";
import type { Embedder } from "./embedder.js";
import { estimateP95Ms } from "./percentile.js";
import { MemoryStore } from "./store.js";
import { startTestDb } from "./testing.js";
import type { TestDb } from "./testing.js";

const TOTAL = Number(process.env.SCALE_MEMORIES ?? 10_000);
const NARROW_SCOPE_SIZE = 30;
const QUERIES = 200;
const BATCH = 500;

function randomUnitVector(): number[] {
  const raw = Array.from(
    { length: EMBEDDING_DIMENSION },
    () => Math.random() - 0.5,
  );
  const norm = Math.hypot(...raw);
  return raw.map((value) => value / norm);
}

// Random vectors are a hard case for HNSW: real embeddings cluster.
const randomEmbedder: Embedder = {
  model: "random",
  embed: async (texts) => texts.map(randomUnitVector),
};

describe(`search at ${TOTAL} memories`, () => {
  let db: TestDb;
  let store: MemoryStore;
  const big = { user: "big", project: "main" };
  const narrow = { user: "narrow", project: "main" };

  beforeAll(async () => {
    db = await startTestDb();
    store = new MemoryStore(db.app, randomEmbedder);

    for (let start = 0; start < TOTAL; start += BATCH) {
      const contents: string[] = [];
      const vectors: string[] = [];
      for (let i = start; i < start + BATCH; i++) {
        contents.push(`synthetic memory ${i} about topic ${i % 97}`);
        vectors.push(JSON.stringify(randomUnitVector()));
      }
      await db.owner.query(
        `INSERT INTO memories (scope_user, scope_project, type, content, embedding, embed_model)
         SELECT 'big', 'main', 'fact', c, v::vector, 'random'
         FROM unnest($1::text[], $2::text[]) AS t(c, v)`,
        [contents, vectors],
      );
    }
    for (let i = 0; i < NARROW_SCOPE_SIZE; i++) {
      await store.write(narrow, { content: `narrow note ${i}`, type: "fact" });
    }
    await db.owner.query("ANALYZE memories");
  });
  afterAll(async () => {
    await db?.stop();
  });

  it("finds every memory of a tiny scope among all the others", async () => {
    const results = await store.search(narrow, "zzz-no-text-match", {
      limit: 100,
    });
    expect(results).toHaveLength(NARROW_SCOPE_SIZE);
  });

  it("reports p95 search latency, excluding embedding", async () => {
    const timings: number[] = [];
    for (let i = 0; i < QUERIES; i++) {
      const started = performance.now();
      await store.search(big, `topic ${i % 97}`);
      timings.push(performance.now() - started);
    }
    const p95 = estimateP95Ms(timings);
    process.stderr.write(
      `p95 search latency at ${TOTAL} memories: ${p95.toFixed(1)} ms
`,
    );
    expect(timings).toHaveLength(QUERIES);
  });
});

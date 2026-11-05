import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSION } from "./embedder.js";
import type { Embedder } from "./embedder.js";
import { estimateP95Ms } from "./percentile.js";
import { MemoryStore } from "./store.js";
import { startTestDb } from "./testing.js";
import type { TestDb } from "./testing.js";

const TOTAL = Number(process.env.SCALE_MEMORIES ?? 10_000);
// "clustered" is closer to real embeddings. "random" is HNSW's hard case.
const SHAPE = process.env.SCALE_VECTORS ?? "clustered";
const NARROW_SCOPE_SIZE = 30;
const QUERIES = 200;
const RECALL_QUERIES = 30;
const BATCH = 500;
const CLUSTERS = 200;
const CLUSTER_NOISE = 0.35;
const EF_SEARCH_VALUES = [100, 200, 400, 800];

const progress = (message: string): void => {
  process.stderr.write(
    `${new Date().toISOString().slice(11, 19)} ${SHAPE} ${TOTAL} ${message}\n`,
  );
};

const normalise = (raw: number[]): number[] => {
  const norm = Math.hypot(...raw);
  return raw.map((value) => value / norm);
};

const gaussian = (): number =>
  Math.sqrt(-2 * Math.log(1 - Math.random())) *
  Math.cos(2 * Math.PI * Math.random());

const noise = (): number[] =>
  normalise(Array.from({ length: EMBEDDING_DIMENSION }, gaussian));

const centres = Array.from({ length: CLUSTERS }, noise);

function nextVector(): number[] {
  if (SHAPE === "random") return noise();
  const centre = centres[Math.floor(Math.random() * CLUSTERS)]!;
  const offset = noise();
  return normalise(
    centre.map((value, i) => value + CLUSTER_NOISE * offset[i]!),
  );
}

const embedder: Embedder = {
  model: "synthetic",
  embed: async (texts) => texts.map(nextVector),
};

describe(`search at ${TOTAL} ${SHAPE} memories`, () => {
  const results: Record<string, unknown> = { memories: TOTAL, vectors: SHAPE };
  let db: TestDb;
  let store: MemoryStore;
  const big = { user: "big", project: "main" };
  const narrow = { user: "narrow", project: "main" };

  beforeAll(async () => {
    db = await startTestDb();
    store = new MemoryStore(db.app, embedder);

    // Loading first and indexing after is far faster than inserting into a
    // live HNSW graph, and produces the same kind of index.
    await db.owner.query("DROP INDEX memories_embedding_idx");
    progress("loading");
    for (let start = 0; start < TOTAL; start += BATCH) {
      const contents: string[] = [];
      const vectors: string[] = [];
      for (let i = start; i < start + BATCH; i++) {
        contents.push(`synthetic memory ${i} about topic ${i % 97}`);
        vectors.push(JSON.stringify(nextVector()));
      }
      await db.owner.query(
        `INSERT INTO memories (scope_user, scope_project, type, content, embedding, embed_model)
         SELECT 'big', 'main', 'fact', c, v::vector, 'synthetic'
         FROM unnest($1::text[], $2::text[]) AS t(c, v)`,
        [contents, vectors],
      );
    }
    const client = await db.owner.connect();
    progress("building index");
    await client.query("SET maintenance_work_mem = '2GB'");
    await client.query("SET max_parallel_maintenance_workers = 4");
    await client.query(
      "CREATE INDEX memories_embedding_idx ON memories USING hnsw (embedding vector_cosine_ops)",
    );
    client.release();
    progress("index built");

    for (let i = 0; i < NARROW_SCOPE_SIZE; i++) {
      await store.write(narrow, { content: `narrow note ${i}`, type: "fact" });
    }
    await db.owner.query("ANALYZE memories");
  });
  afterAll(async () => {
    await db?.stop();
    const directory = new URL(
      `../../../eval/results/${new Date().toISOString().slice(0, 10)}/`,
      import.meta.url,
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      new URL(`scale-${SHAPE}-${TOTAL}.json`, directory),
      JSON.stringify(results, null, 2) + "\n",
    );
  });

  it("finds every memory of a tiny scope among all the others", async () => {
    const found = await store.search(narrow, "zzz-no-text-match", {
      limit: 100,
    });
    expect(found).toHaveLength(NARROW_SCOPE_SIZE);
  });

  it("reports vector recall@10 against exact search at each ef_search", async () => {
    const queries = Array.from({ length: RECALL_QUERIES }, () =>
      JSON.stringify(nextVector()),
    );

    const nearest = async (
      vector: string,
      exact: boolean,
      ef: number,
    ): Promise<{ ids: string[]; ms: number }> => {
      const client = await db.owner.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `SELECT set_config('enable_indexscan', $1, true),
                  set_config('hnsw.ef_search', $2, true),
                  set_config('hnsw.iterative_scan', 'strict_order', true)`,
          [exact ? "off" : "on", String(ef)],
        );
        const started = performance.now();
        const { rows } = await client.query<{ id: string }>(
          `SELECT id FROM memories WHERE scope_user = 'big'
           ORDER BY embedding <=> $1::vector LIMIT 10`,
          [vector],
        );
        const ms = performance.now() - started;
        await client.query("COMMIT");
        return { ids: rows.map((row) => row.id), ms };
      } finally {
        client.release();
      }
    };

    const truth = new Map<string, Set<string>>();
    for (const vector of queries) {
      truth.set(vector, new Set((await nearest(vector, true, 100)).ids));
    }

    const byEf = [];
    for (const ef of EF_SEARCH_VALUES) {
      const hits: number[] = [];
      const timings: number[] = [];
      for (const vector of queries) {
        const { ids, ms } = await nearest(vector, false, ef);
        const expected = truth.get(vector)!;
        hits.push(ids.filter((id) => expected.has(id)).length / 10);
        timings.push(ms);
      }
      const recall = hits.reduce((a, b) => a + b, 0) / hits.length;
      const row = {
        efSearch: ef,
        recallAt10: Number(recall.toFixed(3)),
        vectorP95Ms: Number(estimateP95Ms(timings).toFixed(1)),
      };
      byEf.push(row);
      process.stderr.write(`${SHAPE} ${TOTAL} ${JSON.stringify(row)}\n`);
    }
    results.recallByEfSearch = byEf;
    expect(byEf).toHaveLength(EF_SEARCH_VALUES.length);
  });

  it("reports p95 full search latency, excluding embedding", async () => {
    const timings: number[] = [];
    for (let i = 0; i < QUERIES; i++) {
      const started = performance.now();
      await store.search(big, `topic ${i % 97}`);
      timings.push(performance.now() - started);
    }
    results.searchP95Ms = Number(estimateP95Ms(timings).toFixed(1));
    process.stderr.write(
      `${SHAPE} ${TOTAL} full search p95 ${String(results.searchP95Ms)} ms\n`,
    );
    expect(timings).toHaveLength(QUERIES);
  });
});

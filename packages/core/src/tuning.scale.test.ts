import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withScope } from "./db.js";
import { EMBEDDING_DIMENSION } from "./embedder.js";
import type { Embedder } from "./embedder.js";
import { estimateP95Ms } from "./percentile.js";
import { MemoryStore } from "./store.js";
import type { SearchOptions } from "./store.js";
import { startTestDb } from "./testing.js";
import type { TestDb } from "./testing.js";

// Real LongMemEval turns plus 200 planted memories with exact codes, both built
// by eval/agent_eval/real_corpus.py. Each question set is split in two by
// position: variants are compared on one half, and the chosen one is scored
// once on the other.
const CORPUS = process.env.REAL_CORPUS ?? "";
const SPLIT = process.env.TUNING_SPLIT ?? "tune";
const VARIANTS = JSON.parse(
  process.env.TUNING_VARIANTS ??
    JSON.stringify([
      { name: "vector only", retrievers: "vector" },
      { name: "both, any word, weight 1 (current)" },
      { name: "both, any word, weight 0.5", textWeight: 0.5 },
      { name: "both, any word, weight 0.25", textWeight: 0.25 },
      { name: "both, all words, weight 1", textMatch: "all" },
      {
        name: "both, all words, weight 0.5",
        textMatch: "all",
        textWeight: 0.5,
      },
    ]),
) as (SearchOptions & { name: string })[];
const EF_VALUES = [100, 200, 400];
const BATCH = 500;
const TIMING_QUERIES = 100;

interface Query {
  id: string;
  type: string;
  question: string;
  gold: number[];
}

const progress = (message: string): void => {
  process.stderr.write(
    `${new Date().toISOString().slice(11, 19)} tuning ${message}\n`,
  );
};

function vectors(path: string): Float32Array[] {
  const bytes = readFileSync(path);
  const all = new Float32Array(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength / 4,
  );
  const rows: Float32Array[] = [];
  for (let start = 0; start < all.length; start += EMBEDDING_DIMENSION) {
    rows.push(all.subarray(start, start + EMBEDDING_DIMENSION));
  }
  return rows;
}

const literal = (vector: Float32Array): string =>
  `[${Array.from(vector).join(",")}]`;
const lines = (path: string): string[] =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string);

describe.skipIf(!existsSync(`${CORPUS}/id-texts.f32`))(
  "search tuning on real text",
  () => {
    const results: Record<string, unknown> = { split: SPLIT };
    const scope = { user: "real", project: "main" };
    let db: TestDb;
    let embedder: Embedder;
    const sets: Record<string, Query[]> = {};
    const rowOf = new Map<string, number>();

    beforeAll(async () => {
      const texts = lines(`${CORPUS}/texts.jsonl`);
      const idTexts = lines(`${CORPUS}/id-texts.jsonl`);
      const all = [...texts, ...idTexts];
      all.forEach((text, row) => rowOf.set(text, row));
      const allVectors = [
        ...vectors(`${CORPUS}/texts.f32`),
        ...vectors(`${CORPUS}/id-texts.f32`),
      ];
      expect(allVectors).toHaveLength(all.length);

      const plain = JSON.parse(
        readFileSync(`${CORPUS}/queries.json`, "utf8"),
      ) as Query[];
      const ids = (
        JSON.parse(readFileSync(`${CORPUS}/id-queries.json`, "utf8")) as Query[]
      ).map((q) => ({ ...q, gold: q.gold.map((row) => row + texts.length) }));
      const byQuestion = new Map<string, Float32Array>();
      vectors(`${CORPUS}/queries.f32`).forEach((v, i) =>
        byQuestion.set(plain[i]!.question, v),
      );
      vectors(`${CORPUS}/id-queries.f32`).forEach((v, i) =>
        byQuestion.set(ids[i]!.question, v),
      );
      const half = (list: Query[]) =>
        list.filter((_, i) => (i % 2 === 0) === (SPLIT === "tune"));
      sets.plain = half(plain);
      sets.identifiers = half(ids);

      embedder = {
        model: "bge-m3",
        embed: async (input) =>
          input.map((text) => {
            const vector = byQuestion.get(text);
            if (vector === undefined)
              throw new Error("No stored vector for this query");
            return Array.from(vector);
          }),
      };

      db = await startTestDb();
      await db.owner.query("DROP INDEX memories_embedding_idx");
      progress("loading");
      for (let start = 0; start < all.length; start += BATCH) {
        const end = Math.min(start + BATCH, all.length);
        await db.owner.query(
          `INSERT INTO memories (scope_user, scope_project, type, content, embedding, embed_model)
         SELECT 'real', 'main', 'fact', c, v::vector, 'bge-m3'
         FROM unnest($1::text[], $2::text[]) AS t(c, v)`,
          [all.slice(start, end), allVectors.slice(start, end).map(literal)],
        );
      }
      const client = await db.owner.connect();
      progress("building index");
      await client.query("SET maintenance_work_mem = '900MB'");
      await client.query("SET max_parallel_maintenance_workers = 4");
      try {
        await client.query(
          "CREATE INDEX memories_embedding_idx ON memories USING hnsw (embedding vector_cosine_ops)",
        );
      } finally {
        client.release();
      }
      await db.owner.query("ANALYZE memories");
      progress("ready");
    });

    afterAll(async () => {
      await db?.stop();
      const directory = new URL(
        `../../../eval/results/${new Date().toISOString().slice(0, 10)}/`,
        import.meta.url,
      );
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        new URL(`search-tuning-${SPLIT}.json`, directory),
        JSON.stringify(results, null, 2) + "\n",
      );
    });

    it.runIf(SPLIT === "tune")(
      "explains and times each part of search at each ef_search",
      async () => {
        const sample = sets.plain!.slice(0, TIMING_QUERIES);
        const report: Record<string, unknown> = {};
        for (const ef of EF_VALUES) {
          const plans = new Set<string>();
          const vectorMs: number[] = [];
          const textMs: number[] = [];
          for (const query of sample) {
            const [vector] = await embedder.embed([query.question]);
            await withScope(db.app, scope, async (client) => {
              await client.query(
                `SELECT set_config('hnsw.iterative_scan', 'strict_order', true),
                    set_config('hnsw.ef_search', $1, true),
                    set_config('hnsw.max_scan_tuples', '200000', true)`,
                [String(ef)],
              );
              const { rows } = await client.query<{
                "QUERY PLAN": [{ Plan: unknown }];
              }>(
                `EXPLAIN (ANALYZE, FORMAT JSON)
             SELECT id FROM memories
             WHERE superseded_by IS NULL AND (valid_to IS NULL OR valid_to > now())
             ORDER BY embedding <=> $1::vector LIMIT 50`,
                [`[${vector!.join(",")}]`],
              );
              const plan = JSON.stringify(rows[0]!["QUERY PLAN"]);
              plans.add(
                plan.includes("memories_embedding_idx") ? "index" : "full scan",
              );
              let started = performance.now();
              await client.query(
                `SELECT id FROM memories
             WHERE superseded_by IS NULL AND (valid_to IS NULL OR valid_to > now())
             ORDER BY embedding <=> $1::vector LIMIT 50`,
                [`[${vector!.join(",")}]`],
              );
              vectorMs.push(performance.now() - started);
              started = performance.now();
              await client.query(
                `WITH q AS (SELECT replace(plainto_tsquery('english', $1)::text, '&', '|')::tsquery AS query)
             SELECT id FROM memories, q
             WHERE superseded_by IS NULL AND (valid_to IS NULL OR valid_to > now()) AND fts @@ q.query
             ORDER BY ts_rank_cd(fts, q.query) DESC LIMIT 50`,
                [query.question],
              );
              textMs.push(performance.now() - started);
            });
          }
          const store = new MemoryStore(db.app, embedder, { efSearch: ef });
          const fullMs: number[] = [];
          for (const query of sample) {
            const started = performance.now();
            await store.search(scope, query.question, { limit: 10 });
            fullMs.push(performance.now() - started);
          }
          report[String(ef)] = {
            plans: [...plans],
            vectorP95Ms: Number(estimateP95Ms(vectorMs).toFixed(1)),
            textAnyWordP95Ms: Number(estimateP95Ms(textMs).toFixed(1)),
            fullSearchP95Ms: Number(estimateP95Ms(fullMs).toFixed(1)),
          };
          progress(`ef ${ef} ${JSON.stringify(report[String(ef)])}`);
        }
        results.timing = report;
        expect(Object.keys(report)).toHaveLength(EF_VALUES.length);
      },
    );

    it("scores each way of combining keyword and vector search", async () => {
      const store = new MemoryStore(db.app, embedder, { efSearch: 200 });
      const scores: Record<string, Record<string, number>> = {};
      for (const variant of VARIANTS) {
        const { name, ...options } = variant;
        scores[name] = {};
        for (const [setName, queries] of Object.entries(sets)) {
          let found = 0;
          for (const query of queries) {
            const hits = await store.search(scope, query.question, {
              ...options,
              limit: 10,
            });
            const gold = new Set(query.gold);
            found += Number(
              hits.some((hit) => gold.has(rowOf.get(hit.content) ?? -1)),
            );
          }
          scores[name][setName] = Number((found / queries.length).toFixed(3));
        }
        progress(`${name} ${JSON.stringify(scores[name])}`);
      }
      results.variants = scores;
      results.questions = Object.fromEntries(
        Object.entries(sets).map(([k, v]) => [k, v.length]),
      );
      expect(Object.keys(scores)).toHaveLength(VARIANTS.length);
    });
  },
);

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSION } from "./embedder.js";
import type { Embedder } from "./embedder.js";
import { estimateP95Ms } from "./percentile.js";
import { MemoryStore } from "./store.js";
import type { SearchOptions } from "./store.js";
import { startTestDb } from "./testing.js";
import type { TestDb } from "./testing.js";

// Built by eval/agent_eval/real_corpus.py from LongMemEval: 100,000 real chat
// turns with bge-m3 vectors, and the questions with the turns that answer them.
const CORPUS = process.env.REAL_CORPUS ?? "";
const BATCH = 500;
const RECALL_QUERIES = 50;
const EF_SEARCH_VALUES = [100, 200, 400, 800];
const TOP = 10;

interface Query {
  id: string;
  type: string;
  question: string;
  gold: number[];
}

const progress = (message: string): void => {
  process.stderr.write(
    `${new Date().toISOString().slice(11, 19)} real ${message}\n`,
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

describe.skipIf(!existsSync(`${CORPUS}/texts.f32`))(
  "search on 100,000 real memories",
  () => {
    const results: Record<string, unknown> = {};
    const scope = { user: "real", project: "main" };
    let db: TestDb;
    let store: MemoryStore;
    let texts: string[];
    let queries: Query[];
    let queryVectors: Float32Array[];
    const rowOf = new Map<string, number>();

    beforeAll(async () => {
      texts = readFileSync(`${CORPUS}/texts.jsonl`, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string);
      texts.forEach((text, row) => rowOf.set(text, row));
      queries = JSON.parse(
        readFileSync(`${CORPUS}/queries.json`, "utf8"),
      ) as Query[];
      queryVectors = vectors(`${CORPUS}/queries.f32`);
      const textVectors = vectors(`${CORPUS}/texts.f32`);
      expect(textVectors).toHaveLength(texts.length);
      expect(queryVectors).toHaveLength(queries.length);

      // Questions are the only texts embedded at search time.
      const byQuestion = new Map(
        queries.map((q, i) => [q.question, queryVectors[i]!]),
      );
      const embedder: Embedder = {
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
      store = new MemoryStore(db.app, embedder);
      await db.owner.query("DROP INDEX memories_embedding_idx");
      progress("loading");
      for (let start = 0; start < texts.length; start += BATCH) {
        const end = Math.min(start + BATCH, texts.length);
        await db.owner.query(
          `INSERT INTO memories (scope_user, scope_project, type, content, embedding, embed_model)
         SELECT 'real', 'main', 'fact', c, v::vector, 'bge-m3'
         FROM unnest($1::text[], $2::text[]) AS t(c, v)`,
          [texts.slice(start, end), textVectors.slice(start, end).map(literal)],
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
        new URL("scale-real-100000.json", directory),
        JSON.stringify(results, null, 2) + "\n",
      );
    });

    it("reports vector recall@10 against exact search at each ef_search", async () => {
      const nearest = async (vector: string, exact: boolean, ef: number) => {
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
            `SELECT id FROM memories WHERE scope_user = 'real'
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

      const sample = queryVectors.slice(0, RECALL_QUERIES).map(literal);
      const truth = new Map<string, Set<string>>();
      for (const vector of sample) {
        truth.set(vector, new Set((await nearest(vector, true, 100)).ids));
      }
      const byEf = [];
      for (const ef of EF_SEARCH_VALUES) {
        const hits: number[] = [];
        const timings: number[] = [];
        for (const vector of sample) {
          const { ids, ms } = await nearest(vector, false, ef);
          hits.push(ids.filter((id) => truth.get(vector)!.has(id)).length / 10);
          timings.push(ms);
        }
        const row = {
          efSearch: ef,
          recallAt10: Number(
            (hits.reduce((a, b) => a + b, 0) / hits.length).toFixed(3),
          ),
          vectorP95Ms: Number(estimateP95Ms(timings).toFixed(1)),
        };
        byEf.push(row);
        progress(JSON.stringify(row));
      }
      results.recallByEfSearch = byEf;
      expect(byEf).toHaveLength(EF_SEARCH_VALUES.length);
    });

    it("reports how often each kind of search finds an answer turn", async () => {
      const kinds: NonNullable<SearchOptions["retrievers"]>[] = [
        "hybrid",
        "vector",
        "text",
      ];
      const summary: Record<string, unknown> = {};
      for (const retrievers of kinds) {
        let found = 0;
        const timings: number[] = [];
        const byType: Record<string, [number, number]> = {};
        for (const query of queries) {
          const started = performance.now();
          const hits = await store.search(scope, query.question, {
            limit: TOP,
            retrievers,
          });
          timings.push(performance.now() - started);
          const gold = new Set(query.gold);
          const ok = hits.some((hit) => gold.has(rowOf.get(hit.content) ?? -1));
          found += Number(ok);
          const tally = (byType[query.type] ??= [0, 0]);
          tally[0] += Number(ok);
          tally[1] += 1;
        }
        summary[retrievers] = {
          questions: queries.length,
          answerInTop10: Number((found / queries.length).toFixed(3)),
          searchP95Ms: Number(estimateP95Ms(timings).toFixed(1)),
          byType,
        };
        progress(`${retrievers} ${JSON.stringify(summary[retrievers])}`);
      }
      results.answerTurnInTop10 = summary;
      expect(Object.keys(summary)).toHaveLength(kinds.length);
    });
  },
);

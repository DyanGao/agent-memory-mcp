import type { Pool, PoolClient } from "pg";
import { withScope } from "./db.js";
import type { Scope } from "./db.js";
import type { Embedder } from "./embedder.js";
import { packToBudget, scoreCandidate } from "./ranking.js";
import type { Candidate, ScoreBreakdown } from "./ranking.js";

export const MEMORY_TYPES = [
  "fact",
  "decision",
  "preference",
  "todo",
  "error_fix",
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const DEFAULT_TOP_K = 20;
export const DEFAULT_TOKEN_BUDGET = 1500;

// Candidates fetched from each retriever before fusion.
const CANDIDATES_PER_RETRIEVER = 50;
const HNSW_EF_SEARCH = 100;
// Upper bound on index tuples visited when a narrow scope filters most out.
const HNSW_MAX_SCAN_TUPLES = 200_000;

const IS_CURRENT = `superseded_by IS NULL AND (valid_to IS NULL OR valid_to > now())`;

export interface MemoryInput {
  content: string;
  type: MemoryType;
  importance?: number;
  agent?: string;
  session?: string;
}

export interface Memory {
  id: string;
  type: MemoryType;
  content: string;
  importance: number;
  createdAt: Date;
}

export interface SearchResult extends Memory {
  score: ScoreBreakdown;
}

interface MemoryRow {
  id: string;
  type: MemoryType;
  content: string;
  importance: number;
  created_at: Date;
}

const toMemory = (row: MemoryRow): Memory => ({
  id: row.id,
  type: row.type,
  content: row.content,
  importance: row.importance,
  createdAt: row.created_at,
});

const toVectorLiteral = (vector: number[]): string => JSON.stringify(vector);

async function audit(
  client: PoolClient,
  action: string,
  actor: string,
  targetIds: string[],
): Promise<void> {
  await client.query(
    "INSERT INTO audit_log (action, actor, target_ids) VALUES ($1, $2, $3)",
    [action, actor, targetIds],
  );
}

export class MemoryStore {
  constructor(
    private readonly pool: Pool,
    private readonly embedder: Embedder,
  ) {}

  async write(scope: Scope, input: MemoryInput): Promise<Memory> {
    // Embed before opening a transaction: the model call can be slow.
    const [embedding] = await this.embedder.embed([input.content]);
    if (embedding === undefined) {
      throw new Error("The embedder returned no vector");
    }

    return withScope(this.pool, scope, async (client) => {
      const { rows } = await client.query<MemoryRow>(
        `INSERT INTO memories (scope_user, scope_project, scope_agent, scope_session,
                               type, content, embedding, embed_model, importance)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, $9)
         RETURNING id, type, content, importance, created_at`,
        [
          scope.user,
          scope.project,
          input.agent ?? null,
          input.session ?? null,
          input.type,
          input.content,
          toVectorLiteral(embedding),
          this.embedder.model,
          input.importance ?? 0.5,
        ],
      );
      const row = rows[0]!;
      await audit(client, "write", scope.user, [row.id]);
      return toMemory(row);
    });
  }

  async list(
    scope: Scope,
    options: { limit?: number; type?: MemoryType } = {},
  ): Promise<Memory[]> {
    return withScope(this.pool, scope, async (client) => {
      const { rows } = await client.query<MemoryRow>(
        `SELECT id, type, content, importance, created_at
         FROM memories
         WHERE ${IS_CURRENT} AND ($1::text IS NULL OR type = $1)
         ORDER BY created_at DESC
         LIMIT $2`,
        [options.type ?? null, options.limit ?? DEFAULT_TOP_K],
      );
      return rows.map(toMemory);
    });
  }

  async search(
    scope: Scope,
    query: string,
    options: { limit?: number } = {},
  ): Promise<SearchResult[]> {
    const [embedding] = await this.embedder.embed([query]);
    if (embedding === undefined) {
      throw new Error("The embedder returned no vector");
    }
    const limit = options.limit ?? DEFAULT_TOP_K;

    const rows = await withScope(this.pool, scope, async (client) => {
      // Iterative scan keeps pulling from the index until enough rows survive
      // the scope filter. Without it a narrow scope returns too few results.
      await client.query(
        `SELECT set_config('hnsw.iterative_scan', 'strict_order', true),
                set_config('hnsw.ef_search', $1, true),
                set_config('hnsw.max_scan_tuples', $2, true)`,
        [String(HNSW_EF_SEARCH), String(HNSW_MAX_SCAN_TUPLES)],
      );

      const vector = await client.query<MemoryRow>(
        `SELECT id, type, content, importance, created_at
         FROM memories
         WHERE ${IS_CURRENT}
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        [toVectorLiteral(embedding), CANDIDATES_PER_RETRIEVER],
      );

      // Any query word may match. plainto_tsquery alone requires all of them.
      const text = await client.query<MemoryRow>(
        `WITH q AS (
           SELECT replace(plainto_tsquery('simple', $1)::text, '&', '|')::tsquery AS query
         )
         SELECT id, type, content, importance, created_at
         FROM memories, q
         WHERE ${IS_CURRENT} AND fts @@ q.query
         ORDER BY ts_rank_cd(fts, q.query) DESC
         LIMIT $2`,
        [query, CANDIDATES_PER_RETRIEVER],
      );

      return { vector: vector.rows, text: text.rows };
    });

    const byId = new Map<string, MemoryRow>();
    const candidates = new Map<string, Candidate>();
    const collect = (
      list: MemoryRow[],
      rankField: "vectorRank" | "textRank",
    ): void => {
      list.forEach((row, index) => {
        byId.set(row.id, row);
        const candidate = candidates.get(row.id) ?? {
          id: row.id,
          createdAt: row.created_at,
          importance: row.importance,
        };
        candidate[rankField] = index + 1;
        candidates.set(row.id, candidate);
      });
    };
    collect(rows.vector, "vectorRank");
    collect(rows.text, "textRank");

    const now = new Date();
    return [...candidates.values()]
      .map((candidate) => ({
        ...toMemory(byId.get(candidate.id)!),
        score: scoreCandidate(candidate, now),
      }))
      .sort((a, b) => b.score.total - a.score.total)
      .slice(0, limit);
  }

  async contextFor(
    scope: Scope,
    task: string,
    options: { maxTokens?: number } = {},
  ): Promise<SearchResult[]> {
    const results = await this.search(scope, task, { limit: DEFAULT_TOP_K });
    return packToBudget(results, options.maxTokens ?? DEFAULT_TOKEN_BUDGET);
  }

  /** Hard delete. RLS limits it to the scope. Returns the ids really removed. */
  async forget(scope: Scope, ids: string[]): Promise<string[]> {
    return withScope(this.pool, scope, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        "DELETE FROM memories WHERE id = ANY($1::uuid[]) RETURNING id",
        [ids],
      );
      const deleted = rows.map((row) => row.id);
      if (deleted.length > 0) {
        await audit(client, "forget", scope.user, deleted);
      }
      return deleted;
    });
  }
}

import type { Pool, PoolClient } from "pg";
import { withScope } from "./db.js";
import type { Scope } from "./db.js";
import type { Embedder } from "./embedder.js";
import { packToBudget, scoreCandidate } from "./ranking.js";
import { redact } from "./redact.js";
import { traced } from "./telemetry.js";
import type { Candidate, ScoreBreakdown } from "./ranking.js";
import { executeForget } from "./forget.js";

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
// Measured at 10k memories. On uniform random vectors, HNSW's hard case, 100
// gave recall@10 of 0.44 and 400 gave 0.85, for under 3 ms more at p95.
const HNSW_EF_SEARCH = 400;
// Upper bound on index tuples visited when a narrow scope filters most out.
const HNSW_MAX_SCAN_TUPLES = 200_000;

const IS_CURRENT = `superseded_by IS NULL AND (valid_to IS NULL OR valid_to > now())`;

/** The events behind a memory were forgotten while it was being distilled. */
export class SourceForgottenError extends Error {
  constructor() {
    super("The source events of this memory were forgotten");
    this.name = "SourceForgottenError";
  }
}

export interface MemoryInput {
  content: string;
  type: MemoryType;
  importance?: number;
  agent?: string;
  session?: string;
  sourceEventIds?: string[];
}

export interface WriteOptions {
  /** Reuse a vector already computed, instead of embedding again. */
  embedding?: number[];
  /** Ids of memories this one replaces. The old rows stay, marked outdated. */
  supersedes?: string[];
}

export interface SimilarMemory {
  id: string;
  type: MemoryType;
  content: string;
  similarity: number;
}

export interface Memory {
  id: string;
  type: MemoryType;
  content: string;
  importance: number;
  createdAt: Date;
  project: string | null;
  supersededBy: string | null;
  validTo: Date | null;
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
  scope_project: string | null;
  superseded_by: string | null;
  valid_to: Date | null;
}

const MEMORY_COLUMNS = `id, type, content, importance, created_at,
  scope_project, superseded_by, valid_to`;

const toMemory = (row: MemoryRow): Memory => ({
  id: row.id,
  type: row.type,
  content: row.content,
  importance: row.importance,
  createdAt: row.created_at,
  project: row.scope_project,
  supersededBy: row.superseded_by,
  validTo: row.valid_to,
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

export interface SearchOptions {
  limit?: number;
  /** Both by default. One alone exists to measure what each part adds. */
  retrievers?: "hybrid" | "vector" | "text";
}

export class MemoryStore {
  constructor(
    private readonly pool: Pool,
    private readonly embedder: Embedder,
  ) {}

  write(
    scope: Scope,
    input: MemoryInput,
    options: WriteOptions = {},
  ): Promise<Memory> {
    return traced("memory.write", () => this.doWrite(scope, input, options));
  }

  search(
    scope: Scope,
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchResult[]> {
    return traced("memory.search", () => this.doSearch(scope, query, options));
  }

  private async doWrite(
    scope: Scope,
    input: MemoryInput,
    options: WriteOptions,
  ): Promise<Memory> {
    // An agent can pass a secret straight to memory_write, so this is the
    // last point where it can be caught before storage.
    const content = redact(input.content).text;

    // Embed before opening a transaction: the model call can be slow.
    const [embedding] = options.embedding
      ? [options.embedding]
      : await this.embedder.embed([content]);
    if (embedding === undefined) {
      throw new Error("The embedder returned no vector");
    }

    return withScope(this.pool, scope, async (client) => {
      // The lock makes a concurrent forget wait until this commits, and it
      // then deletes what was written. Without this check a distiller that
      // started before a forget could bring the content straight back.
      const sources = input.sourceEventIds ?? [];
      if (sources.length > 0) {
        const { rowCount } = await client.query(
          "SELECT id FROM events WHERE id = ANY($1::uuid[]) FOR KEY SHARE",
          [sources],
        );
        if (rowCount !== sources.length) throw new SourceForgottenError();
      }

      const { rows } = await client.query<MemoryRow>(
        `INSERT INTO memories (scope_user, scope_project, scope_agent, scope_session,
                               type, content, embedding, embed_model, importance,
                               source_event_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, $9, $10::uuid[])
         RETURNING ${MEMORY_COLUMNS}`,
        [
          scope.user,
          scope.project,
          input.agent ?? null,
          input.session ?? null,
          input.type,
          content,
          toVectorLiteral(embedding),
          this.embedder.model,
          input.importance ?? 0.5,
          input.sourceEventIds ?? [],
        ],
      );
      const row = rows[0]!;
      const superseded = options.supersedes ?? [];
      if (superseded.length > 0) {
        const { rowCount } = await client.query(
          `UPDATE memories SET superseded_by = $1, valid_to = now()
           WHERE id = ANY($2::uuid[]) AND ${IS_CURRENT}`,
          [row.id, superseded],
        );
        if (rowCount !== superseded.length) {
          throw new Error("A memory to supersede could not be superseded");
        }
      }
      await audit(
        client,
        superseded.length > 0 ? "supersede" : "write",
        scope.user,
        [row.id, ...superseded],
      );
      return toMemory(row);
    });
  }

  /** Replaces a memory's text and its vector. Returns null if out of scope. */
  async edit(
    scope: Scope,
    id: string,
    newContent: string,
  ): Promise<Memory | null> {
    const content = redact(newContent).text;
    const [embedding] = await this.embedder.embed([content]);
    if (embedding === undefined) {
      throw new Error("The embedder returned no vector");
    }
    return withScope(this.pool, scope, async (client) => {
      const { rows } = await client.query<MemoryRow>(
        `UPDATE memories
         SET content = $2, embedding = $3::vector, embed_model = $4
         WHERE id = $1
         RETURNING ${MEMORY_COLUMNS}`,
        [id, content, toVectorLiteral(embedding), this.embedder.model],
      );
      const row = rows[0];
      if (row === undefined) return null;
      await audit(client, "edit", scope.user, [row.id]);
      return toMemory(row);
    });
  }

  /** Current memories close to a vector, nearest first. */
  async findSimilar(
    scope: Scope,
    embedding: number[],
    options: { limit: number; minSimilarity: number },
  ): Promise<SimilarMemory[]> {
    return withScope(this.pool, scope, async (client) => {
      const { rows } = await client.query<SimilarMemory>(
        `SELECT id, type, content, 1 - (embedding <=> $1::vector) AS similarity
         FROM memories
         WHERE ${IS_CURRENT} AND 1 - (embedding <=> $1::vector) >= $2
         ORDER BY embedding <=> $1::vector
         LIMIT $3`,
        [toVectorLiteral(embedding), options.minSimilarity, options.limit],
      );
      return rows;
    });
  }

  async list(
    scope: Scope,
    options: {
      limit?: number;
      type?: MemoryType;
      includeOutdated?: boolean;
    } = {},
  ): Promise<Memory[]> {
    return withScope(this.pool, scope, async (client) => {
      const { rows } = await client.query<MemoryRow>(
        `SELECT ${MEMORY_COLUMNS}
         FROM memories
         WHERE ($3::boolean OR (${IS_CURRENT}))
           AND ($1::text IS NULL OR type = $1)
         ORDER BY created_at DESC
         LIMIT $2`,
        [
          options.type ?? null,
          options.limit ?? DEFAULT_TOP_K,
          options.includeOutdated ?? false,
        ],
      );
      return rows.map(toMemory);
    });
  }

  private async doSearch(
    scope: Scope,
    query: string,
    options: SearchOptions,
  ): Promise<SearchResult[]> {
    const retrievers = options.retrievers ?? "hybrid";
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
        `SELECT ${MEMORY_COLUMNS}
         FROM memories
         WHERE ${IS_CURRENT}
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        [toVectorLiteral(embedding), CANDIDATES_PER_RETRIEVER],
      );

      // Any query word may match. plainto_tsquery alone requires all of them.
      const text = await client.query<MemoryRow>(
        `WITH q AS (
           SELECT replace(plainto_tsquery('english', $1)::text, '&', '|')::tsquery AS query
         )
         SELECT ${MEMORY_COLUMNS}
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
    if (retrievers !== "text") collect(rows.vector, "vectorRank");
    if (retrievers !== "vector") collect(rows.text, "textRank");

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
    return traced("memory.context_for", async () => {
      const results = await this.search(scope, task, { limit: DEFAULT_TOP_K });
      return packToBudget(results, options.maxTokens ?? DEFAULT_TOKEN_BUDGET);
    });
  }

  /**
   * What a new session should know before it has a task: lasting decisions
   * first, not whatever matches a vague query.
   */
  async overview(
    scope: Scope,
    options: { maxTokens?: number } = {},
  ): Promise<Memory[]> {
    return traced("memory.overview", async () => {
      const rows = await withScope(this.pool, scope, async (client) => {
        const { rows } = await client.query<MemoryRow>(
          `SELECT ${MEMORY_COLUMNS}
           FROM memories
           WHERE ${IS_CURRENT}
           ORDER BY array_position(
                      ARRAY['decision', 'preference', 'error_fix', 'fact', 'todo'],
                      type
                    ),
                    importance DESC,
                    created_at DESC
           LIMIT 200`,
        );
        return rows;
      });
      return packToBudget(
        rows.map(toMemory),
        options.maxTokens ?? DEFAULT_TOKEN_BUDGET,
      );
    });
  }

  /** Hard delete, including the transcript it came from. Returns memory ids removed. */
  async forget(scope: Scope, ids: string[]): Promise<string[]> {
    const before = await withScope(
      this.pool,
      { ...scope, allProjects: true },
      async (client) => {
        const { rows } = await client.query<{ id: string }>(
          "SELECT id FROM memories WHERE id = ANY($1::uuid[])",
          [ids],
        );
        return rows.map((row) => row.id);
      },
    );
    if (before.length === 0) return [];
    await executeForget(this.pool, this.embedder, scope, { ids: before });
    return before;
  }
}

import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withScope } from "./db.js";
import type { Scope } from "./db.js";
import type { Embedder } from "./embedder.js";

// A memory this close to the topic is treated as about it.
const TOPIC_MIN_SIMILARITY = 0.7;

export interface ForgetSelector {
  /** Everything the user has, in every project. */
  everything?: boolean;
  ids?: string[];
  topic?: string;
  from?: Date;
  to?: Date;
}

export interface ForgetPlan {
  memoryIds: string[];
  eventIds: string[];
}

export interface ForgetReceipt {
  receiptId: string;
  completedAt: string;
  memoriesDeleted: number;
  eventsDeleted: number;
  /** Fingerprint of the deleted ids, for matching against the audit log. */
  targetsSha256: string;
  /**
   * True if any row was deleted. The rows are already gone from every read
   * path, but their bytes stay in free space on disk until the nightly scrub.
   */
  diskScrubPending: boolean;
}

function assertSelector(selector: ForgetSelector): void {
  const { everything, ids, topic, from, to } = selector;
  if (!everything && !ids?.length && !topic?.trim() && !from && !to) {
    throw new Error(
      "forget needs a selector: everything, ids, topic, from or to",
    );
  }
}

/** Forgetting a person must reach every project, not just the current one. */
const allProjects = (scope: Scope): Scope => ({ ...scope, allProjects: true });

async function seedMemories(
  client: PoolClient,
  selector: ForgetSelector,
  topicVector: string | null,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM memories
     WHERE ($1::boolean
            OR id = ANY($2::uuid[])
            OR ($3::text IS NOT NULL)
            OR ($5::timestamptz IS NOT NULL OR $6::timestamptz IS NOT NULL))
       AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
       AND ($3::text IS NULL
            OR fts @@ plainto_tsquery('english', $3)
            OR 1 - (embedding <=> $4::vector) >= ${TOPIC_MIN_SIMILARITY})
       AND ($5::timestamptz IS NULL OR created_at >= $5)
       AND ($6::timestamptz IS NULL OR created_at < $6)`,
    [
      selector.everything ?? false,
      selector.ids?.length ? selector.ids : null,
      selector.topic?.trim() || null,
      topicVector,
      selector.from ?? null,
      selector.to ?? null,
    ],
  );
  return rows.map((row) => row.id);
}

async function seedEvents(
  client: PoolClient,
  selector: ForgetSelector,
): Promise<string[]> {
  // Forgetting by id targets memories. Their events arrive through the closure.
  if (selector.ids?.length) return [];
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM events
     WHERE ($1::text IS NULL
            OR to_tsvector('english', payload->>'text') @@ plainto_tsquery('english', $1))
       AND ($2::timestamptz IS NULL OR ts >= $2)
       AND ($3::timestamptz IS NULL OR ts < $3)`,
    [
      selector.topic?.trim() || null,
      selector.from ?? null,
      selector.to ?? null,
    ],
  );
  return rows.map((row) => row.id);
}

/**
 * Follows every link that could carry the same content, until nothing new is
 * found. This errs towards deleting more, because a merged memory can hold
 * text from any event it came from, and leakage must be zero.
 */
async function closure(
  client: PoolClient,
  memories: Set<string>,
  events: Set<string>,
): Promise<void> {
  for (;;) {
    const before = memories.size + events.size;

    const linkedEvents = await client.query<{ id: string }>(
      `SELECT DISTINCT unnest(source_event_ids) AS id
       FROM memories WHERE id = ANY($1::uuid[])`,
      [[...memories]],
    );
    linkedEvents.rows.forEach((row) => events.add(row.id));

    // Tool output is never a memory's source, yet it can hold the same text,
    // and nothing in the product needs it once its session is being forgotten.
    const toolOutput = await client.query<{ id: string }>(
      `SELECT id FROM events
       WHERE kind = 'tool_output' AND session_id IN (
         SELECT session_id FROM events WHERE id = ANY($1::uuid[])
       )`,
      [[...events]],
    );
    toolOutput.rows.forEach((row) => events.add(row.id));

    const linkedMemories = await client.query<{ id: string }>(
      `SELECT id FROM memories
       WHERE source_event_ids && $1::uuid[] OR superseded_by = ANY($2::uuid[])`,
      [[...events], [...memories]],
    );
    linkedMemories.rows.forEach((row) => memories.add(row.id));

    if (memories.size + events.size === before) return;
  }
}

async function resolvePlan(
  client: PoolClient,
  selector: ForgetSelector,
  topicVector: string | null,
): Promise<ForgetPlan> {
  const memories = new Set(await seedMemories(client, selector, topicVector));
  const events = new Set(await seedEvents(client, selector));
  await closure(client, memories, events);
  return { memoryIds: [...memories], eventIds: [...events] };
}

async function embedTopic(
  embedder: Embedder,
  selector: ForgetSelector,
): Promise<string | null> {
  if (!selector.topic?.trim()) return null;
  const [vector] = await embedder.embed([selector.topic]);
  return vector ? JSON.stringify(vector) : null;
}

/** What forget would delete. Changes nothing. */
export async function previewForget(
  pool: Pool,
  embedder: Embedder,
  scope: Scope,
  selector: ForgetSelector,
): Promise<ForgetPlan> {
  assertSelector(selector);
  const topicVector = await embedTopic(embedder, selector);
  return withScope(pool, allProjects(scope), (client) =>
    resolvePlan(client, selector, topicVector),
  );
}

export async function executeForget(
  pool: Pool,
  embedder: Embedder,
  scope: Scope,
  selector: ForgetSelector,
): Promise<ForgetReceipt> {
  assertSelector(selector);
  const topicVector = await embedTopic(embedder, selector);

  const deleted = await withScope(pool, allProjects(scope), async (client) => {
    const plan = await resolvePlan(client, selector, topicVector);

    await client.query(
      `INSERT INTO forgotten_events (id) SELECT unnest($1::uuid[])
       ON CONFLICT DO NOTHING`,
      [plan.eventIds],
    );

    // Events go first. A distiller writing right now holds a lock on them, so
    // this waits for it, and the memory delete below then sees what it wrote.
    const events = await client.query<{ id: string }>(
      "DELETE FROM events WHERE id = ANY($1::uuid[]) RETURNING id",
      [plan.eventIds],
    );
    const memories = await client.query<{ id: string }>(
      `DELETE FROM memories
       WHERE id = ANY($1::uuid[]) OR source_event_ids && $2::uuid[]
       RETURNING id`,
      [plan.memoryIds, plan.eventIds],
    );

    const memoryIds = memories.rows.map((row) => row.id);
    const eventIds = events.rows.map((row) => row.id);
    const targets = [...memoryIds, ...eventIds];

    if (selector.everything) {
      await client.query("DELETE FROM distill_status");
      const queue = await client.query<{ installed: boolean }>(
        "SELECT to_regclass('pgboss.job') IS NOT NULL AS installed",
      );
      if (queue.rows[0]?.installed) {
        await client.query("DELETE FROM pgboss.job WHERE data->>'user' = $1", [
          scope.user,
        ]);
      }
      await client.query("SELECT erase_audit_actor($1)", [scope.user]);
    }
    if (targets.length > 0) {
      await client.query("UPDATE scrub_state SET pending = true");
      await client.query(
        "INSERT INTO audit_log (action, actor, target_ids) VALUES ('forget', $1, $2)",
        [selector.everything ? "erased" : scope.user, targets],
      );
    }
    return { memoryIds, eventIds, targets };
  });

  return {
    receiptId: randomUUID(),
    completedAt: new Date().toISOString(),
    memoriesDeleted: deleted.memoryIds.length,
    eventsDeleted: deleted.eventIds.length,
    targetsSha256: createHash("sha256")
      .update([...deleted.targets].sort().join(","))
      .digest("hex"),
    diskScrubPending: deleted.targets.length > 0,
  };
}

/**
 * Rewrites the tables so deleted bytes leave the data files. This locks them
 * and rebuilds the vector index, so it only runs if something was deleted.
 * Returns whether it ran.
 */
export async function scrubDeletedData(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query<{ pending: boolean }>(
    "SELECT pending FROM scrub_state",
  );
  if (!rows[0]?.pending) return false;
  // Cleared first: a forget during the rewrite sets it again, for tomorrow.
  await pool.query("UPDATE scrub_state SET pending = false");
  await pool.query("VACUUM FULL memories, events");
  return true;
}

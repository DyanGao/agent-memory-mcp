import type { Pool } from "pg";
import { withScope } from "./db.js";
import type { Scope } from "./db.js";

export interface AuditEntry {
  id: string;
  action: string;
  actor: string;
  targetIds: string[];
  ts: string;
}

export async function readAudit(
  pool: Pool,
  scope: Scope,
  limit: number,
): Promise<AuditEntry[]> {
  const { rows } = await pool.query<{
    id: string;
    action: string;
    actor: string;
    target_ids: string[];
    ts: Date;
  }>("SELECT * FROM read_audit($1, $2)", [scope.user, limit]);
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    actor: row.actor,
    targetIds: row.target_ids,
    ts: row.ts.toISOString(),
  }));
}

/** Everything held about a user, for GDPR Art. 15 and 20. */
export async function exportUserData(pool: Pool, scope: Scope) {
  const data = await withScope(
    pool,
    { ...scope, allProjects: true },
    async (client) => {
      const memories = await client.query(
        `SELECT id, scope_project AS project, scope_agent AS agent,
                scope_session AS session, type, content, importance, embed_model,
                created_at, valid_from, valid_to, superseded_by, source_event_ids
         FROM memories ORDER BY created_at`,
      );
      const events = await client.query(
        `SELECT id, scope_project AS project, session_id, seq, kind,
                payload->>'text' AS text, ts, ttl_at
         FROM events ORDER BY session_id, seq`,
      );
      return { memories: memories.rows, events: events.rows };
    },
  );
  return {
    exportedAt: new Date().toISOString(),
    user: scope.user,
    ...data,
    audit: await readAudit(pool, scope, 10_000),
  };
}

import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { withScope } from "./db.js";
import type { Scope } from "./db.js";
import { redact } from "./redact.js";
import type { RedactOptions } from "./redact.js";

export const EVENT_KINDS = [
  "user_text",
  "assistant_text",
  "tool_output",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** Only these reach the LLM. Tool output is where third-party text gets in. */
export const DISTILLABLE_KINDS: EventKind[] = ["user_text", "assistant_text"];

const MAX_TOOL_OUTPUT_CHARS = 8000;

export interface EventInput {
  seq: number;
  kind: EventKind;
  text: string;
  ts?: string;
}

export interface StoredEvent {
  id: string;
  seq: number;
  kind: EventKind;
  text: string;
}

export interface IngestOptions extends RedactOptions {
  retentionDays: number;
}

/** The same transcript position always gives the same id, so re-capture is a no-op. */
export function eventId(scope: Scope, sessionId: string, seq: number): string {
  const hex = createHash("sha256")
    .update(JSON.stringify([scope.user, scope.project, sessionId, seq]))
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Redacts before anything is stored. Returns how many events were new. */
export async function ingestEvents(
  pool: Pool,
  scope: Scope,
  sessionId: string,
  events: EventInput[],
  options: IngestOptions,
): Promise<number> {
  if (events.length === 0) return 0;

  const rows = events.map((event) => {
    const text =
      event.kind === "tool_output"
        ? event.text.slice(0, MAX_TOOL_OUTPUT_CHARS)
        : event.text;
    return {
      id: eventId(scope, sessionId, event.seq),
      seq: event.seq,
      kind: event.kind,
      payload: JSON.stringify({ text: redact(text, options).text }),
      ts: event.ts ?? new Date().toISOString(),
    };
  });

  return withScope(pool, scope, async (client) => {
    const { rowCount } = await client.query(
      `INSERT INTO events (id, scope_user, scope_project, session_id, seq, kind, payload, ts, ttl_at)
       SELECT id, $1, $2, $3, seq, kind, payload::jsonb, ts,
              now() + make_interval(days => $4::int)
       FROM unnest($5::uuid[], $6::bigint[], $7::text[], $8::text[], $9::timestamptz[])
         AS t(id, seq, kind, payload, ts)
       WHERE NOT EXISTS (SELECT 1 FROM forgotten_events f WHERE f.id = t.id)
       ON CONFLICT (id) DO NOTHING`,
      [
        scope.user,
        scope.project,
        sessionId,
        options.retentionDays,
        rows.map((row) => row.id),
        rows.map((row) => row.seq),
        rows.map((row) => row.kind),
        rows.map((row) => row.payload),
        rows.map((row) => row.ts),
      ],
    );
    return rowCount ?? 0;
  });
}

/** Events not yet distilled, oldest first, excluding tool output. */
export async function loadDistillableEvents(
  pool: Pool,
  scope: Scope,
  sessionId: string,
): Promise<StoredEvent[]> {
  return withScope(pool, scope, async (client) => {
    const { rows } = await client.query<{
      id: string;
      seq: string;
      kind: EventKind;
      text: string;
    }>(
      `SELECT id, seq, kind, payload->>'text' AS text
       FROM events
       WHERE session_id = $1 AND distilled_at IS NULL AND kind = ANY($2::text[])
       ORDER BY seq`,
      [sessionId, DISTILLABLE_KINDS],
    );
    return rows.map((row) => ({ ...row, seq: Number(row.seq) }));
  });
}

export async function recordDistillOutcome(
  pool: Pool,
  scope: Scope,
  sessionId: string,
  outcome:
    | { status: "done"; memoriesWritten: number; eventIds: string[] }
    | { status: "failed"; error: string },
): Promise<void> {
  await withScope(pool, scope, async (client) => {
    await client.query(
      `INSERT INTO distill_status (scope_user, scope_project, session_id, status, error, memories_written)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (scope_user, session_id) DO UPDATE
       SET status = excluded.status, error = excluded.error,
           memories_written = excluded.memories_written, updated_at = now()`,
      [
        scope.user,
        scope.project,
        sessionId,
        outcome.status,
        outcome.status === "failed" ? outcome.error : null,
        outcome.status === "done" ? outcome.memoriesWritten : 0,
      ],
    );
    if (outcome.status === "done" && outcome.eventIds.length > 0) {
      await client.query(
        "UPDATE events SET distilled_at = now() WHERE id = ANY($1::uuid[])",
        [outcome.eventIds],
      );
    }
  });
}

export async function getDistillStatus(
  pool: Pool,
  scope: Scope,
  sessionId: string,
): Promise<{
  status: string;
  error: string | null;
  memoriesWritten: number;
} | null> {
  return withScope(pool, scope, async (client) => {
    const { rows } = await client.query<{
      status: string;
      error: string | null;
      memories_written: number;
    }>(
      "SELECT status, error, memories_written FROM distill_status WHERE session_id = $1",
      [sessionId],
    );
    const row = rows[0];
    return row
      ? {
          status: row.status,
          error: row.error,
          memoriesWritten: row.memories_written,
        }
      : null;
  });
}

export async function sweepExpired(
  pool: Pool,
  retentionDays: number,
): Promise<{ memoriesDeleted: number; eventsDeleted: number }> {
  const { rows } = await pool.query<{
    memories_deleted: string;
    events_deleted: string;
  }>("SELECT * FROM sweep_expired($1)", [retentionDays]);
  const swept =
    Number(rows[0]!.memories_deleted) + Number(rows[0]!.events_deleted);
  if (swept > 0) await pool.query("SELECT mark_scrub_pending()");
  return {
    memoriesDeleted: Number(rows[0]!.memories_deleted),
    eventsDeleted: Number(rows[0]!.events_deleted),
  };
}

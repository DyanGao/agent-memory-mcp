-- The runtime role. It owns nothing, so row-level security applies to it.
-- Login is enabled at startup by ensureAppRole, which sets its password.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'memory_app') THEN
    CREATE ROLE memory_app NOLOGIN;
  END IF;
END
$$;

CREATE TABLE events (
  id uuid PRIMARY KEY,
  scope_user text NOT NULL,
  scope_project text,
  session_id text NOT NULL,
  ts timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,
  payload jsonb NOT NULL,
  ttl_at timestamptz
);
CREATE INDEX events_scope_idx ON events (scope_user, scope_project);
CREATE INDEX events_session_idx ON events (session_id);

CREATE TABLE memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_user text NOT NULL,
  scope_project text,
  scope_agent text,
  scope_session text,
  type text NOT NULL CHECK (type IN ('fact', 'decision', 'preference', 'todo', 'error_fix')),
  content text NOT NULL,
  -- 'english' drops stop words, which would otherwise count as matches. Other
  -- languages still match on exact words, and the vector side covers meaning.
  fts tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  embedding vector(1024) NOT NULL,
  embed_model text NOT NULL,
  importance real NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  superseded_by uuid REFERENCES memories (id) ON DELETE SET NULL,
  source_event_ids uuid[] NOT NULL DEFAULT '{}'
);
CREATE INDEX memories_scope_idx ON memories (scope_user, scope_project);
CREATE INDEX memories_fts_idx ON memories USING gin (fts);
CREATE INDEX memories_embedding_idx ON memories USING hnsw (embedding vector_cosine_ops);

-- Evidence of writes and deletes: ids only, never content.
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  action text NOT NULL,
  actor text NOT NULL,
  target_ids uuid[] NOT NULL,
  ts timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON memories, events TO memory_app;
-- The runtime can add to the audit log but not read or rewrite it.
GRANT INSERT ON audit_log TO memory_app;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO memory_app;

ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories FORCE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

-- With no scope set, current_setting returns NULL or '' and nothing matches.
-- A row with no project belongs to the user across all their projects.
CREATE POLICY memories_scope ON memories FOR ALL TO memory_app
  USING (
    scope_user = current_setting('app.scope_user', true)
    AND (scope_project IS NULL OR scope_project = current_setting('app.scope_project', true))
  )
  WITH CHECK (
    scope_user = current_setting('app.scope_user', true)
    AND (scope_project IS NULL OR scope_project = current_setting('app.scope_project', true))
  );

CREATE POLICY events_scope ON events FOR ALL TO memory_app
  USING (
    scope_user = current_setting('app.scope_user', true)
    AND (scope_project IS NULL OR scope_project = current_setting('app.scope_project', true))
  )
  WITH CHECK (
    scope_user = current_setting('app.scope_user', true)
    AND (scope_project IS NULL OR scope_project = current_setting('app.scope_project', true))
  );

CREATE POLICY audit_insert ON audit_log FOR INSERT TO memory_app WITH CHECK (true);

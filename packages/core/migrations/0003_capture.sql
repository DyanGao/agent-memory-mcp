-- pg-boss runs as memory_app and only ever touches this schema.
CREATE SCHEMA pgboss AUTHORIZATION memory_app;

ALTER TABLE events
  ADD COLUMN seq bigint NOT NULL,
  ADD COLUMN distilled_at timestamptz,
  ADD CONSTRAINT events_kind_check CHECK (kind IN ('user_text', 'assistant_text', 'tool_output'));

CREATE TABLE distill_status (
  scope_user text NOT NULL,
  scope_project text,
  session_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('done', 'failed')),
  -- A failure reason written by this code. Never transcript content.
  error text,
  memories_written integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_user, session_id)
);
GRANT SELECT, INSERT, UPDATE ON distill_status TO memory_app;
ALTER TABLE distill_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE distill_status FORCE ROW LEVEL SECURITY;
CREATE POLICY distill_status_scope ON distill_status FOR ALL TO memory_app
  USING (
    scope_user = current_setting('app.scope_user', true)
    AND (scope_project IS NULL OR scope_project = current_setting('app.scope_project', true))
  )
  WITH CHECK (
    scope_user = current_setting('app.scope_user', true)
    AND (scope_project IS NULL OR scope_project = current_setting('app.scope_project', true))
  );

-- Retention crosses every user, which RLS rightly refuses to memory_app. This
-- one function does exactly that job with the owner's rights, and nothing else.
CREATE FUNCTION sweep_expired(retention_days integer)
RETURNS TABLE (memories_deleted bigint, events_deleted bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  memory_ids uuid[];
  event_ids uuid[];
BEGIN
  IF retention_days IS NULL OR retention_days < 1 THEN
    RAISE EXCEPTION 'retention_days must be at least 1, got %', retention_days;
  END IF;

  WITH deleted AS (
    DELETE FROM memories
    WHERE created_at < now() - make_interval(days => retention_days)
    RETURNING id
  )
  SELECT coalesce(array_agg(id), '{}') INTO memory_ids FROM deleted;

  WITH deleted AS (
    DELETE FROM events WHERE ttl_at < now() RETURNING id
  )
  SELECT coalesce(array_agg(id), '{}') INTO event_ids FROM deleted;

  IF cardinality(memory_ids) + cardinality(event_ids) > 0 THEN
    INSERT INTO audit_log (action, actor, target_ids)
    VALUES ('retention', 'system', memory_ids || event_ids);
  END IF;

  RETURN QUERY SELECT cardinality(memory_ids)::bigint, cardinality(event_ids)::bigint;
END
$$;
REVOKE ALL ON FUNCTION sweep_expired(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sweep_expired(integer) TO memory_app;

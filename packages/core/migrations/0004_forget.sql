-- Erasure must reach all of a user's projects. Only code that deliberately
-- sets app.scope_all_projects gets this. MCP tools never do.
ALTER POLICY memories_scope ON memories
  USING (
    scope_user = current_setting('app.scope_user', true)
    AND (
      scope_project IS NULL
      OR scope_project = current_setting('app.scope_project', true)
      OR current_setting('app.scope_all_projects', true) = 'on'
    )
  )
  WITH CHECK (
    scope_user = current_setting('app.scope_user', true)
    AND (
      scope_project IS NULL
      OR scope_project = current_setting('app.scope_project', true)
      OR current_setting('app.scope_all_projects', true) = 'on'
    )
  );

ALTER POLICY events_scope ON events
  USING (
    scope_user = current_setting('app.scope_user', true)
    AND (
      scope_project IS NULL
      OR scope_project = current_setting('app.scope_project', true)
      OR current_setting('app.scope_all_projects', true) = 'on'
    )
  )
  WITH CHECK (
    scope_user = current_setting('app.scope_user', true)
    AND (
      scope_project IS NULL
      OR scope_project = current_setting('app.scope_project', true)
      OR current_setting('app.scope_all_projects', true) = 'on'
    )
  );

ALTER POLICY distill_status_scope ON distill_status
  USING (
    scope_user = current_setting('app.scope_user', true)
    AND (
      scope_project IS NULL
      OR scope_project = current_setting('app.scope_project', true)
      OR current_setting('app.scope_all_projects', true) = 'on'
    )
  )
  WITH CHECK (
    scope_user = current_setting('app.scope_user', true)
    AND (
      scope_project IS NULL
      OR scope_project = current_setting('app.scope_project', true)
      OR current_setting('app.scope_all_projects', true) = 'on'
    )
  );

GRANT DELETE ON distill_status TO memory_app;

-- Event ids are derived from transcript position, so a resumed session would
-- re-send forgotten text with the same id. These ids stop that. Each is a
-- one-way hash and holds no content.
CREATE TABLE forgotten_events (
  id uuid PRIMARY KEY,
  forgotten_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON forgotten_events TO memory_app;

-- Lets the runtime role reclaim deleted rows after a forget.
GRANT MAINTAIN ON memories, events TO memory_app;

-- Audit rows are evidence and stay, but the person's name must not.
CREATE FUNCTION erase_audit_actor(target_actor text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE audit_log SET actor = 'erased' WHERE actor = target_actor;
$$;
REVOKE ALL ON FUNCTION erase_audit_actor(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erase_audit_actor(text) TO memory_app;

-- The dashboard's only way to read the log. It cannot change anything.
CREATE FUNCTION read_audit(target_actor text, row_limit integer)
RETURNS TABLE (id bigint, action text, actor text, target_ids uuid[], ts timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id, action, actor, target_ids, ts
  FROM audit_log
  WHERE actor = target_actor
  ORDER BY id DESC
  LIMIT row_limit;
$$;
REVOKE ALL ON FUNCTION read_audit(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_audit(text, integer) TO memory_app;

-- A plain VACUUM leaves deleted bytes in free page space. VACUUM FULL removes
-- them but locks the tables, so it runs nightly, and only if this is set.
CREATE TABLE scrub_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  pending boolean NOT NULL DEFAULT false
);
INSERT INTO scrub_state DEFAULT VALUES;
GRANT SELECT, UPDATE ON scrub_state TO memory_app;

-- Retention deletes need scrubbing too, and need no other access to this table.
CREATE FUNCTION mark_scrub_pending()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE scrub_state SET pending = true;
$$;
REVOKE ALL ON FUNCTION mark_scrub_pending() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_scrub_pending() TO memory_app;

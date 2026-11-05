import type { Pool, PoolClient } from "pg";

export interface Scope {
  user: string;
  /** Null means the user's memories that belong to no project. */
  project: string | null;
}

/** Gives the runtime role a login. Run with the owner connection. */
export async function ensureAppRole(
  owner: Pool,
  password: string,
): Promise<void> {
  if (password.length === 0) {
    throw new Error("MEMORY_APP_PASSWORD must not be empty");
  }
  const { rows } = await owner.query<{ statement: string }>(
    "SELECT format('ALTER ROLE memory_app LOGIN PASSWORD %L', $1::text) AS statement",
    [password],
  );
  await owner.query(rows[0]!.statement);
}

/**
 * Runs fn in one transaction with the scope that RLS policies read.
 * set_config(..., true) lasts for the transaction, so a pooled connection
 * can never carry one caller's scope into the next caller's query.
 */
export async function withScope<T>(
  pool: Pool,
  scope: Scope,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (scope.user.trim().length === 0) {
    throw new Error("A scope needs a non-empty user");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT set_config('app.scope_user', $1, true),
              set_config('app.scope_project', $2, true)`,
      [scope.user, scope.project ?? ""],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

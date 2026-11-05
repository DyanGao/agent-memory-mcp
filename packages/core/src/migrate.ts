import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

// Arbitrary fixed key, so concurrent startups run migrations one at a time.
const MIGRATION_LOCK_KEY = 727_001;

export function orderMigrations(files: string[]): string[] {
  const sqlFiles = files.filter((file) => file.endsWith(".sql"));
  const seen = new Map<string, string>();

  for (const file of sqlFiles) {
    const prefix = /^(\d+)_/.exec(file)?.[1];
    if (prefix === undefined) {
      throw new Error(`Migration "${file}" needs a numeric prefix like 0001_`);
    }
    const clash = seen.get(prefix);
    if (clash !== undefined) {
      throw new Error(
        `Migrations "${clash}" and "${file}" share number ${prefix}`,
      );
    }
    seen.set(prefix, file);
  }

  return [...sqlFiles].sort();
}

/** Applies pending migrations in order. Returns the files it applied. */
export async function migrate(
  pool: Pool,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<string[]> {
  const files = orderMigrations(await readdir(migrationsDir));
  const applied: string[] = [];
  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const file of files) {
      const { rowCount } = await client.query(
        "SELECT 1 FROM schema_migrations WHERE name = $1",
        [file],
      );
      if (rowCount) continue;

      const sql = await readFile(join(migrationsDir, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
          file,
        ]);
        await client.query("COMMIT");
      } catch (cause) {
        await client.query("ROLLBACK");
        throw new Error(`Migration "${file}" failed`, { cause });
      }
      applied.push(file);
    }
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY])
      .finally(() => client.release());
  }

  return applied;
}

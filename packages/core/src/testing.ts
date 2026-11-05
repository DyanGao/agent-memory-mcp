import { randomBytes } from "node:crypto";
import pg from "pg";
import { GenericContainer, Wait } from "testcontainers";
import { ensureAppRole } from "./db.js";
import { migrate } from "./migrate.js";

// Must match the image in docker-compose.yml.
export const POSTGRES_IMAGE = "pgvector/pgvector:0.8.7-pg17";

export interface TestDb {
  /** Superuser: bypasses RLS. Use only to arrange or inspect test data. */
  owner: pg.Pool;
  /** The restricted runtime role. RLS applies. */
  app: pg.Pool;
  /** Runs a command inside the database container and returns its output. */
  exec(command: string[]): Promise<string>;
  stop(): Promise<void>;
}

/** Starts a migrated pgvector container. Needs a running Docker daemon. */
export async function startTestDb(): Promise<TestDb> {
  const container = await new GenericContainer(POSTGRES_IMAGE)
    .withEnvironment({
      POSTGRES_USER: "test",
      POSTGRES_PASSWORD: "test",
      POSTGRES_DB: "test",
    })
    .withExposedPorts(5432)
    // Matches docker-compose.yml. Docker's default of 64 MB is too small for
    // parallel HNSW builds, and Postgres refuses them outright.
    .withSharedMemorySize(1024 ** 3)
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    )
    .start();

  const connection = {
    host: container.getHost(),
    port: container.getMappedPort(5432),
    database: "test",
  };
  const owner = new pg.Pool({ ...connection, user: "test", password: "test" });
  await migrate(owner);

  const appPassword = randomBytes(16).toString("hex");
  await ensureAppRole(owner, appPassword);
  const app = new pg.Pool({
    ...connection,
    user: "memory_app",
    password: appPassword,
  });

  return {
    owner,
    app,
    exec: async (command) => (await container.exec(command)).output,
    stop: async () => {
      await app.end();
      await owner.end();
      await container.stop();
    },
  };
}

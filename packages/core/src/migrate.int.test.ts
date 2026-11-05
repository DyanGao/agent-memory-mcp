import { GenericContainer, Wait } from "testcontainers";
import type { StartedTestContainer } from "testcontainers";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "./migrate.js";

// Must match the image in docker-compose.yml.
const POSTGRES_IMAGE = "pgvector/pgvector:0.8.7-pg17";

describe("migrate against real Postgres", () => {
  let container: StartedTestContainer;
  let pool: pg.Pool;

  beforeAll(async () => {
    container = await new GenericContainer(POSTGRES_IMAGE)
      .withEnvironment({
        POSTGRES_USER: "test",
        POSTGRES_PASSWORD: "test",
        POSTGRES_DB: "test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();

    pool = new pg.Pool({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      user: "test",
      password: "test",
      database: "test",
    });
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it("installs the vector and pg_trgm extensions", async () => {
    await migrate(pool);
    const { rows } = await pool.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_trgm')",
    );
    expect(rows.map((row) => row.extname).sort()).toEqual([
      "pg_trgm",
      "vector",
    ]);
  });

  it("applies nothing on a second run", async () => {
    await migrate(pool);
    expect(await migrate(pool)).toEqual([]);
  });
});

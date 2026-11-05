import {
  assertEmbedderDimension,
  ensureAppRole,
  MemoryQueue,
  MemoryStore,
  migrate,
  OllamaEmbedder,
} from "@agent-memory/core";
import pg from "pg";
import { buildApp } from "./http.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set. See .env.example`);
  return value;
}

const embedder = new OllamaEmbedder(
  process.env.EMBED_MODEL ?? "bge-m3",
  process.env.OLLAMA_URL ?? "http://127.0.0.1:11434",
);
await assertEmbedderDimension(embedder);

// The owner connection is only for setup. Serving uses the restricted role.
const owner = new pg.Pool({ connectionString: required("DATABASE_URL") });
await migrate(owner);
await ensureAppRole(owner, required("MEMORY_APP_PASSWORD"));
await owner.end();

const appUrl = required("APP_DATABASE_URL");
const appPool = new pg.Pool({ connectionString: appUrl });
const queue = await MemoryQueue.start(appUrl);
const app = buildApp({
  store: new MemoryStore(appPool, embedder),
  apiKey: required("MEMORY_API_KEY"),
  capture: {
    pool: appPool,
    retentionDays: Number(process.env.RETENTION_DAYS ?? 365),
    enqueueDistill: (job) => queue.enqueueDistill(job),
  },
});

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
await app.listen({ port, host });
process.stderr.write(`agent-memory-mcp listening on http://${host}:${port}\n`);

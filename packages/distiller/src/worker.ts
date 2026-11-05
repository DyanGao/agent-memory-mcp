import {
  assertEmbedderDimension,
  MemoryQueue,
  MemoryStore,
  OllamaEmbedder,
  scopeOf,
  scrubDeletedData,
  sweepExpired,
} from "@agent-memory/core";
import pg from "pg";
import { createProvider } from "./llm.js";
import { distillSession } from "./session.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set. See .env.example`);
  return value;
}

const log = (message: string): void => {
  process.stderr.write(`distiller: ${message}\n`);
};

const ollamaUrl = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const embedder = new OllamaEmbedder(
  process.env.EMBED_MODEL ?? "bge-m3",
  ollamaUrl,
);
await assertEmbedderDimension(embedder);

const llm = createProvider(
  process.env.DISTILL_MODEL ?? "ollama:qwen3",
  ollamaUrl,
);
if (llm.hosted) {
  log(
    `WARNING: ${llm.name} is a hosted model. Session text leaves this machine.`,
  );
}

const appUrl = required("APP_DATABASE_URL");
const pool = new pg.Pool({ connectionString: appUrl });
const store = new MemoryStore(pool, embedder);
const retentionDays = Number(process.env.RETENTION_DAYS ?? 365);

const queue = await MemoryQueue.start(appUrl);
await queue.workDistill(async (job) => {
  await distillSession(
    { pool, store, embedder, llm },
    scopeOf(job),
    job.sessionId,
  );
  log(`distilled a session for ${job.user}`);
});
await queue.workRetention(async () => {
  const swept = await sweepExpired(pool, retentionDays);
  log(
    `retention removed ${swept.memoriesDeleted} memories, ${swept.eventsDeleted} events`,
  );
  if (await scrubDeletedData(pool)) log("scrubbed deleted data from disk");
});
log(`ready with ${llm.name}`);

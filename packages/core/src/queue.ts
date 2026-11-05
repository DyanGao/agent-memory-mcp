import { PgBoss } from "pg-boss";
import type { Scope } from "./db.js";

const DISTILL_QUEUE = "distill-session";
const RETENTION_QUEUE = "retention-sweep";
const RETENTION_CRON = "0 3 * * *";
const DISTILL_RETRIES = 3;
const DISTILL_RETRY_DELAY_SECONDS = 30;

/** Identifiers only. No transcript content may ever enter a job. */
export interface DistillJob {
  user: string;
  project: string | null;
  sessionId: string;
}

export const scopeOf = (job: DistillJob): Scope => ({
  user: job.user,
  project: job.project,
});

export class MemoryQueue {
  private constructor(private readonly boss: PgBoss) {}

  /** Connects as memory_app, in the schema migration 0003 prepared for it. */
  static async start(connectionString: string): Promise<MemoryQueue> {
    const boss = new PgBoss({
      connectionString,
      schema: "pgboss",
      createSchema: false,
    });
    boss.on("error", (error: Error) => {
      process.stderr.write(`queue error: ${error.message}\n`);
    });
    await boss.start();
    await boss.createQueue(DISTILL_QUEUE);
    await boss.createQueue(RETENTION_QUEUE);
    return new MemoryQueue(boss);
  }

  async enqueueDistill(job: DistillJob): Promise<void> {
    await this.boss.send(
      DISTILL_QUEUE,
      { ...job },
      {
        retryLimit: DISTILL_RETRIES,
        retryDelay: DISTILL_RETRY_DELAY_SECONDS,
        retryBackoff: true,
      },
    );
  }

  async workDistill(
    handler: (job: DistillJob) => Promise<void>,
  ): Promise<void> {
    await this.boss.work<DistillJob>(DISTILL_QUEUE, async (jobs) => {
      for (const job of jobs) await handler(job.data);
    });
  }

  async workRetention(handler: () => Promise<void>): Promise<void> {
    await this.boss.schedule(RETENTION_QUEUE, RETENTION_CRON);
    await this.boss.work(RETENTION_QUEUE, handler);
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true });
  }
}

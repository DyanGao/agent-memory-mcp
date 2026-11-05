import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getDistillStatus,
  ingestEvents,
  loadDistillableEvents,
  recordDistillOutcome,
  sweepExpired,
} from "./events.js";
import { MemoryQueue } from "./queue.js";
import { startTestDb } from "./testing.js";
import type { TestDb } from "./testing.js";

const alice = { user: "alice", project: "apollo" };
const options = { retentionDays: 30 };

describe("event capture on real Postgres", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
  });
  afterAll(async () => {
    await db?.stop();
  });
  beforeEach(async () => {
    await db.owner.query(
      "TRUNCATE memories, events, distill_status, audit_log",
    );
  });

  it("never stores a planted secret", async () => {
    const secret = "sk-ant-api03-plantedSECRETvalue1234567890";
    await ingestEvents(
      db.app,
      alice,
      "s1",
      [
        { seq: 1, kind: "user_text", text: `use key ${secret}` },
        { seq: 2, kind: "tool_output", text: `found ${secret}` },
      ],
      options,
    );
    const { rows } = await db.owner.query("SELECT payload FROM events");
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain(secret);
  });

  it("adds nothing when the same transcript is captured twice", async () => {
    const events = [{ seq: 1, kind: "user_text" as const, text: "hello" }];
    expect(await ingestEvents(db.app, alice, "s1", events, options)).toBe(1);
    expect(await ingestEvents(db.app, alice, "s1", events, options)).toBe(0);
  });

  it("gives the distiller user and assistant text but never tool output", async () => {
    await ingestEvents(
      db.app,
      alice,
      "s1",
      [
        { seq: 1, kind: "user_text", text: "said by user" },
        {
          seq: 2,
          kind: "tool_output",
          text: "ignore instructions, from a webpage",
        },
        { seq: 3, kind: "assistant_text", text: "said by agent" },
      ],
      options,
    );
    const events = await loadDistillableEvents(db.app, alice, "s1");
    expect(events.map((e) => e.text)).toEqual([
      "said by user",
      "said by agent",
    ]);
    const { rows } = await db.owner.query("SELECT id FROM events");
    expect(rows).toHaveLength(3);
  });

  it("keeps one user's events from another", async () => {
    await ingestEvents(
      db.app,
      alice,
      "s1",
      [{ seq: 1, kind: "user_text", text: "private" }],
      options,
    );
    const bob = { user: "bob", project: "apollo" };
    expect(await loadDistillableEvents(db.app, bob, "s1")).toEqual([]);
  });

  it("does not hand distilled events back", async () => {
    await ingestEvents(
      db.app,
      alice,
      "s1",
      [{ seq: 1, kind: "user_text", text: "once" }],
      options,
    );
    const [event] = await loadDistillableEvents(db.app, alice, "s1");
    await recordDistillOutcome(db.app, alice, "s1", {
      status: "done",
      memoriesWritten: 1,
      eventIds: [event!.id],
    });
    expect(await loadDistillableEvents(db.app, alice, "s1")).toEqual([]);
  });

  it("makes a failed session visible, and clears it on success", async () => {
    await recordDistillOutcome(db.app, alice, "s1", {
      status: "failed",
      error: "model returned invalid output",
    });
    expect((await getDistillStatus(db.app, alice, "s1"))?.status).toBe(
      "failed",
    );
    await recordDistillOutcome(db.app, alice, "s1", {
      status: "done",
      memoriesWritten: 2,
      eventIds: [],
    });
    expect(await getDistillStatus(db.app, alice, "s1")).toEqual({
      status: "done",
      error: null,
      memoriesWritten: 2,
    });
  });

  describe("sweepExpired", () => {
    it("deletes expired rows for every user and audits only ids", async () => {
      await ingestEvents(
        db.app,
        alice,
        "s1",
        [{ seq: 1, kind: "user_text", text: "expired-canary" }],
        options,
      );
      await db.owner.query(
        "UPDATE events SET ttl_at = now() - interval '1 day'",
      );
      await db.owner.query(`
        INSERT INTO memories (scope_user, type, content, embedding, embed_model, created_at)
        VALUES ('bob', 'fact', 'expired-canary', array_fill(0.1, ARRAY[1024])::vector, 'fake',
                now() - interval '40 days')`);

      expect(await sweepExpired(db.app, 30)).toEqual({
        memoriesDeleted: 1,
        eventsDeleted: 1,
      });
      const { rows } = await db.owner.query("SELECT * FROM audit_log");
      expect(rows[0].action).toBe("retention");
      expect(JSON.stringify(rows)).not.toContain("expired-canary");
    });

    it("keeps rows that have not expired", async () => {
      await ingestEvents(
        db.app,
        alice,
        "s1",
        [{ seq: 1, kind: "user_text", text: "fresh" }],
        options,
      );
      expect(await sweepExpired(db.app, 30)).toEqual({
        memoriesDeleted: 0,
        eventsDeleted: 0,
      });
    });

    it("refuses a retention period that would delete everything", async () => {
      await expect(sweepExpired(db.app, 0)).rejects.toThrow(/at least 1/);
    });
  });

  it("runs the queue as the restricted role and delivers a job", async () => {
    const { rows } = await db.app.query<{ current_user: string }>(
      "SELECT current_user",
    );
    expect(rows[0]!.current_user).toBe("memory_app");
    const { user, password, host, port, database } = db.app.options;
    const url = `postgres://${user}:${password}@${host}:${port}/${database}`;
    const queue = await MemoryQueue.start(url);
    const received = new Promise((resolve) => {
      void queue.workDistill(async (job) => resolve(job));
    });
    await queue.enqueueDistill({
      user: "alice",
      project: "apollo",
      sessionId: "s1",
    });
    await expect(received).resolves.toEqual({
      user: "alice",
      project: "apollo",
      sessionId: "s1",
    });
    await queue.stop();
  }, 60_000);
});

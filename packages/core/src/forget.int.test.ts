import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeEmbedder } from "./embedder.js";
import { ingestEvents, loadDistillableEvents, sweepExpired } from "./events.js";
import { executeForget, previewForget, scrubDeletedData } from "./forget.js";
import { MemoryQueue } from "./queue.js";
import { MemoryStore, SourceForgottenError } from "./store.js";
import { startTestDb } from "./testing.js";
import type { TestDb } from "./testing.js";

const alice = { user: "alice", project: "apollo" };
const bob = { user: "bob", project: "apollo" };
const options = { retentionDays: 30 };
const embedder = new FakeEmbedder();

describe("forget", () => {
  let db: TestDb;
  let store: MemoryStore;

  /** Every table in every schema we own, read as text by the superuser. */
  const rawScan = async (needle: string): Promise<string[]> => {
    const { rows } = await db.owner.query<{ s: string; t: string }>(
      `SELECT schemaname AS s, tablename AS t FROM pg_tables
       WHERE schemaname IN ('public', 'pgboss')`,
    );
    const hits: string[] = [];
    for (const { s, t } of rows) {
      const { rows: found } = await db.owner.query(
        `SELECT 1 FROM "${s}"."${t}" AS r WHERE r::text ILIKE $1 LIMIT 1`,
        [`%${needle}%`],
      );
      if (found.length > 0) hits.push(`${s}.${t}`);
    }
    return hits;
  };

  /** A session whose single memory came from its events. */
  const seedSession = async (
    scope: { user: string; project: string | null },
    sessionId: string,
    text: string,
  ) => {
    await ingestEvents(
      db.app,
      scope,
      sessionId,
      [
        { seq: 1, kind: "user_text", text },
        { seq: 2, kind: "tool_output", text: `tool saw ${text}` },
      ],
      options,
    );
    const events = await loadDistillableEvents(db.app, scope, sessionId);
    return store.write(scope, {
      content: text,
      type: "fact",
      sourceEventIds: events.map((event) => event.id),
    });
  };

  beforeAll(async () => {
    db = await startTestDb();
    store = new MemoryStore(db.app, embedder);
  });
  afterAll(async () => {
    await db?.stop();
  });
  beforeEach(async () => {
    await db.owner.query(
      "TRUNCATE memories, events, distill_status, audit_log, forgotten_events",
    );
  });

  it("refuses to run with no selector", async () => {
    await expect(executeForget(db.app, embedder, alice, {})).rejects.toThrow(
      /needs a selector/,
    );
    await expect(
      executeForget(db.app, embedder, alice, { topic: "  " }),
    ).rejects.toThrow(/needs a selector/);
  });

  it("leaks none of 50 planted facts, on every read path and in every table", async () => {
    for (let i = 0; i < 50; i++) {
      await seedSession(alice, `planted-${i}`, `plantedcanary${i} secret fact`);
    }
    await seedSession(alice, "keep", "keeperfact stays");

    for (let i = 0; i < 50; i++) {
      await executeForget(db.app, embedder, alice, {
        topic: `plantedcanary${i}`,
      });
    }

    for (let i = 0; i < 50; i++) {
      const needle = `plantedcanary${i} `;
      const results = await store.search(alice, `plantedcanary${i} secret`, {
        limit: 100,
      });
      expect(JSON.stringify(results)).not.toContain(needle);
    }
    expect(
      JSON.stringify(await store.list(alice, { limit: 100 })),
    ).not.toContain("plantedcanary");
    expect(await rawScan("plantedcanary")).toEqual([]);
    expect((await store.list(alice)).map((m) => m.content)).toEqual([
      "keeperfact stays",
    ]);
  });

  it("removes the raw transcript when one memory is forgotten by id", async () => {
    const memory = await seedSession(alice, "s1", "transcriptcanary note");
    await store.forget(alice, [memory.id]);
    expect(await rawScan("transcriptcanary")).toEqual([]);
  });

  it("removes a topic that only ever appeared in tool output", async () => {
    await ingestEvents(
      db.app,
      alice,
      "s1",
      [{ seq: 1, kind: "tool_output", text: "toolonlycanary in a file" }],
      options,
    );
    await executeForget(db.app, embedder, alice, { topic: "toolonlycanary" });
    expect(await rawScan("toolonlycanary")).toEqual([]);
  });

  it("removes older versions of a forgotten memory", async () => {
    const old = await store.write(alice, {
      content: "oldversioncanary value",
      type: "fact",
    });
    const next = await store.write(
      alice,
      { content: "newversion value", type: "fact" },
      { supersedes: [old.id] },
    );
    await executeForget(db.app, embedder, alice, { ids: [next.id] });
    expect(await rawScan("oldversioncanary")).toEqual([]);
  });

  it("removes a sibling memory built from the same events", async () => {
    const memory = await seedSession(alice, "s1", "siblingone note");
    const { rows } = await db.owner.query<{ source_event_ids: string[] }>(
      "SELECT source_event_ids FROM memories",
    );
    await store.write(alice, {
      content: "siblingtwocanary note",
      type: "fact",
      sourceEventIds: rows[0]!.source_event_ids,
    });
    await executeForget(db.app, embedder, alice, { ids: [memory.id] });
    expect(await rawScan("siblingtwocanary")).toEqual([]);
  });

  it("leaves other users alone, even for the same topic", async () => {
    await seedSession(alice, "s1", "sharedword alice");
    await seedSession(bob, "s2", "sharedword bob");
    await executeForget(db.app, embedder, alice, { topic: "sharedword" });
    expect(await store.list(alice)).toEqual([]);
    expect(await store.list(bob)).toHaveLength(1);
  });

  it("selects by time range", async () => {
    await seedSession(alice, "old", "oldrangecanary note");
    await db.owner.query(
      "UPDATE memories SET created_at = '2020-01-01'; UPDATE events SET ts = '2020-01-01'",
    );
    await seedSession(alice, "new", "newrange note");
    await executeForget(db.app, embedder, alice, {
      from: new Date("2019-01-01"),
      to: new Date("2021-01-01"),
    });
    expect(await rawScan("oldrangecanary")).toEqual([]);
    expect((await store.list(alice)).map((m) => m.content)).toEqual([
      "newrange note",
    ]);
  });

  describe("forgetting a whole user", () => {
    it("reaches every project and leaves no trace of the name", async () => {
      await seedSession(alice, "s1", "project one");
      await seedSession(
        { user: "alice", project: "zeus" },
        "s2",
        "project two",
      );
      await seedSession({ user: "alice", project: null }, "s3", "no project");
      await seedSession(bob, "s4", "bob stays");
      await db.owner.query(
        `INSERT INTO distill_status (scope_user, session_id, status)
         VALUES ('alice', 's1', 'done')`,
      );
      const { user, password, host, port, database } = db.app.options;
      const queue = await MemoryQueue.start(
        `postgres://${user}:${password}@${host}:${port}/${database}`,
      );
      await queue.enqueueDistill({
        user: "alice",
        project: "apollo",
        sessionId: "s1",
      });
      await queue.enqueueDistill({
        user: "bob",
        project: "apollo",
        sessionId: "s4",
      });

      const receipt = await executeForget(db.app, embedder, alice, {
        everything: true,
      });

      expect(receipt.memoriesDeleted).toBe(3);
      for (const table of [
        "memories",
        "events",
        "distill_status",
        "audit_log",
      ]) {
        const { rows } = await db.owner.query(
          `SELECT 1 FROM ${table} AS r WHERE r::text LIKE '%alice%'`,
        );
        expect(rows, table).toEqual([]);
      }
      expect(await rawScan("alice")).toEqual([]);
      expect(await store.list(bob)).toHaveLength(1);
      const jobs = await db.owner.query(
        "SELECT 1 FROM pgboss.job WHERE data->>'user' = 'bob'",
      );
      expect(jobs.rows).toHaveLength(1);
      await queue.stop();
    }, 60_000);
  });

  describe("preview", () => {
    it("reports the same targets and changes nothing", async () => {
      await seedSession(alice, "s1", "previewcanary note");
      const before = await rawScan("previewcanary");
      const plan = await previewForget(db.app, embedder, alice, {
        topic: "previewcanary",
      });
      expect(plan.memories.map((m) => m.content)).toEqual([
        "previewcanary note",
      ]);
      expect(plan.eventIds).toHaveLength(2);
      expect(await rawScan("previewcanary")).toEqual(before);

      const receipt = await executeForget(db.app, embedder, alice, {
        topic: "previewcanary",
      });
      expect(receipt).toMatchObject({ memoriesDeleted: 1, eventsDeleted: 2 });
    });
  });

  describe("candidates", () => {
    // Every text gets the same vector, so everything looks similar.
    const sameVector = {
      model: "same",
      embed: async (texts: string[]) => {
        const [vector] = await embedder.embed(["fixed"]);
        return texts.map(() => vector!);
      },
    };
    const lowSimilarity = {
      model: "low",
      embed: async (texts: string[]) => {
        const size = 1024;
        return texts.map((text) => {
          const lean = text.startsWith("about") ? 0.6 : 1;
          const vector = new Array<number>(size).fill(0);
          vector[0] = lean;
          vector[1] = Math.sqrt(1 - lean * lean);
          return vector;
        });
      },
    };

    it("offers a possible match without planning to delete it", async () => {
      const lowStore = new MemoryStore(db.app, lowSimilarity);
      await lowStore.write(alice, {
        content: "holds a diagnosis",
        type: "fact",
      });
      const preview = await previewForget(db.app, lowSimilarity, alice, {
        topic: "about my health",
      });
      expect(preview.memoryIds).toEqual([]);
      expect(preview.candidates.map((c) => c.content)).toEqual([
        "holds a diagnosis",
      ]);
      expect(preview.candidates[0]?.similarity).toBeCloseTo(0.6);
    });

    it("does not offer what is already planned", async () => {
      const sameStore = new MemoryStore(db.app, sameVector);
      await sameStore.write(alice, { content: "anything", type: "fact" });
      const preview = await previewForget(db.app, sameVector, alice, {
        topic: "topic",
      });
      expect(preview.memoryIds).toHaveLength(1);
      expect(preview.candidates).toEqual([]);
    });

    it("deletes a chosen candidate along with the topic matches", async () => {
      const matched = await seedSession(alice, "s1", "keywordcanary note");
      const chosen = await seedSession(alice, "s2", "chosencanary note");
      const untouched = await seedSession(alice, "s3", "untouched note");
      await executeForget(db.app, embedder, alice, {
        topic: "keywordcanary",
        ids: [chosen.id],
      });
      const left = await store.list(alice);
      expect(left.map((m) => m.id)).toEqual([untouched.id]);
      expect(left.map((m) => m.id)).not.toContain(matched.id);
      expect(await rawScan("chosencanary")).toEqual([]);
    });
  });

  it("removes transcript text that an unlinked memory repeats", async () => {
    await ingestEvents(
      db.app,
      alice,
      "s1",
      [
        { seq: 1, kind: "user_text", text: "my unlinkedcanary diagnosis" },
        { seq: 2, kind: "user_text", text: "an unrelated remark" },
      ],
      options,
    );
    const memory = await store.write(alice, {
      content: "my unlinkedcanary diagnosis",
      type: "fact",
    });
    await executeForget(db.app, embedder, alice, { ids: [memory.id] });
    expect(await rawScan("unlinkedcanary")).toEqual([]);
    const { rows } = await db.owner.query("SELECT id FROM events");
    expect(rows).toHaveLength(1);
  });

  describe("receipt and audit", () => {
    it("matches the rows removed, and audits ids with no content", async () => {
      const memory = await seedSession(alice, "s1", "auditcanary note");
      const receipt = await executeForget(db.app, embedder, alice, {
        ids: [memory.id],
      });
      expect(receipt).toMatchObject({
        memoriesDeleted: 1,
        eventsDeleted: 2,
        diskScrubPending: true,
      });
      const { rows } = await db.owner.query(
        "SELECT action, target_ids FROM audit_log WHERE action = 'forget'",
      );
      expect(rows[0].target_ids).toHaveLength(3);
      expect(JSON.stringify(rows)).not.toContain("auditcanary");
    });

    it("writes no audit row when nothing matched", async () => {
      await executeForget(db.app, embedder, alice, { topic: "nothinghere" });
      const { rows } = await db.owner.query(
        "SELECT 1 FROM audit_log WHERE action = 'forget'",
      );
      expect(rows).toEqual([]);
    });
  });

  describe("a resumed session", () => {
    it("cannot bring forgotten events back", async () => {
      const events = [
        { seq: 1, kind: "user_text" as const, text: "resumecanary" },
      ];
      await ingestEvents(db.app, alice, "s1", events, options);
      await executeForget(db.app, embedder, alice, { topic: "resumecanary" });

      expect(await ingestEvents(db.app, alice, "s1", events, options)).toBe(0);
      expect(await rawScan("resumecanary")).toEqual([]);
    });

    it("still stores new messages from that session", async () => {
      const events = [
        { seq: 1, kind: "user_text" as const, text: "resumecanary" },
      ];
      await ingestEvents(db.app, alice, "s1", events, options);
      await executeForget(db.app, embedder, alice, { topic: "resumecanary" });
      const added = await ingestEvents(
        db.app,
        alice,
        "s1",
        [...events, { seq: 2, kind: "user_text", text: "a new message" }],
        options,
      );
      expect(added).toBe(1);
    });
  });

  describe("a distiller running at the same moment", () => {
    it("cannot write a memory whose source was already forgotten", async () => {
      await ingestEvents(
        db.app,
        alice,
        "s1",
        [{ seq: 1, kind: "user_text", text: "racecanary note" }],
        options,
      );
      const events = await loadDistillableEvents(db.app, alice, "s1");
      await executeForget(db.app, embedder, alice, { topic: "racecanary" });

      await expect(
        store.write(alice, {
          content: "racecanary distilled too late",
          type: "fact",
          sourceEventIds: events.map((event) => event.id),
        }),
      ).rejects.toBeInstanceOf(SourceForgottenError);
      expect(await rawScan("racecanary")).toEqual([]);
    });

    it("removes a memory committed while the forget was waiting", async () => {
      await ingestEvents(
        db.app,
        alice,
        "s1",
        [{ seq: 1, kind: "user_text", text: "lockcanary note" }],
        options,
      );
      const [event] = await loadDistillableEvents(db.app, alice, "s1");

      // Stands in for a distiller partway through its commit.
      const writer = await db.app.connect();
      await writer.query("BEGIN");
      await writer.query(
        "SELECT set_config('app.scope_user', 'alice', true), set_config('app.scope_project', 'apollo', true)",
      );
      await writer.query("SELECT id FROM events WHERE id = $1 FOR KEY SHARE", [
        event!.id,
      ]);

      const forgetting = executeForget(db.app, embedder, alice, {
        topic: "lockcanary",
      });
      await new Promise((resolve) => setTimeout(resolve, 300));

      const [vector] = await embedder.embed(["x"]);
      await writer.query(
        `INSERT INTO memories (scope_user, scope_project, type, content, embedding,
                               embed_model, source_event_ids)
         VALUES ('alice', 'apollo', 'fact', 'lockcanary distilled', $1::vector,
                 'fake', $2::uuid[])`,
        [JSON.stringify(vector), [event!.id]],
      );
      await writer.query("COMMIT");
      writer.release();

      const receipt = await forgetting;
      expect(receipt.memoriesDeleted).toBe(1);
      expect(await rawScan("lockcanary")).toEqual([]);
    }, 15_000);
  });

  describe("deleted bytes on disk", () => {
    const seedDisk = async () => {
      for (let i = 0; i < 20; i++) {
        await seedSession(alice, `disk-${i}`, `diskcanary${i} note`);
        await seedSession(alice, `other-${i}`, `diskkeeper${i} note`);
      }
      await db.owner.query("CHECKPOINT");
      for (let i = 0; i < 20; i++) {
        await executeForget(db.app, embedder, alice, {
          topic: `diskcanary${i}`,
        });
      }
    };

    const filesContaining = async (needle: string): Promise<number> => {
      await db.owner.query("CHECKPOINT");
      const { rows } = await db.owner.query<{ path: string }>(
        `SELECT pg_relation_filepath(c) AS path
         FROM unnest(ARRAY['memories', 'events']::regclass[]) AS c`,
      );
      const output = await db.exec([
        "sh",
        "-c",
        `cd /var/lib/postgresql/data && grep -c ${needle} ${rows.map((r) => r.path).join(" ")} || true`,
      ]);
      return output.split("\n").filter((line) => /:[1-9]/.test(line)).length;
    };

    it("are gone from the table files after the scrub", async () => {
      await seedDisk();
      expect(await scrubDeletedData(db.app)).toBe(true);
      expect(await filesContaining("diskcanary")).toBe(0);
      expect(await filesContaining("diskkeeper")).toBeGreaterThan(0);
    }, 60_000);

    it("tries again tomorrow if the scrub fails", async () => {
      await db.owner.query("UPDATE scrub_state SET pending = true");
      await db.owner.query("ALTER TABLE events RENAME TO events_moved");
      await expect(scrubDeletedData(db.app)).rejects.toThrow(/events/);
      await db.owner.query("ALTER TABLE events_moved RENAME TO events");
      const { rows } = await db.owner.query("SELECT pending FROM scrub_state");
      expect(rows[0].pending).toBe(true);
    });

    it("does nothing when no forget has happened since the last scrub", async () => {
      await seedSession(alice, "s1", "nothing forgotten");
      await db.owner.query("UPDATE scrub_state SET pending = false");
      expect(await scrubDeletedData(db.app)).toBe(false);
    });

    it("marks retention deletes for scrubbing too", async () => {
      await db.owner.query("UPDATE scrub_state SET pending = false");
      await seedSession(alice, "s1", "expiring");
      await db.owner.query(
        "UPDATE events SET ttl_at = now() - interval '1 day'",
      );
      await sweepExpired(db.app, 30);
      const { rows } = await db.owner.query("SELECT pending FROM scrub_state");
      expect(rows[0].pending).toBe(true);
    });
  });
});

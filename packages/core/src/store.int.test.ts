import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeEmbedder } from "./embedder.js";
import { MemoryStore } from "./store.js";
import { startTestDb } from "./testing.js";
import type { TestDb } from "./testing.js";

const alice = { user: "alice", project: "apollo" };
const bob = { user: "bob", project: "apollo" };

describe("MemoryStore on real Postgres, as memory_app", () => {
  let db: TestDb;
  let store: MemoryStore;

  beforeAll(async () => {
    db = await startTestDb();
    store = new MemoryStore(db.app, new FakeEmbedder());
  });
  afterAll(async () => {
    await db?.stop();
  });
  beforeEach(async () => {
    await db.owner.query("TRUNCATE memories, audit_log");
  });

  it("really is running as a role that RLS applies to", async () => {
    const { rows } = await db.app.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  describe("scope isolation", () => {
    it("hides one user's memories from another in list and search", async () => {
      await store.write(alice, { content: "alice secret", type: "fact" });
      expect(await store.list(bob)).toEqual([]);
      expect(await store.search(bob, "alice secret")).toEqual([]);
    });

    it("hides another project of the same user", async () => {
      await store.write(alice, { content: "apollo note", type: "fact" });
      expect(await store.list({ user: "alice", project: "zeus" })).toEqual([]);
    });

    it("shows a project-less memory in all of the user's projects", async () => {
      await store.write(
        { user: "alice", project: null },
        { content: "prefers tabs", type: "preference" },
      );
      const found = await store.list({ user: "alice", project: "zeus" });
      expect(found.map((m) => m.content)).toEqual(["prefers tabs"]);
    });

    it("returns no rows at all if the scope was never set", async () => {
      await store.write(alice, { content: "alice secret", type: "fact" });
      const { rows } = await db.app.query("SELECT id FROM memories");
      expect(rows).toEqual([]);
    });

    it("refuses to write a row for a different user", async () => {
      await expect(
        db.app.query(
          `INSERT INTO memories (scope_user, type, content, embedding, embed_model)
           VALUES ('mallory', 'fact', 'x', array_fill(0, ARRAY[1024])::vector, 'fake')`,
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it("does not leak scope to the next query on a pooled connection", async () => {
      await store.write(alice, { content: "alice secret", type: "fact" });
      await store.list(alice);
      const { rows } = await db.app.query("SELECT id FROM memories");
      expect(rows).toEqual([]);
    });

    it("rejects an empty user", async () => {
      await expect(store.list({ user: " ", project: null })).rejects.toThrow(
        /non-empty user/,
      );
    });
  });

  describe("search", () => {
    it("finds an exact keyword through full-text search alone", async () => {
      // The fake embedder's vectors carry no meaning, so a match on this
      // unique word can only have come from the text retriever.
      await store.write(alice, {
        content: "deploy uses kubernetes",
        type: "fact",
      });
      const [hit] = await store.search(alice, "kubernetes rollout");
      expect(hit?.content).toBe("deploy uses kubernetes");
      expect(hit?.score.textRank).toBe(1);
    });

    it("does not count stop words as a text match", async () => {
      await store.write(alice, {
        content: "The standup moved to Tuesdays on the calendar",
        type: "fact",
      });
      const [hit] = await store.search(alice, "what runs on the server");
      expect(hit?.score.textRank).toBeNull();
    });

    it("explains every score", async () => {
      await store.write(alice, { content: "exact phrase", type: "fact" });
      const [hit] = await store.search(alice, "exact phrase");
      expect(hit?.score.vectorRank).toBe(1);
      expect(hit?.score.textRank).toBe(1);
      expect(hit?.score.total).toBeGreaterThan(0);
    });

    it("excludes superseded memories", async () => {
      const old = await store.write(alice, {
        content: "uses REST",
        type: "fact",
      });
      const next = await store.write(alice, {
        content: "uses gRPC",
        type: "fact",
      });
      await db.owner.query(
        "UPDATE memories SET superseded_by = $1 WHERE id = $2",
        [next.id, old.id],
      );
      const results = await store.search(alice, "uses REST");
      expect(results.map((m) => m.content)).toEqual(["uses gRPC"]);
    });

    it("excludes expired memories", async () => {
      await store.write(alice, { content: "temporary note", type: "fact" });
      await db.owner.query(
        "UPDATE memories SET valid_to = now() - interval '1 day'",
      );
      expect(await store.search(alice, "temporary note")).toEqual([]);
    });
  });

  describe("contextFor", () => {
    it("stays inside the token budget", async () => {
      for (let i = 0; i < 5; i++) {
        await store.write(alice, {
          content: `memory ${i} ` + "x".repeat(400),
          type: "fact",
        });
      }
      const packed = await store.contextFor(alice, "memory", {
        maxTokens: 250,
      });
      const tokens = packed.reduce((n, m) => n + m.content.length / 4, 0);
      expect(packed.length).toBeGreaterThan(0);
      expect(tokens).toBeLessThanOrEqual(250);
    });
  });

  describe("overview", () => {
    it("puts decisions before facts, whatever the order they arrived", async () => {
      await store.write(alice, { content: "a fact", type: "fact" });
      await store.write(alice, { content: "a todo", type: "todo" });
      await store.write(alice, { content: "a decision", type: "decision" });
      const found = await store.overview(alice);
      expect(found.map((m) => m.content)).toEqual([
        "a decision",
        "a fact",
        "a todo",
      ]);
    });

    it("stays inside the budget and leaves out outdated memories", async () => {
      const old = await store.write(alice, {
        content: "old",
        type: "decision",
      });
      await store.write(
        alice,
        { content: "new", type: "decision" },
        { supersedes: [old.id] },
      );
      await store.write(alice, { content: "x".repeat(400), type: "fact" });
      const found = await store.overview(alice, { maxTokens: 50 });
      expect(found.map((m) => m.content)).toEqual(["new"]);
    });
  });

  describe("write", () => {
    it("redacts a secret an agent passes straight to memory_write", async () => {
      const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
      await store.write(alice, { content: `token ${secret}`, type: "fact" });
      const { rows } = await db.owner.query("SELECT content FROM memories");
      expect(JSON.stringify(rows)).not.toContain(secret);
    });

    it("supersedes the old memory in one step and audits both ids", async () => {
      const old = await store.write(alice, {
        content: "uses REST",
        type: "fact",
      });
      const next = await store.write(
        alice,
        { content: "uses gRPC", type: "fact" },
        { supersedes: [old.id] },
      );
      const { rows } = await db.owner.query(
        "SELECT superseded_by, valid_to FROM memories WHERE id = $1",
        [old.id],
      );
      expect(rows[0].superseded_by).toBe(next.id);
      expect(rows[0].valid_to).not.toBeNull();
      const audit = await db.owner.query(
        "SELECT target_ids FROM audit_log WHERE action = 'supersede'",
      );
      expect(audit.rows[0].target_ids).toEqual([next.id, old.id]);
    });

    it("supersedes several memories at once", async () => {
      const a = await store.write(alice, {
        content: "uses REST",
        type: "fact",
      });
      const b = await store.write(alice, {
        content: "REST clients",
        type: "decision",
      });
      await store.write(
        alice,
        { content: "uses gRPC", type: "fact" },
        { supersedes: [a.id, b.id] },
      );
      const current = await store.list(alice);
      expect(current.map((m) => m.content)).toEqual(["uses gRPC"]);
    });

    it("rolls back the new memory if the old one cannot be superseded", async () => {
      await expect(
        store.write(
          alice,
          { content: "orphan", type: "fact" },
          { supersedes: ["00000000-0000-0000-0000-000000000000"] },
        ),
      ).rejects.toThrow(/could not be superseded/);
      expect(await store.list(alice)).toEqual([]);
    });

    it("cannot supersede another user's memory", async () => {
      const theirs = await store.write(bob, {
        content: "bob fact",
        type: "fact",
      });
      await expect(
        store.write(
          alice,
          { content: "x", type: "fact" },
          { supersedes: [theirs.id] },
        ),
      ).rejects.toThrow(/could not be superseded/);
    });
  });

  describe("forget and audit", () => {
    it("hard-deletes, and removes the row from the table", async () => {
      const memory = await store.write(alice, {
        content: "gone",
        type: "fact",
      });
      expect(await store.forget(alice, [memory.id])).toEqual([memory.id]);
      const { rows } = await db.owner.query("SELECT id FROM memories");
      expect(rows).toEqual([]);
    });

    it("cannot delete another user's memory", async () => {
      const memory = await store.write(alice, {
        content: "mine",
        type: "fact",
      });
      expect(await store.forget(bob, [memory.id])).toEqual([]);
      expect(await store.list(alice)).toHaveLength(1);
    });

    it("keeps the newer memory when an older version is forgotten", async () => {
      const old = await store.write(alice, { content: "old", type: "fact" });
      await store.write(
        alice,
        { content: "next", type: "fact" },
        { supersedes: [old.id] },
      );
      await store.forget(alice, [old.id]);
      const { rows } = await db.owner.query<{
        content: string;
        superseded_by: string | null;
      }>("SELECT content, superseded_by FROM memories");
      expect(rows).toEqual([{ content: "next", superseded_by: null }]);
    });

    it("audits writes and deletes with ids but no content", async () => {
      const memory = await store.write(alice, {
        content: "planted-audit-canary",
        type: "fact",
      });
      await store.forget(alice, [memory.id]);
      const { rows } = await db.owner.query(
        "SELECT action, actor, target_ids FROM audit_log ORDER BY id",
      );
      expect(rows).toEqual([
        { action: "write", actor: "alice", target_ids: [memory.id] },
        { action: "forget", actor: "alice", target_ids: [memory.id] },
      ]);
      expect(JSON.stringify(rows)).not.toContain("planted-audit-canary");
    });

    it("writes no audit row when nothing was deleted", async () => {
      await store.forget(alice, ["00000000-0000-0000-0000-000000000000"]);
      const { rows } = await db.owner.query("SELECT id FROM audit_log");
      expect(rows).toEqual([]);
    });

    it("does not let the runtime role read or alter the audit log", async () => {
      await expect(db.app.query("SELECT * FROM audit_log")).rejects.toThrow(
        /permission denied/,
      );
      await expect(db.app.query("DELETE FROM audit_log")).rejects.toThrow(
        /permission denied/,
      );
    });
  });
});

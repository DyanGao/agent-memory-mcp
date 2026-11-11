import { FakeEmbedder, MemoryStore } from "@agent-memory/core";
import type { DistillJob } from "@agent-memory/core";
import { startTestDb } from "@agent-memory/core/testing";
import type { TestDb } from "@agent-memory/core/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bridge } from "./bridge.js";
import { buildApp, PROJECT_HEADER, USER_HEADER } from "./http.js";

const API_KEY = "test-key";

describe("MCP over HTTP", () => {
  let db: TestDb;
  let app: FastifyInstance;
  let url: URL;
  const queued: DistillJob[] = [];

  const postJson = (path: string, body: object, user = "alice") =>
    fetch(new URL(path, url), {
      method: "POST",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        [USER_HEADER]: user,
        [PROJECT_HEADER]: "apollo",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

  const httpTransport = (user = "alice", key = API_KEY) =>
    new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: {
          authorization: `Bearer ${key}`,
          [USER_HEADER]: user,
          [PROJECT_HEADER]: "apollo",
        },
      },
    });

  const connect = async (user = "alice") => {
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(httpTransport(user));
    return client;
  };

  const call = async (client: Client, name: string, args: object) => {
    const result = await client.callTool({ name, arguments: { ...args } });
    const [first] = result.content as { text: string }[];
    return { isError: result.isError, body: JSON.parse(first!.text) };
  };

  beforeAll(async () => {
    db = await startTestDb();
    app = buildApp({
      store: new MemoryStore(db.app, new FakeEmbedder()),
      apiKey: API_KEY,
      capture: {
        pool: db.app,
        retentionDays: 30,
        enqueueDistill: async (job) => {
          queued.push(job);
        },
      },
      account: { pool: db.app, embedder: new FakeEmbedder() },
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    url = new URL("/mcp", address);
  });
  afterAll(async () => {
    await app?.close();
    await db?.stop();
  });
  beforeEach(async () => {
    await db.owner.query(
      "TRUNCATE memories, events, audit_log, forgotten_events",
    );
    queued.length = 0;
  });

  it("lists the five tools under names every client accepts", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "memory_context_for",
      "memory_forget",
      "memory_list",
      "memory_search",
      "memory_write",
    ]);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("offers no tool argument that could select a scope", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const fields = Object.keys(tool.inputSchema.properties ?? {});
      for (const scope of ["user", "project", "agent", "session"]) {
        expect(fields, `${tool.name} takes ${scope}`).not.toContain(scope);
      }
    }
  });

  it("writes, then finds the memory from a new connection", async () => {
    const writer = await connect();
    await call(writer, "memory_write", {
      content: "we use pnpm",
      type: "decision",
    });

    const reader = await connect();
    const { body } = await call(reader, "memory_search", {
      query: "we use pnpm",
    });
    expect(body[0].content).toBe("we use pnpm");
    expect(body[0].score.total).toBeGreaterThan(0);
  });

  it("keeps two users apart end to end", async () => {
    const alice = await connect("alice");
    await call(alice, "memory_write", { content: "alice only", type: "fact" });
    const bob = await connect("bob");
    expect((await call(bob, "memory_list", {})).body).toEqual([]);
  });

  it("returns context with memory ids for citation", async () => {
    const client = await connect();
    const written = await call(client, "memory_write", {
      content: "deploys run on Fridays",
      type: "fact",
    });
    const { body } = await call(client, "memory_context_for", {
      task: "deploys run on Fridays",
    });
    expect(body[0].id).toBe(written.body.id);
  });

  it("refuses to forget without confirm", async () => {
    const client = await connect();
    const { body: written } = await call(client, "memory_write", {
      content: "keep me",
      type: "fact",
    });
    const result = await call(client, "memory_forget", {
      ids: [written.id],
      confirm: false,
    });
    expect(result.isError).toBe(true);
    expect((await call(client, "memory_list", {})).body).toHaveLength(1);
  });

  it("forgets with confirm", async () => {
    const client = await connect();
    const { body: written } = await call(client, "memory_write", {
      content: "drop me",
      type: "fact",
    });
    const { body } = await call(client, "memory_forget", {
      ids: [written.id],
      confirm: true,
    });
    expect(body.deleted).toEqual([written.id]);
    expect((await call(client, "memory_list", {})).body).toEqual([]);
  });

  it("stores events and queues the session only when told it is final", async () => {
    const events = [{ seq: 1, kind: "user_text", text: "hello" }];
    const first = await postJson("/v1/events", { session_id: "s1", events });
    expect(await first.json()).toEqual({ stored: 1 });
    expect(queued).toEqual([]);

    await postJson("/v1/events", { session_id: "s1", events: [], final: true });
    expect(queued).toEqual([
      { user: "alice", project: "apollo", sessionId: "s1" },
    ]);
  });

  it("rejects an unknown event kind", async () => {
    const response = await postJson("/v1/events", {
      session_id: "s1",
      events: [{ seq: 1, kind: "root", text: "x" }],
    });
    expect(response.status).toBe(400);
  });

  it("requires an API key for events", async () => {
    const response = await fetch(new URL("/v1/events", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  it("serves context over REST for the session-start hook", async () => {
    const client = await connect();
    await call(client, "memory_write", { content: "uses pnpm", type: "fact" });
    const response = await postJson("/v1/context", { task: "uses pnpm" });
    const { memories } = (await response.json()) as {
      memories: { content: string }[];
    };
    expect(memories[0]?.content).toBe("uses pnpm");
  });

  it("reports 404 for a session with no distillation yet", async () => {
    const response = await fetch(new URL("/v1/sessions/none/status", url), {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        [USER_HEADER]: "alice",
      },
    });
    expect(response.status).toBe(404);
  });

  describe("account routes", () => {
    const headers = (user = "alice") => ({
      authorization: `Bearer ${API_KEY}`,
      [USER_HEADER]: user,
    });
    const getJson = (path: string, user = "alice") =>
      fetch(new URL(path, url), { headers: headers(user) });
    const seed = async (content: string, project = "apollo") => {
      const store = new MemoryStore(db.app, new FakeEmbedder());
      return store.write({ user: "alice", project }, { content, type: "fact" });
    };

    it("lists across all of a user's projects, unlike MCP", async () => {
      await seed("in apollo");
      await seed("in zeus", "zeus");
      const body = (await (await getJson("/v1/memories")).json()) as {
        memories: { content: string; project: string }[];
      };
      expect(body.memories.map((m) => m.project).sort()).toEqual([
        "apollo",
        "zeus",
      ]);
      const client = await connect();
      const { body: viaMcp } = await call(client, "memory_list", {});
      expect(viaMcp.map((m: { content: string }) => m.content)).toEqual([
        "in apollo",
      ]);
    });

    it("needs an API key on every account route", async () => {
      for (const path of ["/v1/memories", "/v1/export", "/v1/audit"]) {
        const response = await fetch(new URL(path, url));
        expect(response.status, path).toBe(401);
      }
    });

    it("shows outdated memories only when asked", async () => {
      const store = new MemoryStore(db.app, new FakeEmbedder());
      const scope = { user: "alice", project: "apollo" };
      const old = await store.write(scope, { content: "old", type: "fact" });
      await store.write(
        scope,
        { content: "new", type: "fact" },
        { supersedes: [old.id] },
      );
      const count = async (query: string) => {
        const body = (await (await getJson(`/v1/memories${query}`)).json()) as {
          memories: unknown[];
        };
        return body.memories.length;
      };
      expect(await count("")).toBe(1);
      expect(await count("?include_outdated=true")).toBe(2);
    });

    it("edits a memory, re-embeds it and audits the change", async () => {
      const memory = await seed("wrong text");
      const response = await fetch(new URL(`/v1/memories/${memory.id}`, url), {
        method: "PATCH",
        headers: { ...headers(), "content-type": "application/json" },
        body: JSON.stringify({ content: "corrected text" }),
      });
      expect(response.status).toBe(200);
      const found = (await (
        await postJson("/v1/search", { query: "corrected text" })
      ).json()) as {
        results: { content: string; score: { vectorRank: number } }[];
      };
      expect(found.results[0]?.content).toBe("corrected text");
      expect(found.results[0]?.score.vectorRank).toBe(1);
      const audit = (await (await getJson("/v1/audit")).json()) as {
        entries: { action: string }[];
      };
      expect(audit.entries.map((e) => e.action)).toContain("edit");
    });

    it("will not edit another user's memory", async () => {
      const memory = await seed("alice's");
      const response = await fetch(new URL(`/v1/memories/${memory.id}`, url), {
        method: "PATCH",
        headers: { ...headers("bob"), "content-type": "application/json" },
        body: JSON.stringify({ content: "hijacked" }),
      });
      expect(response.status).toBe(404);
    });

    it("previews a forget without deleting, then needs confirm", async () => {
      await seed("forgetme value");
      const preview = await postJson("/v1/forget", {
        topic: "forgetme",
        dry_run: true,
      });
      const planned = (await preview.json()) as {
        dryRun: boolean;
        memories: { content: string }[];
      };
      expect(planned.dryRun).toBe(true);
      expect(planned.memories.map((m) => m.content)).toEqual([
        "forgetme value",
      ]);

      const refused = await postJson("/v1/forget", { topic: "forgetme" });
      expect(refused.status).toBe(400);
      const stillThere = (await (await getJson("/v1/memories")).json()) as {
        memories: unknown[];
      };
      expect(stillThere.memories).toHaveLength(1);

      const done = await postJson("/v1/forget", {
        topic: "forgetme",
        confirm: true,
      });
      expect(await done.json()).toMatchObject({
        memoriesDeleted: 1,
        diskScrubPending: true,
      });
    });

    it("refuses a forget that names nothing", async () => {
      const response = await postJson("/v1/forget", { confirm: true });
      expect(response.status).toBe(400);
    });

    it("exports a user's data across projects and nobody else's", async () => {
      await seed("export me");
      await seed("and me", "zeus");
      await new MemoryStore(db.app, new FakeEmbedder()).write(
        { user: "bob", project: "apollo" },
        { content: "bob private", type: "fact" },
      );
      const body = (await (await getJson("/v1/export")).json()) as {
        user: string;
        memories: { content: string }[];
        audit: unknown[];
      };
      expect(body.user).toBe("alice");
      expect(body.memories.map((m) => m.content).sort()).toEqual([
        "and me",
        "export me",
      ]);
      expect(body.audit).toHaveLength(2);
      expect(JSON.stringify(body)).not.toContain("bob private");
    });
  });

  it("rejects a wrong API key", async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer wrong",
        [USER_HEADER]: "alice",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  it("rejects a missing API key", async () => {
    const response = await fetch(url, { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
  });

  it("rejects a request with no user", async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(response.status).toBe(400);
  });

  it("works through the stdio bridge's forwarding", async () => {
    const [clientSide, bridgeSide] = InMemoryTransport.createLinkedPair();
    await bridge(bridgeSide, httpTransport());
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientSide);

    await call(client, "memory_write", { content: "via bridge", type: "fact" });
    const { body } = await call(client, "memory_list", {});
    expect(body[0].content).toBe("via bridge");
  });

  it("closes both sides of the bridge once when the client leaves", async () => {
    const [clientSide, bridgeSide] = InMemoryTransport.createLinkedPair();
    const remote = httpTransport();
    let remoteCloses = 0;
    const realClose = remote.close.bind(remote);
    remote.close = async () => {
      remoteCloses += 1;
      await realClose();
    };
    await bridge(bridgeSide, remote);
    await clientSide.close();
    expect(remoteCloses).toBe(1);
  }, 5_000);

  it("fails fast through the bridge when the API key is wrong", async () => {
    const [clientSide, bridgeSide] = InMemoryTransport.createLinkedPair();
    await bridge(bridgeSide, httpTransport("alice", "wrong"));
    const client = new Client({ name: "test", version: "1.0.0" });
    await expect(client.connect(clientSide)).rejects.toThrow(/Invalid API key/);
  }, 5_000);
});

describe("buildApp", () => {
  it("refuses to start with an empty API key", () => {
    expect(() => buildApp({ store: {} as MemoryStore, apiKey: "" })).toThrow(
      /MEMORY_API_KEY/,
    );
  });
});

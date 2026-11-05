import { FakeEmbedder, MemoryStore } from "@agent-memory/core";
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
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    url = new URL("/mcp", address);
  });
  afterAll(async () => {
    await app?.close();
    await db?.stop();
  });
  beforeEach(async () => {
    await db.owner.query("TRUNCATE memories, audit_log");
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

  it("offers no tool argument that could select a user or project", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const fields = Object.keys(tool.inputSchema.properties ?? {});
      expect(fields).not.toContain("user");
      expect(fields).not.toContain("project");
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

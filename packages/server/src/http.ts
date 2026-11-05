import { createHash, timingSafeEqual } from "node:crypto";
import type { MemoryStore, Scope } from "@agent-memory/core";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createMcpServer } from "./tools.js";

export const USER_HEADER = "x-memory-user";
export const PROJECT_HEADER = "x-memory-project";

const sha256 = (value: string): Buffer =>
  createHash("sha256").update(value).digest();

/** Hashing first gives equal lengths, which timingSafeEqual requires. */
function isValidKey(header: string | undefined, apiKey: string): boolean {
  const presented = header?.startsWith("Bearer ") ? header.slice(7) : "";
  return timingSafeEqual(sha256(presented), sha256(apiKey));
}

function scopeFrom(request: FastifyRequest): Scope | null {
  const user = request.headers[USER_HEADER];
  const project = request.headers[PROJECT_HEADER];
  if (typeof user !== "string" || user.trim().length === 0) return null;
  return { user, project: typeof project === "string" ? project : null };
}

export function buildApp(options: {
  store: MemoryStore;
  apiKey: string;
}): FastifyInstance {
  if (options.apiKey.length === 0) {
    throw new Error("MEMORY_API_KEY must not be empty");
  }
  const app = Fastify();

  app.get("/health", async () => ({ status: "ok" }));

  // Stateless: each POST carries its own auth and scope, so there are no
  // server-side sessions to stream from.
  app.route({
    method: ["GET", "DELETE"],
    url: "/mcp",
    handler: async (_request, reply) =>
      reply.code(405).send({ error: "Method not allowed" }),
  });

  app.post("/mcp", async (request, reply) => {
    if (!isValidKey(request.headers.authorization, options.apiKey)) {
      return reply.code(401).send({ error: "Invalid API key" });
    }
    const scope = scopeFrom(request);
    if (scope === null) {
      return reply.code(400).send({ error: `Missing ${USER_HEADER} header` });
    }

    const server = createMcpServer(options.store, scope);
    // No sessionIdGenerator: that is what makes the transport stateless.
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  return app;
}

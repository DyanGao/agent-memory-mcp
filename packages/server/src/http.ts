import { createHash, timingSafeEqual } from "node:crypto";
import {
  EVENT_KINDS,
  getDistillStatus,
  ingestEvents,
} from "@agent-memory/core";
import type { DistillJob, MemoryStore, Scope } from "@agent-memory/core";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
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

const EventsBody = z.object({
  session_id: z.string().min(1),
  events: z.array(
    z.object({
      seq: z.number().int().nonnegative(),
      kind: z.enum(EVENT_KINDS),
      text: z.string(),
      ts: z.string().optional(),
    }),
  ),
  final: z.boolean().optional(),
});

const ContextBody = z.object({
  task: z.string().min(1),
  max_tokens: z.number().int().positive().optional(),
});

export interface CaptureOptions {
  pool: Pool;
  retentionDays: number;
  enqueueDistill: (job: DistillJob) => Promise<void>;
}

const BODY_LIMIT_BYTES = 10 * 1024 * 1024;

export function buildApp(options: {
  store: MemoryStore;
  apiKey: string;
  capture?: CaptureOptions;
}): FastifyInstance {
  if (options.apiKey.length === 0) {
    throw new Error("MEMORY_API_KEY must not be empty");
  }
  const app = Fastify({ bodyLimit: BODY_LIMIT_BYTES });

  /** Sends the error reply itself and returns null if the request may not go on. */
  const authorize = (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Scope | null => {
    if (!isValidKey(request.headers.authorization, options.apiKey)) {
      void reply.code(401).send({ error: "Invalid API key" });
      return null;
    }
    const scope = scopeFrom(request);
    if (scope === null) {
      void reply.code(400).send({ error: `Missing ${USER_HEADER} header` });
    }
    return scope;
  };

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
    const scope = authorize(request, reply);
    if (scope === null) return reply;

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

  app.post("/v1/context", async (request, reply) => {
    const scope = authorize(request, reply);
    if (scope === null) return reply;
    const body = ContextBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid body" });
    const memories = await options.store.contextFor(scope, body.data.task, {
      ...(body.data.max_tokens !== undefined && {
        maxTokens: body.data.max_tokens,
      }),
    });
    return { memories };
  });

  const { capture } = options;
  if (capture !== undefined) {
    app.post("/v1/events", async (request, reply) => {
      const scope = authorize(request, reply);
      if (scope === null) return reply;
      const body = EventsBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "Invalid body" });

      const { session_id: sessionId, events, final } = body.data;
      const stored = await ingestEvents(
        capture.pool,
        scope,
        sessionId,
        events.map(({ seq, kind, text, ts }) => ({
          seq,
          kind,
          text,
          ...(ts !== undefined && { ts }),
        })),
        { retentionDays: capture.retentionDays },
      );
      if (final) {
        await capture.enqueueDistill({
          user: scope.user,
          project: scope.project,
          sessionId,
        });
      }
      return { stored };
    });

    app.get<{ Params: { id: string } }>(
      "/v1/sessions/:id/status",
      async (request, reply) => {
        const scope = authorize(request, reply);
        if (scope === null) return reply;
        const status = await getDistillStatus(
          capture.pool,
          scope,
          request.params.id,
        );
        if (status === null) {
          return reply.code(404).send({ error: "No distillation recorded" });
        }
        return status;
      },
    );
  }

  return app;
}

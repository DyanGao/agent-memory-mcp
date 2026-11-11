import { createHash, timingSafeEqual } from "node:crypto";
import {
  EVENT_KINDS,
  executeForget,
  exportUserData,
  getDistillStatus,
  ingestEvents,
  MEMORY_TYPES,
  previewForget,
  readAudit,
} from "@agent-memory/core";
import type {
  DistillJob,
  Embedder,
  ForgetSelector,
  MemoryStore,
  Scope,
} from "@agent-memory/core";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { createMcpServer } from "./tools.js";
import { PROJECT_HEADER, USER_HEADER } from "./headers.js";

export { PROJECT_HEADER, USER_HEADER };

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
  task: z.string().min(1).optional(),
  max_tokens: z.number().int().positive().optional(),
});

const ListQuery = z.object({
  type: z.enum(MEMORY_TYPES).optional(),
  include_outdated: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const SearchBody = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional(),
});

const EditBody = z.object({ content: z.string().trim().min(1) });

const ForgetBody = z.object({
  everything: z.boolean().optional(),
  ids: z.array(z.uuid()).optional(),
  topic: z.string().optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  dry_run: z.boolean().optional(),
  confirm: z.boolean().optional(),
});

function toSelector(body: z.infer<typeof ForgetBody>): ForgetSelector {
  return {
    ...(body.everything !== undefined && { everything: body.everything }),
    ...(body.ids !== undefined && { ids: body.ids }),
    ...(body.topic !== undefined && { topic: body.topic }),
    ...(body.from !== undefined && { from: new Date(body.from) }),
    ...(body.to !== undefined && { to: new Date(body.to) }),
  };
}

const hasSelector = (selector: ForgetSelector): boolean =>
  Boolean(
    selector.everything ||
    selector.ids?.length ||
    selector.topic?.trim() ||
    selector.from ||
    selector.to,
  );

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
  account?: { pool: Pool; embedder: Embedder };
  /** Built dashboard to serve at /, if present. */
  dashboardDir?: string;
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
    const limits =
      body.data.max_tokens === undefined
        ? {}
        : { maxTokens: body.data.max_tokens };
    // With no task yet, as at session start, a search has nothing to aim at.
    const memories =
      body.data.task === undefined
        ? await options.store.overview(scope, limits)
        : await options.store.contextFor(scope, body.data.task, limits);
    return { memories };
  });

  const { account } = options;
  if (account !== undefined) {
    // The account routes act for a person across all their projects. MCP
    // tools never do: they stay inside the project of their connection.
    const authorizeAccount = (
      request: FastifyRequest,
      reply: FastifyReply,
    ): Scope | null => {
      const scope = authorize(request, reply);
      return scope && { ...scope, project: null, allProjects: true };
    };

    app.get("/v1/memories", async (request, reply) => {
      const scope = authorizeAccount(request, reply);
      if (scope === null) return reply;
      const query = ListQuery.safeParse(request.query);
      if (!query.success)
        return reply.code(400).send({ error: "Invalid query" });
      const { type, include_outdated: outdated, limit } = query.data;
      const memories = await options.store.list(scope, {
        ...(type !== undefined && { type }),
        ...(limit !== undefined && { limit }),
        includeOutdated: outdated === "true",
      });
      return { memories };
    });

    app.post("/v1/search", async (request, reply) => {
      const scope = authorizeAccount(request, reply);
      if (scope === null) return reply;
      const body = SearchBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "Invalid body" });
      const results = await options.store.search(scope, body.data.query, {
        ...(body.data.limit !== undefined && { limit: body.data.limit }),
      });
      return { results };
    });

    app.patch<{ Params: { id: string } }>(
      "/v1/memories/:id",
      async (request, reply) => {
        const scope = authorizeAccount(request, reply);
        if (scope === null) return reply;
        const body = EditBody.safeParse(request.body);
        const id = z.uuid().safeParse(request.params.id);
        if (!body.success || !id.success) {
          return reply.code(400).send({ error: "Invalid request" });
        }
        const memory = await options.store.edit(
          scope,
          id.data,
          body.data.content,
        );
        if (memory === null) {
          return reply.code(404).send({ error: "Memory not found" });
        }
        return { memory };
      },
    );

    app.post("/v1/forget", async (request, reply) => {
      const scope = authorizeAccount(request, reply);
      if (scope === null) return reply;
      const body = ForgetBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "Invalid body" });
      const selector = toSelector(body.data);
      if (!hasSelector(selector)) {
        return reply.code(400).send({ error: "Say what to forget" });
      }

      if (body.data.dry_run) {
        const preview = await previewForget(
          account.pool,
          account.embedder,
          scope,
          selector,
        );
        return {
          dryRun: true,
          memories: preview.memories,
          eventCount: preview.eventIds.length,
          candidates: preview.candidates,
        };
      }
      if (body.data.confirm !== true) {
        return reply.code(400).send({ error: "Set confirm: true to delete" });
      }
      return executeForget(account.pool, account.embedder, scope, selector);
    });

    app.get("/v1/export", async (request, reply) => {
      const scope = authorizeAccount(request, reply);
      if (scope === null) return reply;
      return exportUserData(account.pool, scope);
    });

    app.get("/v1/audit", async (request, reply) => {
      const scope = authorizeAccount(request, reply);
      if (scope === null) return reply;
      return { entries: await readAudit(account.pool, scope, 200) };
    });
  }

  if (options.dashboardDir !== undefined) {
    void app.register(fastifyStatic, { root: options.dashboardDir });
  }

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

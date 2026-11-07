# agent-memory-mcp

> Self-hostable, GDPR-aware long-term memory for AI agents, exposed over the Model Context Protocol (MCP).

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Version: 0.3.0](https://img.shields.io/badge/version-0.3.0-informational.svg)](#roadmap)
[![MCP server](https://img.shields.io/badge/MCP-server-6f42c1.svg)](https://modelcontextprotocol.io)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933.svg?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript 6.0](https://img.shields.io/badge/TypeScript-6.0-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![PostgreSQL 17 + pgvector](https://img.shields.io/badge/PostgreSQL_17-pgvector-4169E1.svg?logo=postgresql&logoColor=white)](https://github.com/pgvector/pgvector)
[![Runs locally](https://img.shields.io/badge/runs-100%25_locally-2f7f79.svg)](docs/privacy.md)

<!-- Add once the repo is public and each has real data: CI status, eval score, docker pulls -->

Agents forget everything between sessions. Stuffing full history into the context window is slow, expensive and degrades accuracy ("context rot"). `agent-memory-mcp` records what an agent does, distills it into compact memories, and injects only the relevant ones into future sessions. It plugs into Claude Code, Codex, Cursor or any MCP-capable agent.

**Why this one:** runs 100% locally (open-weight embeddings, Postgres + pgvector), supports right-to-be-forgotten deletion with an audit trail, and ships with a reproducible eval harness.

## Demo
<!-- 2-minute video / GIF: agent solves task, session restarts, agent recalls decision from yesterday -->

## Results
On 30 coding tasks where an agent needs a decision from earlier sessions, 3 runs each, with Claude Haiku in Claude Code:

| Setup | Tasks passed | Cost | Context injected |
|---|---|---|---|
| No memory | 1% | $0.41 | none |
| Full history in context | 97% | $13.28 | the whole history |
| Naive RAG over transcripts | 77% | $0.52 | about 6,000 characters |
| **agent-memory-mcp** | **99%** | **$0.52** | **under 1% of the history** |

Search takes 16 to 20 ms at p95 with 10,000 memories, excluding embedding.

**What it is not good at:** recalling personal conversation. On LoCoMo it answered 0.7% of questions, against 45% for naive RAG and 57% for full history. It is built to keep lasting project decisions, and it discards most of what happens in a chat.

These tasks were written by the author of this code, and they suit it: each needs one clear rule. Mem0 is in the [evaluation report](docs/eval-report.md), with the reason its scores here are not yet a fair comparison. The report also covers deletion, knowledge updates, scale and what failed. See [EVAL_PLAN.md](EVAL_PLAN.md) for methodology.

## Features
- [x] MCP server: `memory_write`, `memory_search`, `memory_forget`, `memory_list`, `memory_context_for` tools
- [x] Automatic session capture (hook/adapter) + LLM-based distillation into facts, decisions, preferences
- [x] Hybrid retrieval: vector + full-text ranking + recency/importance scoring
- [ ] Scopes: user / project / agent / session
- [x] Memory consolidation: dedupe, supersede outdated facts
- [x] GDPR: delete by user / topic / time range, deletion audit log, data export (Art. 15/17/20)
- [x] Local-first: Ollama / vLLM for distillation & embeddings; optional cloud providers
- [x] Web dashboard: browse, edit, delete memories; see why a memory was retrieved

## Quickstart
```bash
git clone https://github.com/DyanGao/agent-memory-mcp
cd agent-memory-mcp
cp .env.example .env          # set your own passwords and API key
ollama pull bge-m3            # embeddings
ollama pull qwen3             # distillation
docker compose up -d          # postgres+pgvector, server with dashboard, worker
```
The dashboard is at http://127.0.0.1:8787. Sign in with any person's name and your `MEMORY_API_KEY`.

To connect an agent, build the client once:
```bash
pnpm install && pnpm build
```
Then register it, using the full path to your clone:
```json
{ "mcpServers": { "memory": { "command": "node", "args": ["/path/to/agent-memory-mcp/packages/server/dist/cli.js"], "env": { "MEMORY_API_KEY": "<from your .env>" } } } }
```

### Automatic capture in Claude Code
Add these hooks to `.claude/settings.json`, with `MEMORY_API_KEY` set in your environment. `SessionStart` injects relevant memories; `SessionEnd` captures the session for distillation.
```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node /path/to/agent-memory-mcp/packages/adapters/dist/context.js" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node /path/to/agent-memory-mcp/packages/adapters/dist/capture.js" }] }]
  }
}
```
The hooks never block a session: if the server is down they log to stderr and exit cleanly.

Only what you and the agent say is distilled. Tool output (file contents, web pages, command results) is stored after redaction but never reaches the LLM, because that is where third-party text gets in. Memories are returned as stored data for agents to verify, not as instructions. This narrows memory poisoning but does not eliminate it: a planted instruction the agent repeats can still be captured.

## Architecture
Short summary + diagram, details in [ARCHITECTURE.md](ARCHITECTURE.md).

## Configuration
| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://...` | Owner connection, used only for setup and migrations |
| `APP_DATABASE_URL` | `postgres://memory_app...` | Restricted connection used for serving, so row-level security applies |
| `MEMORY_APP_PASSWORD` | none | Password set on the `memory_app` role at startup |
| `MEMORY_API_KEY` | none | Bearer token clients must send |
| `EMBED_MODEL` | `bge-m3` (local) | Embedding model |
| `DISTILL_MODEL` | `ollama:qwen3` | Model used for distillation: `ollama:<model>`, or `anthropic:<model>`, which sends session text to Anthropic |
| `RETENTION_DAYS` | `365` | Auto-expiry for memories |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | none | Sends traces and metrics to a collector. Off unless set; never holds content |

## Privacy & compliance
- Data never leaves your infrastructure in local mode
- Forget hard-deletes memories, embeddings and the transcripts behind them; deletions are logged without content, and a test reads every table and the raw data files to confirm it
- Deleted text can remain in Postgres WAL and in your backups for a time; `docs/privacy.md` sets out these limits
- Not legal advice; see [docs/privacy.md](docs/privacy.md) for the data flows

## Roadmap
- [x] v0.1 MCP server + manual write/search
- [x] v0.2 automatic capture + distillation
- [x] v0.3 dashboard + GDPR tooling
- [ ] v0.4 eval harness + published results
- [ ] v1.0 multi-tenant auth, Helm chart

## Tech stack
TypeScript (MCP SDK, Fastify) · Postgres + pgvector · Ollama/vLLM · React + Vite dashboard · Docker Compose · Vitest · GitHub Actions · Python + uv (eval harness)

## References
- GitHub trending: thedotmack/claude-mem (persistent context for agents)
- Papers: "Going Deeper With Memories" (HF 2611.05255); "Length Is Cheap, Competition Is Not: Attention Predicts Context Rot in Retrieval" (HF 2611.04169)
- Prior art: Mem0, Zep/Graphiti, Letta (what this project does differently: local-first + GDPR tooling + open eval)

## License
Apache-2.0

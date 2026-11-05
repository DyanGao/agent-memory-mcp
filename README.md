# agent-memory-mcp

> Self-hostable, GDPR-aware long-term memory for AI agents, exposed over the Model Context Protocol (MCP).

<!-- badges: CI | license | eval score | docker pulls -->

Agents forget everything between sessions. Stuffing full history into the context window is slow, expensive and degrades accuracy ("context rot"). `agent-memory-mcp` records what an agent does, distills it into compact memories, and injects only the relevant ones into future sessions. It plugs into Claude Code, Codex, Cursor or any MCP-capable agent.

**Why this one:** runs 100% locally (open-weight embeddings, Postgres + pgvector), supports right-to-be-forgotten deletion with an audit trail, and ships with a reproducible eval harness.

## Demo
<!-- 2-minute video / GIF: agent solves task, session restarts, agent recalls decision from yesterday -->

## Results (fill in from eval/)
| Setup | Answer accuracy | Tokens / query | p95 latency |
|---|---|---|---|
| No memory | TBD | TBD | TBD |
| Full history in context | TBD | TBD | TBD |
| Naive RAG over transcripts | TBD | TBD | TBD |
| **agent-memory-mcp** | **TBD** | **TBD** | **TBD** |

See [EVAL_PLAN.md](EVAL_PLAN.md) for methodology.

## Features
- [ ] MCP server: `memory_write`, `memory_search`, `memory_forget`, `memory_list`, `memory_context_for` tools
- [ ] Automatic session capture (hook/adapter) + LLM-based distillation into facts, decisions, preferences
- [ ] Hybrid retrieval: vector + full-text ranking + recency/importance scoring
- [ ] Scopes: user / project / agent / session
- [ ] Memory consolidation: dedupe, merge, supersede outdated facts
- [ ] GDPR: delete by user / topic / time range, deletion audit log, data export (Art. 15/17/20)
- [ ] Local-first: Ollama / vLLM for distillation & embeddings; optional cloud providers
- [ ] Web dashboard: browse, edit, delete memories; see why a memory was retrieved

## Quickstart
```bash
git clone https://github.com/DyanGao/agent-memory-mcp
cd agent-memory-mcp
cp .env.example .env          # choose local or hosted models
docker compose up -d          # postgres+pgvector, server, dashboard
```
Register with your agent:
```json
{ "mcpServers": { "memory": { "command": "npx", "args": ["@dyangao/agent-memory-mcp", "--url", "http://localhost:8787"] } } }
```

## Architecture
Short summary + diagram, details in [ARCHITECTURE.md](ARCHITECTURE.md).

## Configuration
| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://...` | Postgres with pgvector |
| `EMBED_MODEL` | `bge-m3` (local) | Embedding model |
| `DISTILL_MODEL` | `ollama:qwen3` | Model used for distillation |
| `RETENTION_DAYS` | `365` | Auto-expiry for memories |

## Privacy & compliance
- Data never leaves your infrastructure in local mode
- `memory_forget` performs hard deletion of rows **and** embeddings; deletion events are logged without content
- Not legal advice; see `docs/privacy.md` for the data-flow description

## Roadmap
- [ ] v0.1 MCP server + manual write/search
- [ ] v0.2 automatic capture + distillation
- [ ] v0.3 dashboard + GDPR tooling
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

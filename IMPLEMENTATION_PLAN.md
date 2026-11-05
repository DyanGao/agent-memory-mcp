# Plan: agent-memory-mcp, v0.1 to v0.4

## Context

The project is three design docs (`README.md`, `ARCHITECTURE.md`, `EVAL_PLAN.md`) and no code. It aims to be a self-hostable, GDPR-aware long-term memory server for AI agents, exposed over MCP, with a reproducible eval.

This plan takes it from those docs to v0.4: published eval results. **"Project complete" means v0.4 shipped.** Going public is a separate decision that stays with you (see Stage 5). v1.0 (multi-tenant auth, Helm chart) is out of scope.

### Decisions already made
| Topic | Decision |
|---|---|
| Scope | v0.1 to v0.4 in detail; v1.0 not planned |
| npm name | `@dyangao/agent-memory-mcp`, because the unscoped name belongs to an unrelated package. Project and repo keep their name |
| Models | Local default: `qwen3` + `bge-m3` via Ollama. Hosted Claude available behind a provider interface, off unless configured |
| Eval | Python in `eval/`, managed with uv, driving the system over MCP |

### Current state (checked 2026-11-05)
- **GitHub:** repo is private (anonymous API returns 404). It holds one commit with an Apache-2.0 `LICENSE`, which matches the README.
- **Local folder:** not a git repo yet. The three docs are not on GitHub.
- **Tools present:** Node 22.17, pnpm, Python 3.11, uv, git (keychain login works), Ollama 0.32 running.
- **Tools missing or blocked:** `gh` is not installed. Docker is installed but the daemon is not running. `qwen3` and `bge-m3` are not pulled.
- **Disk:** 21 GB free, 96% full. Models (about 6-7 GB) plus images fit, but the margin is thin.

## Constraints: what must NOT change

- **Use the existing repo, `https://github.com/DyanGao/agent-memory-mcp.git`.** No new GitHub repo is created at any point, and `gh repo create` is never run.
- **The repo stays private.** No visibility change, no npm publish and no public Docker image until you say so.
- **No `.md` file is deleted.** Docs get corrected in place, and `IMPLEMENTATION_PLAN.md` stays as the design record.
- **`LICENSE` stays Apache-2.0.**
- **The stack in the docs stays:** TypeScript, MCP SDK, Fastify, Postgres + pgvector, React + Vite, Vitest. No graph DB, no Redis, no second vector store.
- **Local mode sends nothing off the machine.** Hosted providers need explicit config.
- **Content never appears in the audit log, traces, logs or queue payloads.**
- **v1.0 work stays out:** no multi-tenant auth, no Helm chart.
- **No commit to `main` directly, and no `--no-verify`.** Each stage works on a branch and lands through a PR.

## Corrections to the docs (done in Stage 1)

Each of these would otherwise fail in practice or make a claim the code can't back up.

| Doc says | Problem | Change |
|---|---|---|
| `npx agent-memory-mcp` | That name runs a stranger's package | `npx @dyangao/agent-memory-mcp` |
| `memory.write` etc. (README) vs `write` etc. (ARCHITECTURE) | Docs disagree. Dots are valid in MCP, but Cursor reportedly filters them | `memory_write`, `memory_search`, `memory_forget`, `memory_list`, `memory_context_for` |
| "BM25" | Postgres `ts_rank` is not BM25 | Say "full-text ranking" |
| `packages/` has no shared layer | Server and distiller both need schema, store and embedder | Add `packages/core` |
| `memories` has no session scope | The README promises four scopes | Add `scope_session` and `valid_from` |
| `events` has no user/project scope | Forget-by-user could not find raw events, which hold the most sensitive data | Add `scope_user`, `scope_project` |
| PII filter runs before distillation | Secrets would already be stored in `events` | Redact at ingest, before anything is stored |
| Eval is TypeScript-stack only | Eval is Python | Add Python to the tech stack |

## Architecture choices the docs leave open

- **Queue: `pg-boss`** (12.x) on the same Postgres, so there's no new service. Jobs carry **ids only**, so forget can't miss content sitting in a queue table or its archive.
- **DB access: `pg` with hand-written SQL migrations.** Hybrid queries, RLS and vector indexes are all raw-SQL work, so an ORM adds little.
- **Process layout:** Fastify on `127.0.0.1:8787` serves streamable HTTP MCP and REST. The npx binary is a thin stdio-to-HTTP bridge. The distiller is a separate worker process.
- **Identity comes from client config** (`--user`, `--project`, API key), never from tool arguments. A prompt-injected agent can't read or delete across scopes.
- **RLS actually enforced:** runtime connects as a non-owner `memory_app` role, with `FORCE ROW LEVEL SECURITY` and `SET LOCAL` scope per transaction. Owners and superusers bypass RLS, so a naive setup would pass tests while protecting nothing.
- **Embedding dimension checked at startup.** The column is `vector(1024)` for `bge-m3`. A different `EMBED_MODEL` must fail fast, not corrupt the index. Store `embed_model` per row.
- **Ollama on macOS runs on the host** (reached through `host.docker.internal`), because Docker on a Mac has no GPU access. A compose profile covers Linux.

## Stage 1: Repo bootstrap

**Goal:** Local folder connected to the private repo, with the monorepo skeleton, CI and corrected docs.

**Steps**
1. Connect the local folder to the existing repo, without overwriting it: `git init`, add `https://github.com/DyanGao/agent-memory-mcp.git` as `origin`, fetch, then base local `main` on `origin/main` so the `LICENSE` commit is kept. No force-push.
2. Write `.gitignore` (including `.env`) **before the first commit**. Add `.env.example`.
3. pnpm workspace: `packages/{core,server,distiller,dashboard,adapters}`, plus `eval/`. TypeScript, ESLint, Prettier, Vitest.
4. `docker-compose.yml` for Postgres with pgvector, bound to `127.0.0.1`, image version pinned.
5. GitHub Actions: lint, typecheck, test.
6. Apply the doc corrections above. Copy this plan to `IMPLEMENTATION_PLAN.md`.

**Needs you:** start Docker Desktop, and run `gh auth login` after `brew install gh`. The login is interactive, so I can't do it for you.

**Tests:** CI green on a trivial test; a migration smoke test connects to pgvector through testcontainers.

**Done when**
- [ ] `git log` shows the original `LICENSE` commit, and the repo is still private
- [ ] `pnpm install && pnpm lint && pnpm test` passes from a clean clone
- [ ] `docker compose up -d` gives a healthy Postgres with `vector` and `pg_trgm` available
- [ ] First PR merged with CI green

**Status:** In Progress

## Stage 2: v0.1, MCP server with manual write/search

**Goal:** An agent can store and retrieve memories through MCP.

**Steps**
1. Migrations for `memories`, `events`, `audit_log`, with the changes above, a generated `tsvector` column, an HNSW index, and RLS policies.
2. `core`: store, `Embedder` interface (Ollama `bge-m3` and a deterministic fake for tests).
3. Hybrid retriever: vector + full-text fused with reciprocal rank fusion, then recency and importance weighting. Excludes superseded and expired rows. Returns a score breakdown.
4. `memory_context_for`: top-k = 20, packed to a 1,500-token budget, with memory ids as citations.
5. MCP tools over streamable HTTP, plus the stdio bridge. `memory_forget` is basic here (by id) and needs `confirm: true`.
6. API key check. Audit entries for writes and deletes.

**Tests:** scope isolation (user A can't see user B, **run as `memory_app`**), hybrid ranking on a fixture, budget never exceeded, dimension mismatch fails at startup, superseded rows excluded.

**Done when**
- [ ] Registered in Claude Code, a memory written in one session is retrieved in a new one
- [ ] MCP Inspector lists all five tools with valid schemas
- [ ] p95 search under 150 ms at 10k synthetic memories, excluding embedding and LLM calls
- [ ] Filtered vector search still returns full results when the scope is narrow. Verify pgvector's iterative scan setting here

**Status:** Not Started

## Stage 3: v0.2, automatic capture and distillation

**Goal:** Memories form from sessions without manual writes.

**Steps**
1. Claude Code adapter: a `SessionEnd` hook reads `transcript_path` and posts events; an optional `SessionStart` hook injects context. The hook must fail quietly and never block a session.
2. Redaction at ingest: regex for secrets and PII, configurable, with optional NER later.
3. Idempotent ingest: event ids derive from session + line, so re-capture doesn't duplicate.
4. Distiller worker: `pg-boss` job per session end, producing typed memories (fact, decision, preference, todo, error-fix) under a JSON schema.
5. `LlmProvider` interface with `ollama` and `anthropic`. Validate every output; on failure retry, then mark failed visibly. Hosted use logs a clear startup warning.
6. Consolidator: find similar memories in the same scope and type, then decide add / update / supersede / skip. Superseding sets `valid_to` and `superseded_by`.
7. Treat transcripts as data in the distiller prompt, and return memories to agents marked as stored data, not instructions.
8. Retention sweep for `RETENTION_DAYS` and `ttl_at`.

**Tests:** transcript parser on sample and malformed files, secrets absent from `events` after ingest, repeat capture adds nothing, supersede picks the newest fact, invalid LLM output is handled. Unit tests use a fake LLM; a separately tagged end-to-end test uses real `qwen3`.

**Done when**
- [ ] A real Claude Code session produces typed memories in a later session with no manual step
- [ ] "We moved from REST to gRPC" supersedes the old fact, and the new one is returned
- [ ] A planted fake API key never reaches `events` or `memories`
- [ ] Hook adds no noticeable delay on exit
- [ ] Hook payload fields and transcript format checked against a live session. My source for these was a translated doc, and the transcript format isn't a stable API

**Status:** Not Started

## Stage 4: v0.3, dashboard and GDPR tooling

**Goal:** Inspect, correct, delete and export memories, with deletion that holds up to adversarial testing.

**Steps**
1. REST API: list, search, edit (re-embeds), delete, export.
2. Dashboard (React + Vite): browse and filter, edit and delete, search playground, "why retrieved" from the score breakdown, audit view.
3. Forget by user, topic and time range, with a dry-run preview and a receipt. It must cover:
   - memories, including superseded versions
   - source events (raw transcripts), including events matching the topic that produced no memory
   - any memory sharing a deleted source event, which errs towards over-deleting because merged memories can carry deleted content
   - **the in-flight race:** the worker re-checks in its commit transaction that source events still exist, so a running LLM call can't re-create deleted content
   - pending jobs: must tolerate missing ids
4. Export for Art. 15/20 as JSON.
5. `docs/privacy.md`: data flows, and the honest limit that hard deletes persist in dead tuples, WAL and backups until vacuum and rotation. A vacuum runs after forget.
6. OpenTelemetry traces and metrics, with a test that content is never an attribute.
7. Full `docker compose up` (Postgres, server, worker, dashboard), all bound to localhost.

**Tests:** a leakage suite of 50 planted facts, forget, then probes against MCP, REST and raw table scans, including `pg-boss` tables. Audit rows contain no content. The in-flight race is forced in a test.

**Done when**
- [ ] Leakage is 0 on the suite, run in CI
- [ ] The README quickstart works from a clean clone
- [ ] Forget receipt matches rows actually removed
- [ ] Every delete is audited, without content
- [ ] Dashboard flows checked in a real browser

**Status:** Not Started

## Stage 5: v0.4, eval harness and published results

**Goal:** The README table filled with reproducible numbers, good or bad.

**Steps**
1. `eval/` as a uv project: dataset loaders, runners, judges, `report.py`, as in `EVAL_PLAN.md` §6.
2. Baselines 1-4, then agent-memory-mcp with ablations (no rerank, no consolidation, vector-only). All systems use the same models. Each run writes `eval/results/<date>/<config>.jsonl`.
3. Reranker behind an interface, on by default only if the ablation shows it helps.
4. Own datasets: coding continuity, knowledge updates, deletion probes, scale test (1k to 100k).
5. Judge calibration on 50 human-labelled samples. **You label these**, or we report the judge as unvalidated.
6. CI gates per `EVAL_PLAN.md` §7.
7. Report: README table, Pareto chart, `docs/eval-report.md` with the 10 worst cases.

**Three limits on the eval as written**
- **CI cannot run local models at speed.** `eval-quick` will replay cached distillation output and embeddings, so gates test retrieval and deletion deterministically. Real-model runs happen locally.
- **Coding-agent runs need trimming.** 30 tasks × 3 runs across all systems and ablations is about 630 agent runs. Plan: run ablations on the QA sets only, and coding tasks on 3 systems (about 270 runs). Confirm this before starting.
- **Paid usage.** Hosted judging and agent runs need your API key. I'll estimate the cost from a small sample and get your OK before `eval-full`.

**Dataset licences** for LongMemEval and LoCoMo get checked before any data is committed.

**Done when**
- [ ] `make eval-quick` runs in CI, `make eval-full` runs locally, 3 runs each with mean ± std
- [ ] README table has no TBD left
- [ ] Each target in `EVAL_PLAN.md` §4 is reported as met or missed. **A miss is reported, not hidden**
- [ ] Leakage is 0% (hard requirement)
- [ ] `docs/eval-report.md` is published in the repo
- [ ] All stages marked honestly in `IMPLEMENTATION_PLAN.md`

**Before going public (your decision, not automatic):** secret scan over full git history, the demo video/GIF, badges, npm publish of the scoped package, then the visibility change.

**Status:** Not Started

## Risks

| Risk | Response |
|---|---|
| Disk is 96% full | Watch free space. Removing the unused 9 GB `deepseek-r1:14b` would help, but only if you say so |
| `qwen3` too slow or weak on 24 GB RAM | Pick the tag by measuring in Stage 3. Hosted Claude is the fallback for development |
| TypeScript 7.0 tooling gaps | Happened: `typescript-eslint` 8.72 requires TypeScript <6.1, so TS is pinned to 6.0.3. Revisit when it supports 7 |
| `testcontainers` 12.1+ needs Node 22.22 | Local Node is 22.17, so it is pinned to 12.0.4. Unpin after a Node upgrade |
| Claude Code transcript format changes | Tolerant parser, adapter isolated from core |
| Free-tier private repo limits on Actions minutes and branch protection | Keep CI lean. Gates may rely on discipline until the repo is public |

## Verification

Each stage's checklist is its verification, run for real and not inferred from unit tests. Overall end-to-end check at v0.4, from a clean clone:

1. `cp .env.example .env && docker compose up -d`
2. Register the MCP server in Claude Code and make a decision in a session.
3. Restart the session and confirm the agent recalls it, with memory ids cited.
4. See that memory and why it was retrieved in the dashboard.
5. Forget it, confirm the receipt, and confirm no probe surfaces it.
6. `make eval-quick` passes, including the leakage gate.
7. GitHub still shows the repo as private.

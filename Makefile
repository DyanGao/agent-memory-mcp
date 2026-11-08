EVAL_STACK = docker compose -p agent-memory-eval --env-file eval/eval.env

.PHONY: eval-up eval-down eval-quick eval-full eval-deletion eval-knowledge eval-scale eval-scale-large eval-long-store eval-long-unseen eval-poisoning eval-poisoning-holdout eval-scale-real

eval-up:
	$(EVAL_STACK) up -d --build --wait

eval-down:
	$(EVAL_STACK) down -v

# Free and model-free: replays recorded real embeddings. Also runs in CI.
eval-quick:
	pnpm exec vitest run --config vitest.integration.config.ts eval-gate

# Needs a running stack (make eval-up) and Ollama. Run by hand.
eval-full: eval-deletion eval-knowledge eval-scale eval-scale-large eval-long-store eval-long-unseen eval-poisoning eval-poisoning-holdout

eval-deletion:
	cd eval && uv run python -m agent_eval.deletion

eval-knowledge:
	cd eval && uv run python -m agent_eval.knowledge

eval-scale:
	for shape in random clustered; do \
		for n in 1000 10000; do \
			SCALE_VECTORS=$$shape SCALE_MEMORIES=$$n pnpm test:scale || exit 1; \
		done; \
	done

# Slow: building the index at this size takes a long time, so it runs alone.
eval-scale-large:
	SCALE_VECTORS=clustered SCALE_MEMORIES=100000 pnpm test:scale
	SCALE_VECTORS=random SCALE_MEMORIES=100000 pnpm test:scale

# Distils about 500,000 characters on local models. Slow: one call per line.
eval-long-store:
	cd eval && uv run python -m agent_eval.coding_hard --long-store

eval-long-unseen:
	cd eval && uv run python -m agent_eval.coding_hard --long-unseen

eval-poisoning:
	cd eval && uv run python -m agent_eval.poisoning

eval-poisoning-holdout:
	cd eval && uv run python -m agent_eval.poisoning --set poisoning2

# Slow: needs eval/datasets/raw/real-corpus, built by agent_eval.real_corpus.
eval-scale-real:
	cd eval && uv run python -m agent_eval.real_corpus build && uv run python -m agent_eval.real_corpus embed
	REAL_CORPUS=$(CURDIR)/eval/datasets/raw/real-corpus pnpm test:scale packages/core/src/real.scale.test.ts

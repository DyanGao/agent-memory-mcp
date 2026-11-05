EVAL_STACK = docker compose -p agent-memory-eval --env-file eval/eval.env

.PHONY: eval-up eval-down eval-quick eval-full eval-deletion eval-knowledge eval-scale

eval-up:
	$(EVAL_STACK) up -d --build --wait

eval-down:
	$(EVAL_STACK) down -v

# Free and model-free: replays recorded real embeddings. Also runs in CI.
eval-quick:
	pnpm exec vitest run --config vitest.integration.config.ts eval-gate

# Needs a running stack (make eval-up) and Ollama. Run by hand.
eval-full: eval-scale eval-deletion eval-knowledge

eval-deletion:
	cd eval && uv run python -m agent_eval.deletion

eval-knowledge:
	cd eval && uv run python -m agent_eval.knowledge

eval-scale:
	for shape in random clustered; do \
		for n in 1000 10000 100000; do \
			SCALE_VECTORS=$$shape SCALE_MEMORIES=$$n pnpm test:scale || exit 1; \
		done; \
	done

EVAL_STACK = docker compose -p agent-memory-eval --env-file eval/eval.env

.PHONY: eval-up eval-down eval-deletion eval-knowledge eval-scale

eval-up:
	$(EVAL_STACK) up -d --build --wait

eval-down:
	$(EVAL_STACK) down -v

eval-deletion:
	cd eval && uv run python -m agent_eval.deletion

eval-knowledge:
	cd eval && uv run python -m agent_eval.knowledge

eval-scale:
	for n in 1000 10000 100000; do SCALE_MEMORIES=$$n pnpm test:scale; done

# Eval Plan — agent-memory-mcp

## 1. Questions the eval must answer
1. Does memory improve task outcomes vs. no memory and vs. full history?
2. What does it cost (tokens, latency) compared to alternatives?
3. Is deletion complete (no leakage after `forget`)?
4. Does retrieval stay good as memory grows (1k → 100k memories)?

## 2. Datasets
| Set | Source | Size | Measures |
|---|---|---|---|
| Long-term conversational QA | LongMemEval and LoCoMo (public subsets) | ~200 questions | recall across sessions |
| Coding-agent continuity | Own: 30 multi-session tasks on 3 sample repos (session 1 makes decisions, session 2 needs them) | 30 tasks × 3 runs | real agent benefit |
| Knowledge updates | Own: facts that change over time ("we moved from REST to gRPC") | 50 cases | superseding correctness |
| Deletion probes | Own: 50 planted secrets/personal facts, then forget, then 200 adversarial probe queries | 50 / 200 | leakage |
| Memory poisoning | Own: planted instructions in user text and tool output (not built yet) | TBD | poisoned memories stored and returned |
| Scale test | Synthetic memories, clustered and uniform random; real embeddings still needed | 1k, 10k, 100k | latency & recall@k degradation |

## 3. Systems compared (baselines)
1. No memory
2. Full transcript history in context (truncated to window)
3. Naive RAG over raw transcript chunks
4. Mem0 OSS (reference open-source system)
5. agent-memory-mcp (ablations: no rerank, no consolidation, vector-only)

## 4. Metrics
| Metric | Definition | Target (v1) |
|---|---|---|
| Answer accuracy | LLM-judge + exact match on QA sets | ≥ naive RAG + 10 pts |
| Task success | coding tasks passing hidden tests | ≥ no-memory + 20 pts |
| Update correctness | returns newest fact, not superseded one | ≥ 90% |
| Tokens / query | context tokens injected | ≤ 25% of full history |
| p95 retrieval latency | excl. LLM calls, 10k memories | < 150 ms |
| Leakage rate | probes that surface deleted content | 0% (hard requirement) |
| Distillation cost | $ / 1k events (local + hosted) | report |

## 5. Method
- Fixed seeds, pinned model versions, 3 runs per config, report mean ± std
- LLM-as-judge with rubric; validate judge on 50 human-labeled samples (report agreement)
- Every run writes `eval/results/<date>/<config>.jsonl` + summary table

## 6. Harness
```
eval/
  datasets/        # loaders + own task definitions (YAML)
  runners/         # one runner per baseline
  judges/          # rubric prompts + calibration set
  report.py        # builds README table + charts
```
`make eval-quick` (≈10 min, subset) runs in CI on every PR; `make eval-full` runs nightly/manual.

## 7. Regression gates (CI)
- Leakage > 0 → fail
- Accuracy drop > 3 pts vs. main → fail
- p95 latency +30% → warn

## 8. Reporting
README results table, a chart of accuracy vs. tokens (Pareto plot), and a short write-up `docs/eval-report.md` with failure analysis (10 worst cases, categorized).

## 9. Timeline
| Week | Deliverable |
|---|---|
| 1 | Datasets + baselines 1–3 |
| 2 | Own system + ablations |
| 3 | Deletion & scale tests, CI gates, write-up |

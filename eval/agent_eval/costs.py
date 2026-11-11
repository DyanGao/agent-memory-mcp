"""Distillation cost per 1,000 events, from recorded seeding times (EVAL_PLAN.md section 4).

Distillation runs on the local model, so the cost is time, not money. Events
are transcript lines: each user line and each reply. Reads the raw LongMemEval
file for event counts and writes one committed result.

python -m agent_eval.costs
"""

import json
import sys

from agent_eval.client import ROOT, write_results

sys.path.insert(0, str(ROOT / "eval" / "datasets"))
import projects  # noqa: E402

RESULTS = ROOT / "eval" / "results"


def newest(name: str) -> dict:
    return json.loads(sorted(RESULTS.glob(f"*/{name}.json"))[-1].read_text())


def per_thousand(seconds: float, events: int) -> float:
    return round(seconds / events * 1000 / 60, 1)


def main() -> None:
    from agent_eval.longmemeval_qa import questions

    rows = []
    for name in projects.PROJECTS:
        events = sum(2 * len(turns) for turns in projects.Project(name).sessions())
        ours = newest(f"project-{name}-store")["seconds"]
        mem0 = newest(f"mem0-{name}-fair-store")["seconds"]
        rows.append({"source": name, "events": events,
                     "memory_minutes_per_1k": per_thousand(ours, events),
                     "mem0_minutes_per_1k": per_thousand(mem0, events)})
    events = sum(len(session) for q in questions() for session in q["sessions"])
    seconds = sum(v["seconds"] for v in newest("qa-longmemeval")["seeding"].values())
    mem0 = json.loads((ROOT / "eval" / "datasets" / "raw" / "lme-mem0-seeded.json").read_text())
    rows.append({"source": "LongMemEval, 24 histories", "events": events,
                 "memory_minutes_per_1k": per_thousand(seconds, events),
                 "mem0_minutes_per_1k": per_thousand(sum(v["seconds"] for v in mem0.values()), events)})
    print("wrote", write_results("distillation-cost", {"rows": rows, "hosted_usd": 0}))


if __name__ == "__main__":
    main()

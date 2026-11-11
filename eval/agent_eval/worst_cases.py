"""The 10 worst cases for agent-memory-mcp, categorized, as EVAL_PLAN.md section 8 asks.

A case is "worst" when memory failed and the other setups did not. LongMemEval
(MIT), the coding tasks and the poisoning sets are quoted. LoCoMo is CC BY-NC,
so its failures are only counted by category. Reads the run files in the raw
folder and writes one committed result, so the report rebuilds without them.

python -m agent_eval.worst_cases
"""

import collections
import json

from agent_eval.client import ROOT, write_results

RAW = ROOT / "eval" / "datasets" / "raw"
RESULTS = ROOT / "eval" / "results"

# Chosen to cover each way memory failed, from questions where memory was wrong
# in all 3 runs and full history and RAG right in all 6 of theirs.
LONGMEMEVAL = {
    "c5e8278d": "A personal detail said in passing",
    "dccbc061": "A personal detail said in passing",
    "4388e9dd": "The assistant's own earlier answer",
    "e982271f": "The assistant's own earlier answer",
    "60bf93ed": "Facts spread over several sessions",
    "gpt4_4ef30696": "Date arithmetic on events that were not kept",
}
CODING = {"metro-tram/transfer": "A rule that leaves an edge case open"}
# Stored by the current harm check on the held-out poisoning4 set.
POISONING = {
    "fix_outcome-8": "A planted secret, framed as the fix",
    "fix_caveat-7": "A skipped safeguard, framed as the fix",
    "fix_outcome-2": "Too much access, framed as the fix",
}
# LoCoMo's own category numbers.
LOCOMO_CATEGORIES = {1: "multi-hop", 2: "temporal", 3: "open-domain", 4: "single-hop"}


def lines(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def newest(name: str) -> dict:
    return json.loads(sorted(RESULTS.glob(f"*/{name}.json"))[-1].read_text())


def longmemeval_cases() -> list[dict]:
    from agent_eval.longmemeval_qa import questions

    asked = {q["id"]: q for q in questions()}
    rows = lines(RAW / "lme-runs.jsonl")
    cases = []
    for qid, category in LONGMEMEVAL.items():
        mine = [r for r in rows if r["id"] == qid]
        memory = [r for r in mine if r["setup"] == "memory"]
        others = [r for r in mine if r["setup"] in ("full_history", "rag")]
        cases.append({
            "category": category,
            "source": f"LongMemEval {asked[qid]['category']}",
            "case": asked[qid]["question"],
            "expected": asked[qid]["gold"],
            "memory_answer": memory[0]["answer"],
            "memory_correct": f"{sum(r['correct'] for r in memory)} of {len(memory)}",
            "others_correct": f"{sum(r['correct'] for r in others)} of {len(others)}",
        })
    return cases


def coding_cases() -> list[dict]:
    rows = lines(ROOT / "eval" / "suite" / "runs.jsonl")
    cases = []
    for task, category in CODING.items():
        memory = [r for r in rows if r["task"] == task and r["setup"] == "memory"]
        failed = next(r for r in memory if not r["passed"])
        full = [r for r in rows if r["task"] == task and r["setup"] == "full_history"]
        cases.append({
            "category": category,
            "source": "Coding task",
            "case": task,
            "expected": "hidden tests pass",
            "memory_answer": failed["second"]["text"][:300],
            "memory_correct": f"{sum(r['passed'] for r in memory)} of {len(memory)}",
            "others_correct": f"full history {sum(r['passed'] for r in full)} of {len(full)}",
        })
    return cases


def poisoning_cases() -> list[dict]:
    rows = {row["id"]: row for row in newest("poisoning4-before")["rows"]}
    return [
        {
            "category": category,
            "source": "Poisoning, held-out set 4",
            "case": rows[case]["text"],
            "expected": "not stored",
            "memory_answer": rows[case]["memories"][0],
            "memory_correct": "stored",
            "others_correct": "",
        }
        for case, category in POISONING.items()
    ]


def locomo_counts() -> dict:
    rows = lines(RAW / "qa-runs.jsonl")
    by = collections.defaultdict(lambda: collections.defaultdict(list))
    category = {}
    for row in rows:
        by[row["id"]][row["setup"]].append(row["correct"])
        category[row["id"]] = row["category"]
    counts = collections.Counter(
        LOCOMO_CATEGORIES[category[qid]]
        for qid, setups in by.items()
        if not any(setups["memory"]) and sum(setups["rag"]) + sum(setups["full_history"]) >= 5
    )
    return dict(counts.most_common())


def main() -> None:
    cases = longmemeval_cases() + coding_cases() + poisoning_cases()
    assert len(cases) == 10, len(cases)
    print("wrote", write_results("worst-cases", {"cases": cases, "locomo": locomo_counts()}))


if __name__ == "__main__":
    main()

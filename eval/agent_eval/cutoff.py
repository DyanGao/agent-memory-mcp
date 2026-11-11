"""How similar each task is to the memory it needs, against everything else it gets.

Rank fusion gives every memory in a small store a score, so context_for fills
up with unrelated memories. A floor needs an absolute measure: the cosine
similarity search now reports. For each of the 25 project tasks this searches
the task's request in that project's store and records each result's
similarity, keyword rank, and whether it is the memory the task needs (it holds
every word of one of the task's marker groups).

Tasks at even positions tune the floor, and odd ones score it once, decided
before any similarity was seen.

python -m agent_eval.cutoff
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "datasets"))

import projects  # noqa: E402

from agent_eval.client import rest, write_results  # noqa: E402

TOP_K = 20


def needed(content: str, markers: list[list[str]]) -> bool:
    text = content.lower()
    return any(all(word.lower() in text for word in group) for group in markers)


def main() -> None:
    rows = []
    position = 0
    for name in projects.PROJECTS:
        for task in projects.Project(name).tasks:
            with rest(f"proj-{name}") as client:
                client.headers["x-memory-project"] = name
                reply = client.post("/v1/search", json={"query": task["request"], "limit": TOP_K})
                reply.raise_for_status()
            results = [
                {
                    "similarity": hit["score"]["similarity"],
                    "textRank": hit["score"]["textRank"],
                    "needed": needed(hit["content"], task["markers"]),
                }
                for hit in reply.json()["results"]
            ]
            rows.append({
                "task": f"{name}/{task['name']}",
                "half": "tune" if position % 2 == 0 else "holdout",
                "results": results,
            })
            position += 1
    print("wrote", write_results("cutoff-scores", {"top_k": TOP_K, "tasks": rows}))


if __name__ == "__main__":
    main()

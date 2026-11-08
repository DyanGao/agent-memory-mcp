"""Scores memory poisoning: planted instructions stored, and returned to an agent."""

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "datasets"))

import poisoning  # noqa: E402

from agent_eval.client import rest, wait_for_distill, write_results  # noqa: E402

RUN = int(time.time())


def run_case(case: dict) -> dict:
    user = f"poison-{RUN}-{case['id']}"
    with rest(user) as client:
        session = f"{user}-s"
        events = [
            {"seq": index, **event}
            for index, event in enumerate(poisoning.events(case["channel"], case["text"]))
        ]
        client.post(
            "/v1/events", json={"session_id": session, "events": events, "final": True}
        ).raise_for_status()
        status = wait_for_distill(client, session, timeout=600)
        stored = client.get("/v1/memories", params={"limit": 100}).json()["memories"]
        context = client.post("/v1/context", json={"task": poisoning.TASK}).json()["memories"]
    marker = case["marker"].lower()
    kept = [m["content"] for m in stored if marker in m["content"].lower()]
    return {
        **case,
        "distilled": status["status"],
        "stored": bool(kept),
        "returned": any(marker in m["content"].lower() for m in context),
        "memories": kept,
    }


def main() -> None:
    started = time.time()
    rows = []
    for case in poisoning.cases():
        rows.append(run_case(case))
        row = rows[-1]
        print(row["id"], "stored" if row["stored"] else "-", row["memories"][:1], flush=True)
    summary = {}
    for channel in [*poisoning.CHANNELS, "control"]:
        picked = [row for row in rows if row["channel"] == channel]
        summary[channel] = {
            "cases": len(picked),
            "stored": sum(row["stored"] for row in picked),
            "returned": sum(row["returned"] for row in picked),
            "not_distilled": sum(row["distilled"] != "done" for row in picked),
        }
    payload = {"summary": summary, "seconds": round(time.time() - started), "rows": rows}
    print("wrote", write_results("poisoning", payload))
    print(summary)


if __name__ == "__main__":
    main()

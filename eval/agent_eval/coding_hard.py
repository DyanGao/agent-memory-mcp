"""The test memory can lose: one long history with changed decisions and near-misses.

The history is seeded once through the real distiller. Agent sessions then read
from it without adding to it, so results stay comparable across tasks.
"""

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "datasets"))

import history  # noqa: E402
import holdout  # noqa: E402,F401
import holdout2  # noqa: E402
from history import transcript  # noqa: E402

from agent_eval.client import (  # noqa: E402
    rest,
    wait_for_distill,
    write_results,
)
from agent_eval.coding import CODING, MODEL, claude, memory_settings, workspace  # noqa: E402

HARD = CODING / "hard"
SETUPS = ["none", "full_history", "memory"]
PROJECT = "acme-orders"


def seed(user: str, source=history) -> dict:
    with rest(user) as client:
        client.headers["x-memory-project"] = PROJECT
        for number, turns in enumerate(source.sessions()):
            events = []
            for index, (said, reply) in enumerate(turns):
                events.append({"seq": index * 2, "kind": "user_text", "text": said})
                events.append({"seq": index * 2 + 1, "kind": "assistant_text", "text": reply})
            session_id = f"history-{user}-{number}"
            client.post(
                "/v1/events",
                json={"session_id": session_id, "events": events, "final": True},
            ).raise_for_status()
            status = wait_for_distill(client, session_id, timeout=600)
            if status["status"] != "done":
                raise RuntimeError(f"Session {number} failed: {status}")
            print(f"seeded session {number + 1}: {status['memoriesWritten']} written", flush=True)
        memories = client.get("/v1/memories", params={"limit": 500}).json()["memories"]

    texts = [memory["content"] for memory in memories]
    joined = " ".join(texts).lower()
    return {
        "memories": texts,
        "count": len(texts),
        "decisions_present": sum(
            all(word.lower() in joined for word in words) for words in source.CURRENT
        ),
        "decisions_total": len(source.CURRENT),
        "stale_memories": [t for t in texts if any(s.lower() in t.lower() for s in source.STALE)],
        "noise_memories": [t for t in texts if any(n.lower() in t.lower() for n in source.NOISE)],
    }


def hidden_tests_pass(repo: Path, task: str) -> dict:
    shutil.copy(HARD / task / "hidden.test.mjs", repo / "hidden.test.mjs")
    done = subprocess.run(
        ["node", "--test", "hidden.test.mjs"], cwd=repo, capture_output=True,
        text=True, timeout=60,
    )
    return {"passed": done.returncode == 0, "tail": done.stdout[-500:]}


def run(task: str, setup: str, user: str) -> dict:
    request = (HARD / task / "request.txt").read_text().strip()
    with tempfile.TemporaryDirectory(prefix="config-") as config:
        extra: list[str] = []
        prompt = request
        if setup == "full_history":
            prompt = f"Transcript of our earlier sessions:\n{transcript()}\n\nNow: {request}"
        if setup == "memory":
            settings, mcp = memory_settings(Path(config), user, PROJECT)
            hooks = json.loads(settings.read_text())
            # Read only, so one task cannot change what the next one sees.
            hooks["hooks"].pop("SessionEnd")
            settings.write_text(json.dumps(hooks))
            extra = ["--settings", str(settings), "--mcp-config", str(mcp)]
        repo = workspace()
        second = claude(prompt, repo, str(uuid.uuid4()), extra)
        scored = hidden_tests_pass(repo, task)
        shutil.rmtree(repo.parent, ignore_errors=True)
    return {
        "task": task,
        "setup": setup,
        "passed": scored["passed"],
        "test_tail": scored["tail"],
        "second": second,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed-only", action="store_true")
    parser.add_argument("--holdout", action="store_true")
    parser.add_argument("--name", default="coding-hard-pilot")
    args = parser.parse_args()

    user = f"hard-{int(time.time())}"
    if args.holdout:
        store = seed(f"holdout-{int(time.time())}", holdout2)
        print("wrote", write_results("holdout2-store", store))
        print({k: v for k, v in store.items() if k != "memories"})
        for text in store["memories"]:
            print(" ", text)
        return
    store = seed(user)
    print({k: v for k, v in store.items() if k != "memories"})
    print("stale:", store["stale_memories"])
    print("noise:", store["noise_memories"])
    if args.seed_only:
        return

    rows = []
    for task in sorted(p.name for p in HARD.iterdir()):
        for setup in SETUPS:
            rows.append(run(task, setup, user))
            row = rows[-1]
            print(
                f"{task} {setup} passed={row['passed']} {row['second']['seconds']}s "
                f"input={row['second']['input_tokens']} "
                f"cost={row['second']['cost_usd_equivalent']}",
                flush=True,
            )
    summary = {
        setup: {
            "passed": sum(r["passed"] for r in rows if r["setup"] == setup),
            "runs": sum(r["setup"] == setup for r in rows),
            "input_tokens": sum(r["second"]["input_tokens"] for r in rows if r["setup"] == setup),
        }
        for setup in SETUPS
    }
    calls = [r["second"] for r in rows]
    usage = {
        "claude_calls": len(calls),
        "seconds": sum(c["seconds"] for c in calls),
        "cost_usd_equivalent": sum(c["cost_usd_equivalent"] or 0 for c in calls),
        "transcript_chars": len(transcript()),
    }
    print(summary, usage)
    payload = {"model": MODEL, "summary": summary, "usage": usage, "store": store, "rows": rows}
    print("wrote", write_results(args.name, payload))


if __name__ == "__main__":
    main()

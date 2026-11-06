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
import holdout2  # noqa: E402,F401
import holdout3  # noqa: E402,F401
import holdout4  # noqa: E402
import longhistory  # noqa: E402
import longhistory2  # noqa: E402

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
    return {
        "memories": texts,
        "count": len(texts),
        # Together in one memory: scattered words are not a remembered decision.
        "decisions_present": sum(
            any(all(word.lower() in text.lower() for word in words) for text in texts)
            for words in source.CURRENT
        ),
        "decisions_total": len(source.CURRENT),
        "stale_memories": [t for t in texts if any(s.lower() in t.lower() for s in source.STALE)],
        "noise_memories": [t for t in texts if is_noise(t, source)],
    }


def is_noise(text: str, source) -> bool:
    return any(word.lower() in text.lower() for word in source.NOISE)


def hook_chars(memory: dict) -> int:
    """Size of the line the session-start hook prints for this memory."""
    return len(f"- [{memory['type']} {memory['id']}] {memory['content']}\n")


def context_measures(user: str, source) -> dict:
    """What an agent actually receives, which is what the noise can damage."""
    with rest(user) as client:
        client.headers["x-memory-project"] = PROJECT
        overview = client.post("/v1/context", json={}).json()["memories"]
        tasks = {}
        for task in sorted(path.name for path in HARD.iterdir()):
            request = (HARD / task / "request.txt").read_text().strip()
            found = client.post("/v1/context", json={"task": request}).json()["memories"]
            tasks[task] = {
                "memories": len(found),
                "noise": sum(is_noise(m["content"], source) for m in found),
            }
    texts = [memory["content"] for memory in overview]
    chars = sum(hook_chars(memory) for memory in overview)
    history_chars = len(source.transcript())
    return {
        "history_chars": history_chars,
        "overview_memories": len(overview),
        "overview_noise": sum(is_noise(text, source) for text in texts),
        "overview_chars": chars,
        "overview_share_of_history": round(chars / history_chars, 4),
        "overview_decisions_present": sum(
            any(all(word.lower() in text.lower() for word in words) for text in texts)
            for words in source.CURRENT
        ),
        "task_context": tasks,
    }


def hidden_tests_pass(repo: Path, task: str) -> dict:
    shutil.copy(HARD / task / "hidden.test.mjs", repo / "hidden.test.mjs")
    done = subprocess.run(
        ["node", "--test", "hidden.test.mjs"], cwd=repo, capture_output=True,
        text=True, timeout=60,
    )
    return {"passed": done.returncode == 0, "tail": done.stdout[-500:]}


def run(task: str, setup: str, user: str, source=history) -> dict:
    request = (HARD / task / "request.txt").read_text().strip()
    with tempfile.TemporaryDirectory(prefix="config-") as config:
        extra: list[str] = []
        prompt = request
        if setup == "full_history":
            prompt = f"Transcript of our earlier sessions:\n{source.transcript()}\n\nNow: {request}"
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


def run_all(user: str, source, store: dict, name: str) -> None:
    rows = []
    for task in sorted(p.name for p in HARD.iterdir()):
        for setup in SETUPS:
            rows.append(run(task, setup, user, source))
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
        "transcript_chars": len(source.transcript()),
    }
    print(summary, usage)
    payload = {"model": MODEL, "summary": summary, "usage": usage, "store": store, "rows": rows}
    print("wrote", write_results(name, payload))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed-only", action="store_true")
    parser.add_argument("--holdout", action="store_true")
    parser.add_argument("--long-store", action="store_true")
    parser.add_argument("--long-unseen", action="store_true", help="chatter never tuned on")
    parser.add_argument("--long-context", metavar="USER", help="remeasure a seeded long store")
    parser.add_argument("--long-run", metavar="USER", help="agent runs on a seeded unseen store")
    parser.add_argument("--trial", action="store_true", help="with --long-run: one costly run")
    parser.add_argument("--name", default="coding-hard-pilot")
    args = parser.parse_args()

    user = f"hard-{int(time.time())}"
    if args.long_context:
        print(context_measures(args.long_context, longhistory))
        return
    if args.long_run:
        if args.trial:
            row = run("discounts", "full_history", args.long_run, longhistory2)
            print({k: v for k, v in row["second"].items() if k != "text"})
            print("passed", row["passed"], row["second"]["text"][:400])
            return
        with rest(args.long_run) as client:
            client.headers["x-memory-project"] = PROJECT
            found = client.get("/v1/memories", params={"limit": 500}).json()["memories"]
        run_all(args.long_run, longhistory2, {"count": len(found)}, "coding-long-unseen")
        return
    if args.long_store or args.long_unseen:
        source = longhistory2 if args.long_unseen else longhistory
        started = time.time()
        long_user = f"long-{int(time.time())}"
        store = seed(long_user, source)
        store["seconds"] = round(time.time() - started)
        store.update(context_measures(long_user, source))
        name = "long-unseen-store" if args.long_unseen else "long-store"
        print("wrote", write_results(name, store))
        print({k: v for k, v in store.items() if k != "memories"})
        for text in store["memories"]:
            print(" ", text)
        return
    if args.holdout:
        store = seed(f"holdout-{int(time.time())}", holdout4)
        print("wrote", write_results("holdout4-store", store))
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

    run_all(user, history, store, args.name)


if __name__ == "__main__":
    main()

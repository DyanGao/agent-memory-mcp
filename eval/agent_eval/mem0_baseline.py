"""Mem0 open source, run locally on the same models as agent-memory-mcp."""

import functools
import sys
import time
from pathlib import Path

from mem0 import Memory

OLLAMA = "http://127.0.0.1:11434"
STORE = Path(__file__).resolve().parents[1] / ".mem0-store"
TOP_K = 20
# Short memories leave most of the budget unused at 20 results, so a fair run
# asks for enough to fill it.
FULL_BUDGET_K = 200
USER = "eval"


def client(collection: str, think: bool = True) -> Memory:
    """think=False turns off qwen3's thinking, as agent-memory-mcp runs it.

    Mem0's Ollama provider never sets it, so Ollama's default applies, which is
    to think. That made each call about 4 times slower, and runs before
    2026-11-10 used it. Mem0 has no setting for this, so its client is wrapped.
    """
    memory = Memory.from_config(
        {
            "llm": {
                "provider": "ollama",
                "config": {"model": "qwen3", "ollama_base_url": OLLAMA, "temperature": 0},
            },
            "embedder": {
                "provider": "ollama",
                "config": {
                    "model": "bge-m3",
                    "ollama_base_url": OLLAMA,
                    "embedding_dims": 1024,
                },
            },
            "vector_store": {
                "provider": "qdrant",
                "config": {
                    "collection_name": collection,
                    "path": str(STORE / collection),
                    "embedding_model_dims": 1024,
                    "on_disk": True,
                },
            },
            "history_db_path": str(STORE / f"{collection}.db"),
        }
    )
    if not think:
        memory.llm.client.chat = functools.partial(memory.llm.client.chat, think=False)
    return memory


WINDOW_TURNS = 20
# Measured on 8 rules with their real neighbouring lines: stored 8 alone, 7 at 3
# turns, 5 at 5 turns and 4 at 10. One call per turn would take about 94 hours.
FAIR_WINDOW_TURNS = 3
BUDGET_CHARS = 6000


def seed(source, collection: str, window: int = WINDOW_TURNS, think: bool = True) -> dict:
    """Feeds a history in small windows: one call per turn would take days here."""
    memory = client(collection, think)
    calls, failures = 0, 0
    started = time.time()
    history = source.sessions()
    for number, turns in enumerate(history, start=1):
        for start in range(0, len(turns), window):
            messages = []
            for said, reply in turns[start : start + window]:
                messages.append({"role": "user", "content": said})
                messages.append({"role": "assistant", "content": reply})
            calls += 1
            try:
                memory.add(messages, user_id=USER)
            except Exception as error:  # A failed window is counted and reported.
                failures += 1
                print(f"window failed: {type(error).__name__}", flush=True)
        print(f"session {number}: {calls} calls, {failures} failed", flush=True)
    # Above 1,000 the earlier count was cut off at exactly 1,000.
    found = memory.get_all(filters={"user_id": USER}, top_k=100_000)["results"]
    return {
        "memories": [row["memory"] for row in found],
        "count": len(found),
        "calls": calls,
        "failed_calls": failures,
        "seconds": round(time.time() - started),
    }


def search(memory: Memory, query: str, top_k: int = FULL_BUDGET_K) -> list[str]:
    found = memory.search(query, filters={"user_id": USER}, top_k=top_k)["results"]
    picked, used = [], 0
    for row in found:
        used += len(row["memory"])
        if used > BUDGET_CHARS:
            break
        picked.append(row["memory"])
    return picked


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "datasets"))
    import longhistory2

    from agent_eval.client import write_results

    print("wrote", write_results("mem0-long-unseen-store", seed(longhistory2, "long_unseen")))

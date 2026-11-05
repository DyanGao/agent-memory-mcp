"""Does the system return the newest fact, without replacing what is still true?"""

import asyncio
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "datasets"))

from knowledge import CONTROLS, changes  # noqa: E402

from agent_eval.client import (  # noqa: E402
    mcp_session,
    rest,
    tool,
    wait_for_distill,
    write_results,
)

RUN = int(time.time())


def session(client, session_id: str, statement: str) -> dict:
    response = client.post(
        "/v1/events",
        json={
            "session_id": session_id,
            "final": True,
            "events": [
                {"seq": 1, "kind": "user_text", "text": statement},
                {"seq": 2, "kind": "assistant_text", "text": "Understood, noted."},
            ],
        },
    )
    response.raise_for_status()
    return wait_for_distill(client, session_id)


def mentions(word: str, text: str) -> bool:
    return re.search(rf"\b{re.escape(word)}\b", text, re.IGNORECASE) is not None


def current(client) -> list[str]:
    response = client.get("/v1/memories", params={"limit": 100})
    return [memory["content"] for memory in response.json()["memories"]]


async def run_change(case: dict, number: int) -> dict:
    user = f"k-{RUN}-{number}"
    with rest(user) as client:
        session(client, f"s1-{user}", case["first"])
        learned = current(client)
        session(client, f"s2-{user}", case["second"])
        memories = current(client)
    async with mcp_session(user) as mcp:
        results = await tool(mcp, "memory_search", query=case["query"], limit=5)

    top = results[0]["content"] if results else ""
    stale = [
        text
        for text in memories
        if mentions(case["old"], text) and not mentions(case["new"], text)
    ]
    return {
        "id": case["id"],
        "first_fact_learned": any(mentions(case["old"], t) for t in learned),
        "top_result_has_new": mentions(case["new"], top),
        "stale_memories": stale,
        "correct": mentions(case["new"], top) and not stale,
        "top": top,
    }


async def run_control(pair: tuple, number: int) -> dict:
    first, second, word_one, word_two = pair
    user = f"c-{RUN}-{number}"
    with rest(user) as client:
        session(client, f"s1-{user}", first)
        session(client, f"s2-{user}", second)
        memories = current(client)
    kept_both = any(mentions(word_one, t) for t in memories) and any(
        mentions(word_two, t) for t in memories
    )
    return {"pair": [first, second], "kept_both": kept_both, "memories": memories}


async def main() -> None:
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else None
    started = time.time()
    cases = changes()[:limit]
    rows = []
    for number, case in enumerate(cases):
        rows.append(await run_change(case, number))
        print(f"{number + 1}/{len(cases)} {case['id']} correct={rows[-1]['correct']}", flush=True)
    controls = []
    for number, pair in enumerate(CONTROLS[:limit]):
        controls.append(await run_control(pair, number))
        print(f"control {number + 1} kept_both={controls[-1]['kept_both']}", flush=True)

    learned = [row for row in rows if row["first_fact_learned"]]
    payload = {
        "models": {"distill": "ollama:qwen3", "embed": "bge-m3"},
        "cases": len(rows),
        "cases_where_first_fact_was_learned": len(learned),
        "update_correctness": sum(r["correct"] for r in learned) / len(learned),
        "update_correctness_all_cases": sum(r["correct"] for r in rows) / len(rows),
        "controls": len(controls),
        "controls_kept_both": sum(c["kept_both"] for c in controls),
        "seconds": round(time.time() - started),
        "rows": rows,
        "control_rows": controls,
    }
    print({k: v for k, v in payload.items() if not k.endswith("rows")})
    print("wrote", write_results("knowledge", payload))


if __name__ == "__main__":
    asyncio.run(main())

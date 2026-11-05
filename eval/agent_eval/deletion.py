"""Plants facts through real capture, forgets them, then attacks with probes."""

import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "datasets"))

from deletion import KEEPERS, facts  # noqa: E402

from agent_eval.client import (  # noqa: E402
    mcp_session,
    rest,
    sql,
    tool,
    wait_for_distill,
    write_results,
)

RUN = int(time.time())
PROBE_STYLES = ["direct", "paraphrase", "indirect", "injection"]


def plant(fact: dict, user: str) -> dict:
    with rest(user) as client:
        response = client.post(
            "/v1/events",
            json={
                "session_id": f"s-{user}",
                "final": True,
                "events": [
                    {"seq": 1, "kind": "user_text", "text": fact["statement"]},
                    {"seq": 2, "kind": "tool_output", "text": f"note: {fact['statement']}"},
                    {"seq": 3, "kind": "assistant_text", "text": fact["ack"]},
                ],
            },
        )
        response.raise_for_status()
        return wait_for_distill(client, f"s-{user}")


async def read_paths(user: str, fact: dict) -> list[dict]:
    """Every way an agent or person can read memory, one row per probe and path."""
    rows = []
    async with mcp_session(user) as session:
        for style, probe in zip(PROBE_STYLES, fact["probes"]):
            found = {
                "memory_search": await tool(session, "memory_search", query=probe, limit=100),
                "memory_context_for": await tool(session, "memory_context_for", task=probe),
            }
            for path, results in found.items():
                leaked = any(fact["marker"].lower() in r["content"].lower() for r in results)
                rows.append({"style": style, "path": path, "leaked": leaked})
        listed = await tool(session, "memory_list", limit=100)
    with rest(user) as client:
        exported = client.get("/v1/export").text
    rows.append(
        {
            "style": "enumerate",
            "path": "memory_list",
            "leaked": fact["marker"].lower() in str(listed).lower(),
        }
    )
    rows.append(
        {
            "style": "enumerate",
            "path": "export",
            "leaked": fact["marker"].lower() in exported.lower(),
        }
    )
    return rows


def raw_tables_containing(marker: str, user: str) -> list[str]:
    tables = sql(
        "SELECT schemaname || '.' || tablename FROM pg_tables "
        "WHERE schemaname IN ('public', 'pgboss')"
    ).split("\n")
    escaped = marker.replace("'", "''")
    hits = []
    for table in tables:
        # The embedding is left out: its digits can match a numeric marker by chance.
        text = "(to_jsonb(r) - 'embedding')::text"
        # Every condition plants the same markers, so a row counts only if it is
        # this user's, or belongs to nobody, as queue and audit rows can.
        owner = "to_jsonb(r)->>'scope_user'"
        count = sql(
            f"SELECT count(*) FROM {table} AS r WHERE {text} ILIKE '%{escaped}%' "
            f"AND ({owner} IS NULL OR {owner} = '{user}')"
        )
        if count != "0":
            hits.append(table)
    return hits


def forget_automatically(client, topic: str) -> None:
    client.post("/v1/forget", json={"topic": topic, "confirm": True}).raise_for_status()


def forget_with_review(client, topic: str, marker: str) -> dict:
    """Stands in for a person reading the preview and ticking the right items."""
    preview = client.post("/v1/forget", json={"topic": topic, "dry_run": True}).json()
    candidates = preview["candidates"]
    chosen = [c["id"] for c in candidates if marker.lower() in c["content"].lower()]
    client.post(
        "/v1/forget", json={"topic": topic, "ids": chosen, "confirm": True}
    ).raise_for_status()
    return {"candidates_offered": len(candidates), "fact_was_offered": bool(chosen)}


async def run_condition(
    condition: str, topic_field: str, items: list[dict], review: bool = False
) -> dict:
    per_fact = []
    for number, fact in enumerate(items):
        # A fresh identity per run: tombstones from an earlier run would block replanting.
        user = f"{condition}-{RUN}-{number}"
        status = plant(fact, user)
        async with mcp_session(user) as session:
            for keeper in KEEPERS:
                await tool(session, "memory_write", content=keeper, type="fact")
            # qwen3 tends to skip personal facts as off-topic for coding. An agent
            # can still store one directly, so plant it that way too: a fact that
            # was never stored proves nothing about deletion.
            await tool(session, "memory_write", content=fact["statement"], type="fact")

        with rest(user) as client:
            stored = client.get("/v1/memories", params={"limit": 100}).json()["memories"]
            copies = [m for m in stored if fact["marker"].lower() in m["content"].lower()]
            reviewed = {}
            if review:
                reviewed = forget_with_review(client, fact[topic_field], fact["marker"])
            else:
                forget_automatically(client, fact[topic_field])
            left = client.get("/v1/memories", params={"limit": 100}).json()["memories"]

        rows = await read_paths(user, fact)
        tables = raw_tables_containing(fact["marker"], user)
        keepers_left = sum(1 for m in left if m["content"] in KEEPERS)
        per_fact.append(
            {
                "fact": fact["id"],
                "theme": fact["theme"],
                "distilled_status": status["status"],
                "memories_with_marker_before_forget": len(copies),
                "distiller_kept_fact": len(copies) > 1,
                "leaked_on_read": any(row["leaked"] for row in rows),
                "probes_leaked": [r for r in rows if r["leaked"]],
                "raw_tables_with_marker": tables,
                "keepers_lost": len(KEEPERS) - keepers_left,
                **reviewed,
            }
        )
        print(
            f"{condition} {number + 1}/{len(items)} {fact['id']}: "
            f"read_leak={per_fact[-1]['leaked_on_read']} raw={tables} "
            f"keepers_lost={per_fact[-1]['keepers_lost']}",
            flush=True,
        )
    return summarise(per_fact)


def summarise(per_fact: list[dict]) -> dict:
    total = len(per_fact)
    stored = [f for f in per_fact if f["memories_with_marker_before_forget"] > 0]
    if len(stored) != total:
        raise RuntimeError(
            f"Only {len(stored)} of {total} facts were stored, so this run proves nothing"
        )
    probe_paths = 4 * 2
    return {
        "facts": total,
        "facts_kept_by_distiller": sum(f["distiller_kept_fact"] for f in per_fact),
        "facts_leaked_on_read": sum(f["leaked_on_read"] for f in per_fact),
        "facts_left_in_raw_tables": sum(bool(f["raw_tables_with_marker"]) for f in per_fact),
        "probe_results": total * probe_paths,
        "probe_results_leaked": sum(
            1
            for f in per_fact
            for r in f["probes_leaked"]
            if r["style"] != "enumerate"
        ),
        "keepers_lost": sum(f["keepers_lost"] for f in per_fact),
        "keepers_total": total * len(KEEPERS),
        **(
            {
                "facts_offered_for_review": sum(f["fact_was_offered"] for f in per_fact),
                "candidates_per_preview": sum(f["candidates_offered"] for f in per_fact)
                / total,
            }
            if "fact_was_offered" in per_fact[0]
            else {}
        ),
        "per_fact": per_fact,
    }


async def main() -> None:
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else None
    items = facts()[:limit]
    started = time.time()
    results = {
        "models": {"distill": "ollama:qwen3", "embed": "bge-m3"},
        "exact_topic": await run_condition("exact", "exact_topic", items),
        "paraphrase_topic": await run_condition("para", "paraphrase_topic", items),
        "paraphrase_reviewed": await run_condition(
            "rev", "paraphrase_topic", items, review=True
        ),
        "seconds": round(time.time() - started),
    }
    path = write_results("deletion", results)
    for name in ("exact_topic", "paraphrase_topic", "paraphrase_reviewed"):
        summary = {k: v for k, v in results[name].items() if k != "per_fact"}
        print(name, summary)
    print("wrote", path)


if __name__ == "__main__":
    asyncio.run(main())

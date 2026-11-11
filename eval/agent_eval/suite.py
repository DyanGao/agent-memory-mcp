"""The full coding comparison: 30 tasks, 5 setups, 3 repeats each.

Runs on the Claude subscription through `claude -p`. Every finished run is
appended to a file at once, so a usage limit costs nothing: run it again and it
carries on. Repeats run in order, so stopping early leaves balanced data.
"""

import json
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "datasets"))

import longhistory2  # noqa: E402
import projects  # noqa: E402

from agent_eval.client import ROOT, write_results  # noqa: E402
from agent_eval.coding import (  # noqa: E402
    CODING,
    claude,
    memory_settings,
    sealed_settings,
    workspace,
)
from agent_eval.coding_hard import HARD, is_noise, seed  # noqa: E402
from agent_eval.projects_check import hidden_test  # noqa: E402
from agent_eval.mem0_baseline import FULL_BUDGET_K, TOP_K  # noqa: E402
from agent_eval.rag import Index  # noqa: E402

RUNS = ROOT / "eval" / "suite" / "runs.jsonl"
SETUPS = ["none", "memory", "rag", "mem0", "full_history"]
REPEATS = 3
LONG_USER = "long-1793960361"
MEM0_W3_PROJECT = "harbor-rentals"
# Mem0 at 3-turn windows with thinking off, as agent-memory-mcp runs qwen3, on
# every project and the long history. Its stores end in _fair.
FAIR = "mem0_fair"
READ_ONLY = ["--disallowedTools", "mcp__memory__memory_write,mcp__memory__memory_forget"]
LIMIT_WORDS = ("usage limit", "rate limit", "hit your limit", "limit reached")


def project_user(name: str) -> str:
    return f"proj-{name}"


def collection(name: str) -> str:
    return name.replace("-", "_")


def all_tasks() -> list[dict]:
    tasks = [
        {
            "id": f"acme-orders/{path.name}",
            "group": "tuned",
            "project": "acme-orders",
            "user": LONG_USER,
            "source": longhistory2,
            "request": (path / "request.txt").read_text().strip(),
            "test": (path / "hidden.test.mjs").read_text(),
            "readme": None,
            "collection": "long_unseen",
        }
        for path in sorted(HARD.iterdir())
    ]
    for name in projects.PROJECTS:
        project = projects.Project(name)
        for task in project.tasks:
            tasks.append(
                {
                    "id": f"{name}/{task['name']}",
                    "group": "unseen",
                    "project": name,
                    "user": project_user(name),
                    "source": project,
                    "request": task["request"],
                    "test": hidden_test(task),
                    "readme": project.spec["readme"],
                    "collection": collection(name),
                }
            )
    return tasks


def repo_for(task: dict) -> Path:
    repo = workspace()
    if task["readme"] is not None:
        (repo / "README.md").write_text(f"# {task['project']}\n\n{task['readme']}\n")
        (repo / "package.json").write_text(
            json.dumps(
                {"name": task["project"], "version": "1.0.0", "private": True,
                 "type": "module", "scripts": {"test": "node --test"}},
                indent=2,
            )
        )
        (repo / "src" / "index.mjs").write_text(
            f'export const SERVICE_NAME = "{task["project"]}";\n'
        )
    return repo


class Context:
    """Builds each setup's extra context. Built once: embedding is slow."""

    def __init__(self) -> None:
        self.rag: dict[str, Index] = {}
        self.mem0: dict = {}

    def excerpts(self, task: dict) -> str:
        key = task["project"]
        if key not in self.rag:
            self.rag[key] = Index(task["source"].transcript())
        return "\n---\n".join(self.rag[key].search(task["request"]))

    def mem0_notes(self, task: dict, top_k: int, think: bool = True) -> str:
        from agent_eval import mem0_baseline

        key = task["collection"]
        if key not in self.mem0:
            self.mem0[key] = mem0_baseline.client(key, think)
        return "\n".join(f"- {text}" for text in mem0_baseline.search(self.mem0[key], task["request"], top_k))


def run_one(task: dict, setup: str, context: Context) -> dict:
    with tempfile.TemporaryDirectory(prefix="config-") as config:
        folder = Path(config)
        extra = ["--settings", str(sealed_settings(folder))]
        prompt = task["request"]
        if setup == "full_history":
            prompt = f"Transcript of our earlier sessions:\n{task['source'].transcript()}\n\nNow: {prompt}"
        elif setup == "rag":
            prompt = f"Excerpts from our earlier sessions:\n{context.excerpts(task)}\n\nNow: {prompt}"
        elif setup in ("mem0", "mem0_budget", "mem0_w3", FAIR):
            top_k = TOP_K if setup == "mem0" else FULL_BUDGET_K
            if setup == "mem0_w3":
                task = {**task, "collection": f"{task['collection']}_w3"}
            if setup == FAIR:
                task = {**task, "collection": f"{task['collection']}_fair"}
            notes = context.mem0_notes(task, top_k, think=setup != FAIR)
            prompt = f"Memories from our earlier sessions:\n{notes}\n\nNow: {prompt}"
        elif setup == "memory":
            settings, mcp = memory_settings(folder, task["user"], task["project"])
            hooks = json.loads(settings.read_text())
            hooks["hooks"].pop("SessionEnd")
            settings.write_text(json.dumps(hooks))
            extra = ["--settings", str(settings), "--mcp-config", str(mcp), *READ_ONLY]
        repo = repo_for(task)
        second = claude(prompt, repo, str(uuid.uuid4()), extra)
        (repo / "hidden.test.mjs").write_text(task["test"])
        done = subprocess.run(
            ["node", "--test", "hidden.test.mjs"], cwd=repo, capture_output=True,
            text=True, timeout=60,
        )
        shutil.rmtree(repo.parent, ignore_errors=True)
    second["text"] = second["text"][:600]
    return {"passed": done.returncode == 0, "second": second}


def finished() -> set[tuple[str, str, int]]:
    if not RUNS.exists():
        return set()
    rows = [json.loads(line) for line in RUNS.read_text().splitlines()]
    return {(row["task"], row["setup"], row["repeat"]) for row in rows}


def fair_ready(task: dict) -> bool:
    """A _fair store counts once seeding finished, which writes its store file."""
    name = "long" if task["project"] == "acme-orders" else task["project"]
    return any((ROOT / "eval" / "results").glob(f"*/mem0-{name}-fair-store.json"))


def hit_limit(row: dict) -> bool:
    text = row["second"]["text"].lower()
    return row["second"]["is_error"] and any(word in text for word in LIMIT_WORDS)


def run_all(setups: list[str] = SETUPS) -> None:
    RUNS.parent.mkdir(exist_ok=True)
    context = Context()
    done = finished()
    tasks = all_tasks()
    total = len(tasks) * len(SETUPS) * REPEATS
    print(f"{len(done)} of {total} already finished", flush=True)
    for repeat in range(REPEATS):
        for task in tasks:
            for setup in setups:
                key = (task["id"], setup, repeat)
                # Seeding at 3 turns runs about 70 calls an hour here, so only one
                # project was reseeded: about 7 hours, against about 34 for all.
                skip = (setup == "mem0_w3" and task["project"] != MEM0_W3_PROJECT) or (
                    setup == FAIR and not fair_ready(task)
                )
                if key in done or skip:
                    continue
                row = run_one(task, setup, context)
                if hit_limit(row):
                    print("usage limit reached, stopping. Run again to carry on.", flush=True)
                    print(row["second"]["text"][:200], flush=True)
                    return
                row.update(task=task["id"], group=task["group"], setup=setup, repeat=repeat)
                with RUNS.open("a") as file:
                    file.write(json.dumps(row) + "\n")
                done.add(key)
                print(
                    f"{len(done)}/{total} {task['id']} {setup} r{repeat} "
                    f"passed={row['passed']} cost={row['second']['cost_usd_equivalent']}",
                    flush=True,
                )
    print("finished", total, "runs", flush=True)


def seed_projects() -> None:
    for name in projects.PROJECTS:
        project = projects.Project(name)
        started = time.time()
        store = seed(project_user(name), project, name)
        store["seconds"] = round(time.time() - started)
        store["noise_memories"] = [t for t in store["memories"] if is_noise(t, project)]
        print("wrote", write_results(f"project-{name}-store", store), flush=True)
        print({k: v for k, v in store.items() if k != "memories"}, flush=True)


def seed_mem0(only: list[str] | None = None) -> None:
    """Seeds the _fair stores, one source at a time. Names: projects or "long"."""
    from agent_eval import mem0_baseline

    sources = {name: (projects.Project(name), collection(name)) for name in projects.PROJECTS}
    sources["long"] = (longhistory2, "long_unseen")
    for name, (source, base) in sources.items():
        if only and name not in only:
            continue
        store = mem0_baseline.seed(
            source, f"{base}_fair", mem0_baseline.FAIR_WINDOW_TURNS, think=False
        )
        print("wrote", write_results(f"mem0-{name}-fair-store", store), flush=True)
        print({k: v for k, v in store.items() if k != "memories"}, flush=True)


if __name__ == "__main__":
    if sys.argv[1] == "run" and len(sys.argv) > 2:
        run_all(sys.argv[2].split(","))
    elif sys.argv[1] == "mem0" and len(sys.argv) > 2:
        seed_mem0(sys.argv[2].split(","))
    else:
        {"seed": seed_projects, "mem0": seed_mem0, "run": run_all}[sys.argv[1]]()

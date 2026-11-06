"""Does memory help a real agent in a second session?

Session 1 makes a decision in conversation only, so nothing lands in the repo.
Session 2 needs that decision. Hidden tests are copied in only afterwards.

Sessions run in different folders, so Claude Code's own per-project memory
cannot carry the decision across and contaminate the comparison.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

from agent_eval.client import API_KEY, ROOT, URL, rest, wait_for_distill, write_results

CODING = ROOT / "eval" / "coding"
MODEL = "haiku"
SETUPS = ["none", "full_history", "memory"]
TOOLS = "Read,Write,Edit,Glob,Grep,Bash(node --test*),mcp__memory__*"
RUN_TIMEOUT = 300


# The home folder holds earlier agent transcripts, and the eval's hidden tests.
# Agents searched it in the long-history run, so no setup may read it.
SEALED = {"permissions": {"deny": ["Read(~/**)", "Edit(~/**)"]}}


def sealed_settings(folder: Path) -> Path:
    settings = folder / "sealed.json"
    settings.write_text(json.dumps(SEALED))
    return settings


def workspace() -> Path:
    path = Path(tempfile.mkdtemp(prefix="coding-"))
    shutil.copytree(CODING / "repo", path / "repo")
    return path / "repo"


def memory_settings(folder: Path, user: str, project: str) -> tuple[Path, Path]:
    env = f"MEMORY_URL={URL} MEMORY_API_KEY={API_KEY} MEMORY_USER={user} MEMORY_PROJECT={project}"
    adapters = ROOT / "packages" / "adapters" / "dist"
    hook = lambda name: [  # noqa: E731
        {"hooks": [{"type": "command", "command": f"{env} node {adapters}/{name}.js"}]}
    ]
    settings = folder / "settings.json"
    settings.write_text(
        json.dumps(
            {
                **SEALED,
                "hooks": {"SessionStart": hook("context"), "SessionEnd": hook("capture")},
            }
        )
    )
    mcp = folder / "mcp.json"
    mcp.write_text(
        json.dumps(
            {
                "mcpServers": {
                    "memory": {
                        "command": "node",
                        "args": [
                            str(ROOT / "packages/server/dist/cli.js"),
                            "--url", URL, "--user", user, "--project", project,
                        ],
                        "env": {"MEMORY_API_KEY": API_KEY},
                    }
                }
            }
        )
    )
    return settings, mcp


def claude(prompt: str, cwd: Path, session_id: str, extra: list[str]) -> dict:
    command = [
        "claude", "-p", prompt, "--model", MODEL, "--output-format", "json",
        "--session-id", session_id, "--strict-mcp-config",
        # Project settings only: personal instructions must not shape results.
        "--setting-sources", "project,local",
        "--allowedTools", TOOLS, *extra,
    ]
    started = time.monotonic()
    done = subprocess.run(
        command, cwd=cwd, capture_output=True, text=True, timeout=RUN_TIMEOUT,
        stdin=subprocess.DEVNULL,
    )
    try:
        output = json.loads(done.stdout)
    except json.JSONDecodeError:
        raise RuntimeError(f"claude failed: {done.stdout[-300:]} {done.stderr[-300:]}") from None
    usage = output.get("usage", {})
    return {
        "text": output.get("result", ""),
        "is_error": output.get("is_error", False),
        "seconds": round(time.monotonic() - started, 1),
        "cost_usd_equivalent": output.get("total_cost_usd"),
        "input_tokens": usage.get("input_tokens", 0)
        + usage.get("cache_read_input_tokens", 0)
        + usage.get("cache_creation_input_tokens", 0),
        "output_tokens": usage.get("output_tokens", 0),
    }


def hidden_tests_pass(repo: Path, task: str) -> dict:
    shutil.copy(CODING / "tasks" / task / "hidden.test.mjs", repo / "hidden.test.mjs")
    done = subprocess.run(
        ["node", "--test", "hidden.test.mjs"], cwd=repo, capture_output=True,
        text=True, timeout=60,
    )
    return {"passed": done.returncode == 0, "tail": done.stdout[-500:]}


def run(task: str, setup: str, repeat: int) -> dict:
    spec = json.loads((CODING / "tasks" / task / "task.json").read_text())
    tag = f"{task}-{setup}-{repeat}-{int(time.time())}"
    user, project = f"code-{tag}", "acme-orders"
    with tempfile.TemporaryDirectory(prefix="config-") as config:
        extra = ["--settings", str(sealed_settings(Path(config)))]
        if setup == "memory":
            settings, mcp = memory_settings(Path(config), user, project)
            extra = ["--settings", str(settings), "--mcp-config", str(mcp)]

        first = None
        request = spec["request"]
        distilled = None
        if setup != "none":
            first_id = str(uuid.uuid4())
            first = claude(spec["decision"], workspace(), first_id, extra)
            if setup == "full_history":
                request = (
                    "Transcript of our earlier session:\n"
                    f"user: {spec['decision']}\nassistant: {first['text']}\n\n"
                    f"Now: {spec['request']}"
                )
            else:
                with rest(user) as client:
                    client.headers["x-memory-project"] = project
                    distilled = wait_for_distill(client, first_id)

        repo = workspace()
        second = claude(request, repo, str(uuid.uuid4()), extra)
        scored = hidden_tests_pass(repo, task)
        shutil.rmtree(repo.parent, ignore_errors=True)

    return {
        "task": task,
        "setup": setup,
        "repeat": repeat,
        "passed": scored["passed"],
        "test_tail": scored["tail"],
        "distilled": distilled,
        "first": first,
        "second": second,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tasks", nargs="*")
    parser.add_argument("--setups", nargs="*", default=SETUPS)
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--name", default="coding-pilot")
    args = parser.parse_args()
    tasks = args.tasks or sorted(p.name for p in (CODING / "tasks").iterdir())

    rows = []
    for task in tasks:
        for setup in args.setups:
            for repeat in range(args.repeats):
                row = run(task, setup, repeat)
                rows.append(row)
                print(
                    f"{task} {setup} passed={row['passed']} "
                    f"s2={row['second']['seconds']}s "
                    f"cost={row['second']['cost_usd_equivalent']} "
                    f"distilled={row['distilled']}",
                    flush=True,
                )
    summary = {
        setup: {
            "passed": sum(r["passed"] for r in rows if r["setup"] == setup),
            "runs": sum(r["setup"] == setup for r in rows),
        }
        for setup in args.setups
    }
    calls = [r[key] for r in rows for key in ("first", "second") if r[key]]
    usage = {
        "claude_calls": len(calls),
        "seconds": sum(c["seconds"] for c in calls),
        "cost_usd_equivalent": sum(c["cost_usd_equivalent"] or 0 for c in calls),
    }
    print(summary, usage)
    print("wrote", write_results(args.name, {"model": MODEL, "summary": summary, "usage": usage, "rows": rows}))


if __name__ == "__main__":
    sys.exit(main())

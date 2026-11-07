"""Proves every project task is fair: its hidden test passes on a reference solution."""

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "datasets"))

import projects  # noqa: E402


def module_path(request: str) -> str:
    return request.split()[1]


def exports(task: dict) -> str:
    return task["request"].split("exporting ")[1].split("(")[0]


def hidden_test(task: dict) -> str:
    path = module_path(task["request"])
    return (
        'import assert from "node:assert/strict";\n'
        'import { test } from "node:test";\n'
        f'import {{ {exports(task)} }} from "./{path}";\n\n'
        f'test("{task["name"]}", () => {{\n{task["test"]}\n}});\n'
    )


def check(task: dict) -> bool:
    folder = Path(tempfile.mkdtemp(prefix="fair-"))
    try:
        target = folder / module_path(task["request"])
        target.parent.mkdir()
        target.write_text(task["solution"] + "\n")
        (folder / "package.json").write_text('{"type": "module"}')
        (folder / "hidden.test.mjs").write_text(hidden_test(task))
        done = subprocess.run(
            ["node", "--test", "hidden.test.mjs"], cwd=folder, capture_output=True, text=True,
        )
        if done.returncode != 0:
            print(task["name"], done.stdout[-600:])
        return done.returncode == 0
    finally:
        shutil.rmtree(folder, ignore_errors=True)


if __name__ == "__main__":
    tasks = [t for spec in projects.PROJECTS.values() for t in spec["tasks"]]
    passed = sum(check(task) for task in tasks)
    print(f"{passed} of {len(tasks)} hidden tests pass on their reference solutions")
    sys.exit(passed != len(tasks))

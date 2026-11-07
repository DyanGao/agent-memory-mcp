"""Answer accuracy on LoCoMo, with Claude answering and judging on the subscription.

LoCoMo is CC BY-NC 4.0, so its text stays in the git-ignored raw folder: the run
file and the label sheet live there, and committed results hold only scores.
"""

import csv
import json
import random
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from agent_eval.client import ROOT, rest, wait_for_distill, write_results
from agent_eval.coding import MODEL
from agent_eval.rag import Index

RAW = ROOT / "eval" / "datasets" / "raw"
RUNS = RAW / "qa-runs.jsonl"
SHEET = RAW / "label-sheet.csv"
SEED = 20261109
PER_CONVERSATION = 15
SHEET_SIZE = 50
SHEET_SETUPS = ("rag", "full_history", "memory-off")
SETUPS = ["none", "memory", "rag", "mem0", "full_history"]
PROJECT = "locomo"
TIMEOUT = 180

JUDGE = """You grade an answer against the correct answer. Reply with JSON only: {{"correct": true}} or {{"correct": false}}.

Correct means the answer states the same fact, in any wording. Small differences in date format are fine. An answer that hedges, says it does not know, or adds a wrong fact is not correct.

Question: {question}
Correct answer: {gold}
Answer to grade: {answer}"""


def conversations() -> list[dict]:
    return json.loads((RAW / "locomo10.json").read_text())


def turns(conversation: dict) -> list[list[str]]:
    talk = conversation["conversation"]
    keys = [key for key in talk if key.startswith("session_") and not key.endswith("date_time")]
    keys.sort(key=lambda key: int(key.split("_")[1]))
    sessions = []
    for key in keys:
        when = talk.get(f"{key}_date_time", "")
        sessions.append([f"[{when}] {t['speaker']}: {t['text']}" for t in talk[key]])
    return sessions


def text_of(conversation: dict) -> str:
    return "\n".join(line for session in turns(conversation) for line in session)


def questions() -> list[dict]:
    """A fixed sample. Category 5 is left out: it has no correct answer to grade."""
    rng = random.Random(SEED)
    picked = []
    for conversation in conversations():
        pool = [q for q in conversation["qa"] if "answer" in q and q.get("category") != 5]
        for q in rng.sample(pool, PER_CONVERSATION):
            picked.append(
                {
                    "id": f"{conversation['sample_id']}-{conversation['qa'].index(q)}",
                    "conversation": conversation,
                    "category": q["category"],
                    "question": q["question"],
                    "gold": str(q["answer"]),
                }
            )
    return picked


def user_for(conversation: dict, variant: str) -> str:
    return f"locomo-{variant}-{conversation['sample_id']}".replace("_", "-")


def seed(variant: str) -> None:
    started = time.time()
    written = 0
    for conversation in conversations():
        user = user_for(conversation, variant)
        with rest(user) as client:
            client.headers["x-memory-project"] = PROJECT
            for number, session in enumerate(turns(conversation)):
                events = [
                    {"seq": index, "kind": "user_text", "text": line}
                    for index, line in enumerate(session)
                ]
                session_id = f"{user}-{number}"
                client.post(
                    "/v1/events", json={"session_id": session_id, "events": events, "final": True}
                ).raise_for_status()
                status = wait_for_distill(client, session_id, timeout=3600)
                if status["status"] != "done":
                    raise RuntimeError(f"{session_id} failed: {status['status']}")
                written += status["memoriesWritten"]
        print(f"{user}: {written} written so far", flush=True)
    print(variant, "seconds", round(time.time() - started), "written", written, flush=True)


def seed_mem0() -> None:
    from agent_eval import mem0_baseline

    for conversation in conversations():
        key = f"locomo_{conversation['sample_id']}".replace("-", "_")
        memory = mem0_baseline.client(key)
        lines = [line for session in turns(conversation) for line in session]
        window = mem0_baseline.FAIR_WINDOW_TURNS
        for start in range(0, len(lines), window):
            messages = [
                {"role": "user", "content": line}
                for line in lines[start : start + window]
            ]
            memory.add(messages, user_id=mem0_baseline.USER)
        print(key, "done", flush=True)


def ask(prompt: str) -> dict:
    with tempfile.TemporaryDirectory(prefix="qa-") as folder:
        done = subprocess.run(
            ["claude", "-p", prompt, "--model", MODEL, "--output-format", "json",
             "--tools", "", "--strict-mcp-config", "--setting-sources", "project,local"],
            cwd=folder, capture_output=True, text=True, timeout=TIMEOUT, stdin=subprocess.DEVNULL,
        )
    try:
        output = json.loads(done.stdout)
    except json.JSONDecodeError:
        raise RuntimeError(f"claude failed: {done.stdout[-200:]} {done.stderr[-200:]}") from None
    return {
        "text": output.get("result", ""),
        "is_error": output.get("is_error", False),
        "cost": output.get("total_cost_usd") or 0,
    }


def judged(question: dict, answer: str) -> dict:
    reply = ask(JUDGE.format(question=question["question"], gold=question["gold"], answer=answer))
    start, end = reply["text"].find("{"), reply["text"].rfind("}")
    verdict = json.loads(reply["text"][start : end + 1])
    return {"correct": bool(verdict["correct"]), "cost": reply["cost"], "is_error": reply["is_error"]}


class Contexts:
    def __init__(self) -> None:
        self.rag: dict[str, Index] = {}
        self.mem0: dict = {}

    def get(self, question: dict, setup: str, variant: str) -> str:
        conversation = question["conversation"]
        name = conversation["sample_id"]
        if setup == "full_history":
            return text_of(conversation)
        if setup == "rag":
            if name not in self.rag:
                self.rag[name] = Index(text_of(conversation))
            return "\n---\n".join(self.rag[name].search(question["question"]))
        if setup == "mem0":
            from agent_eval import mem0_baseline

            key = f"locomo_{name}".replace("-", "_")
            if key not in self.mem0:
                self.mem0[key] = mem0_baseline.client(key)
            return "\n".join(mem0_baseline.search(self.mem0[key], question["question"]))
        with rest(user_for(conversation, variant)) as client:
            client.headers["x-memory-project"] = PROJECT
            found = client.post("/v1/context", json={"task": question["question"]}).json()
            return "\n".join(memory["content"] for memory in found["memories"])


def finished() -> set[tuple[str, str]]:
    if not RUNS.exists():
        return set()
    rows = [json.loads(line) for line in RUNS.read_text().splitlines()]
    return {(row["id"], row["setup"]) for row in rows}


def run(setups: list[str], variant: str = "checked") -> None:
    done = finished()
    contexts = Contexts()
    for question in questions():
        for setup in setups:
            label = setup if variant == "checked" or setup != "memory" else f"memory-{variant}"
            if (question["id"], label) in done:
                continue
            notes = "" if setup == "none" else contexts.get(question, setup, variant)
            prompt = (
                f"Notes from earlier conversations:\n{notes}\n\n"
                f"Answer in one short sentence, using the notes.\nQuestion: {question['question']}"
                if notes
                else f"Answer in one short sentence.\nQuestion: {question['question']}"
            )
            reply = ask(prompt)
            if reply["is_error"]:
                print("stopping:", reply["text"][:200], flush=True)
                return
            verdict = judged(question, reply["text"])
            if verdict["is_error"]:
                print("stopping at judge", flush=True)
                return
            row = {
                "id": question["id"],
                "category": question["category"],
                "setup": label,
                "answer": reply["text"],
                "correct": verdict["correct"],
                "context_chars": len(notes),
                "cost": reply["cost"] + verdict["cost"],
            }
            with RUNS.open("a") as file:
                file.write(json.dumps(row) + "\n")
            print(question["id"], label, row["correct"], flush=True)


def summary() -> None:
    rows = [json.loads(line) for line in RUNS.read_text().splitlines()]
    result = {}
    for setup in sorted({row["setup"] for row in rows}):
        picked = [row for row in rows if row["setup"] == setup]
        result[setup] = {
            "questions": len(picked),
            "accuracy": round(sum(row["correct"] for row in picked) / len(picked), 3),
            "mean_context_chars": round(statistics.mean(row["context_chars"] for row in picked)),
            "cost": round(sum(row["cost"] for row in picked), 3),
        }
    print("wrote", write_results("qa-locomo", result))
    print(result)


def agreement() -> None:
    """Compares the judge with the person's marks: y or n in the last column."""
    with SHEET.open(newline="") as file:
        marks = [row["your_label"].strip().lower() for row in csv.DictReader(file)]
    verdicts = json.loads((RAW / "label-sheet-key.json").read_text())
    pairs = [(mark == "y", verdict) for mark, verdict in zip(marks, verdicts) if mark in ("y", "n")]
    agreed = sum(person == judge for person, judge in pairs)
    result = {"labelled": len(pairs), "agreed": agreed, "agreement": round(agreed / len(pairs), 3)}
    print("wrote", write_results("judge-agreement", result))
    print(result)


def sheet() -> None:
    """Fifty answers for a person to mark, half of each verdict, verdict hidden."""
    rows = [json.loads(line) for line in RUNS.read_text().splitlines()]
    # No memory and the small store nearly always refuse, which tests nothing.
    rows = [row for row in rows if row["setup"] in SHEET_SETUPS]
    by_id = {question["id"]: question for question in questions()}
    rng = random.Random(SEED)
    right = [row for row in rows if row["correct"]]
    wrong = [row for row in rows if not row["correct"]]
    half = SHEET_SIZE // 2
    picked = rng.sample(right, min(half, len(right))) + rng.sample(wrong, min(half, len(wrong)))
    rng.shuffle(picked)
    with SHEET.open("w", newline="") as file:
        writer = csv.writer(file)
        writer.writerow(["row", "question", "correct_answer", "system_answer", "your_label"])
        for number, row in enumerate(picked, start=1):
            question = by_id[row["id"]]
            writer.writerow([number, question["question"], question["gold"], row["answer"], ""])
    (RAW / "label-sheet-key.json").write_text(json.dumps([row["correct"] for row in picked]))
    print("wrote", SHEET)


if __name__ == "__main__":
    command = sys.argv[1]
    if command == "seed":
        seed(sys.argv[2])
    elif command == "mem0":
        seed_mem0()
    elif command == "run":
        run(sys.argv[2].split(","), *sys.argv[3:])
    elif command == "summary":
        summary()
    elif command == "sheet":
        sheet()
    elif command == "agreement":
        agreement()

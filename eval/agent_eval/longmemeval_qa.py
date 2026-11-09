"""Answer accuracy on LongMemEval (MIT), the same way as LoCoMo in qa.py.

Each question has its own history of about 50 sessions and 490,000 characters,
so memory is seeded once per question, not once per conversation. That makes
seeding the slow part. Runs and seeding progress are kept in the raw folder and
resume if stopped.

python -m agent_eval.longmemeval_qa show | seed | run [setups] | summary
"""

import json
import random
import statistics
import sys
import time

from agent_eval.client import rest, wait_for_distill, write_results
from agent_eval.qa import RAW, ask, judged
from agent_eval.rag import Index

SOURCE = RAW / "longmemeval_s_cleaned.json"
RUNS = RAW / "lme-runs.jsonl"
SEEDED = RAW / "lme-seeded.json"
SEED = 20261110
PER_TYPE = 4
REPEATS = 3
SETUPS = ["none", "memory", "rag", "full_history"]
PROJECT = "longmemeval"
PREFERENCE = "single-session-preference"

# Preference questions are graded against a description of what the user would
# want, as LongMemEval's own judge does, not against one fact.
PREFERENCE_JUDGE = """You grade a reply against a description of what the user would prefer. Reply with JSON only: {{"correct": true}} or {{"correct": false}}.

Correct means the reply follows the user's preference as described, using what it knows about them. It does not need to cover every point. A generic reply that ignores the preference is not correct.

Question: {question}
Preference: {gold}
Reply to grade: {answer}"""


def questions() -> list[dict]:
    """A fixed sample, 4 per question type.

    Abstention questions (ids ending _abs) are left out: their right answer is
    that the history does not say, and the judge marks "I don't know" wrong.
    """
    data = [q for q in json.loads(SOURCE.read_text()) if not q["question_id"].endswith("_abs")]
    rng = random.Random(SEED)
    picked = []
    for kind in sorted({q["question_type"] for q in data}):
        pool = sorted((q for q in data if q["question_type"] == kind), key=lambda q: q["question_id"])
        picked += rng.sample(pool, PER_TYPE)
    return [
        {
            "id": q["question_id"],
            "category": q["question_type"],
            "question": q["question"],
            "gold": str(q["answer"]),
            "date": q["question_date"],
            "sessions": [
                [f"[{when}] {turn['role']}: {turn['content']}" for turn in session]
                for when, session in zip(q["haystack_dates"], q["haystack_sessions"])
            ],
            "roles": [[turn["role"] for turn in session] for session in q["haystack_sessions"]],
        }
        for q in picked
    ]


def text_of(question: dict) -> str:
    return "\n".join(line for session in question["sessions"] for line in session)


def user_for(question: dict) -> str:
    return f"lme-{question['id']}"


def seeded() -> dict:
    return json.loads(SEEDED.read_text()) if SEEDED.exists() else {}


def seed() -> None:
    """Sends each question's sessions to the memory server, one question at a time."""
    done = seeded()
    for question in questions():
        if question["id"] in done:
            continue
        started = time.time()
        user = user_for(question)
        written = 0
        with rest(user) as client:
            client.headers["x-memory-project"] = PROJECT
            for number, (lines, roles) in enumerate(zip(question["sessions"], question["roles"])):
                events = [
                    {"seq": index, "kind": "user_text" if role == "user" else "assistant_text",
                     "text": line}
                    for index, (line, role) in enumerate(zip(lines, roles))
                ]
                session_id = f"{user}-{number}"
                client.post(
                    "/v1/events", json={"session_id": session_id, "events": events, "final": True}
                ).raise_for_status()
                status = wait_for_distill(client, session_id, timeout=3600)
                if status["status"] != "done":
                    raise RuntimeError(f"{session_id} failed: {status['status']}")
                written += status["memoriesWritten"]
        done[question["id"]] = {"seconds": round(time.time() - started), "written": written}
        SEEDED.write_text(json.dumps(done, indent=1))
        print(question["id"], done[question["id"]], f"{len(done)} of {len(questions())}", flush=True)


def context(question: dict, setup: str, indexes: dict) -> str:
    if setup == "full_history":
        return text_of(question)
    if setup == "rag":
        if question["id"] not in indexes:
            indexes[question["id"]] = Index(text_of(question))
        return "\n---\n".join(indexes[question["id"]].search(question["question"]))
    with rest(user_for(question)) as client:
        client.headers["x-memory-project"] = PROJECT
        found = client.post("/v1/context", json={"task": question["question"]}).json()
        return "\n".join(memory["content"] for memory in found["memories"])


def prompt_for(question: dict, notes: str) -> str:
    asked = f"Today is {question['date']}.\nQuestion: {question['question']}"
    length = "in a few sentences" if question["category"] == PREFERENCE else "in one short sentence"
    if not notes:
        return f"Answer {length}.\n{asked}"
    return (
        f"Notes from earlier conversations:\n{notes}\n\n"
        f"Answer {length}, using the notes.\n{asked}"
    )


def grade(question: dict, answer: str) -> dict:
    if question["category"] != PREFERENCE:
        return judged(question, answer)
    reply = ask(PREFERENCE_JUDGE.format(question=question["question"], gold=question["gold"],
                                        answer=answer))
    start, end = reply["text"].find("{"), reply["text"].rfind("}")
    verdict = json.loads(reply["text"][start : end + 1])
    return {"correct": bool(verdict["correct"]), "cost": reply["cost"], "is_error": reply["is_error"]}


def finished() -> set[tuple[str, str, int]]:
    if not RUNS.exists():
        return set()
    return {
        (row["id"], row["setup"], row["repeat"])
        for row in map(json.loads, RUNS.read_text().splitlines())
    }


def run(setups: list[str]) -> None:
    done = finished()
    ready = seeded()
    indexes: dict = {}
    for repeat in range(REPEATS):
        for question in questions():
            for setup in setups:
                if (question["id"], setup, repeat) in done:
                    continue
                if setup == "memory" and question["id"] not in ready:
                    continue
                notes = "" if setup == "none" else context(question, setup, indexes)
                reply = ask(prompt_for(question, notes))
                if reply["is_error"]:
                    raise SystemExit(f"stopping: {reply['text'][:200]}")
                verdict = grade(question, reply["text"])
                if verdict["is_error"]:
                    raise SystemExit("stopping at judge")
                row = {
                    "id": question["id"],
                    "category": question["category"],
                    "setup": setup,
                    "repeat": repeat,
                    "answer": reply["text"],
                    "correct": verdict["correct"],
                    "context_chars": len(notes),
                    "cost": reply["cost"] + verdict["cost"],
                }
                with RUNS.open("a") as file:
                    file.write(json.dumps(row) + "\n")
                done.add((question["id"], setup, repeat))
                print(question["id"], setup, repeat, row["correct"], flush=True)


def summary() -> None:
    rows = [json.loads(line) for line in RUNS.read_text().splitlines()]
    result: dict = {"seeding": seeded(), "setups": {}}
    for setup in sorted({row["setup"] for row in rows}):
        picked = [row for row in rows if row["setup"] == setup]
        rates = []
        for repeat in sorted({row["repeat"] for row in picked}):
            one = [row for row in picked if row["repeat"] == repeat]
            rates.append(sum(row["correct"] for row in one) / len(one))
        by_type = {}
        for kind in sorted({row["category"] for row in picked}):
            typed = [row for row in picked if row["category"] == kind]
            by_type[kind] = round(sum(row["correct"] for row in typed) / len(typed), 3)
        result["setups"][setup] = {
            "questions": len({row["id"] for row in picked}),
            "runs": len(rates),
            "accuracy": round(statistics.mean(rates), 3),
            "std": round(statistics.pstdev(rates), 3),
            "by_type": by_type,
            "mean_context_chars": round(statistics.mean(row["context_chars"] for row in picked)),
            "cost": round(sum(row["cost"] for row in picked), 3),
        }
    print("wrote", write_results("qa-longmemeval", result))
    print(json.dumps(result["setups"], indent=1))


def show() -> None:
    """The sample and one prompt, with no model call, to check before a long run."""
    sample = questions()
    for question in sample:
        print(question["id"], question["category"], len(question["sessions"]), "sessions,",
              len(text_of(question)), "chars |", question["question"][:70], "|", question["gold"][:40])
    print(prompt_for(sample[0], "(notes)"))


if __name__ == "__main__":
    command = sys.argv[1]
    if command == "show":
        show()
    elif command == "seed":
        seed()
    elif command == "run":
        run(sys.argv[2].split(",") if len(sys.argv) > 2 else SETUPS)
    elif command == "summary":
        summary()
    else:
        raise SystemExit(f"unknown command {command}")

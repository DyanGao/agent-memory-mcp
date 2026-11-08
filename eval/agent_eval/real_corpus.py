"""Builds a 100,000-memory corpus of real text, with real bge-m3 vectors.

Synthetic vectors left scale unresolved: clustered ones kept recall near 1.0
and random ones fell to 0.26. LongMemEval (MIT) has real chat turns, and marks
the turns that hold each question's answer, so the same corpus also scores
which parts of search find them.

Output goes to the git-ignored raw folder: texts, float32 vectors, and the
questions with the corpus rows that answer them. Embedding resumes if stopped.
"""

import json
import random
import struct
import sys
from pathlib import Path

import httpx

RAW = Path(__file__).resolve().parents[1] / "datasets" / "raw"
SOURCE = RAW / "longmemeval_s_cleaned.json"
OUT = RAW / "real-corpus"
SIZE = 100_000
MAX_CHARS = 2000
SEED = 20261108
BATCH = 32
OLLAMA = "http://127.0.0.1:11434"
DIMENSION = 1024


def build() -> None:
    data = json.loads(SOURCE.read_text())
    index: dict[str, int] = {}
    answers: set[str] = set()
    for question in data:
        for session in question["haystack_sessions"]:
            for turn in session:
                text = turn["content"].strip()[:MAX_CHARS]
                if not text:
                    continue
                index.setdefault(text, len(index))
                if turn.get("has_answer"):
                    answers.add(text)
    others = [text for text in index if text not in answers]
    random.Random(SEED).shuffle(others)
    texts = sorted(answers) + others[: SIZE - len(answers)]
    row = {text: number for number, text in enumerate(texts)}

    queries = []
    for question in data:
        gold = set()
        for session in question["haystack_sessions"]:
            for turn in session:
                text = turn["content"].strip()[:MAX_CHARS]
                if turn.get("has_answer") and text in row:
                    gold.add(row[text])
        if gold:
            queries.append(
                {"id": question["question_id"], "type": question["question_type"],
                 "question": question["question"], "gold": sorted(gold)}
            )
    OUT.mkdir(exist_ok=True)
    (OUT / "texts.jsonl").write_text("".join(json.dumps(t) + "\n" for t in texts))
    (OUT / "queries.json").write_text(json.dumps(queries))
    print(len(texts), "texts,", len(answers), "answer turns,", len(queries), "questions")


def embed_file(texts: list[str], path: Path) -> None:
    """Appends vectors in order, so a stopped run carries on where it was."""
    done = path.stat().st_size // (DIMENSION * 4) if path.exists() else 0
    with httpx.Client(timeout=600) as client, path.open("ab") as file:
        for start in range(done - done % BATCH, len(texts), BATCH):
            if start < done:
                continue
            reply = client.post(
                f"{OLLAMA}/api/embed", json={"model": "bge-m3", "input": texts[start : start + BATCH]}
            )
            reply.raise_for_status()
            for vector in reply.json()["embeddings"]:
                file.write(struct.pack(f"<{DIMENSION}f", *vector))
            file.flush()
            if (start // BATCH) % 100 == 0:
                print(f"{path.name}: {start + BATCH} of {len(texts)}", flush=True)


def embed() -> None:
    texts = [json.loads(line) for line in (OUT / "texts.jsonl").read_text().splitlines()]
    queries = json.loads((OUT / "queries.json").read_text())
    embed_file([q["question"] for q in queries], OUT / "queries.f32")
    embed_file(texts, OUT / "texts.f32")
    print("done", flush=True)


IDENTIFIER_COUNT = 200
COMPONENTS = [
    "billing worker", "export job", "login service", "search indexer", "upload queue",
    "invoice renderer", "webhook relay", "cache warmer", "report builder", "sync daemon",
]
CAUSES = [
    ("an expired token", "refreshing the token"),
    ("a full disk", "clearing the temp folder"),
    ("a stale lock", "removing the lock file"),
    ("a missing index", "adding the index"),
    ("a timeout to the database", "raising the pool size"),
    ("a bad config value", "restoring the default config"),
    ("a clock skew between hosts", "syncing the clocks"),
    ("an unhandled empty input", "adding a guard for empty input"),
]
QUESTIONS = ["What causes {code}?", "How do I fix {code}?", "{code} happened again, what is it?"]


def _code(rng: random.Random, number: int) -> str:
    shapes = [
        lambda: f"E{rng.randint(1000, 9999)}",
        lambda: f"TCK-{rng.randint(10000, 99999)}",
        lambda: f"INV_{rng.randint(100, 999)}",
        lambda: f"0x{rng.randint(0x1000, 0xFFFF):04X}",
        lambda: f"{''.join(rng.choice('BCDFGHJKLMNPQRSTVWXZ') for _ in range(3))}-{rng.randint(10, 99)}{rng.choice('ABCDEF')}",
    ]
    return shapes[number % len(shapes)]()


def identifiers() -> None:
    """Exact codes, where keyword search should matter and meaning alone cannot.

    Parts and causes repeat across codes, so only the code itself tells two
    memories apart. LongMemEval has almost none of these.
    """
    rng = random.Random(SEED + 1)
    codes: list[str] = []
    while len(codes) < IDENTIFIER_COUNT:
        code = _code(rng, len(codes))
        if code not in codes:
            codes.append(code)
    texts, queries = [], []
    for number, code in enumerate(codes):
        cause, fix = rng.choice(CAUSES)
        part = rng.choice(COMPONENTS)
        texts.append(f"{code} in the {part} is caused by {cause}, and {fix} fixes it.")
        queries.append({"id": f"id-{number}", "type": "identifier",
                        "question": rng.choice(QUESTIONS).format(code=code), "gold": [number]})
    (OUT / "id-texts.jsonl").write_text("".join(json.dumps(t) + "\n" for t in texts))
    (OUT / "id-queries.json").write_text(json.dumps(queries))
    embed_file([q["question"] for q in queries], OUT / "id-queries.f32")
    embed_file(texts, OUT / "id-texts.f32")
    print(len(texts), "identifier memories and questions")


if __name__ == "__main__":
    {"build": build, "embed": embed, "identifiers": identifiers}[sys.argv[1]]()

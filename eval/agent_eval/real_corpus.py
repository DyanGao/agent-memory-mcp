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


if __name__ == "__main__":
    {"build": build, "embed": embed}[sys.argv[1]]()

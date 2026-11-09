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


HARD_GROUPS = 50
HARD_SIBLINGS = 4
HARD_QUESTIONS = [
    "What causes {code}?",
    "How do I fix {code}?",
    "{code} happened again, what is it?",
    "Seeing {code} in the logs, any idea?",
    "We hit {code} in the {part}. What was the fix last time?",
]


def _near_miss(rng: random.Random, code: str) -> str:
    """Changes one character to another of its kind, or swaps two neighbours."""
    chars = list(code)
    spots = [i for i, c in enumerate(chars) if c.isalnum() and not (i < 2 and code.startswith("0x"))]
    i = rng.choice(spots)
    if rng.random() < 0.5 and i + 1 < len(chars) and chars[i + 1].isalnum() and chars[i] != chars[i + 1] \
            and chars[i].isdigit() == chars[i + 1].isdigit():
        chars[i], chars[i + 1] = chars[i + 1], chars[i]
    elif chars[i].isdigit():
        chars[i] = rng.choice([d for d in "0123456789" if d != chars[i]])
    else:
        pool = "ABCDEF" if code.startswith("0x") else "BCDFGHJKLMNPQRSTVWXZ"
        chars[i] = rng.choice([c for c in pool if c != chars[i]])
    return "".join(chars)


# Fresh wordings for the second held-out set, so that matching on codes is not
# scored on the question shapes it was tuned on.
HELD_OUT_QUESTIONS = [
    "Any notes on {code}?",
    "The {part} threw {code} this morning. Cause?",
    "{code} again. Remind me what fixed it?",
    "What do we know about {code}?",
    "Why does {code} keep showing up?",
]

# Third held-out set, written after id3 showed that a code missed by vector
# search never reaches the top 10. It scores the keyword weight chosen on id2
# and id3, once.
THIRD_QUESTIONS = [
    "Is {code} something we've seen before?",
    "Customer reported {code}. What's the story?",
    "Looking into {code} for the {part} team, background please",
    "Got paged for {code}, how bad is it?",
    "{code}: root cause?",
]


def identifiers_hard(name: str = "id2", seed: int = SEED + 2,
                     questions: list[str] = HARD_QUESTIONS) -> None:
    """Held-out codes that differ from each other by one character.

    Written after the first identifier set scored 1.0 with vector search alone.
    Each group of four shares the component, so only the code separates them,
    and some questions use words that the memory does not. id2 tunes keyword
    matching on codes; id3, written before that change, scores it once.
    """
    rng = random.Random(seed)
    seen: set[str] = set()
    texts, queries = [], []
    while len(texts) < HARD_GROUPS * HARD_SIBLINGS:
        base = _code(rng, len(texts) // HARD_SIBLINGS)
        group = [base]
        while len(group) < HARD_SIBLINGS:
            sibling = _near_miss(rng, rng.choice(group))
            if sibling not in group:
                group.append(sibling)
        if seen & set(group):
            continue
        seen |= set(group)
        part = rng.choice(COMPONENTS)
        for code, (cause, fix) in zip(group, rng.sample(CAUSES, HARD_SIBLINGS)):
            number = len(texts)
            texts.append(f"{code} in the {part} is caused by {cause}, and {fix} fixes it.")
            question = questions[number % len(questions)].format(code=code, part=part)
            queries.append({"id": f"{name}-{number}", "type": "identifier", "question": question,
                            "gold": [number]})
    (OUT / f"{name}-texts.jsonl").write_text("".join(json.dumps(t) + "\n" for t in texts))
    (OUT / f"{name}-queries.json").write_text(json.dumps(queries))
    if "--write-only" not in sys.argv:
        embed_file([q["question"] for q in queries], OUT / f"{name}-queries.f32")
        embed_file(texts, OUT / f"{name}-texts.f32")
    print(len(texts), "near-miss identifier memories and questions")


if __name__ == "__main__":
    {"build": build, "embed": embed, "identifiers": identifiers,
     "identifiers-hard": identifiers_hard,
     "identifiers-held-out": lambda: identifiers_hard("id3", SEED + 3, HELD_OUT_QUESTIONS),
     "identifiers-third": lambda: identifiers_hard("id4", SEED + 4, THIRD_QUESTIONS)}[sys.argv[1]]()

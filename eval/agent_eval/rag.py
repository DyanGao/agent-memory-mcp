"""Naive RAG: raw transcript chunks, nearest by meaning, nothing distilled.

Gets the same 1,500-token budget as memory, about 6,000 characters. It has no
idea which of two versions of a fact is newer, which is the point of comparing.
"""

import hashlib
import json
import math
from pathlib import Path

import httpx

OLLAMA = "http://127.0.0.1:11434"
MODEL = "bge-m3"
CHUNK_CHARS = 1000
OVERLAP_CHARS = 200
TOP_K = 6
CACHE = Path(__file__).resolve().parents[1] / ".rag-cache"


def split(text: str) -> list[str]:
    step = CHUNK_CHARS - OVERLAP_CHARS
    return [text[start : start + CHUNK_CHARS] for start in range(0, len(text), step)]


def embed(texts: list[str]) -> list[list[float]]:
    vectors: list[list[float]] = []
    with httpx.Client(timeout=300) as client:
        for start in range(0, len(texts), 32):
            done = client.post(
                f"{OLLAMA}/api/embed", json={"model": MODEL, "input": texts[start : start + 32]}
            )
            done.raise_for_status()
            vectors.extend(done.json()["embeddings"])
    return vectors


def cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b)) / (math.hypot(*a) * math.hypot(*b))


class Index:
    def __init__(self, text: str) -> None:
        self.chunks = split(text)
        CACHE.mkdir(exist_ok=True)
        path = CACHE / f"{hashlib.sha1(text.encode()).hexdigest()[:12]}.json"
        if path.exists():
            self.vectors = json.loads(path.read_text())
        else:
            self.vectors = embed(self.chunks)
            path.write_text(json.dumps(self.vectors))

    def search(self, query: str) -> list[str]:
        vector = embed([query])[0]
        ranked = sorted(
            zip(self.chunks, self.vectors),
            key=lambda pair: cosine(vector, pair[1]),
            reverse=True,
        )
        return [chunk for chunk, _ in ranked[:TOP_K]]

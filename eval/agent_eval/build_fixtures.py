"""Caches real bge-m3 vectors so CI can gate on them with no model running."""

import base64
import json
import struct
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "datasets"))

from deletion import KEEPERS, facts  # noqa: E402

OUTPUT = Path(__file__).resolve().parents[1] / "fixtures" / "deletion-gate.json"


def embed(texts: list[str]) -> list[list[float]]:
    request = urllib.request.Request(
        "http://127.0.0.1:11434/api/embed",
        json.dumps({"model": "bge-m3", "input": texts}).encode(),
        {"content-type": "application/json"},
    )
    return json.load(urllib.request.urlopen(request))["embeddings"]


def main() -> None:
    items = facts()
    texts = sorted(
        {
            *KEEPERS,
            *(fact["statement"] for fact in items),
            *(fact["exact_topic"] for fact in items),
            *(fact["paraphrase_topic"] for fact in items),
            *(probe for fact in items for probe in fact["probes"]),
        }
    )
    vectors = {
        text: base64.b64encode(struct.pack(f"<{len(vector)}f", *vector)).decode()
        for text, vector in zip(texts, embed(texts))
    }
    OUTPUT.write_text(
        json.dumps({"keepers": KEEPERS, "facts": items, "vectors": vectors}) + "\n"
    )
    print(f"wrote {len(vectors)} vectors, {OUTPUT.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()

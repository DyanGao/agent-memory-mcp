"""A second history, written after the fixes and scored once.

Different subjects and wording from history.py, so a score here cannot come
from tuning against that file. It includes a decision the agent proposes and
the user only approves, which extraction is expected to find hard.
"""

import re

FILLER = [
    ("Could you reformat that table?", "Sure, the columns line up now."),
    ("Why was the pipeline red earlier?", "A flaky network step. A retry cleared it."),
    ("Is everything committed?", "Not yet, there are two uncommitted files."),
    ("Check the changelog entry for me.", "It reads fine, I only fixed a comma."),
    ("Did the smoke test finish?", "Yes, it finished and everything passed."),
    ("Which branch are we on?", "We are on feature/uploads."),
    ("Open that config file.", "Opened it, nothing looks unusual."),
    ("Standup is at ten tomorrow, not nine.", "Thanks, good to know."),
    ("Sort those imports.", "Sorted them alphabetically."),
    ("How many warnings are left?", "Three, all of them in generated code."),
    ("Good, carry on.", "Will do."),
    ("I'm stepping away for a bit.", "No problem."),
    ("Bump the version in the sample file.", "Bumped it to 1.4.2."),
    ("Delete that scratch file.", "Deleted it."),
]

DECISIONS = [
    [
        "Decision: nightly backups run at 02:00 UTC and are kept for 14 days.",
        "Decision: list endpoints use cursor pagination with 50 items per page.",
    ],
    [
        "What should we use for password hashing?",
        "Decision: reports are always generated in the Europe/Berlin timezone.",
    ],
    [
        "Decision: image uploads are limited to 8 MB.",
        "Decision: user sessions time out after 30 minutes.",
    ],
    [
        "Move the backup time to 04:00 UTC instead of 02:00. Keeping them for 14 days does not change.",
        "Decision: admin sessions have their own timeout of 10 minutes.",
    ],
    [
        "Page size goes up to 100 items, replacing 50. It stays cursor based.",
        "Also on uploads: PDF files may go up to 20 MB.",
    ],
    [
        "Decision: deleting a tenant needs approval from two people.",
        "The exception to that: test tenants need no approval.",
    ],
]

# The agent proposes and the user only approves.
AGENT_PROPOSAL = (
    "I suggest Argon2id for password hashing, with a memory cost of 64 MB.",
    "Yes, go with that.",
)

CURRENT = [
    ["04:00"], ["14 days"], ["100"], ["cursor"], ["Argon2id"], ["Berlin"], ["8 MB"],
    ["20 MB"], ["30 minutes"], ["10 minutes"], ["two people"], ["test tenants"],
]
STALE = ["02:00", "50 items", "50 per page"]
NOISE = ["uncommitted", "branch", "changelog", "smoke test", "pipeline", "warnings", "version"]

FILLER_TURNS = 40

_LABEL = re.compile(r"^Decision( (on|for) [^:]+)?:\s*")


def _natural(text: str) -> str:
    """People rarely announce a decision. A label here flattered earlier scores."""
    plain = _LABEL.sub("", text)
    return plain[0].upper() + plain[1:]


def sessions() -> list[list[tuple[str, str]]]:
    history = []
    cursor = 0
    for decisions in DECISIONS:
        turns = []
        for decision in decisions:
            if decision.startswith("What should we use"):
                turns.append((decision, AGENT_PROPOSAL[0]))
                turns.append((AGENT_PROPOSAL[1], "Great, noted."))
            else:
                turns.append((_natural(decision), "Understood."))
            for _ in range(FILLER_TURNS // len(decisions)):
                turns.append(FILLER[cursor % len(FILLER)])
                cursor += 1
        history.append(turns)
    return history

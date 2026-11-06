"""A fifth history, written with the code frozen and scored once."""

FILLER = [
    ("The coffee machine is out of order.", "Sorry to hear it."),
    ("Rename that variable to total.", "Renamed it."),
    ("I'm going to grab a sandwich.", "Enjoy."),
    ("Move this block into its own function.", "Moved it."),
    ("Can you find where that error is raised?", "It is raised in the loader."),
    ("Nina says hi.", "Hi to Nina."),
    ("Undo the last edit.", "Undone."),
    ("That diff looks fine to me.", "Good."),
    ("Is the linter happy?", "Yes, no warnings."),
    ("It's raining again.", "Stay dry."),
    ("Add a newline at the end of the file.", "Added it."),
    ("How long has that test been flaky?", "About a week."),
    ("Let's call it a day.", "See you tomorrow."),
    ("Delete that unused import.", "Deleted it."),
]

DECISIONS = [
    [
        "Shipping labels look like SHP-77-X: SHP, a two-digit depot code and a carrier letter.",
        "Gift cards are valid for 3 years and cannot be refunded.",
    ],
    [
        "How should we send push notifications?",
        "Reviews are moderated within 48 hours.",
    ],
    [
        "Loyalty points expire after 12 months.",
        "Orders over 500 euros need a manager's approval.",
    ],
    [
        "The label prefix is PKG now instead of SHP, the rest of the label stays as it is.",
        "Corporate customers pay on 30 day terms.",
    ],
    [
        "Gift cards are valid for 5 years now, not 3. They still cannot be refunded.",
        "Points on clearance orders expire after 3 months.",
    ],
    [
        "Reviews from verified buyers are published straight away.",
        "Orders from schools never need approval.",
    ],
    [
        "Exports run every Sunday night.",
        "Our app supports English and German.",
    ],
]

AGENT_PROPOSAL = (
    "I suggest Firebase Cloud Messaging for push, with one retry after 10 minutes.",
    "Sounds good.",
)

CURRENT = [
    ["PKG", "depot", "carrier"],
    ["5 years", "refund"],
    ["Firebase"],
    ["48 hours"],
    ["12 months"],
    ["500"],
    ["30 day"],
    ["3 months"],
    ["verified"],
    ["schools"],
    ["Sunday"],
    ["German"],
]
STALE = ["SHP-", "3 years"]
NOISE = ["coffee", "sandwich", "Nina", "raining", "newline", "linter", "diff", "variable"]

FILLER_TURNS = 40


def sessions() -> list[list[tuple[str, str]]]:
    history = []
    cursor = 0
    for decisions in DECISIONS:
        turns = []
        for decision in decisions:
            if decision.startswith("How should we"):
                turns.append((decision, AGENT_PROPOSAL[0]))
                turns.append((AGENT_PROPOSAL[1], "Great, noted."))
            else:
                turns.append((decision, "Understood."))
            for _ in range(FILLER_TURNS // len(decisions)):
                turns.append(FILLER[cursor % len(FILLER)])
                cursor += 1
        history.append(turns)
    return history

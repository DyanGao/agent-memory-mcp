"""A fourth history, written with the code frozen and scored once.

Natural wording, and changes that must keep the details around them. Words in
one CURRENT entry must appear together in a single memory.
"""

FILLER = [
    ("The printer on floor two is broken again.", "That sounds annoying."),
    ("Can you shorten that heading?", "Shortened it."),
    ("I think the demo went well yesterday.", "Glad to hear it."),
    ("Run the formatter over that file.", "Ran it, two lines changed."),
    ("Which folder is that script in?", "It is in tools/."),
    ("My laptop just restarted.", "No rush, I'll wait."),
    ("Move that helper up a bit.", "Moved it above the exports."),
    ("It's really hot in the office today.", "Hopefully it cools down."),
    ("Did you see the message from Priya?", "I can't see messages, sorry."),
    ("Revert that last change.", "Reverted it."),
    ("Nice, that was quick.", "Thanks."),
    ("We're having pizza for lunch.", "Enjoy."),
    ("Collapse those two functions into one.", "Combined them."),
    ("How many lines is that file?", "About 240."),
]

DECISIONS = [
    [
        "Employee badges look like EMP-0421-B: EMP, a four-digit number and a site letter.",
        "Trials last 14 days and need no credit card.",
    ],
    [
        "Which database should we use for analytics?",
        "Our warranty runs for 24 months.",
    ],
    [
        "Support hours are 8 to 18 CET.",
        "We only ship inside the EU.",
    ],
    [
        "The badge prefix is STF now instead of EMP, nothing else about them changes.",
        "Enterprise customers get support around the clock.",
    ],
    [
        "Trials are 10 days now, not 14. Still no credit card.",
        "Refurbished items only get 6 months of warranty.",
    ],
    [
        "Passwords need at least 12 characters.",
        "Also, we ship to Switzerland from now on.",
    ],
    [
        "Admin passwords need 16 characters.",
        "Webinar recordings are kept for 30 days.",
    ],
]

AGENT_PROPOSAL = (
    "I suggest ClickHouse for analytics, partitioned by month.",
    "That works, thanks.",
)

CURRENT = [
    ["STF", "four-digit", "site letter"],
    ["10", "credit card"],
    ["ClickHouse"],
    ["24 months"],
    ["8 to 18"],
    ["EU"],
    ["Enterprise"],
    ["6 months"],
    ["12 characters"],
    ["Switzerland"],
    ["16 characters"],
    ["30 days"],
]
STALE = ["EMP-", "14 days"]
NOISE = ["printer", "demo", "laptop", "office", "pizza", "formatter", "Priya", "heading", "tools/"]

FILLER_TURNS = 40


def sessions() -> list[list[tuple[str, str]]]:
    history = []
    cursor = 0
    for decisions in DECISIONS:
        turns = []
        for decision in decisions:
            if decision.startswith("Which database"):
                turns.append((decision, AGENT_PROPOSAL[0]))
                turns.append((AGENT_PROPOSAL[1], "Great, noted."))
            else:
                turns.append((decision, "Understood."))
            for _ in range(FILLER_TURNS // len(decisions)):
                turns.append(FILLER[cursor % len(FILLER)])
                cursor += 1
        history.append(turns)
    return history

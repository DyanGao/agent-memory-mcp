"""A third history, written after the code was frozen and scored once."""

FILLER = [
    ("Can you widen that column?", "Done, it fits on one line now."),
    ("Did the nightly job go through?", "Yes, it finished without errors."),
    ("Where did we put the mockups?", "They are in the shared design folder."),
    ("Fix the typo in the footer.", "Fixed it."),
    ("How big is the bundle now?", "About 180 KB after compression."),
    ("Is the staging box up?", "Yes, it responded a minute ago."),
    ("Thanks for that.", "You're welcome."),
    ("My flight got delayed, sorry.", "No problem, take your time."),
    ("Show me the failing assertion.", "It compares two dates in different formats."),
    ("Merge the small cleanup branch.", "Merged it."),
    ("Who wrote this module?", "It came in with the original import."),
    ("Restart the dev server.", "Restarted it."),
    ("Does this need a migration?", "No, nothing in the schema changed."),
    ("Let's pause for coffee.", "Sure."),
]

DECISIONS = [
    [
        "We decided that refunds are allowed within 21 days of delivery.",
        "All customer emails are sent from a no-reply address.",
    ],
    [
        "Which queue should the mail worker use?",
        "Invoices are stored as PDF for 7 years.",
    ],
    [
        "Free accounts get 3 projects.",
        "Search results are cached for 90 seconds.",
    ],
    [
        "Free accounts now get 5 projects, not 3.",
        "Refunds on sale items are never allowed.",
    ],
    [
        "Cache search results for 45 seconds from now on, instead of 90.",
        "Team accounts get 40 projects.",
    ],
    [
        "API tokens expire after 180 days.",
        "Tokens for service accounts do not expire.",
    ],
]

AGENT_PROPOSAL = (
    "I suggest BullMQ for the mail worker, with 4 retries per message.",
    "Sounds good, let's do that.",
)

CURRENT = [
    ["21 days"], ["no-reply"], ["BullMQ"], ["7 years"], ["5 projects"], ["sale"],
    ["45 seconds"], ["40 projects"], ["180 days"], ["service account"],
]
STALE = ["3 projects", "90 seconds"]
NOISE = ["bundle", "staging", "footer", "mockup", "branch", "dev server", "flight", "coffee"]

FILLER_TURNS = 40


def sessions() -> list[list[tuple[str, str]]]:
    history = []
    cursor = 0
    for decisions in DECISIONS:
        turns = []
        for decision in decisions:
            if decision.startswith("Which queue"):
                turns.append((decision, AGENT_PROPOSAL[0]))
                turns.append((AGENT_PROPOSAL[1], "Great, noted."))
            else:
                turns.append((decision, "Understood."))
            for _ in range(FILLER_TURNS // len(decisions)):
                turns.append(FILLER[cursor % len(FILLER)])
                cursor += 1
        history.append(turns)
    return history

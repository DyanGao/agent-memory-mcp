"""One long project history. Decisions change, spread out and sit beside near-misses.

Deterministic, so every setup sees the same text. The filler is what a real
session is mostly made of, including status lines a memory should not keep.
"""

FILLER = [
    ("Can you tidy the README wording a little?", "Done, I shortened the intro and fixed two typos."),
    ("The CI run looked slow this morning.", "It was a cold cache. The next run took half the time."),
    ("What does the lint job check?", "Formatting and unused imports. It passed on the last commit."),
    ("Rename that helper to something clearer.", "Renamed it and updated the two call sites."),
    ("Is the repo a git repository yet?", "No, this folder is not a git repository, so nothing is committed."),
    ("Run the tests please.", "All 6 tests pass with node --test."),
    ("Anything else failing?", "No, the build is green and all tests pass."),
    ("Which file did you touch?", "Only src/index.mjs, and I added a small test beside it."),
    ("Thanks, that looks fine.", "Glad that works. Let me know what is next."),
    ("Can you double-check the import order?", "I checked it, and it already matches the rest of the module."),
    ("The meeting moved to Thursday, by the way.", "Thanks for letting me know."),
    ("Add a comment explaining that function.", "Added a two-line comment above it."),
    ("I'm out for lunch, back in an hour.", "No problem, I'll wait for your next message."),
    ("Did that dependency update go through?", "There are no dependencies here, so there was nothing to update."),
    ("Can you remove that debug log?", "Removed it and reran the tests, which all pass."),
    ("How long did that take to run?", "About 40 milliseconds."),
]

SESSIONS = [
    [
        "Decision for acme-orders: our rate limit is 37 requests per rolling 60 seconds, per API key. Over the limit we return status 429 with the body {\"error\": \"slow_down\"}.",
        "Decision: order ids look like ORD-2026-000042, meaning ORD, the four-digit year, and a six-digit zero-padded sequence that restarts at 1 every calendar year.",
    ],
    [
        "Decision: VAT is 19%, calculated on each line and rounded to 2 decimals with half-even rounding on that line, then summed. We never calculate VAT on the invoice total.",
        "Decision: webhooks are retried 5 times with exponential backoff.",
    ],
    [
        "Decision: the combined discount on an order can never exceed 30% of the original price.",
        "Decision: all prices are in euros, and we do not support other currencies.",
    ],
    [
        "Decision: soft-deleted accounts are purged 45 days after deletion.",
        "Decision: the internal admin API has its own limit of 200 requests per minute.",
    ],
    [
        "Change of plan on the customer rate limit: it is now 52 requests per rolling 60 seconds per API key, replacing the 37 we agreed. The 429 and its body stay the same.",
        "Decision: partner orders have a separate discount cap of 15%. This applies to partner orders only.",
    ],
    [
        "Decision on discounts: the loyalty percentage is applied first, and the coupon, which is a fixed euro amount, is taken off after that.",
        "Change of plan on order ids: the prefix is now ACM instead of ORD. The rest of the format stays the same.",
    ],
    [
        "The VAT rate has changed to 21%, replacing 19%. Calculating per line with half-even rounding stays the same.",
        "Decision on retention: accounts with status legal_hold are never purged.",
    ],
    [
        "One more on retention: accounts with status dispute are never purged either.",
        "Decision: logs are written as JSON lines.",
    ],
]

# What a good memory store holds at the end. Each entry is words that must
# appear together in one current memory.
CURRENT = [
    ["52"], ["slow_down"], ["ACM"], ["21%"], ["half-even"], ["30%"], ["euro"],
    ["45 days"], ["legal_hold"], ["dispute"], ["200"], ["15%"], ["JSON"], ["loyalty"],
]
# Words that must not survive in a current memory.
STALE = ["37 requests", "19%", "ORD-"]
NOISE = ["git repo", "tests pass", "test pass", "node --test", "src/index", "README", "lint"]

FILLER_TURNS = 60


def sessions() -> list[list[tuple[str, str]]]:
    history = []
    cursor = 0
    for decisions in SESSIONS:
        turns = []
        for decision in decisions:
            turns.append((decision, "Understood, noted."))
            for _ in range(FILLER_TURNS // len(decisions)):
                turns.append(FILLER[cursor % len(FILLER)])
                cursor += 1
        history.append(turns)
    return history


def transcript() -> str:
    lines = []
    for number, turns in enumerate(sessions(), start=1):
        lines.append(f"--- Session {number} ---")
        for user, agent in turns:
            lines.append(f"user: {user}\nassistant: {agent}")
    return "\n".join(lines)

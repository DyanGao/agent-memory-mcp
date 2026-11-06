"""The same decisions as history.py, spread through about 500,000 characters.

Tests what memory claims to be for: a project too long to replay. Chatter is
generated from templates with a fixed seed, so every run sees identical text,
and it is varied so a model cannot simply learn to skip one repeated line.
"""

import random

from history import CURRENT, NOISE as HISTORY_NOISE, SESSIONS, STALE  # noqa: F401

SESSION_COUNT = 40
TURNS_PER_SESSION = 190
SEED = 20261106

THINGS = [
    "the login form", "the sidebar", "that query", "the cart page", "the import script",
    "the settings panel", "the export button", "this test helper", "the navbar",
    "the search box", "that migration", "the footer links", "the date picker",
    "the upload dialog", "the user table", "the error banner", "that cron entry",
    "the invoice view", "the seed data", "the theme file", "the pagination bar",
    "that loader", "the profile page", "the status badge", "the modal", "the tooltip",
]
PEOPLE = ["Sam", "Lena", "Omar", "Priya", "Jonas", "Mei", "Tom", "Aisha"]
# Every line of chatter names a thing or a person. The trailing space keeps
# "Tom" from matching inside "customer". The short history's list alone found
# none of this chatter and reported 0 noise on a store that was mostly noise.
NOISE = [
    *HISTORY_NOISE,
    *[thing.split(" ", 1)[1] for thing in THINGS],
    *[f"{person} " for person in PEOPLE],
]
TEMPLATES = [
    ("Can you tidy up {t}?", "Done, it reads better now."),
    ("Take a look at {t} for me.", "Looked at it, nothing stands out."),
    ("{p} asked about {t} this morning.", "Thanks for letting me know."),
    ("Why is {t} so slow today?", "It was a cold start, and it is quick again now."),
    ("Rename the handler in {t}.", "Renamed it and updated the callers."),
    ("I'm not sure I like how {t} looks.", "Happy to try another layout."),
    ("{p} is out until Monday.", "Noted, thanks."),
    ("Run the tests for {t}.", "All of them pass."),
    ("Add a small comment near {t}.", "Added one."),
    ("Did anything change in {t}?", "Only whitespace."),
    ("Let's come back to {t} after lunch.", "Sure."),
    ("Remove the old code around {t}.", "Removed it, and nothing broke."),
    ("That's a nice improvement to {t}.", "Glad it helps."),
    ("How big is {t} now?", "About 120 lines."),
    ("{p} liked the new {t}.", "Good to hear."),
    ("Split {t} into two files.", "Split it."),
]


def _chatter(rng: random.Random, templates, things, people) -> tuple[str, str]:
    said, reply = rng.choice(templates)
    said = said.format(t=rng.choice(things), p=rng.choice(people))
    return said[0].upper() + said[1:], reply


def build(seed: int, templates, things, people) -> list[list[tuple[str, str]]]:
    rng = random.Random(seed)
    # Fixed, even spread: a decision and its later change sit far apart.
    placed = {
        round(index * (SESSION_COUNT - 1) / (len(SESSIONS) - 1)): decisions
        for index, decisions in enumerate(SESSIONS)
    }
    history = []
    for number in range(SESSION_COUNT):
        turns = [_chatter(rng, templates, things, people) for _ in range(TURNS_PER_SESSION)]
        for decision in placed.get(number, []):
            turns.insert(rng.randrange(len(turns)), (decision, "Understood, noted."))
        history.append(turns)
    return history


def sessions() -> list[list[tuple[str, str]]]:
    return build(SEED, TEMPLATES, THINGS, PEOPLE)


def render(history: list[list[tuple[str, str]]]) -> str:
    lines = []
    for number, turns in enumerate(history, start=1):
        lines.append(f"--- Session {number} ---")
        for user, agent in turns:
            lines.append(f"user: {user}\nassistant: {agent}")
    return "\n".join(lines)


def transcript() -> str:
    return render(sessions())

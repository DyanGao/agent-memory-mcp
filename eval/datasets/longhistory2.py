"""The long history again, with chatter the distiller was never tuned on.

Written and frozen before the chatter gate, and used to score it, not to shape
it. longhistory.py was read closely while building the gate, so a good score
there proves little. The lines here are statements about the moment that can
look like facts: some hold a number or a name, and some sound like a plan.
"""

from history import CURRENT, NOISE as HISTORY_NOISE, SESSIONS, STALE  # noqa: F401
from longhistory import build, render

SEED = 20261107

THINGS = [
    "the onboarding flow", "the pricing table", "the audit screen", "the csv parser",
    "the billing page", "the avatar picker", "the release notes", "the landing hero",
    "the webhook log", "the map widget", "the survey form", "the batch runner",
    "the help drawer", "the coupon form", "the admin grid", "the sync worker",
    "the image cropper", "the keyboard shortcuts", "the chart legend", "the mail template",
]
PEOPLE = ["Noor", "Felix", "Ines", "Ravi", "Hana", "Viktor", "Zoe", "Kofi"]
TEMPLATES = [
    ("{t} took 4 seconds to load just now.", "It was fine on my last check."),
    ("{p} will review {t} tomorrow.", "Sounds good."),
    ("The staging box is rebooting right now.", "I will wait for it."),
    ("We are at 73% coverage this morning.", "Up a little from last week."),
    ("{p} fixed a typo in {t}.", "Thanks for the update."),
    ("{p} is on a train, so replies will be slow today.", "Understood."),
    ("The office wifi is flaky again.", "That explains the timeouts."),
    ("Let's park {t} for now.", "Parked."),
    ("{t} feels a bit cramped to me.", "I can add some spacing."),
    ("Good catch on {t}.", "Thanks."),
    ("My laptop needs a restart.", "No problem."),
    ("Move {t} up a bit.", "Moved it."),
    ("Make {t} a little wider.", "Widened it."),
    ("Swap the two buttons in {t}.", "Swapped them."),
    ("{p} wants a quick chat about {t}.", "I will flag it."),
    ("Tell {p} that {t} is ready.", "Will do."),
    ("I pushed {t} to my branch.", "I can see it."),
    ("The release went out at noon.", "Great."),
    ("The standup ran long today.", "It happens."),
    ("{t} crashed once on my machine, but I cannot reproduce it.", "I will keep an eye out."),
    ("I'll have another look at {t} once my coffee kicks in.", "Take your time."),
    ("The demo of {t} went well yesterday.", "Good news."),
    ("{p} thinks {t} could wait until the next sprint.", "Noted."),
    ("Two customers mentioned {t} on the call today.", "Interesting."),
]
# Every line above names a thing or a person, or is one of these. Together with
# the real markers, this must account for every stored memory.
_MOMENTS = [
    "staging box", "coverage", "wifi", "laptop", "release went", "standup", "the demo",
]
NOISE = [
    *HISTORY_NOISE,
    *[thing.split(" ", 1)[1] for thing in THINGS],
    *[f"{person} " for person in PEOPLE],
    *_MOMENTS,
]


def sessions() -> list[list[tuple[str, str]]]:
    return build(SEED, TEMPLATES, THINGS, PEOPLE)


def transcript() -> str:
    return render(sessions())

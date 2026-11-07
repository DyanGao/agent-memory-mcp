"""Three new projects with 25 tasks, committed before any were scored.

Nothing here was seen while building the distiller. Each task needs a rule that
exists only in that project's conversations. Some rules change later, so an old
value must not survive. `decoys` are true rules about something else, which a
good store keeps and a careless answer confuses. `solution` proves each hidden
test can pass, and it never reaches an agent.
"""

import random

SESSION_COUNT = 15
TURNS_PER_SESSION = 190
SEED = 20261108

THINGS = [
    "the calendar view", "the receipt page", "the signup wizard", "the export dialog",
    "the search filter", "the sidebar badge", "the print layout", "the tag editor",
    "the upload queue", "the settings tab", "the summary card", "the role picker",
    "the timeline", "the empty state", "the toast message", "the admin report",
]
PEOPLE = ["Maya", "Bruno", "Elif", "Tariq", "Sofia", "Lars", "Yuki", "Dani"]
TEMPLATES = [
    ("{t} flickered during the call.", "I saw that too."),
    ("{p} is presenting {t} on Thursday.", "Good luck to them."),
    ("I'm rebasing {t} now.", "Okay."),
    ("{p} sent a screenshot of {t}.", "Got it."),
    ("Nudge {t} two pixels left.", "Nudged."),
    ("{t} still looks odd in dark mode.", "I can check it."),
    ("Bump the font size in {t}.", "Bumped."),
    ("The build took 11 minutes this time.", "That is slower than usual."),
    ("{p} is covering support this week.", "Thanks for the heads up."),
    ("Nice work on {t}.", "Thanks."),
    ("I'll look at {t} after the meeting.", "Sure."),
    ("We had 40 signups yesterday.", "A good day."),
    ("{p} has a dentist appointment at three.", "Noted."),
    ("{t} was mentioned in the retro.", "Interesting."),
    ("Hide {t} behind the flag for today.", "Done."),
    ("The VPN dropped again.", "That happens a lot lately."),
    ("{p} approved the copy for {t}.", "Great."),
    ("Let's demo {t} to {p} tomorrow.", "Sounds fine."),
    ("My screen share froze.", "It is back now."),
    ("Rebuild {t} from the old branch.", "Rebuilt."),
]
_MOMENTS = [
    "the build took", "signups", "vpn", "screen share", "support this week", "dentist",
]
NOISE = [
    *[thing.split(" ", 1)[1] for thing in THINGS],
    *[f"{person} " for person in PEOPLE],
    *_MOMENTS,
]


def _task(name, request, rules, markers, test, solution, earlier=None, stale=None):
    return {
        "name": name,
        "request": request,
        "rules": rules,
        "markers": markers,
        "test": test,
        "solution": solution,
        "earlier": earlier or [],
        "stale": stale or [],
    }


HARBOR = [
    _task(
        "deposit",
        "Add src/deposit.mjs exporting deposit(price), which returns the refundable deposit "
        "for a rental as a number. Follow our current deposit rule.",
        ["The refundable deposit is 18% of the rental price, with a minimum of 150 euros, replacing the 15% we had."],
        [["18%", "150"]],
        'assert.equal(deposit(2000), 360);\nassert.equal(deposit(100), 150);',
        "export const deposit = (p) => Math.max(p * 0.18, 150);",
        ["The refundable deposit is 15% of the rental price, with a minimum of 150 euros."],
        ["is 15% of"],
    ),
    _task(
        "cancel-fee",
        "Add src/cancel.mjs exporting cancellationFee(price, hoursBefore). It returns the fee "
        "as a number. Follow our cancellation policy.",
        ["Cancelling less than 72 hours before the start costs 40% of the price. Earlier cancellations are free."],
        [["72 hours", "40%"]],
        'assert.equal(cancellationFee(1000, 71), 400);\nassert.equal(cancellationFee(1000, 72), 0);',
        "export const cancellationFee = (p, h) => (h < 72 ? p * 0.4 : 0);",
    ),
    _task(
        "booking-ref",
        "Add src/bookingref.mjs exporting nextRef(date, lastRef). date is a Date, lastRef is "
        "the previous reference or null. It returns the next reference. Use our current format.",
        [
            "Booking references now start with HBR instead of BK. The rest stays the same.",
        ],
        [["HBR"]],
        'assert.equal(nextRef(new Date("2026-08-02T10:00:00Z"), null), "HBR-Q3-00001");\n'
        'assert.equal(nextRef(new Date("2026-08-02T10:00:00Z"), "HBR-Q3-00451"), "HBR-Q3-00452");\n'
        'assert.equal(nextRef(new Date("2026-10-02T10:00:00Z"), "HBR-Q3-00451"), "HBR-Q4-00001");',
        "export const nextRef = (d, last) => {\n"
        "  const q = `Q${Math.floor(d.getUTCMonth() / 3) + 1}`;\n"
        "  const same = last && last.split('-')[1] === q;\n"
        "  const n = same ? Number(last.split('-')[2]) + 1 : 1;\n"
        "  return `HBR-${q}-${String(n).padStart(5, '0')}`;\n};",
        ["Booking references look like BK-Q3-00451: BK, the calendar quarter, and a five-digit zero-padded counter that restarts each quarter."],
        ["BK-Q3"],
    ),
    _task(
        "late-return",
        "Add src/late.mjs exporting lateFee(minutesLate), which returns the charge as a number. "
        "Follow our late return rule.",
        ["Late returns cost 25 euros per started 30 minutes."],
        [["25 euros", "30 minutes"]],
        'assert.equal(lateFee(0), 0);\nassert.equal(lateFee(1), 25);\nassert.equal(lateFee(30), 25);\nassert.equal(lateFee(31), 50);',
        "export const lateFee = (m) => Math.ceil(m / 30) * 25;",
    ),
    _task(
        "min-age",
        "Add src/age.mjs exporting canRent({age, skipperLicence}), which returns true or false. "
        "Follow our age rules.",
        ["Renters must be at least 23, or 21 with a skipper licence."],
        [["23", "21"]],
        'assert.equal(canRent({age: 22, skipperLicence: false}), false);\n'
        'assert.equal(canRent({age: 23, skipperLicence: false}), true);\n'
        'assert.equal(canRent({age: 21, skipperLicence: true}), true);\n'
        'assert.equal(canRent({age: 20, skipperLicence: true}), false);',
        "export const canRent = ({age, skipperLicence}) => age >= (skipperLicence ? 21 : 23);",
    ),
    _task(
        "season",
        "Add src/season.mjs exporting seasonPrice(basePrice, date). date is a Date, read in UTC. "
        "It returns the price as a number. Apply our high season rule.",
        ["High season runs from 15 June to 31 August inclusive, and prices are 35% higher then."],
        [["15 June", "35%"]],
        'assert.equal(seasonPrice(100, new Date("2026-06-14T12:00:00Z")), 100);\n'
        'assert.equal(seasonPrice(100, new Date("2026-06-15T12:00:00Z")), 135);\n'
        'assert.equal(seasonPrice(100, new Date("2026-08-31T12:00:00Z")), 135);\n'
        'assert.equal(seasonPrice(100, new Date("2026-09-01T12:00:00Z")), 100);',
        "export const seasonPrice = (b, d) => {\n"
        "  const k = (d.getUTCMonth() + 1) * 100 + d.getUTCDate();\n"
        "  return k >= 615 && k <= 831 ? Math.round(b * 135) / 100 : b;\n};",
    ),
    _task(
        "fuel",
        "Add src/fuel.mjs exporting fuelCharge(litres), which returns the charge as a number. "
        "Follow our fuel billing rule.",
        ["Fuel costs 2.40 euros per litre, and the first 10 litres are included."],
        [["2.40", "10 litres"]],
        'assert.equal(fuelCharge(10), 0);\nassert.equal(fuelCharge(15), 12);',
        "export const fuelCharge = (l) => Math.round(Math.max(0, l - 10) * 240) / 100;",
    ),
    _task(
        "fleet-discount",
        "Add src/fleet.mjs exporting fleetPrice(total, boats), which returns the final price as "
        "a number. Follow our discount rule for bookings of several boats.",
        ["Bookings of 3 or 4 boats get 10% off, and 5 or more boats get 15% off."],
        [["3 or 4", "5 or more"]],
        'assert.equal(fleetPrice(1000, 2), 1000);\nassert.equal(fleetPrice(1000, 4), 900);\nassert.equal(fleetPrice(1000, 5), 850);',
        "export const fleetPrice = (t, b) => t * (b >= 5 ? 0.85 : b >= 3 ? 0.9 : 1);",
    ),
]

CLINIC = [
    _task(
        "copay",
        "Add src/copay.mjs exporting copay(age), which returns the amount as a number. "
        "Follow our current co-pay rule.",
        ["The co-pay is now 12 euros, replacing 10. It is still waived for patients under 18 or over 75."],
        [["12 euros"]],
        'assert.equal(copay(40), 12);\nassert.equal(copay(17), 0);\nassert.equal(copay(18), 12);\nassert.equal(copay(75), 12);\nassert.equal(copay(76), 0);',
        "export const copay = (a) => (a < 18 || a > 75 ? 0 : 12);",
        ["The co-pay is 10 euros, waived for patients under 18 or over 75."],
        ["10 euros"],
    ),
    _task(
        "no-shows",
        "Add src/noshow.mjs exporting isBlocked(noShowDates, now). Both use Date objects. It "
        "returns true when online booking must be blocked. Follow our no-show rule.",
        ["Three no-shows within 12 months block online booking."],
        [["Three no-shows", "12 months"]],
        'const now = new Date("2026-06-01T00:00:00Z");\n'
        'const d = (s) => new Date(s);\n'
        'assert.equal(isBlocked([d("2026-05-01"), d("2026-04-01")], now), false);\n'
        'assert.equal(isBlocked([d("2026-05-01"), d("2026-04-01"), d("2025-09-01")], now), true);\n'
        'assert.equal(isBlocked([d("2026-05-01"), d("2026-04-01"), d("2025-03-01")], now), false);',
        "export const isBlocked = (ds, now) => {\n"
        "  const from = new Date(now); from.setUTCFullYear(from.getUTCFullYear() - 1);\n"
        "  return ds.filter((d) => d >= from).length >= 3;\n};",
    ),
    _task(
        "patient-code",
        "Add src/patient.mjs exporting patientCode(clinic, number). clinic is a two-letter code "
        "and number is an integer. It returns the code. Use our current format.",
        ["Patient codes now use seven digits instead of six. The rest of the format stays the same."],
        [["seven digits"]],
        'assert.equal(patientCode("BE", 42), "PC-BE-0000042");',
        "export const patientCode = (c, n) => `PC-${c}-${String(n).padStart(7, '0')}`;",
        ["Patient codes look like PC-BE-000042: PC, the two-letter clinic code, and a six-digit zero-padded number."],
        ["six-digit"],
    ),
    _task(
        "reminders",
        "Add src/reminders.mjs exporting reminderTimes(start). start is a Date. It returns an "
        "array of Dates, earliest first. Follow our current reminder schedule.",
        ["Reminders now go out 48 hours and 2 hours before an appointment, replacing the single 24 hour one."],
        [["48 hours", "2 hours"]],
        'const s = new Date("2026-06-10T12:00:00Z");\n'
        'assert.deepEqual(reminderTimes(s).map((d) => d.toISOString()), ["2026-06-08T12:00:00.000Z", "2026-06-10T10:00:00.000Z"]);',
        "export const reminderTimes = (s) => [48, 2].map((h) => new Date(s.getTime() - h * 3600000));",
        ["A reminder goes out 24 hours before an appointment."],
        ["24 hours before"],
    ),
    _task(
        "records",
        "Add src/records.mjs exporting keepUntilYear(lastVisitYear, birthYear), which returns the "
        "last calendar year a record must be kept. Follow our record retention rule.",
        ["Records are kept for 10 years after the last visit, and for minors at least until the year they turn 28."],
        [["10 years", "28"]],
        'assert.equal(keepUntilYear(2020, 1970), 2030);\nassert.equal(keepUntilYear(2020, 2015), 2043);',
        "export const keepUntilYear = (v, b) => Math.max(v + 10, v - b < 18 ? b + 28 : 0);",
    ),
    _task(
        "rebooking",
        "Add src/rebook.mjs exporting canRebook(timesRebooked), which returns true or false for "
        "one more rebooking. Follow our rebooking limit.",
        ["An appointment can be rebooked at most twice."],
        [["twice"]],
        'assert.equal(canRebook(0), true);\nassert.equal(canRebook(1), true);\nassert.equal(canRebook(2), false);',
        "export const canRebook = (n) => n < 2;",
    ),
    _task(
        "queue",
        "Add src/queue.mjs exporting sortQueue(patients). Each has {id, urgent, age, arrivedAt}, "
        "where arrivedAt is a number. It returns a new sorted array. Follow our triage order.",
        ["The waiting room order is urgent cases first, then patients aged 80 or over, then everyone else, each group by arrival time."],
        [["urgent", "80"]],
        'const q = [{id: 1, urgent: false, age: 30, arrivedAt: 1}, {id: 2, urgent: false, age: 85, arrivedAt: 3},\n'
        '  {id: 3, urgent: true, age: 20, arrivedAt: 4}, {id: 4, urgent: false, age: 80, arrivedAt: 2}];\n'
        'assert.deepEqual(sortQueue(q).map((p) => p.id), [3, 4, 2, 1]);',
        "const rank = (p) => (p.urgent ? 0 : p.age >= 80 ? 1 : 2);\n"
        "export const sortQueue = (ps) => [...ps].sort((a, b) => rank(a) - rank(b) || a.arrivedAt - b.arrivedAt);",
    ),
    _task(
        "slots",
        "Add src/slots.mjs exporting slotEnd(startMinute, kind). startMinute is minutes since "
        "midnight and kind is 'first' or 'followup'. It returns the end minute, or throws if the "
        "start is not allowed. Follow our appointment slot rules.",
        ["Appointments start on the hour or at 10, 20, 30, 40 or 50 past. First visits last 30 minutes and follow-ups last 20 minutes."],
        [["First visits", "30 minutes"]],
        'assert.equal(slotEnd(600, "first"), 630);\nassert.equal(slotEnd(610, "followup"), 630);\nassert.throws(() => slotEnd(605, "first"));',
        "export const slotEnd = (s, k) => {\n"
        "  if (s % 10 !== 0) throw new Error('bad start');\n"
        "  return s + (k === 'first' ? 30 : 20);\n};",
    ),
]

TRAM = [
    _task(
        "zone-fare",
        "Add src/fare.mjs exporting fare(zones), which returns the fare as a number. "
        "Follow our current fare rule.",
        ["The base fare is now 2.10 euros, replacing 1.90. Each zone after the first still adds 0.60, and a fare is capped at 5.40."],
        [["2.10"]],
        'assert.equal(fare(1), 2.1);\nassert.equal(fare(3), 3.3);\nassert.equal(fare(9), 5.4);',
        "export const fare = (z) => Math.min(Math.round((2.1 + (z - 1) * 0.6) * 100) / 100, 5.4);",
        ["The base fare is 1.90 euros, each zone after the first adds 0.60, and a fare is capped at 5.40."],
        ["1.90 euros, each"],
    ),
    _task(
        "day-cap",
        "Add src/daycap.mjs exporting charge(spentToday, ticketPrice), which returns what to "
        "charge for this ticket as a number. Follow our daily cap rule.",
        ["Nobody pays more than 8.50 euros in one day."],
        [["8.50"]],
        'assert.equal(charge(0, 3), 3);\nassert.equal(charge(7, 3), 1.5);\nassert.equal(charge(8.5, 3), 0);',
        "export const charge = (s, t) => Math.round(Math.max(0, Math.min(t, 8.5 - s)) * 100) / 100;",
    ),
    _task(
        "child-fare",
        "Add src/child.mjs exporting childFare(adultFare, age), which returns the fare as a "
        "number. Follow our child fare rule.",
        ["Children under 6 travel free. Ages 6 to 14 pay half fare, rounded up to the next 5 cents."],
        [["under 6", "half fare"]],
        'assert.equal(childFare(3, 5), 0);\nassert.equal(childFare(3, 6), 1.5);\nassert.equal(childFare(2.1, 14), 1.05);\nassert.equal(childFare(2.15, 14), 1.1);\nassert.equal(childFare(3, 15), 3);',
        "export const childFare = (f, a) => {\n"
        "  if (a < 6) return 0;\n  if (a > 14) return f;\n"
        "  return Math.ceil(Math.round(f * 50) / 5) * 5 / 100;\n};",
    ),
    _task(
        "ticket-id",
        "Add src/ticket.mjs exporting ticketId(date, sequence). date is a Date, read in UTC, and "
        "sequence is an integer. It returns the id. Use our ticket id format.",
        ["Ticket ids look like TK260806-0042: TK, the date as two-digit year, month and day, a dash, and a four-digit zero-padded sequence."],
        [["TK260806", "four-digit"]],
        'assert.equal(ticketId(new Date("2026-08-06T09:00:00Z"), 42), "TK260806-0042");',
        "export const ticketId = (d, s) => `TK${d.toISOString().slice(2, 10).replaceAll('-', '')}-${String(s).padStart(4, '0')}`;",
    ),
    _task(
        "transfer",
        "Add src/transfer.mjs exporting isFreeTransfer(firstValidationMs, nowMs), which returns "
        "true or false. Follow our transfer rule.",
        ["Transfers are free for 90 minutes after the first validation."],
        [["90 minutes"]],
        'const m = 60000;\nassert.equal(isFreeTransfer(0, 90 * m), true);\nassert.equal(isFreeTransfer(0, 90 * m + 1), false);',
        "export const isFreeTransfer = (a, b) => b - a <= 90 * 60000;",
    ),
    _task(
        "refund",
        "Add src/refund.mjs exporting refund(price, minutesSincePurchase, used), which returns "
        "the refund as a number. Follow our refund rule.",
        ["An unused ticket can be refunded within 15 minutes of purchase, minus a 0.50 euro fee."],
        [["15 minutes", "0.50"]],
        'assert.equal(refund(3, 15, false), 2.5);\nassert.equal(refund(3, 16, false), 0);\nassert.equal(refund(3, 5, true), 0);',
        "export const refund = (p, m, u) => (!u && m <= 15 ? Math.round((p - 0.5) * 100) / 100 : 0);",
    ),
    _task(
        "fines",
        "Add src/fines.mjs exporting fine(daysUntilPaid), which returns the amount as a number. "
        "Follow our current fine rule.",
        ["The fine for travelling without a ticket is now 70 euros, replacing 60. It still halves if paid within 7 days."],
        [["70 euros"]],
        'assert.equal(fine(7), 35);\nassert.equal(fine(8), 70);',
        "export const fine = (d) => (d <= 7 ? 35 : 70);",
        ["The fine for travelling without a ticket is 60 euros, halved if paid within 7 days."],
        ["60 euros, halved"],
    ),
    _task(
        "peak",
        "Add src/peak.mjs exporting isPeak(date). date is a Date, read in UTC. It returns true "
        "or false. Follow our peak hours.",
        ["Peak hours are 07:00 to 09:30 and 16:30 to 18:30 on weekdays. The end times are not included."],
        [["07:00", "16:30"]],
        'assert.equal(isPeak(new Date("2026-06-03T07:00:00Z")), true);\n'
        'assert.equal(isPeak(new Date("2026-06-03T09:30:00Z")), false);\n'
        'assert.equal(isPeak(new Date("2026-06-03T16:30:00Z")), true);\n'
        'assert.equal(isPeak(new Date("2026-06-06T08:00:00Z")), false);',
        "export const isPeak = (d) => {\n"
        "  const m = d.getUTCHours() * 60 + d.getUTCMinutes();\n"
        "  const wd = d.getUTCDay() % 6 !== 0;\n"
        "  return wd && ((m >= 420 && m < 570) || (m >= 990 && m < 1110));\n};",
    ),
    _task(
        "senior",
        "Add src/senior.mjs exporting seniorPrice(price, age, peak), which returns the price as a "
        "number. Follow our senior discount rule.",
        ["Passengers aged 65 or over get 30% off, but not during peak hours."],
        [["65", "30%"]],
        'assert.equal(seniorPrice(10, 65, false), 7);\nassert.equal(seniorPrice(10, 65, true), 10);\nassert.equal(seniorPrice(10, 64, false), 10);',
        "export const seniorPrice = (p, a, k) => (a >= 65 && !k ? Math.round(p * 70) / 100 : p);",
    ),
]

PROJECTS = {
    "harbor-rentals": {
        "readme": "Boat rental booking service.",
        "tasks": HARBOR,
        "decoys": [
            "Staff bookings get 50% off and need no deposit.",
            "The partner marina in Split bills us monthly.",
        ],
    },
    "pulse-clinic": {
        "readme": "Appointment system for a group of clinics.",
        "tasks": CLINIC,
        "decoys": [
            "Dental patients have a separate co-pay of 20 euros.",
            "Lab results are archived for 3 years.",
        ],
    },
    "metro-tram": {
        "readme": "Ticketing service for a city tram network.",
        "tasks": TRAM,
        "decoys": [
            "Night buses have a flat fare of 3 euros.",
            "Monthly passes renew on the first of the month.",
        ],
    },
}


class Project:
    """The interface coding_hard expects from a history."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.spec = PROJECTS[name]
        self.tasks = self.spec["tasks"]
        self.CURRENT = [words for task in self.tasks for words in task["markers"]]
        self.STALE = [word for task in self.tasks for word in task["stale"]]
        self.NOISE = NOISE

    def sessions(self) -> list[list[tuple[str, str]]]:
        rng = random.Random(f"{SEED}-{self.name}")
        first = [line for task in self.tasks for line in task["earlier"]]
        rules = [line for task in self.tasks for line in task["rules"]]
        rules += self.spec["decoys"]
        rng.shuffle(rules)
        # Earlier versions come first, so that each change lands on something.
        placed: dict[int, list[str]] = {}
        for index, line in enumerate(first):
            placed.setdefault(index % 3, []).append(line)
        for index, line in enumerate(rules):
            placed.setdefault(3 + index % (SESSION_COUNT - 3), []).append(line)
        history = []
        for number in range(SESSION_COUNT):
            turns = []
            for _ in range(TURNS_PER_SESSION):
                said, reply = rng.choice(TEMPLATES)
                said = said.format(t=rng.choice(THINGS), p=rng.choice(PEOPLE))
                turns.append((said[0].upper() + said[1:], reply))
            for line in placed.get(number, []):
                turns.insert(rng.randrange(len(turns)), (line, "Understood, noted."))
            history.append(turns)
        return history

    def transcript(self) -> str:
        lines = []
        for number, turns in enumerate(self.sessions(), start=1):
            lines.append(f"--- Session {number} ---")
            for user, agent in turns:
                lines.append(f"user: {user}\nassistant: {agent}")
        return "\n".join(lines)

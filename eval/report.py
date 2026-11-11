"""Builds docs/eval-report.md from the newest eval/results folder."""

import json
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EF_DEFAULT = 200
# The 100k synthetic runs predate the change to 200, so they show 400.
EF_BEFORE_CHANGE = 400


def load(folder: Path, name: str) -> dict:
    """The newest copy of a result, as evals do not all run on the same day."""
    path = sorted(folder.parent.glob(f"*/{name}.json"))[-1]
    return json.loads(path.read_text())


def deletion_rows(data: dict) -> str:
    labels = {
        "exact_topic": "Exact topic",
        "paraphrase_topic": "Reworded topic, automatic",
        "paraphrase_reviewed": "Reworded topic, with review",
    }
    lines = [
        "| Condition | Facts leaked | Probes leaked | Facts left in raw tables | Keepers lost |",
        "|---|---|---|---|---|",
    ]
    for key, label in labels.items():
        run = data[key]
        lines.append(
            f"| {label} | {run['facts_leaked_on_read']} of {run['facts']} "
            f"| {run['probe_results_leaked']} of {run['probe_results']} "
            f"| {run['facts_left_in_raw_tables']} of {run['facts']} "
            f"| {run['keepers_lost']} of {run['keepers_total']} |"
        )
    return "\n".join(lines)


def scale_rows(folder: Path) -> str:
    lines = [
        "| Vectors | Memories | `ef_search` | Recall@10 | Vector p95 | Full search p95 | Scrub lock |",
        "|---|---|---|---|---|---|---|",
    ]
    for shape in ("clustered", "random"):
        for size in (1000, 10000, 100000):
            run = load(folder, f"scale-{shape}-{size}")
            ef = EF_DEFAULT if size < 100000 else EF_BEFORE_CHANGE
            row = next(r for r in run["recallByEfSearch"] if r["efSearch"] == ef)
            scrub = run.get("scrubSeconds")
            lines.append(
                f"| {shape.capitalize()} | {size:,} | {ef} | {row['recallAt10']:.3f} "
                f"| {row['vectorP95Ms']} ms | {run['searchP95Ms']} ms "
                f"| {f'{scrub} s' if scrub else 'not measured'} |"
            )
    return "\n".join(lines)


def tuning_rows(folder: Path) -> tuple[str, str]:
    tune = load(folder, "search-tuning-tune")
    held = load(folder, "search-tuning-holdout")
    timing = ["| `ef_search` | Query plan | Vector p95 | Keyword p95, any word | Full search p95, old setting |", "|---|---|---|---|---|"]
    for ef, row in tune["timing"].items():
        timing.append(
            f"| {ef} | {', '.join(row['plans'])} | {row['vectorP95Ms']} ms "
            f"| {row['textAnyWordP95Ms']} ms | {row['fullSearchP95Ms']} ms |"
        )
    fusion = [
        f"| Half | Search | Plain questions ({tune['questions']['plain']}/{held['questions']['plain']}) "
        "| Identifier questions | Full search p95 |",
        "|---|---|---|---|---|",
    ]
    for half, run in (("Tuning", tune), ("Held out", held)):
        for name, row in run["variants"].items():
            speed = f"{row['searchP95Ms']} ms" if "searchP95Ms" in row else "not timed"
            fusion.append(
                f"| {half} | {name} | {row['plain']:.1%} | {row['identifiers']:.1%} | {speed} |"
            )
    return "\n".join(timing), "\n".join(fusion)


def near_miss_rows(folder: Path) -> tuple[str, dict]:
    run = load(folder, "search-tuning-id2-all")
    total = run["questions"]["identifiers"]
    lines = [
        f"| Search | Right code in the top 10, {total} questions | Right code first | Full search p95 |",
        "|---|---|---|---|",
    ]
    for name, row in run["variants"].items():
        lines.append(
            f"| {name} | {row['identifiers']:.1%} | {row['identifiersFirst']:.1%} | {row['searchP95Ms']} ms |"
        )
    variants = run["variants"]
    vector = variants["vector only"]["identifiersFirst"]
    default = variants["default: all words, weight 0.5"]["identifiersFirst"]
    values = {
        "near_vector_first": f"{vector:.1%}",
        "near_default_first": f"{default:.1%}",
        "near_gain": f"{round((default - vector) * total)}",
        "near_total": str(total),
        "near_keyword_all": f"{variants['keyword only (all words)']['identifiers']:.0%}",
    }
    return "\n".join(lines), values


def code_match_rows(folder: Path) -> str:
    lines = [
        "| Set | Search | Right code in the top 10 | Right code first | Plain answer in the top 10 |",
        "|---|---|---|---|---|",
    ]
    for label, name in (("Tuning (id2)", "search-tuning-id2-all-plain-tune"),
                        ("Held out (id3)", "search-tuning-id3-all-plain-holdout")):
        for variant, row in load(folder, name)["variants"].items():
            lines.append(
                f"| {label} | {variant} | {row['identifiers']:.1%} | {row['identifiersFirst']:.1%} "
                f"| {row['plain']:.1%} |"
            )
    return "\n".join(lines)


def code_weight_rows(folder: Path) -> str:
    lines = [
        "| Set | Search | Right code in the top 10 | Right code first | Plain answer in the top 10 | Plain answer first |",
        "|---|---|---|---|---|---|",
    ]
    for label, name in (("Tuning (id2)", "search-tuning-weights-id2"),
                        ("Tuning (id3)", "search-tuning-weights-id3"),
                        ("Held out (id4)", "search-tuning-weights-id4-held-out")):
        for variant, row in load(folder, name)["variants"].items():
            lines.append(
                f"| {label} | {variant} | {row['identifiers']:.1%} | {row['identifiersFirst']:.1%} "
                f"| {row['plain']:.1%} | {row['plainFirst']:.1%} |"
            )
    return "\n".join(lines)


def real_rows(folder: Path) -> tuple[str, str, dict]:
    run = load(folder, "scale-real-100000")
    recall = ["| `ef_search` | Recall@10 against exact | Vector p95 |", "|---|---|---|"]
    for row in run["recallByEfSearch"]:
        recall.append(f"| {row['efSearch']} | {row['recallAt10']:.3f} | {row['vectorP95Ms']} ms |")
    found = run["answerTurnInTop10"]
    labels = {"hybrid": "Both, the default", "vector": "Vectors only", "text": "Keywords only"}
    ablation = [
        f"| Search | Answer turn in the top 10, {found['hybrid']['questions']} questions | Full search p95 |",
        "|---|---|---|",
    ]
    for key, label in labels.items():
        ablation.append(
            f"| {label} | {found[key]['answerInTop10']:.1%} | {found[key]['searchP95Ms']} ms |"
        )
    values = {
        "real_hybrid": f"{found['hybrid']['answerInTop10']:.1%}",
        "real_vector": f"{found['vector']['answerInTop10']:.1%}",
        "real_hybrid_loss": f"{(found['vector']['answerInTop10'] - found['hybrid']['answerInTop10']) * 100:.0f}",
        "real_p95": f"{found['hybrid']['searchP95Ms']:.0f}",
    }
    return "\n".join(recall), "\n".join(ablation), values


def pilot_rows(folder: Path) -> str:
    rows = load(folder, "coding-pilot")["rows"]
    # rate-limit ran separately. Its first memory run hit the truncation bug,
    # which was fixed before this rerun.
    rows += load(folder, "coding-pilot-ratelimit-memory")["rows"]
    rows += [
        row
        for row in load(folder, "coding-smoke")["rows"]
        if row["setup"] in ("none", "full_history")
    ]
    setups = {
        "none": "No memory",
        "full_history": "Full history",
        "memory": "agent-memory-mcp",
    }
    lines = ["| Setup | Tasks passed |", "|---|---|"]
    for key, label in setups.items():
        runs = [row for row in rows if row["setup"] == key]
        lines.append(f"| {label} | {sum(r['passed'] for r in runs)} of {len(runs)} |")
    return "\n".join(lines)


def hard_rows(folder: Path) -> str:
    before = load(folder, "coding-hard-pilot")["summary"]
    after = load(folder, "coding-hard-pilot-natural")["summary"]
    setups = {
        "none": "No memory",
        "full_history": "Full history",
        "memory": "agent-memory-mcp",
    }
    lines = ["| Setup | First run | Current code, natural wording |", "|---|---|---|"]
    for key, label in setups.items():
        lines.append(
            f"| {label} | {before[key]['passed']} of {before[key]['runs']} "
            f"| {after[key]['passed']} of {after[key]['runs']} |"
        )
    return "\n".join(lines)


def setup_cost(runs: dict, setup: str) -> float:
    return sum(
        row["second"]["cost_usd_equivalent"] or 0
        for row in runs["rows"]
        if row["setup"] == setup
    )


def setup_tokens(runs: dict, setup: str) -> int:
    return runs["summary"][setup]["input_tokens"]


def run_rows(runs: dict) -> str:
    labels = {
        "none": "No memory",
        "full_history": "Full history",
        "memory": "agent-memory-mcp",
    }
    lines = ["| Setup | Passed | Input tokens | Cost |", "|---|---|---|---|"]
    for setup, label in labels.items():
        row = runs["summary"][setup]
        lines.append(
            f"| {label} | {row['passed']} of {row['runs']} "
            f"| {row['input_tokens']:,} | ${setup_cost(runs, setup):.2f} |"
        )
    return "\n".join(lines)


SUITE_LABELS = {
    "memory": "agent-memory-mcp",
    "full_history": "Full history",
    "rag": "Naive RAG",
    "mem0_fair": "Mem0, 3-turn windows, thinking off",
    "mem0": "Mem0, 20-turn windows, thinking on",
    "mem0_budget": "Mem0, 20-turn windows, thinking on, full budget",
    "none": "No memory",
}


def suite_runs() -> list[dict]:
    path = ROOT / "eval" / "suite" / "runs.jsonl"
    return [json.loads(line) for line in path.read_text().splitlines()]


def pass_stats(rows: list[dict]) -> tuple[int, int, float, float]:
    rates = []
    for repeat in sorted({row["repeat"] for row in rows}):
        picked = [row for row in rows if row["repeat"] == repeat]
        rates.append(sum(row["passed"] for row in picked) / len(picked))
    return sum(row["passed"] for row in rows), len(rows), statistics.mean(rates), statistics.pstdev(rates)


def suite_rows() -> str:
    runs = suite_runs()
    lines = [
        "| Setup | Passed, all 30 | Unseen 25 | Mean ± std over 3 runs | Input tokens | Cost |",
        "|---|---|---|---|---|---|",
    ]
    for setup, label in SUITE_LABELS.items():
        rows = [row for row in runs if row["setup"] == setup]
        unseen = [row for row in rows if row["group"] == "unseen"]
        passed, total, mean, spread = pass_stats(rows)
        tokens = sum(row["second"]["input_tokens"] for row in rows)
        cost = sum(row["second"]["cost_usd_equivalent"] or 0 for row in rows)
        lines.append(
            f"| {label} | {passed} of {total} | {sum(r['passed'] for r in unseen)} of {len(unseen)} "
            f"| {mean:.1%} ± {spread:.1%} | {tokens / 1e6:.1f}M | ${cost:.2f} |"
        )
    return "\n".join(lines)


def harbor_rows() -> str:
    runs = suite_runs()
    labels = {**SUITE_LABELS, "mem0_w3": "Mem0, 3-turn windows, thinking on"}
    lines = ["| Setup | Passed |", "|---|---|"]
    for setup in ["memory", "full_history", "rag", "mem0_fair", "mem0_w3", "mem0", "mem0_budget", "none"]:
        rows = [r for r in runs if r["setup"] == setup and r["task"].startswith("harbor-rentals/")]
        lines.append(f"| {labels[setup]} | {sum(r['passed'] for r in rows)} of {len(rows)} |")
    return "\n".join(lines)


def qa_rows(folder: Path) -> str:
    qa = load(folder, "qa-locomo")
    labels = {
        "full_history": "Full history",
        "rag": "Naive RAG",
        "mem0": "Mem0, thinking off",
        "memory-off": "agent-memory-mcp, lasting check off",
        "memory": "agent-memory-mcp",
        "none": "No memory",
    }
    lines = [f"| Setup | Correct, mean ± std over {qa['rag']['runs']} runs of {qa['rag']['questions']} | Context per question |", "|---|---|---|"]
    for key, label in labels.items():
        row = qa[key]
        lines.append(
            f"| {label} | {row['accuracy']:.1%} ± {row['std']:.1%} | {row['mean_context_chars']:,} characters |"
        )
    return "\n".join(lines)


def lme_rows(folder: Path) -> tuple[str, str, dict]:
    run = load(folder, "qa-longmemeval")
    setups = run["setups"]
    labels = {"full_history": "Full history", "rag": "Naive RAG", "mem0": "Mem0, thinking off",
              "memory": "agent-memory-mcp", "none": "No memory"}
    first = setups["rag"]
    overall = [
        f"| Setup | Correct, mean ± std over {first['runs']} runs of {first['questions']} | Context per question |",
        "|---|---|---|",
    ]
    for key, label in labels.items():
        row = setups[key]
        overall.append(
            f"| {label} | {row['accuracy']:.1%} ± {row['std']:.1%} | {row['mean_context_chars']:,} characters |"
        )
    kinds = sorted(first["by_type"])
    shown = ("full_history", "rag", "mem0", "memory")
    typed = ["| Question type | " + " | ".join(labels[k] for k in shown) + " |",
             "|---|---|---|---|---|"]
    for kind in kinds:
        typed.append(f"| {kind} | " + " | ".join(
            f"{setups[k]['by_type'][kind]:.0%}" for k in shown) + " |")
    seeding = run["seeding"]
    values = {
        "lme_memory": f"{setups['memory']['accuracy']:.1%}",
        "lme_mem0": f"{setups['mem0']['accuracy']:.1%}",
        "lme_rag": f"{setups['rag']['accuracy']:.1%}",
        "lme_full": f"{setups['full_history']['accuracy']:.1%}",
        "lme_written": str(sum(v["written"] for v in seeding.values())),
        "lme_per_question": f"{sum(v['written'] for v in seeding.values()) / len(seeding):.0f}",
        "lme_seed_minutes": f"{sum(v['seconds'] for v in seeding.values()) / len(seeding) / 60:.0f}",
    }
    return "\n".join(overall), "\n".join(typed), values


def worst_rows(folder: Path) -> tuple[str, str]:
    run = load(folder, "worst-cases")
    lines = ["| Category | Source | Case | Expected | What memory gave | Memory | Others |",
             "|---|---|---|---|---|---|---|"]
    clean = lambda text: " ".join(str(text).split()).replace("|", "/")
    for case in run["cases"]:
        answer = clean(case["memory_answer"])
        answer = answer if len(answer) <= 160 else answer[:157] + "..."
        lines.append(
            f"| {case['category']} | {case['source']} | {clean(case['case'])} | {clean(case['expected'])} "
            f"| {answer} | {case['memory_correct']} | {case['others_correct']} |"
        )
    locomo = ", ".join(f"{count} {name}" for name, count in run["locomo"].items())
    return "\n".join(lines), locomo


def cost_rows(folder: Path) -> str:
    run = load(folder, "distillation-cost")
    lines = ["| History | Events | agent-memory-mcp, minutes per 1,000 events | Mem0, thinking off |",
             "|---|---|---|---|"]
    for row in run["rows"]:
        mem0 = f"{row['mem0_minutes_per_1k']}" if row["mem0_minutes_per_1k"] is not None else "not run"
        lines.append(f"| {row['source']} | {row['events']:,} | {row['memory_minutes_per_1k']} | {mem0} |")
    return "\n".join(lines)


def floor_rows(folder: Path) -> tuple[str, str]:
    run = load(folder, "cutoff-scores")
    floor = 0.45
    keep = lambda r: r["textRank"] is not None or (r["similarity"] or 0) >= floor  # noqa: E731
    lines = ["| Half | Tasks | Needed memory still in context | Unrelated memories kept | Memories per task | Weakest needed |",
             "|---|---|---|---|---|---|"]
    for half, label in (("tune", "Tuning"), ("holdout", "Held out")):
        tasks = [t for t in run["tasks"] if t["half"] == half]
        found = [t for t in tasks if any(r["needed"] for r in t["results"])]
        kept = sum(any(r["needed"] and keep(r) for r in t["results"]) for t in found)
        others = [r for t in tasks for r in t["results"] if not r["needed"]]
        before = sum(len(t["results"]) for t in tasks) / len(tasks)
        after = sum(sum(keep(r) for r in t["results"]) for t in tasks) / len(tasks)
        weakest = min(r["similarity"] for t in tasks for r in t["results"] if r["needed"])
        lines.append(
            f"| {label} | {len(tasks)} | {kept} of {len(found)} | {sum(keep(r) for r in others) / len(others):.0%} "
            f"| {before:.1f} to {after:.1f} | {weakest:.3f} |"
        )
    runs = suite_runs()
    agents = ["| Memory setup, 25 unseen tasks, 3 runs | Passed | Mean ± std | Input tokens |", "|---|---|---|---|"]
    for setup, label in (("memory", "Before the floor"), ("memory_floor", "With the floor")):
        rows = [r for r in runs if r["setup"] == setup and r["group"] == "unseen"]
        passed, total, mean, spread = pass_stats(rows)
        tokens = sum(r["second"]["input_tokens"] for r in rows)
        agents.append(f"| {label} | {passed} of {total} | {mean:.1%} ± {spread:.1%} | {tokens / 1e6:.1f}M |")
    return "\n".join(lines), "\n".join(agents)


def write_pareto(folder: Path) -> None:
    from pareto import draw

    runs = suite_runs()
    coding = []
    for setup in ("memory", "full_history", "rag", "mem0_fair", "none"):
        rows = [row for row in runs if row["setup"] == setup]
        cost = sum(row["second"]["cost_usd_equivalent"] or 0 for row in rows)
        # Memory, Mem0 and full history land at about the same height.
        lift = {"memory": 14, "mem0_fair": -12, "full_history": -12}.get(setup, 0)
        label = "Mem0" if setup == "mem0_fair" else SUITE_LABELS[setup]
        coding.append((label, cost, pass_stats(rows)[2], lift))
    qa = load(folder, "qa-locomo")
    names = {"memory": "agent-memory-mcp", "memory-off": "check off", "rag": "Naive RAG",
             "mem0": "Mem0", "full_history": "Full history"}
    answers = [(label, qa[key]["mean_context_chars"], qa[key]["accuracy"]) for key, label in names.items()]
    (ROOT / "docs" / "pareto.svg").write_text(draw(coding, answers) + "\n")


def poison_rows(folder: Path) -> str:
    before = {
        **load(folder, "poisoning-before")["summary"],
        **load(folder, "poisoning-agent_fix-relayed")["summary"],
    }
    after = load(folder, "poisoning")["summary"]
    labels = {
        "tool_output": "In tool output",
        "pasted": "Pasted by the user, with a question",
        "agent_repeat": "Repeated by the agent",
        "relayed": "Relayed by the user as a statement",
        "agent_fix": "Repeated by the agent while explaining a failure",
        "control": "Control: the user's own rule",
    }
    lines = ["| Planted | Stored before the defence | Stored after |", "|---|---|---|"]
    for key, label in labels.items():
        lines.append(
            f"| {label} | {before[key]['stored']} of {before[key]['cases']} "
            f"| {after[key]['stored']} of {after[key]['cases']} |"
        )
    return "\n".join(lines)


def staged_rows(folder: Path, stages: list[tuple[str, str]], labels: dict[str, str]) -> str:
    runs = [(title, load(folder, name)["summary"]) for title, name in stages]
    lines = [
        "| Planted | " + " | ".join(f"Stored, {title}" for title, _ in runs) + " |",
        "|---" * (len(runs) + 1) + "|",
    ]
    for key, label in labels.items():
        cells = [f"{run[key]['stored']} of {run[key]['cases']}" for _, run in runs]
        lines.append(f"| {label} | " + " | ".join(cells) + " |")
    return "\n".join(lines)


def held_out_poison_rows(folder: Path) -> str:
    return staged_rows(
        folder,
        [("no check", "poisoning2-before"), ("whole-memory check", "poisoning2"),
         ("clause check", "poisoning2-clauses")],
        {
            "relayed_doc": "Relayed from an outside document",
            "pasted_statement": "Pasted from a vendor wiki",
            "agent_fix": "Quoted by the agent in a fix explanation",
            "agent_quote": "Quoted by the agent from a README",
            "user_rule": "Control: the user's own rule",
            "team_relay": "Control: a team decision passed on",
            "agent_own_fix": "Control: the agent's own fix",
        },
    )


def third_poison_rows(folder: Path) -> str:
    return staged_rows(
        folder,
        [("whole-memory check", "poisoning3-before"), ("clause check", "poisoning3")],
        {
            "fix_checklist": "Quoted from a checklist in a fix",
            "fix_guide": "Quoted from a contributor guide in a fix",
            "fix_inline": "Woven into a fix sentence",
            "agent_own_fix": "Control: a genuine fix quoting documentation",
            "user_rule": "Control: the user's own rule",
            "team_relay": "Control: a team decision passed on",
        },
    )


def fourth_poison_rows(folder: Path) -> str:
    return staged_rows(
        folder,
        [("clause check, kept", "poisoning4-before"), ("action named first, reverted", "poisoning4")],
        {
            "fix_outcome": "Reported as what made it pass",
            "fix_solution": "Given as the answer from an FAQ",
            "fix_caveat": "Applied from a wiki, with a caveat",
            "agent_own_fix": "Control: a genuine fix, some touching a safeguard",
            "user_rule": "Control: the user's own rule",
            "team_relay": "Control: a team decision passed on",
        },
    )


def fifth_poison_rows(folder: Path) -> str:
    return staged_rows(
        folder,
        [("before the access rule", "poisoning5-before"), ("with the access rule, kept", "poisoning5")],
        {
            "fix_ticket": "Taken from a ticket's resolution",
            "fix_runbook": "Quoted from a runbook",
            "fix_colleague": "A colleague's tip, relayed by the user",
            "fix_summary": "Inside an end-of-session summary",
            "agent_own_fix": "Control: a genuine fix, most granting narrow access",
            "user_rule": "Control: the user's own rule",
            "team_relay": "Control: a team decision passed on",
        },
    )


def sixth_poison_rows(folder: Path) -> str:
    return staged_rows(
        folder,
        [("before the safeguard rule", "poisoning6-before"), ("with the safeguard rule, kept", "poisoning6")],
        {
            "fix_postmortem": "A postmortem's remediation",
            "fix_pr_comment": "A maintainer's pull request comment",
            "fix_handover": "An on-call handover, relayed by the user",
            "fix_chat": "A team chat message",
            "agent_own_fix": "Control: a genuine fix, most adjusting a safeguard",
            "user_rule": "Control: the user's own rule",
            "team_relay": "Control: a team decision passed on",
        },
    )


def long_values(store: dict) -> dict[str, str]:
    task_noise = [row["noise"] for row in store["task_context"].values()]
    return {
        "decisions": f"{store['decisions_present']} of {store['decisions_total']}",
        "stale": str(len(store["stale_memories"])),
        "count": str(store["count"]),
        "noise": str(len(store["noise_memories"])),
        "overview_decisions": (
            f"{store['overview_decisions_present']} of {store['decisions_total']}"
        ),
        "overview_memories": str(store["overview_memories"]),
        "overview_noise": str(store["overview_noise"]),
        "overview_chars": f"{store['overview_chars']:,}",
        "share": f"{store['overview_share_of_history']:.1%}",
        "task_noise": f"{min(task_noise)} to {max(task_noise)}",
        "minutes": str(round(store["seconds"] / 60)),
    }


def main() -> None:
    folder = sorted((ROOT / "eval" / "results").iterdir())[-1]
    deletion = load(folder, "deletion")
    knowledge = load(folder, "knowledge")
    reviewed = deletion["paraphrase_reviewed"]
    template = (ROOT / "eval" / "report.template.md").read_text()
    output = (
        template.replace("{{date}}", f"up to {folder.name}")
        .replace("{{deletion}}", deletion_rows(deletion))
        .replace("{{scale}}", scale_rows(folder))
        .replace("{{pilot}}", pilot_rows(folder))
        .replace("{{hard}}", hard_rows(folder))
        .replace("{{offered}}", f"{reviewed['facts_offered_for_review']} of {reviewed['facts']}")
        .replace("{{candidates}}", f"{reviewed['candidates_per_preview']:.1f}")
        .replace("{{kept}}", f"{reviewed['facts_kept_by_distiller']} of {reviewed['facts']}")
        .replace("{{update}}", f"{knowledge['update_correctness']:.0%}")
        .replace("{{cases}}", str(knowledge["cases"]))
        .replace("{{replaced}}", str(knowledge["controls_wrongly_replaced"]))
        .replace("{{learned}}", str(knowledge["controls_first_fact_learned"]))
        .replace("{{controls}}", str(knowledge["controls"]))
    )
    held = load(folder, "holdout-store")
    second = load(folder, "holdout2-store")
    third = load(folder, "holdout3-store")
    fourth = load(folder, "holdout4-store")
    output = output.replace(
        "{{held}}", f"{held['decisions_present']} of {held['decisions_total']}"
    ).replace(
        "{{held2}}", f"{second['decisions_present']} of {second['decisions_total']}"
    ).replace(
        "{{held3}}", f"{third['decisions_present']} of {third['decisions_total']}"
    ).replace(
        "{{held4}}", f"{fourth['decisions_present']} of {fourth['decisions_total']}"
    )
    for prefix, name in (("long", "long-store"), ("unseen", "long-unseen-store")):
        for field, value in long_values(load(folder, name)).items():
            output = output.replace(f"{{{{{prefix}_{field}}}}}", value)
    agreement = load(folder, "judge-agreement")
    context = load(folder, "suite-context")
    shares = [row["share"] for row in context.values()]
    output = (
        output.replace("{{suite_rows}}", suite_rows())
        .replace("{{harbor_rows}}", harbor_rows())
        .replace("{{qa_rows}}", qa_rows(folder))
        .replace("{{agreed}}", f"{agreement['agreed']} of {agreement['labelled']}")
        .replace("{{agreement}}", f"{agreement['agreement']:.0%}")
        .replace("{{context_share}}", f"{min(shares):.1%} to {max(shares):.1%}")
    )
    qa = load(folder, "qa-locomo")
    runs_all = suite_runs()
    by_setup = lambda name: [row for row in runs_all if row["setup"] == name]  # noqa: E731
    tokens = lambda name: sum(row["second"]["input_tokens"] for row in by_setup(name))  # noqa: E731
    output = (
        output.replace("{{qa_memory}}", f"{qa['memory']['accuracy']:.1%}")
        .replace("{{qa_rag}}", f"{qa['rag']['accuracy']:.1%}")
        .replace("{{qa_mem0}}", f"{qa['mem0']['accuracy']:.1%}")
        .replace("{{qa_off}}", f"{qa['memory-off']['accuracy']:.1%}")
        .replace("{{qa_full}}", f"{qa['full_history']['accuracy']:.1%}")
        .replace("{{suite_memory}}", f"{pass_stats(by_setup('memory'))[2]:.1%}")
        .replace("{{suite_mem0}}", f"{pass_stats(by_setup('mem0_fair'))[2]:.1%}")
        .replace("{{suite_none}}", f"{pass_stats(by_setup('none'))[2]:.1%}")
        .replace("{{token_share}}", f"{tokens('memory') / tokens('full_history'):.0%}")
    )
    runs = load(folder, "coding-long-unseen")
    output = (
        output.replace("{{run_rows}}", run_rows(runs))
        .replace("{{run_chars}}", f"{runs['usage']['transcript_chars']:,}")
        .replace("{{run_cost_share}}", f"{setup_cost(runs, 'memory') / setup_cost(runs, 'full_history'):.0%}")
        .replace("{{run_token_share}}", f"{setup_tokens(runs, 'memory') / setup_tokens(runs, 'full_history'):.0%}")
    )
    output = output.replace("{{poison_rows}}", poison_rows(folder)).replace(
        "{{held_out_poison_rows}}", held_out_poison_rows(folder)
    ).replace("{{third_poison_rows}}", third_poison_rows(folder))
    output = output.replace("{{fourth_poison_rows}}", fourth_poison_rows(folder))
    output = output.replace("{{fifth_poison_rows}}", fifth_poison_rows(folder))
    output = output.replace("{{sixth_poison_rows}}", sixth_poison_rows(folder))
    timing_rows, fusion_rows = tuning_rows(folder)
    output = output.replace("{{tuning_timing_rows}}", timing_rows).replace(
        "{{tuning_fusion_rows}}", fusion_rows
    )
    output = output.replace("{{code_match_rows}}", code_match_rows(folder))
    output = output.replace("{{code_weight_rows}}", code_weight_rows(folder))
    lme_overall, lme_typed, lme_values = lme_rows(folder)
    output = output.replace("{{lme_rows}}", lme_overall).replace("{{lme_type_rows}}", lme_typed)
    for name, value in lme_values.items():
        output = output.replace(f"{{{{{name}}}}}", value)
    worst, locomo_worst = worst_rows(folder)
    output = output.replace("{{worst_rows}}", worst).replace("{{locomo_worst}}", locomo_worst)
    output = output.replace("{{cost_rows}}", cost_rows(folder))
    floor_table, floor_agents = floor_rows(folder)
    output = output.replace("{{floor_rows}}", floor_table).replace("{{floor_agent_rows}}", floor_agents)
    near_rows, near_values = near_miss_rows(folder)
    output = output.replace("{{near_miss_rows}}", near_rows)
    for name, value in near_values.items():
        output = output.replace(f"{{{{{name}}}}}", value)
    recall_rows, ablation_rows, real_values = real_rows(folder)
    output = output.replace("{{real_recall_rows}}", recall_rows).replace(
        "{{real_ablation_rows}}", ablation_rows
    )
    for name, value in real_values.items():
        output = output.replace(f"{{{{{name}}}}}", value)
    write_pareto(folder)
    target = ROOT / "docs" / "eval-report.md"
    target.write_text(output)
    print("wrote", target)


if __name__ == "__main__":
    main()

"""Builds docs/eval-report.md from the newest eval/results folder."""

import json
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EF_DEFAULT = 400


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
        "| Vectors | Memories | Recall@10 | Vector p95 | Full search p95 | Scrub lock |",
        "|---|---|---|---|---|---|",
    ]
    for shape in ("clustered", "random"):
        for size in (1000, 10000, 100000):
            run = load(folder, f"scale-{shape}-{size}")
            row = next(r for r in run["recallByEfSearch"] if r["efSearch"] == EF_DEFAULT)
            scrub = run.get("scrubSeconds")
            lines.append(
                f"| {shape.capitalize()} | {size:,} | {row['recallAt10']:.3f} "
                f"| {row['vectorP95Ms']} ms | {run['searchP95Ms']} ms "
                f"| {f'{scrub} s' if scrub else 'not measured'} |"
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
    "mem0": "Mem0, 20-turn windows",
    "mem0_budget": "Mem0, 20-turn windows, full budget",
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
    labels = {**SUITE_LABELS, "mem0_w3": "Mem0, 3-turn windows"}
    lines = ["| Setup | Passed |", "|---|---|"]
    for setup in ["memory", "full_history", "rag", "mem0_w3", "mem0", "mem0_budget", "none"]:
        rows = [r for r in runs if r["setup"] == setup and r["task"].startswith("harbor-rentals/")]
        lines.append(f"| {labels[setup]} | {sum(r['passed'] for r in rows)} of {len(rows)} |")
    return "\n".join(lines)


def qa_rows(folder: Path) -> str:
    qa = load(folder, "qa-locomo")
    labels = {
        "full_history": "Full history",
        "rag": "Naive RAG",
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


def write_pareto(folder: Path) -> None:
    from pareto import draw

    runs = suite_runs()
    coding = []
    for setup in ("memory", "full_history", "rag", "mem0", "none"):
        rows = [row for row in runs if row["setup"] == setup]
        cost = sum(row["second"]["cost_usd_equivalent"] or 0 for row in rows)
        # Memory and full history land at the same height: one label up, one down.
        lift = {"memory": -12, "full_history": 14}.get(setup, 0)
        coding.append((SUITE_LABELS[setup], cost, pass_stats(rows)[2], lift))
    qa = load(folder, "qa-locomo")
    names = {"memory": "agent-memory-mcp", "memory-off": "check off", "rag": "Naive RAG",
             "full_history": "Full history"}
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


def held_out_poison_rows(folder: Path) -> str:
    before = load(folder, "poisoning2-before")["summary"]
    after = load(folder, "poisoning2")["summary"]
    labels = {
        "relayed_doc": "Relayed from an outside document",
        "pasted_statement": "Pasted from a vendor wiki",
        "agent_fix": "Quoted by the agent in a fix explanation",
        "agent_quote": "Quoted by the agent from a README",
        "user_rule": "Control: the user's own rule",
        "team_relay": "Control: a team decision passed on",
        "agent_own_fix": "Control: the agent's own fix",
    }
    lines = ["| Planted | Stored before the defence | Stored after |", "|---|---|---|"]
    for key, label in labels.items():
        lines.append(
            f"| {label} | {before[key]['stored']} of {before[key]['cases']} "
            f"| {after[key]['stored']} of {after[key]['cases']} |"
        )
    return "\n".join(lines)


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
        .replace("{{qa_off}}", f"{qa['memory-off']['accuracy']:.1%}")
        .replace("{{qa_full}}", f"{qa['full_history']['accuracy']:.1%}")
        .replace("{{suite_memory}}", f"{pass_stats(by_setup('memory'))[2]:.1%}")
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
    )
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

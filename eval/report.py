"""Builds docs/eval-report.md from the newest eval/results folder."""

import json
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
    after = load(folder, "coding-hard-pilot-fixed")["summary"]
    setups = {
        "none": "No memory",
        "full_history": "Full history",
        "memory": "agent-memory-mcp",
    }
    lines = ["| Setup | Before fixes | After fixes |", "|---|---|---|"]
    for key, label in setups.items():
        lines.append(
            f"| {label} | {before[key]['passed']} of {before[key]['runs']} "
            f"| {after[key]['passed']} of {after[key]['runs']} |"
        )
    return "\n".join(lines)


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
    output = output.replace(
        "{{held}}", f"{held['decisions_present']} of {held['decisions_total']}"
    ).replace(
        "{{held2}}", f"{second['decisions_present']} of {second['decisions_total']}"
    ).replace(
        "{{held3}}", f"{third['decisions_present']} of {third['decisions_total']}"
    )
    target = ROOT / "docs" / "eval-report.md"
    target.write_text(output)
    print("wrote", target)


if __name__ == "__main__":
    main()

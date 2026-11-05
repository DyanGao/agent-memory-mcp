"""Builds docs/eval-report.md from the newest eval/results folder."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EF_DEFAULT = 400


def load(folder: Path, name: str) -> dict:
    return json.loads((folder / f"{name}.json").read_text())


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


def main() -> None:
    folder = sorted((ROOT / "eval" / "results").iterdir())[-1]
    deletion = load(folder, "deletion")
    knowledge = load(folder, "knowledge")
    reviewed = deletion["paraphrase_reviewed"]
    template = (ROOT / "eval" / "report.template.md").read_text()
    output = (
        template.replace("{{date}}", folder.name)
        .replace("{{deletion}}", deletion_rows(deletion))
        .replace("{{scale}}", scale_rows(folder))
        .replace("{{offered}}", f"{reviewed['facts_offered_for_review']} of {reviewed['facts']}")
        .replace("{{candidates}}", f"{reviewed['candidates_per_preview']:.1f}")
        .replace("{{kept}}", f"{reviewed['facts_kept_by_distiller']} of {reviewed['facts']}")
        .replace("{{update}}", f"{knowledge['update_correctness']:.0%}")
        .replace("{{cases}}", str(knowledge["cases"]))
        .replace("{{replaced}}", str(knowledge["controls_wrongly_replaced"]))
        .replace("{{learned}}", str(knowledge["controls_first_fact_learned"]))
        .replace("{{controls}}", str(knowledge["controls"]))
    )
    target = ROOT / "docs" / "eval-report.md"
    target.write_text(output)
    print("wrote", target)


if __name__ == "__main__":
    main()

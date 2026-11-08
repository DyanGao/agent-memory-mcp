"""Draws docs/pareto.svg: accuracy against cost, so trade-offs show at a glance.

Plain SVG, so no plotting library is needed. Both axes of cost are log scale:
the setups differ by more than 25 times.
"""

import math

WIDTH, HEIGHT = 760, 330
PANEL = 330
LEFT, TOP, BOTTOM = 60, 40, 50
INK = "#24292f"
GRID = "#d0d7de"
MEMORY = "#0969da"
OTHER = "#57606a"


def _panel(x0: int, title: str, xlabel: str, points: list[tuple]) -> str:
    """Points are (name, x, rate), with an optional label shift in pixels."""
    plot_w, plot_h = PANEL - LEFT - 20, HEIGHT - TOP - BOTTOM
    xs = [math.log10(max(point[1], 1e-6)) for point in points]
    low, high = math.floor(min(xs)), math.ceil(max(xs))
    if high == low:
        high = low + 1

    def px(value: float) -> float:
        return x0 + LEFT + (math.log10(max(value, 1e-6)) - low) / (high - low) * plot_w

    def py(rate: float) -> float:
        return TOP + (1 - rate) * plot_h

    parts = [f'<text x="{x0 + LEFT}" y="22" font-size="14" font-weight="600" fill="{INK}">{title}</text>']
    for tick in (0, 0.25, 0.5, 0.75, 1):
        y = py(tick)
        parts.append(f'<line x1="{x0 + LEFT}" x2="{x0 + LEFT + plot_w}" y1="{y}" y2="{y}" stroke="{GRID}"/>')
        parts.append(f'<text x="{x0 + LEFT - 8}" y="{y + 4}" font-size="11" text-anchor="end" fill="{OTHER}">{tick:.0%}</text>')
    for power in range(low, high + 1):
        x = x0 + LEFT + (power - low) / (high - low) * plot_w
        label = f"{10 ** power:g}"
        parts.append(f'<text x="{x}" y="{TOP + plot_h + 18}" font-size="11" text-anchor="middle" fill="{OTHER}">{label}</text>')
    parts.append(
        f'<text x="{x0 + LEFT + plot_w / 2}" y="{HEIGHT - 10}" font-size="11" text-anchor="middle" fill="{OTHER}">{xlabel}</text>'
    )
    for name, x, rate, *nudge in points:
        lift = nudge[0] if nudge else 0
        colour = MEMORY if name.startswith("agent-memory") else OTHER
        cx, cy = px(x), py(rate)
        anchor = "end" if cx > x0 + LEFT + plot_w * 0.6 else "start"
        dx = -8 if anchor == "end" else 8
        parts.append(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="5" fill="{colour}"/>')
        parts.append(
            f'<text x="{cx + dx:.1f}" y="{cy + 4 + lift:.1f}" font-size="11" text-anchor="{anchor}" fill="{colour}">{name}</text>'
        )
    return "\n".join(parts)


def draw(coding: list[tuple[str, float, float]], qa: list[tuple[str, float, float]]) -> str:
    return "\n".join(
        [
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {WIDTH} {HEIGHT}" '
            f'font-family="-apple-system, Segoe UI, sans-serif">',
            f'<rect width="{WIDTH}" height="{HEIGHT}" fill="#ffffff"/>',
            _panel(0, "Coding tasks passed", "Cost of 90 runs, US dollars", coding),
            _panel(PANEL + 60, "LoCoMo answered correctly", "Context per question, characters", qa),
            "</svg>",
        ]
    )

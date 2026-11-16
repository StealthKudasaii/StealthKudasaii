"""Image de la courbe des gains (PNG) pour Discord. Nécessite matplotlib (sinon : pas d'image)."""
from __future__ import annotations

import io
from datetime import datetime
from typing import Optional


def equity_png(points: list[dict], title: str = "Courbe des gains") -> Optional[bytes]:
    if len(points) < 2:
        return None
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return None

    values = [0.0] + [p["v"] for p in points]
    labels = [""] + [p["t"] for p in points]
    xs = list(range(len(values)))
    color = "#3fb950" if values[-1] >= 0 else "#f85149"

    fig, ax = plt.subplots(figsize=(9, 3.6), dpi=130)
    fig.patch.set_facecolor("#161b22")
    ax.set_facecolor("#161b22")
    ax.plot(xs, values, color=color, linewidth=2.2)
    ax.fill_between(xs, values, 0, color=color, alpha=0.12)
    ax.axhline(0, color="#30363d", linewidth=1, linestyle="--")
    ax.set_title(title, color="#e6edf3", fontsize=12, loc="left")
    ax.tick_params(colors="#8b949e", labelsize=8)
    for spine in ax.spines.values():
        spine.set_visible(False)
    ax.grid(axis="y", color="#21262d", linewidth=0.8)
    step = max(1, len(xs) // 6)
    ticks = xs[1::step]
    ax.set_xticks(ticks)

    def fmt(label: str) -> str:
        try:
            return datetime.fromisoformat(label).strftime("%d/%m")
        except (TypeError, ValueError):
            return ""

    ax.set_xticklabels([fmt(labels[i]) for i in ticks])
    ax.annotate(f"{values[-1]:+.2f}", (xs[-1], values[-1]), textcoords="offset points", xytext=(-10, 8),
                ha="right", color=color, fontsize=11, fontweight="bold")
    fig.tight_layout()
    buf = io.BytesIO()
    fig.savefig(buf, format="png", facecolor=fig.get_facecolor())
    plt.close(fig)
    return buf.getvalue()

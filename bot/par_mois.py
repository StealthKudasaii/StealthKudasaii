"""Résultat de quelques stratégies, tranche de 30 jours par tranche : python -m bot.par_mois"""
from __future__ import annotations

import json
from datetime import datetime, timedelta

from .backtest import OUT
from .strategies import STRATEGIES, evaluate

WATCH = ["⚠", "★ SCALPING + principal contre H1, SL ≤ 6 $ (partiel TP1 + BE",
         "★ SCALPING + principal contre H1, SL ≤ 6 $ (partiel TP1, BE seulement",
         "★ SCALPING + principal contre H1, SL ≤ 6 $ (TP1 seul)", "★ [3 / 8]",
         "SCALPING + principal contre la tendance H1", "SCALPING seul", "Référence"]


def main() -> None:
    d = json.loads((OUT / "strategies_data.json").read_text(encoding="utf-8"))
    sigs, bal, ai = d["signals"], d["balance"], d["ai"]
    res = {k: {int(i): v for i, v in m.items()} for k, m in d["outcomes"].items()}
    end = datetime.fromisoformat(d["end"])
    cuts = [end - timedelta(days=30 * k) for k in range(3, -1, -1)]
    chunks = [[s for s in sigs if a <= datetime.fromisoformat(s["t"]) < b] for a, b in zip(cuts, cuts[1:])]
    print("Prix de l'or au début de chaque tranche :", ", ".join(
        next((f"{p[1]:.0f}" for p in d["price"] if p[0] >= c.isoformat()), "?") for c in cuts))
    head = "  ".join(f"{a:%d/%m}-{b:%d/%m}" for a, b in zip(cuts, cuts[1:]))
    print(f"\n{'Stratégie':70} {head}   3 mois  baisse")
    for w in WATCH:
        name, strat = next((n, s) for n, s in STRATEGIES if n.startswith(w))
        parts = [evaluate(strat, c, res, ai, bal)["pnl"] for c in chunks]
        full = evaluate(strat, sigs, res, ai, bal)
        print(f"{name[:70]:70} " + "  ".join(f"{p:+11.1f}" for p in parts) + f"  {full['pnl']:+7.1f} {full['dd']:6.1f}")
    for src in ("scalp", "main"):
        print(src, "signaux par tranche :", [sum(s["src"] == src for s in c) for c in chunks],
              "dont SELL :", [sum(s["src"] == src and s["side"] == "SELL" for s in c) for c in chunks])


if __name__ == "__main__":
    main()

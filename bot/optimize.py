"""Recherche automatique de réglages, avec contrôle anti « coup de chance » : python -m bot.optimize

Utilise les rejeux déjà faits par bot.strategies (aucun appel API). Pour chaque combinaison de réglages :
  - résultat sur la 1re moitié du mois (A) et sur la 2e moitié (B) ;
  - « walk-forward » : on choisit le meilleur réglage sur A et on regarde ce qu'il donne sur B (et inversement).
Un réglage solide gagne sur les DEUX moitiés, pas seulement sur le mois entier.
"""
from __future__ import annotations

import itertools
import json

from .backtest import OUT
from .strategies import evaluate

SC_MODES = ["groupe", "sans_be_groupe"]
MAIN_MODES = ["groupe", "sans_be_groupe", "bot_seul", "tp1", "tp2", "be_tp2", "sans_be"]
GRID = {
    "h1_max": [None, 0],
    "h4_max": [None, 0],
    "sl_max": [None, 5, 6],
    "side": [None, "SELL"],
    "rsi_max": [None, 0],
}
LIMITS = [(2, 6), (3, 8), (4, 12)]


def combos():
    keys = list(GRID)
    for sc_mode in SC_MODES:
        for mode in MAIN_MODES:
            for vals in itertools.product(*GRID.values()):
                main = {"on": True, "mode": mode, **{k: v for k, v in zip(keys, vals) if v is not None}}
                for mo, md in LIMITS:
                    yield {"scalp": {"on": True, "mode": sc_mode}, "main": main, "max_open": mo, "max_day": md}
    for sc_mode in SC_MODES:
        for mo, md in LIMITS:
            yield {"scalp": {"on": True, "mode": sc_mode}, "main": {"on": False}, "max_open": mo, "max_day": md}


LABELS = {"groupe": "suit le groupe", "sans_be_groupe": "ignore ses BE", "bot_seul": "ignore sa gestion",
          "tp1": "TP1 seul", "tp2": "2 TP max", "be_tp2": "BE après TP2", "sans_be": "ni BE ni trailing"}


def name(c: dict) -> str:
    sc = "SCALPING" + ("" if c["scalp"]["mode"] == "groupe" else f" ({LABELS[c['scalp']['mode']]})")
    m = c["main"]
    if not m["on"]:
        main = "seul"
    else:
        f = []
        if m.get("side"):
            f.append("SELL")
        if m.get("h1_max") == 0:
            f.append("contre H1")
        if m.get("h4_max") == 0:
            f.append("contre H4")
        if m.get("sl_max"):
            f.append(f"SL ≤ {m['sl_max']} $")
        if m.get("rsi_max") == 0:
            f.append("RSI pas étiré")
        main = "+ principal " + (", ".join(f) if f else "tout") + f" ({LABELS[m['mode']]})"
    return f"[{c['max_open']}/{c['max_day']}] {sc} {main}"


def main() -> None:
    data = json.loads((OUT / "strategies_data.json").read_text(encoding="utf-8"))
    sigs, bal, ai = data["signals"], data["balance"], data["ai"]
    res = {k: {int(i): v for i, v in d.items()} for k, d in data["outcomes"].items()}
    mid = sorted(s["t"] for s in sigs)[len(sigs) // 2][:10]
    half_a = [s for s in sigs if s["t"][:10] < mid]
    half_b = [s for s in sigs if s["t"][:10] >= mid]
    rows = []
    for c in combos():
        full = evaluate(c, sigs, res, ai, bal)
        a = evaluate(c, half_a, res, ai, bal)
        b = evaluate(c, half_b, res, ai, bal)
        rows.append({"name": name(c), "cfg": c, "pnl": full["pnl"], "dd": full["dd"], "n": full["n"],
                     "a": a["pnl"], "b": b["pnl"], "worst_half": min(a["pnl"], b["pnl"])})
    print(f"{len(rows)} réglages testés · coupure entre les moitiés : {mid} "
          f"(A = {len(half_a)} signaux, B = {len(half_b)})\n")

    def table(title, lst):
        print(title)
        print(f"  {'Réglage':86} {'mois':>8} {'moit.A':>7} {'moit.B':>7} {'baisse':>7} {'trades':>6}")
        for r in lst:
            print(f"  {r['name'][:86]:86} {r['pnl']:+8.1f} {r['a']:+7.1f} {r['b']:+7.1f} {r['dd']:7.1f} {r['n']:6}")
        print()

    table("Meilleurs sur le mois entier (risque de coup de chance) :", sorted(rows, key=lambda r: -r["pnl"])[:12])
    table("Les plus SOLIDES (meilleure moitié la plus faible) :", sorted(rows, key=lambda r: -r["worst_half"])[:12])
    best_a = max(rows, key=lambda r: r["a"])
    best_b = max(rows, key=lambda r: r["b"])
    print("Walk-forward (le test honnête) :")
    print(f"  choisi sur A : {best_a['name']}\n     A = {best_a['a']:+.1f} $  →  sur B (jamais vu) = {best_a['b']:+.1f} $")
    print(f"  choisi sur B : {best_b['name']}\n     B = {best_b['b']:+.1f} $  →  sur A (jamais vu) = {best_b['a']:+.1f} $")
    ref = next(r for r in rows if not r["cfg"]["main"]["on"] and r["cfg"]["scalp"]["mode"] == "groupe"
               and r["cfg"]["max_open"] == 2)
    print(f"  référence SCALPING seul : A = {ref['a']:+.1f}  B = {ref['b']:+.1f}  mois = {ref['pnl']:+.1f}")
    (OUT / "optimisation.json").write_text(json.dumps({"mid": mid, "rows": rows}, ensure_ascii=False),
                                           encoding="utf-8")


if __name__ == "__main__":
    main()

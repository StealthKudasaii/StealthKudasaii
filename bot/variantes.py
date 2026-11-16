"""Compare plusieurs façons de suivre le groupe sur la même période : python -m bot.variantes --days 30

Utilise les données déjà téléchargées par `python -m bot.backtest --days N` (messages, bougies, lectures
de Claude en cache) : aucun appel payant tant que les messages sont les mêmes.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
from datetime import datetime, timedelta
from pathlib import Path

from .backtest import OUT, CachedAI, Msg, _bar_from_list, replay, signal_pnl
from .config import Config, load_config
from .models import SymbolSpec

# (nom affiché, réglages modifiés par rapport à config.yaml)
VARIANTES = [
    ("Actuel : on suit tout le groupe", {}),
    ("Ignorer les « sécurisez / BE » du groupe", {"management": {"follow_group_be": False}}),
    ("Ignorer toute la gestion du groupe (BE + fermetures)",
     {"management": {"follow_group_be": False, "follow_group_closes": False}}),
    ("Tout sur le TP1", {"management": {"max_tps": 1}}),
    ("Tout sur le TP1 + ignorer les BE du groupe", {"management": {"max_tps": 1, "follow_group_be": False}}),
    ("Ni BE ni trailing : TP ou SL, point", {"management": {"follow_group_be": False, "follow_group_closes": False,
                                                            "breakeven_after_tp": 99, "trail_to_previous_tp": False}}),
    ("Seulement les signaux avec SL ≤ 5 $", {"risk": {"max_sl_distance": 5.0}}),
    ("SL ≤ 5 $ + ignorer les BE du groupe", {"risk": {"max_sl_distance": 5.0}, "management": {"follow_group_be": False}}),
]


SCALP = {"forwarded_from": ["SCALPING"], "commands_from_everyone": False}
SCALP_CMD = {"forwarded_from": ["SCALPING"], "commands_from_everyone": True}
REENTREES = {"duplicate_window_minutes": 0, "max_open_signals": 4, "max_trades_per_day": 15}
VARIANTES_SCALPING = [
    ("Tout le groupe (comme avant)", {}),
    ("SCALPING seulement", {"telegram": SCALP}),
    ("SCALPING + consignes du groupe principal", {"telegram": SCALP_CMD}),
    ("SCALPING + re-entrées", {"telegram": SCALP, "risk": REENTREES}),
    ("SCALPING + re-entrées + consignes du groupe principal", {"telegram": SCALP_CMD, "risk": REENTREES}),
    ("SCALPING + re-entrées, sans BE (TP ou SL)", {"telegram": SCALP, "risk": REENTREES,
                                                  "management": {"breakeven_after_tp": 99, "trail_to_previous_tp": False}}),
    ("SCALPING + re-entrées, tout sur le TP1", {"telegram": SCALP, "risk": REENTREES, "management": {"max_tps": 1}}),
]
GROUPES = {"base": VARIANTES, "scalping": VARIANTES_SCALPING}


def with_overrides(cfg: Config, over: dict) -> Config:
    data = cfg.model_dump()
    for section, values in over.items():
        data[section].update(values)
    return Config.model_validate(data)


def stats(res) -> dict:
    db = res.engine.store.db
    taken = db.execute("SELECT id FROM signals WHERE status IN ('open','closed')").fetchall()
    pnls = [signal_pnl(res, r["id"]) for r in taken]
    peak, dd = res.balance0, 0.0
    for _, eq in res.broker.equity_curve:
        peak = max(peak, eq)
        dd = max(dd, peak - eq)
    days: dict[str, float] = {}
    for t, v in res.broker.realized:
        days[t.date().isoformat()] = days.get(t.date().isoformat(), 0.0) + v
    return {"pnl": sum(pnls), "n": len(pnls), "wins": sum(v > 0.01 for v in pnls),
            "losses": sum(v < -0.01 for v in pnls), "dd": dd,
            "green_days": sum(v > 0 for v in days.values()), "days": len(days),
            "worst_day": min(days.values()) if days else 0.0}


async def main_async(args) -> None:
    cfg = load_config(args.config)
    cfg = cfg.model_copy(update={"ai": cfg.ai.model_copy(update={"analyst_mode": "off"})})
    raw = json.loads((OUT / f"messages_{args.days}j.json").read_text(encoding="utf-8"))
    market = json.loads((OUT / f"marche_{args.days}j.json").read_text(encoding="utf-8"))
    off = timedelta(hours=args.offset)
    messages = [Msg(d["id"], datetime.fromisoformat(d["date_utc"]) + off, d["text"], d["reply_to"], d["edited"],
                d.get("fwd_from"))
                for d in raw]
    bars = {tf: [_bar_from_list(x) for x in rows] for tf, rows in market["bars"].items()}
    spreads = {datetime.fromisoformat(k): v for k, v in market["m1_spread"].items()}
    spec = SymbolSpec(*market["spec"])
    end = bars["M1"][-1].time + timedelta(minutes=1)
    start = end - timedelta(days=args.days)

    from .ai import AI

    ai = CachedAI(AI(cfg.ai.parser_model, cfg.ai.analyst_model, cfg.ai.analyst_effort), OUT / "cache_ia.json", False)
    rows = []
    variantes = GROUPES[args.groupe]
    for i, (name, over) in enumerate(variantes, 1):
        print(f"[{i}/{len(variantes)}] {name}…", flush=True)
        res = await replay(with_overrides(cfg, over), messages, bars, spec, market["contract_size"], ai, start, end,
                           args.balance, spreads, db_path=OUT / f"variante_{i}.sqlite")
        rows.append((name, stats(res)))
        res.engine.store.db.close()

    lot = f"lot fixe {cfg.risk.fixed_lot}" if cfg.risk.fixed_lot > 0 else f"risque {cfg.risk.risk_per_trade_pct} %"
    lines = [f"# Variantes sur {args.days} jours · solde de départ {args.balance:.0f} $ · {lot}\n",
             "| Variante | Résultat | Trades (gagnés / perdus) | Pire baisse | Jours gagnants | Pire journée |",
             "|---|---|---|---|---|---|"]
    for name, s in sorted(rows, key=lambda r: -r[1]["pnl"]):
        lines.append(f"| {name} | **{s['pnl']:+.2f} $** ({100 * s['pnl'] / args.balance:+.1f} %) | "
                     f"{s['n']} ({s['wins']} / {s['losses']}) | −{s['dd']:.2f} $ ({100 * s['dd'] / args.balance:.0f} %) | "
                     f"{s['green_days']} / {s['days']} | {s['worst_day']:+.2f} $ |")
    text = "\n".join(lines)
    out = OUT / f"variantes_{args.groupe}_{args.days}j_{datetime.now():%Y%m%d_%H%M}.md"
    out.write_text(text, encoding="utf-8")
    print("\n" + text + f"\n\nAppels payants : {ai.calls['parser']} · Fichier : {out}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Compare des façons de suivre le groupe")
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--balance", type=float, default=290)
    ap.add_argument("--offset", type=int, default=2, help="décalage heure serveur MT5 - UTC")
    ap.add_argument("--groupe", choices=sorted(GROUPES), default="base")
    ap.add_argument("--config", default="config.yaml")
    args = ap.parse_args()
    logging.basicConfig(level=logging.WARNING)
    from dotenv import load_dotenv

    load_dotenv()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()

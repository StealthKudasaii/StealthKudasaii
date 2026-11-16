"""Recherche de stratégies sur l'historique : python -m bot.strategies --days 30

1. Rejoue le mois avec chaque MODE de gestion (suivre le groupe, ignorer les BE, TP1 seul...) en prenant
   TOUS les signaux, pour connaître le résultat de chaque signal dans chaque mode.
2. Calcule pour chaque signal des indicateurs au moment du message (tendance H1/H4, RSI, ATR, R:R...)
   et, pour les signaux du groupe principal, l'avis d'une IA bon marché (Claude Haiku 5.5).
3. Évalue des dizaines de stratégies (filtres + mode) et vérifie les meilleures par un rejeu exact.
4. Écrit data/backtest/strategies_data.json et le site data/backtest/site_strategies.html.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from .backtest import OUT, BacktestBroker, CachedAI, Msg, _bar_from_list, replay, signal_pnl
from .config import Config, load_config
from .engine import leg_index
from .indicators import ema, rsi, atr
from .models import Side, Signal, SymbolSpec
from .variantes import with_overrides

log = logging.getLogger("strategies")

# Modes de gestion simulés (identiques pour tous les signaux dans un rejeu)
MODES = {
    "groupe": ("Suivre toutes les consignes du groupe", {}),
    "sans_be_groupe": ("Ignorer les « sécurisez / BE » du groupe", {"management": {"follow_group_be": False}}),
    "bot_seul": ("Ignorer toute la gestion du groupe", {"management": {"follow_group_be": False,
                                                                        "follow_group_closes": False}}),
    "tp1": ("Tout sur le TP1", {"management": {"max_tps": 1}}),
    "tp2": ("2 TP maximum", {"management": {"max_tps": 2}}),
    "be_tp2": ("BE seulement après le TP2", {"management": {"breakeven_after_tp": 2}}),
    "sans_be": ("Ni BE ni trailing (TP ou SL)", {"management": {"follow_group_be": False, "follow_group_closes": False,
                                                                "breakeven_after_tp": 99,
                                                                "trail_to_previous_tp": False}}),
}
RELAX = {"risk": {"max_open_signals": 99, "max_trades_per_day": 99, "duplicate_window_minutes": 0,
                  "max_daily_loss_pct": 0},
         "telegram": {"forwarded_from": [], "commands_from_everyone": True}}


def merge(*dicts: dict) -> dict:
    out: dict = {}
    for d in dicts:
        for k, v in d.items():
            out.setdefault(k, {}).update(v)
    return out


def load(days: int, offset: int):
    raw = json.loads((OUT / f"messages_{days}j.json").read_text(encoding="utf-8"))
    market = json.loads((OUT / f"marche_{days}j.json").read_text(encoding="utf-8"))
    off = timedelta(hours=offset)
    messages = [Msg(d["id"], datetime.fromisoformat(d["date_utc"]) + off, d["text"], d["reply_to"], d["edited"],
                    d.get("fwd_from")) for d in raw]
    bars = {tf: [_bar_from_list(x) for x in rows] for tf, rows in market["bars"].items()}
    spreads = {datetime.fromisoformat(k): v for k, v in market["m1_spread"].items()}
    return messages, bars, spreads, SymbolSpec(*market["spec"]), market["contract_size"]


def trend(bars) -> int:
    if len(bars) < 60:
        return 0
    closes = [b.close for b in bars]
    e20, e50 = ema(closes, 20)[-1], ema(closes, 50)[-1]
    if closes[-1] > e50 and e20 > e50:
        return 1
    if closes[-1] < e50 and e20 < e50:
        return -1
    return 0


def features(j: dict, broker: BacktestBroker, prev: list[dict]) -> dict:
    m, p = j["msg"], j["parsed"]
    side = p.get("side") or "BUY"
    sign = 1 if side == "BUY" else -1
    lo, hi = p.get("entry_low"), p.get("entry_high")
    if lo is None and hi is None:
        lo = hi = j["price"]
    lo, hi = min(lo or hi, hi or lo), max(lo or hi, hi or lo)
    entry = hi if side == "BUY" else lo
    sl = p.get("stop_loss") or entry
    tps = sorted([t for t in p.get("take_profits") or [] if (t - entry) * sign > 0], key=lambda t: (t - entry) * sign)
    sl_dist = abs(entry - sl)
    broker.now = m.time
    m15, h1, h4 = broker.rates("M15", 250), broker.rates("H1", 250), broker.rates("H4", 250)
    a15 = atr(m15) or 1.0
    r = rsi([b.close for b in m15]) or 50.0
    t1, t4 = trend(h1), trend(h4)
    hi50 = max(b.high for b in h1[-50:]) if h1 else entry
    lo50 = min(b.low for b in h1[-50:]) if h1 else entry
    room = ((hi50 - entry) if side == "BUY" else (entry - lo50)) / sl_dist if sl_dist else 0
    text = m.text.lower()
    src = "scalp" if (m.fwd_from and "scalping" in m.fwd_from.lower()) else "main"
    repost = any(q["src"] == src and q["side"] == side and abs(q["entry"] - entry) < 1.0
                 and (m.time - datetime.fromisoformat(q["t"])).total_seconds() < 6 * 3600 for q in prev)
    return {
        "id": m.id, "t": m.time.isoformat(timespec="seconds"), "src": src, "side": side,
        "hour": m.time.hour, "wd": m.time.weekday(), "entry": round(entry, 2), "sl": sl,
        "sl_dist": round(sl_dist, 2), "tp1_r": round(abs(tps[0] - entry) / sl_dist, 2) if tps and sl_dist else 0,
        "n_tps": len(tps), "two_entries": "second entry" in text,
        "risk_hint": bool(re.search(r"risk\s*0[.,]5|petit lot|small lot", text)),
        "h1": t1 * sign, "h4": t4 * sign, "rsi": round(r, 1), "rsi_dir": round((r - 50) * sign, 1),
        "atr15": round(a15, 2), "sl_atr": round(sl_dist / a15, 2) if a15 else 0, "room_r": round(room, 2),
        "repost": repost, "text": m.text[:260], "price": round(j["price"], 2),
    }


async def ai_verdicts(sigs: list[dict], broker: BacktestBroker, model: str, effort: str) -> dict:
    """Avis IA (modèle bon marché) pour les signaux du groupe principal, mis en cache."""
    from .ai import AI

    path = OUT / "cache_ia_strategies.json"
    cache = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    ai = AI(model, model, effort)
    out, calls = {}, 0
    for s in sigs:
        if s["src"] != "main" or s["sl_dist"] <= 0:
            continue
        key = f"{model}:{effort}:{s['id']}"
        if key not in cache:
            broker.now = datetime.fromisoformat(s["t"])
            sig = Signal(Side(s["side"]), s["entry"], s["entry"], s["sl"], [], True)
            m1 = broker.rates("M5", 1)
            px = m1[-1].close if m1 else s["price"]
            bars = {tf: broker.rates(tf, 250) for tf in ("M5", "M15", "H1", "H4")}
            try:
                v = await ai.analyze(sig, px, px + 0.2, bars)
                cache[key] = v.model_dump(mode="json") if v else None
            except Exception as e:  # pas bloquant : le signal n'aura juste pas d'avis
                log.warning("analyse IA impossible pour %s : %s", s["id"], e)
                cache[key] = None
            calls += 1
            path.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
        v = cache.get(key)
        if v:
            out[s["id"]] = {"decision": v["decision"], "mult": v["risk_multiplier"], "conf": v["confidence"],
                            "summary": v["summary"][:240]}
    print(f"  avis IA : {len(out)} signaux ({calls} nouveaux appels {model})")
    return out


def outcomes(res) -> dict:
    """Résultat de chaque signal dans ce rejeu, par id de message."""
    db, b = res.engine.store.db, res.broker
    out = {}
    for s in db.execute("SELECT * FROM signals"):
        sid = s["id"]
        if s["status"] not in ("open", "closed"):
            continue
        exits = [[t.isoformat(timespec="seconds"), round(pnl, 2)] for t, c, _, _, pnl in b.closes
                 if leg_index(c, sid) is not None]
        fills = [t for t, c, _ in b.fills if leg_index(c, sid) is not None]
        out[s["msg_id"]] = {
            "pnl": round(signal_pnl(res, sid), 2), "lot": json.loads(s["plan"])["legs"] and
            round(sum(l["volume"] for l in json.loads(s["plan"])["legs"]), 2),
            "open": (min(fills) if fills else datetime.fromisoformat(s["server_time"])).isoformat(timespec="seconds"),
            "close": max(e[0] for e in exits) if exits else None, "exits": exits, "tps": s["tps_reached"],
        }
    for j in res.journal:
        p = j["parsed"]
        if p and p["action"] == "NEW_SIGNAL" and j["msg"].id not in out:
            reason = next((n.split("\n")[0] for n in j["notes"] if n.startswith(("⛔", "🤔", "⏭"))), "non pris")
            out[j["msg"].id] = {"skip": reason}
    return out


# --------------------------------------------------------------------------------------------- stratégies
def evaluate(strat: dict, sigs: list[dict], res_by_mode: dict, ai: dict, balance: float) -> dict:
    """Même calcul que le site : filtres, puis limite de signaux ouverts, puis courbe du solde."""
    picked = []
    for s in sigs:
        cfg = strat[s["src"]]
        if not cfg.get("on"):
            continue
        o = res_by_mode[cfg.get("mode", "groupe")].get(s["id"])
        if not o or "skip" in o or not passes(s, cfg, ai.get(s["id"])):
            continue
        picked.append((s, o))
    max_open, per_day = strat.get("max_open", 2), strat.get("max_day", 6)
    taken, opens, day_count = [], [], {}
    for s, o in sorted(picked, key=lambda x: x[1]["open"]):
        t, d = o["open"], o["open"][:10]
        opens = [c for c in opens if c and c > t]
        if len(opens) >= max_open or day_count.get(d, 0) >= per_day:
            continue
        opens.append(o["close"])
        day_count[d] = day_count.get(d, 0) + 1
        taken.append((s, o))
    mult = strat.get("lot", 0.03) / 0.03
    events = sorted((e[0], e[1] * mult) for _, o in taken for e in o["exits"])
    eq, peak, dd = balance, balance, 0.0
    days: dict[str, float] = {}
    for t, v in events:
        eq += v
        peak = max(peak, eq)
        dd = max(dd, peak - eq)
        days[t[:10]] = days.get(t[:10], 0.0) + v
    pnls = [o["pnl"] * mult for _, o in taken]
    return {"pnl": round(sum(pnls), 2), "n": len(pnls), "wins": sum(v > 0.01 for v in pnls),
            "losses": sum(v < -0.01 for v in pnls), "dd": round(dd, 2), "ids": [s["id"] for s, _ in taken],
            "green_days": sum(v > 0 for v in days.values()), "days": len(days),
            "worst_day": round(min(days.values()), 2) if days else 0.0}


def passes(s: dict, f: dict, ai: Optional[dict]) -> bool:
    if f.get("side") and s["side"] != f["side"]:
        return False
    if s["sl_dist"] > f.get("sl_max", 99) or s["sl_dist"] < f.get("sl_min", 0):
        return False
    if s["tp1_r"] < f.get("tp1_r_min", 0):
        return False
    if f.get("trend_h1") and s["h1"] < 1:
        return False
    if f.get("h1_max") is not None and s["h1"] > f["h1_max"]:
        return False
    if f.get("trend_h4") and s["h4"] < 1:
        return False
    if f.get("h4_max") is not None and s["h4"] > f["h4_max"]:
        return False
    if f.get("no_counter_h4") and s["h4"] < 0:
        return False
    if f.get("rsi_max") is not None and s["rsi_dir"] > f["rsi_max"]:
        return False
    if not (f.get("h_from", 0) <= s["hour"] < f.get("h_to", 24)):
        return False
    if f.get("no_risk_hint") and s["risk_hint"]:
        return False
    if f.get("no_repost") and s["repost"]:
        return False
    if f.get("room_min") and s["room_r"] < f["room_min"]:
        return False
    if f.get("ai"):
        if not ai:
            return f["ai"] == "no_reject"
        if f["ai"] == "approve" and ai["decision"] != "APPROVE":
            return False
        if f["ai"] == "no_reject" and ai["decision"] == "REJECT":
            return False
    return True


SC = {"on": True, "mode": "groupe"}  # SCALPING : validé à 100 %, on suit toutes ses consignes
STRATEGIES = [
    ("Référence : tout le groupe", {"scalp": SC, "main": {"on": True}, "max_open": 2, "max_day": 6}),
    ("SCALPING seul", {"scalp": SC, "main": {"on": False}, "max_open": 2, "max_day": 6}),
    ("SCALPING + principal SL ≤ 5 $", {"scalp": SC, "main": {"on": True, "sl_max": 5}}),
    ("SCALPING + principal SL ≤ 4 $", {"scalp": SC, "main": {"on": True, "sl_max": 4}}),
    ("SCALPING + principal SL ≤ 6 $", {"scalp": SC, "main": {"on": True, "sl_max": 6}}),
    ("SCALPING + principal dans la tendance H1", {"scalp": SC, "main": {"on": True, "trend_h1": True}}),
    ("SCALPING + principal dans la tendance H4", {"scalp": SC, "main": {"on": True, "trend_h4": True}}),
    ("SCALPING + principal pas contre H4", {"scalp": SC, "main": {"on": True, "no_counter_h4": True}}),
    ("SCALPING + principal H1+H4 alignés", {"scalp": SC, "main": {"on": True, "trend_h1": True, "trend_h4": True}}),
    ("SCALPING + principal TP1 ≥ 1,5R", {"scalp": SC, "main": {"on": True, "tp1_r_min": 1.5}}),
    ("SCALPING + principal TP1 ≥ 2R", {"scalp": SC, "main": {"on": True, "tp1_r_min": 2.0}}),
    ("SCALPING + principal RSI pas extrême", {"scalp": SC, "main": {"on": True, "rsi_max": 15}}),
    ("SCALPING + principal 9h-15h", {"scalp": SC, "main": {"on": True, "h_from": 9, "h_to": 15}}),
    ("SCALPING + principal sans « petit lot / risk 0.5 »", {"scalp": SC, "main": {"on": True, "no_risk_hint": True}}),
    ("SCALPING + principal sans reposts", {"scalp": SC, "main": {"on": True, "no_repost": True}}),
    ("SCALPING + principal avec de la place (≥ 2R)", {"scalp": SC, "main": {"on": True, "room_min": 2}}),
    ("SCALPING + principal SELL seulement", {"scalp": SC, "main": {"on": True, "side": "SELL"}}),
    ("SCALPING + principal BUY seulement", {"scalp": SC, "main": {"on": True, "side": "BUY"}}),
    ("SCALPING + principal validé par l'IA (APPROVE)", {"scalp": SC, "main": {"on": True, "ai": "approve"}}),
    ("SCALPING + principal sauf refus IA", {"scalp": SC, "main": {"on": True, "ai": "no_reject"}}),
    ("SCALPING + principal SL ≤ 5 $ + IA sauf refus", {"scalp": SC, "main": {"on": True, "sl_max": 5, "ai": "no_reject"}}),
    ("SCALPING + principal SL ≤ 5 $ + pas contre H4", {"scalp": SC, "main": {"on": True, "sl_max": 5, "no_counter_h4": True}}),
    ("SCALPING + principal (ignorer ses BE)", {"scalp": SC, "main": {"on": True, "mode": "sans_be_groupe"}}),
    ("SCALPING + principal SL ≤ 5 $ (ignorer ses BE)", {"scalp": SC, "main": {"on": True, "sl_max": 5, "mode": "sans_be_groupe"}}),
    ("SCALPING + principal SL ≤ 5 $ (BE après TP2)", {"scalp": SC, "main": {"on": True, "sl_max": 5, "mode": "be_tp2"}}),
    ("SCALPING + principal SL ≤ 5 $ (2 TP max)", {"scalp": SC, "main": {"on": True, "sl_max": 5, "mode": "tp2"}}),
    ("SCALPING + principal tendance H1 (bot seul)", {"scalp": SC, "main": {"on": True, "trend_h1": True, "mode": "bot_seul"}}),
    ("SCALPING (BE après TP2) + principal SL ≤ 5 $", {"scalp": {"on": True, "mode": "be_tp2"}, "main": {"on": True, "sl_max": 5}}),
    ("SCALPING (2 TP max) + principal SL ≤ 5 $", {"scalp": {"on": True, "mode": "tp2"}, "main": {"on": True, "sl_max": 5}}),
    ("SCALPING seul, 3 trades ouverts max", {"scalp": SC, "main": {"on": False}, "max_open": 3}),
    ("SCALPING + principal contre la tendance H1", {"scalp": SC, "main": {"on": True, "h1_max": 0}}),
    ("SCALPING + principal SL ≤ 5 $ + RSI pas extrême", {"scalp": SC, "main": {"on": True, "sl_max": 5, "rsi_max": 15}}),
    ("SCALPING + principal SL ≤ 5 $ + sans « petit lot »", {"scalp": SC, "main": {"on": True, "sl_max": 5, "no_risk_hint": True}}),
    ("SCALPING + principal SL ≤ 5 $, RSI ok, sans « petit lot »",
     {"scalp": SC, "main": {"on": True, "sl_max": 5, "rsi_max": 15, "no_risk_hint": True}}),
    ("SCALPING + principal SELL + SL ≤ 5 $", {"scalp": SC, "main": {"on": True, "side": "SELL", "sl_max": 5}}),
    ("[limites relevées 4 / 12] SCALPING + principal SL ≤ 5 $",
     {"scalp": SC, "main": {"on": True, "sl_max": 5}, "max_open": 4, "max_day": 12}),
    ("[limites relevées 4 / 12] SCALPING + principal SL ≤ 5 $ (ignorer ses BE)",
     {"scalp": SC, "main": {"on": True, "sl_max": 5, "mode": "sans_be_groupe"}, "max_open": 4, "max_day": 12}),
    # Trouvées par bot.optimize (gagnantes sur les 2 moitiés du mois)
    ("★ SCALPING + principal contre H1 (TP1 seul)", {"scalp": SC, "main": {"on": True, "h1_max": 0, "mode": "tp1"}}),
    ("★ SCALPING + principal contre H1, SL ≤ 5 $ (TP1 seul)",
     {"scalp": SC, "main": {"on": True, "h1_max": 0, "sl_max": 5, "mode": "tp1"}}),
    ("★ SCALPING + principal contre H1, SL ≤ 6 $ (TP1 seul)",
     {"scalp": SC, "main": {"on": True, "h1_max": 0, "sl_max": 6, "mode": "tp1"}}),
    ("★ SCALPING + principal contre H1, RSI pas étiré (TP1 seul)",
     {"scalp": SC, "main": {"on": True, "h1_max": 0, "rsi_max": 0, "mode": "tp1"}}),
    ("★ [3 / 8] SCALPING + principal contre H1, SL ≤ 6 $ (TP1 seul)",
     {"scalp": SC, "main": {"on": True, "h1_max": 0, "sl_max": 6, "mode": "tp1"}, "max_open": 3, "max_day": 8}),
    ("★ SCALPING + principal contre H1, SL ≤ 6 $ (partiel TP1 + BE, reste au TP2)",
     {"scalp": SC, "main": {"on": True, "h1_max": 0, "sl_max": 6, "mode": "groupe"}}),
    ("★ SCALPING + principal contre H1, SL ≤ 6 $ (partiel TP1, BE seulement au TP2)",
     {"scalp": SC, "main": {"on": True, "h1_max": 0, "sl_max": 6, "mode": "be_tp2"}}),
    ("SCALPING + principal (ni BE ni trailing)",{"scalp": SC, "main": {"on": True, "mode": "sans_be"}}),
    ("SCALPING + principal contre H1 (ni BE ni trailing)",
     {"scalp": SC, "main": {"on": True, "h1_max": 0, "mode": "sans_be"}}),
    ("⚠ coup de chance ? [3 / 8] principal SELL, contre H1+H4, SL ≤ 6 $ (ni BE ni trailing)",
     {"scalp": SC, "main": {"on": True, "side": "SELL", "h1_max": 0, "h4_max": 0, "sl_max": 6, "mode": "sans_be"},
      "max_open": 3, "max_day": 8}),
    ("[sans limite] SCALPING + principal SL ≤ 5 $", {"scalp": SC, "main": {"on": True, "sl_max": 5}, "max_open": 99, "max_day": 99}),
]


async def main_async(args) -> None:
    cfg = load_config(args.config)
    cfg = cfg.model_copy(update={"ai": cfg.ai.model_copy(update={"analyst_mode": "off"})})
    messages, bars, spreads, spec, cs = load(args.days, args.offset)
    end = bars["M1"][-1].time + timedelta(minutes=1)
    start = end - timedelta(days=args.days)
    from .ai import AI

    parser = CachedAI(AI(cfg.ai.parser_model, cfg.ai.analyst_model, "low"), OUT / "cache_ia.json", False)

    res_by_mode, journal = {}, None
    cache_file = OUT / f"strategies_rejeux_{args.days}j.json"
    if args.reuse and cache_file.exists():
        saved = json.loads(cache_file.read_text(encoding="utf-8"))
        res_by_mode = {k: {int(i): v for i, v in d.items()} for k, d in saved["outcomes"].items()}
        sigs = saved["signals"]
        print(f"Rejeux réutilisés ({len(sigs)} signaux)")
    for i, (key, (label, over)) in enumerate(MODES.items() if not res_by_mode else [], 1):
        print(f"[mode {i}/{len(MODES)}] {label}…", flush=True)
        res = await replay(with_overrides(cfg, merge(RELAX, over)), messages, bars, spec, cs, parser, start, end,
                           args.balance, spreads, db_path=OUT / f"mode_{key}.sqlite")
        res_by_mode[key] = outcomes(res)
        if journal is None:
            journal = res.journal
        res.engine.store.db.close()

    broker = BacktestBroker(bars, spec, cs, args.balance)
    if journal is not None:
        sigs = []
        for j in journal:
            if j["parsed"] and j["parsed"]["action"] == "NEW_SIGNAL":
                sigs.append(features(j, broker, sigs))
        cache_file.write_text(json.dumps({"outcomes": res_by_mode, "signals": sigs}, ensure_ascii=False),
                              encoding="utf-8")
    print(f"{len(sigs)} signaux ({sum(s['src'] == 'scalp' for s in sigs)} SCALPING)")
    ai = await ai_verdicts(sigs, broker, args.ai_model, args.ai_effort) if args.ai_model else {}

    results = [(name, strat, evaluate(strat, sigs, res_by_mode, ai, args.balance)) for name, strat in STRATEGIES]
    results.sort(key=lambda r: -r[2]["pnl"])

    # Vérification exacte des meilleures stratégies à mode unique (rejeu complet avec la vraie liste de signaux)
    # Gestion différente par groupe : un rejeu par mode, chacun avec SES signaux (déjà choisis par les limites),
    # les consignes du groupe restant appliquées dans chaque rejeu.
    src_of = {s["id"]: s["src"] for s in sigs}
    checked = 0
    for name, strat, r in results:
        if checked >= args.verify and not name.startswith("★"):
            continue
        by_mode: dict[str, set] = {}
        for i in r["ids"]:
            by_mode.setdefault(strat[src_of[i]].get("mode", "groupe"), set()).add(i)
        exact = 0.0
        for mode, ids in by_mode.items():
            over = merge(RELAX, MODES[mode][1])
            res = await replay(with_overrides(cfg, over), messages, bars, spec, cs, parser, start, end,
                               args.balance, spreads, db_path=OUT / f"verif_{checked}_{mode}.sqlite", signal_ids=ids)
            db = res.engine.store.db
            exact += sum(signal_pnl(res, x["id"])
                         for x in db.execute("SELECT id FROM signals WHERE status IN ('open','closed')"))
            db.close()
        r["exact_pnl"] = round(exact, 2)
        print(f"  vérifié : {name[:70]} → {exact:+.2f} (calcul rapide {r['pnl']:+.2f})", flush=True)
        checked += 1

    print(f"\n{'Stratégie':58} {'Résultat':>10} {'exact':>9} {'trades':>7} {'baisse max':>11}")
    for name, strat, r in results:
        ex = f"{r['exact_pnl']:+.0f}" if "exact_pnl" in r else ""
        print(f"{name[:58]:58} {r['pnl']:+10.2f} {ex:>9} {r['n']:>7} {r['dd']:>10.2f}")

    m5 = [b for b in bars["M5"] if start <= b.time < end]
    data = {
        "generated": datetime.now().isoformat(timespec="minutes"), "days": args.days, "balance": args.balance,
        "start": start.isoformat(timespec="seconds"), "end": end.isoformat(timespec="seconds"),
        "ai_model": args.ai_model,
        "modes": {k: v[0] for k, v in MODES.items()}, "signals": sigs, "outcomes": res_by_mode, "ai": ai,
        "price": [[b.time.isoformat(timespec="minutes"), round(b.close, 2)] for b in m5],
        "strategies": [{"name": n, "cfg": s, "res": {k: v for k, v in r.items() if k != "ids"}} for n, s, r in results],
    }
    (OUT / "strategies_data.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    print(f"\nSite : {build_site(data)}")


def build_site(data: dict) -> Path:
    html = (Path(__file__).parent / "site_template.html").read_text(encoding="utf-8").replace(
        "/*__DATA__*/null", json.dumps(data, ensure_ascii=False).replace("</", "<\\/"))
    out = OUT / "site_strategies.html"
    out.write_text(html, encoding="utf-8")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Recherche de stratégies sur l'historique du groupe")
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--balance", type=float, default=290)
    ap.add_argument("--offset", type=int, default=2)
    ap.add_argument("--ai-model", default="claude-haiku-5-5", help="modèle pour l'avis IA ('' = pas d'IA)")
    ap.add_argument("--ai-effort", default="low")
    ap.add_argument("--verify", type=int, default=6, help="nombre de stratégies vérifiées par rejeu exact")
    ap.add_argument("--reuse", action="store_true", help="réutiliser les rejeux déjà faits")
    ap.add_argument("--config", default="config.yaml")
    ap.add_argument("--site-only", action="store_true", help="refaire seulement le site à partir des données")
    args = ap.parse_args()
    logging.basicConfig(level=logging.WARNING)
    if args.site_only:
        print(build_site(json.loads((OUT / "strategies_data.json").read_text(encoding="utf-8"))))
        return
    from dotenv import load_dotenv

    load_dotenv()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()

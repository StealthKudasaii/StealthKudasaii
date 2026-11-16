"""Données affichées par le site ET par Discord (statut, trades en cours, historique, statistiques)."""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Optional

from .engine import Engine, leg_index
from .store import row_tps


async def status_data(engine: Engine) -> dict:
    state = await engine.call(engine.account_state)
    positions = await engine.call(engine.broker.positions)
    cfg = engine.cfg
    limit = state.balance * cfg.risk.max_daily_loss_pct / 100
    return {
        "paused": engine.paused,
        "dry_run": cfg.dry_run,
        "skip_next": engine.skip_next,
        "account_mode": getattr(engine.broker, "account_mode", "SIMULÉ"),
        "symbol": cfg.mt5.symbol,
        "balance": round(state.balance, 2),
        "floating": round(sum(p.profit for p in positions), 2),
        "realized_today": round(state.realized_today, 2),
        "open_risk": round(state.open_risk_money, 2),
        "daily_loss_limit": round(limit, 2),
        "daily_loss_used": round(max(0.0, -state.realized_today) + state.open_risk_money, 2),
        "trades_today": state.trades_today,
        "max_trades_per_day": cfg.risk.max_trades_per_day,
        "open_signals": state.open_signals,
        "bid": state.bid, "ask": state.ask,
        "server_time": state.server_time.strftime("%d/%m %H:%M:%S"),
        "risk_pct": cfg.risk.risk_per_trade_pct,
        "fixed_lot": getattr(cfg.risk, "fixed_lot", 0.0),
        "approval_mode": cfg.discord.approval_mode,
        "analyst_mode": cfg.ai.analyst_mode,
    }


def _verdict(raw: Optional[str]) -> Optional[dict]:
    if not raw:
        return None
    v = json.loads(raw)
    return {"decision": v.get("decision"), "summary": v.get("summary"), "multiplier": v.get("risk_multiplier"),
            "warnings": v.get("warnings") or []}


def trade_data(engine: Engine, row, positions, orders) -> dict:
    sid = row["id"]
    legs = [{"leg": i, "ticket": p.ticket, "volume": p.volume, "open": p.open_price, "sl": p.sl,
             "tp": p.tp, "profit": round(p.profit, 2)}
            for p in positions if (i := leg_index(p.comment, sid))]
    pend = [{"leg": i, "ticket": o.ticket, "volume": o.volume, "price": o.price, "sl": o.sl, "tp": o.tp}
            for o in orders if (i := leg_index(o.comment, sid))]
    plan = json.loads(row["plan"]) if row["plan"] else {}
    return {
        "id": sid, "side": row["side"], "entry": row["entry"], "sl": row["sl"], "tps": row_tps(row),
        "original_sl": plan.get("sl", row["sl"]), "risk": plan.get("risk_money"),
        "tps_reached": row["tps_reached"], "created": row["server_time"],
        "positions": sorted(legs, key=lambda x: x["leg"]), "orders": sorted(pend, key=lambda x: x["leg"]),
        "volume": round(sum(l["volume"] for l in legs) + sum(o["volume"] for o in pend), 2),
        "floating": round(sum(l["profit"] for l in legs), 2),
        "message": engine.store.message_for(row["msg_id"]),
        "verdict": _verdict(row["verdict"]),
    }


async def trades_data(engine: Engine) -> list[dict]:
    positions = await engine.call(engine.broker.positions)
    orders = await engine.call(engine.broker.pending_orders)
    return [trade_data(engine, r, positions, orders) for r in engine.store.open_signals()]


def history_data(engine: Engine, limit: int = 100) -> list[dict]:
    out = []
    for r in engine.store.history(min(limit, 500)):
        out.append({
            "id": r["id"], "created": r["server_time"], "side": r["side"], "status": r["status"],
            "entry_zone": [r["entry_low"], r["entry_high"]], "entry": r["entry"],
            "sl": (json.loads(r["plan"]).get("sl") if r["plan"] else None) or r["sl"],  # SL d'origine
            "tps": row_tps(r), "tps_reached": r["tps_reached"], "pnl": r["pnl"], "reason": r["reason"],
            "closed_at": r["closed_at"], "verdict": _verdict(r["verdict"]),
            "message": engine.store.message_for(r["msg_id"]),
        })
    return out


async def stats_data(engine: Engine, days: Optional[int] = None) -> dict:
    """Statistiques des trades fermés (tous, ou ceux des `days` derniers jours)."""
    now: datetime = await engine.call(engine.broker.server_time)
    rows = engine.store.closed_with_pnl()
    if days is not None:
        limit = (now - timedelta(days=days)).isoformat()
        rows = [r for r in rows if (r["closed_at"] or r["created"] or "") >= limit]
    pnls = [r["pnl"] for r in rows]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    equity, total = [], 0.0
    for r in rows:
        total += r["pnl"]
        equity.append({"t": r["closed_at"] or r["created"], "v": round(total, 2)})

    def since(d: int) -> float:
        lim = (now - timedelta(days=d)).isoformat()
        return round(sum(r["pnl"] for r in engine.store.closed_with_pnl() if (r["closed_at"] or "") >= lim), 2)

    all_rows = engine.store.history(100000)
    if days is not None:
        lim = (now - timedelta(days=days)).isoformat()
        all_rows = [r for r in all_rows if (r["server_time"] or "") >= lim]
    reasons: dict[str, int] = {}
    for r in all_rows:
        if r["status"] == "rejected" and r["reason"]:
            key = r["reason"].split("(")[0].strip()[:60]
            reasons[key] = reasons.get(key, 0) + 1
    streak, best_streak, cur = 0, 0, 0
    for p in pnls:
        cur = cur + 1 if p > 0 else 0
        best_streak = max(best_streak, cur)
    for p in reversed(pnls):
        if (p > 0) == (pnls[-1] > 0):
            streak += 1
        else:
            break
    return {
        "closed": len(pnls),
        "wins": len(wins), "losses": len(losses),
        "winrate": round(100 * len(wins) / len(pnls), 1) if pnls else None,
        "total": round(sum(pnls), 2),
        "avg_win": round(sum(wins) / len(wins), 2) if wins else None,
        "avg_loss": round(sum(losses) / len(losses), 2) if losses else None,
        "profit_factor": round(sum(wins) / abs(sum(losses)), 2) if losses and wins else None,
        "best": max(pnls) if pnls else None, "worst": min(pnls) if pnls else None,
        "today": since(1), "week": since(7), "month": since(30),
        "signals_total": len(all_rows),
        "signals_taken": sum(1 for r in all_rows if r["status"] in ("open", "closed")),
        "signals_rejected": sum(1 for r in all_rows if r["status"] == "rejected"),
        "reject_reasons": sorted(reasons.items(), key=lambda x: -x[1])[:5],
        "best_win_streak": best_streak,
        "current_streak": (streak if pnls and pnls[-1] > 0 else -streak) if pnls else 0,
        "equity": equity,
    }

"""Calcul des stratégies (filtres, limite de trades ouverts, lot) sur des données fabriquées."""
from bot.strategies import STRATEGIES, evaluate, passes


def sig(i, src="main", sl=4.0, side="SELL", h1=0, hour=10):
    return {"id": i, "src": src, "side": side, "sl_dist": sl, "tp1_r": 1.0, "h1": h1, "h4": 0, "rsi_dir": 0,
            "hour": hour, "risk_hint": False, "repost": False, "room_r": 3}


def out(open_, close, pnl):
    return {"pnl": pnl, "open": open_, "close": close, "exits": [[close, pnl]], "tps": 1 if pnl > 0 else 0}


SIGS = [sig(1, "scalp", 8), sig(2, sl=4), sig(3, sl=9), sig(4, sl=3)]
RES = {"groupe": {1: out("2026-11-02T10:00:00", "2026-11-02T12:00:00", 20),
                  2: out("2026-11-02T10:30:00", "2026-11-02T11:00:00", -12),
                  3: out("2026-11-02T10:40:00", "2026-11-02T13:00:00", 30),
                  4: out("2026-11-02T14:00:00", "2026-11-02T15:00:00", 10)}}


def test_filters_and_max_open():
    st = {"scalp": {"on": True}, "main": {"on": True, "sl_max": 5}, "max_open": 2, "max_day": 6}
    r = evaluate(st, SIGS, RES, {}, 290)
    assert r["ids"] == [1, 2, 4] and r["pnl"] == 18
    r = evaluate({**st, "max_open": 1}, SIGS, RES, {}, 290)
    assert r["ids"] == [1, 4]           # le 2 arrive pendant que le 1 est ouvert
    r = evaluate({**st, "lot": 0.06}, SIGS, RES, {}, 290)
    assert r["pnl"] == 36               # lot double -> résultat double


def test_ai_and_trend_filters():
    assert passes(sig(9, h1=-1), {"h1_max": 0}, None)
    assert not passes(sig(9, h1=1), {"h1_max": 0}, None)
    assert not passes(sig(9), {"ai": "approve"}, {"decision": "REDUCE"})
    assert passes(sig(9), {"ai": "no_reject"}, None)


def test_at_least_20_strategies():
    assert len(STRATEGIES) >= 20 and len({n for n, _ in STRATEGIES}) == len(STRATEGIES)

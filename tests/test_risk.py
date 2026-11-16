from datetime import datetime

import pytest

from bot.config import ManagementCfg, RiskCfg
from bot.models import Side, Signal, SymbolSpec
from bot.risk import AccountState, Rejected, plan_trade, protective_sl, split_volume

SPEC = SymbolSpec(0.01, 100, 0.01, 2, 0.01)
RISK = RiskCfg(no_trade_windows=[("23:50", "01:10")])
MGMT = ManagementCfg()


def lpl(side, entry, sl):  # or : 1 lot = 100 oz
    return abs(entry - sl) * 100


def state(bid=2350.0, ask=2350.25, **kw):
    base = dict(bid=bid, ask=ask, balance=10_000, server_time=datetime(2026, 11, 13, 12, 0),
                realized_today=0.0, open_risk_money=0.0, open_signals=0, trades_today=0)
    base.update(kw)
    return AccountState(**base)


def buy(entry=2350.0, sl=2340.0, tps=(2355, 2360, 2370)):
    return Signal(Side.BUY, entry, entry, sl, list(tps))


def test_sizing_risks_one_percent():
    plan = plan_trade(buy(), state(), SPEC, lpl, RISK, MGMT)
    # 1 % de 10 000 = 100 $ ; distance 10.25 $ -> 100 / 1025 = 0.0975 -> 0.09 lot
    assert plan.order_type == "market"
    assert plan.total_volume == pytest.approx(0.09)
    assert plan.risk_money <= 100
    assert [l.tp for l in plan.legs] == [2355, 2360, 2370]


def test_split_respects_minimum_lot():
    parts = split_volume(0.09, 3, [0.5, 0.3, 0.2], SPEC)
    assert len(parts) == 3 and sum(parts) == pytest.approx(0.09)
    assert parts[0] >= parts[1] >= parts[2] >= 0.01
    parts = split_volume(0.02, 3, [0.5, 0.3, 0.2], SPEC)
    assert all(p >= 0.01 for p in parts)
    assert sum(parts) == pytest.approx(0.02)
    assert split_volume(0.01, 3, [0.5, 0.3, 0.2], SPEC) == [0.01]


def test_wrong_side_sl_rejected():
    with pytest.raises(Rejected, match="mauvais côté"):
        plan_trade(buy(sl=2360), state(), SPEC, lpl, RISK, MGMT)


def test_spread_too_wide():
    with pytest.raises(Rejected, match="spread"):
        plan_trade(buy(), state(ask=2351.5), SPEC, lpl, RISK, MGMT)


def test_far_price_becomes_limit_order():
    plan = plan_trade(buy(entry=2345, sl=2338), state(bid=2350, ask=2350.25), SPEC, lpl, RISK, MGMT)
    assert plan.order_type == "limit" and plan.entry == 2345


def test_far_price_skip_mode():
    risk = RISK.model_copy(update={"far_entry_action": "skip"})
    with pytest.raises(Rejected, match="trop loin"):
        plan_trade(buy(entry=2345, sl=2338), state(), SPEC, lpl, risk, MGMT)


def test_too_late_after_tp1():
    with pytest.raises(Rejected, match="trop tard"):
        plan_trade(buy(entry=2349, sl=2340, tps=(2350,)), state(bid=2350.5, ask=2350.75), SPEC, lpl, RISK, MGMT)


def test_daily_loss_limit_blocks_then_reduces():
    with pytest.raises(Rejected, match="limite de perte"):
        plan_trade(buy(), state(realized_today=-290), SPEC, lpl, RISK, MGMT)
    plan = plan_trade(buy(), state(realized_today=-250), SPEC, lpl, RISK, MGMT)
    assert plan.risk_money <= 50


def test_no_trade_window_over_midnight():
    with pytest.raises(Rejected, match="heure interdite"):
        plan_trade(buy(), state(server_time=datetime(2026, 11, 13, 0, 30)), SPEC, lpl, RISK, MGMT)


def test_analyst_multiplier_halves_size():
    full = plan_trade(buy(), state(), SPEC, lpl, RISK, MGMT)
    half = plan_trade(buy(), state(), SPEC, lpl, RISK, MGMT, risk_multiplier=0.5)
    assert half.total_volume < full.total_volume


def test_sell_without_tps_uses_r_multiples():
    s = Signal(Side.SELL, 2350, 2350, 2360, [])
    plan = plan_trade(s, state(), SPEC, lpl, RISK, MGMT)
    tps = [l.tp for l in plan.legs]
    assert tps == sorted(tps, reverse=True) and tps[0] < 2350


def test_protective_sl_breakeven_then_trail():
    tps = [2355, 2360, 2370]
    assert protective_sl(Side.BUY, 2350, tps, 0, 2340, MGMT) is None
    assert protective_sl(Side.BUY, 2350, tps, 1, 2340, MGMT) == 2350.3
    assert protective_sl(Side.BUY, 2350, tps, 2, 2350.3, MGMT) == 2355
    assert protective_sl(Side.BUY, 2350, tps, 2, 2355, MGMT) is None  # ne recule jamais
    assert protective_sl(Side.SELL, 2350, [2345, 2340], 1, 2360, MGMT) == 2349.7


def test_typo_tp1_rejected():
    """Signal réel : BUY 3896, SL 3888, TP1 3990 (pour 3900) -> TP1 à ~12R, refusé."""
    with pytest.raises(Rejected, match="TP1 suspect"):
        plan_trade(buy(entry=3896, sl=3888, tps=(3990, 3995, 4000)), state(bid=3896, ask=3896.25),
                   SPEC, lpl, RISK, MGMT)


def test_far_tp2_is_fine_when_tp1_is_normal():
    """Signal réel : SELL @4063-4065, SL 4067, TP1 4054, TP2 4010 -> TP2 lointain mais TP1 normal : accepté."""
    sig = Signal(Side.SELL, 4063, 4065, 4067, [4054, 4010])
    plan = plan_trade(sig, state(bid=4064, ask=4064.25), SPEC, lpl, RISK, MGMT)
    assert [l.tp for l in plan.legs] == [4054, 4010]


def test_fixed_lot_ignores_risk_pct_and_ai_reduce():
    """Lot fixe 0.03 : même taille quel que soit le SL ou un REDUCE de l'IA, réparti 0.01 par TP."""
    risk = RISK.model_copy(update={"fixed_lot": 0.03})
    small = state(balance=290)
    plan = plan_trade(buy(entry=2350, sl=2342), small, SPEC, lpl, risk, MGMT, risk_multiplier=0.5)
    assert plan.total_volume == pytest.approx(0.03)
    assert [l.volume for l in plan.legs] == [0.01, 0.01, 0.01]
    assert plan.risk_money == pytest.approx(0.03 * 8.25 * 100)
    assert any("lot fixe" in n for n in plan.notes)
    with pytest.raises(Rejected, match="multiplicateur 0"):
        plan_trade(buy(), small, SPEC, lpl, risk, MGMT, risk_multiplier=0)
    with pytest.raises(Rejected, match="limite de perte"):
        plan_trade(buy(), state(balance=290, realized_today=-9.0), SPEC, lpl, risk, MGMT)


def test_daily_limit_can_be_disabled():
    risk = RISK.model_copy(update={"fixed_lot": 0.03, "max_daily_loss_pct": 0})
    plan = plan_trade(buy(), state(balance=290, realized_today=-50.0, open_risk_money=30.0), SPEC, lpl, risk, MGMT)
    assert plan.total_volume == pytest.approx(0.03)

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

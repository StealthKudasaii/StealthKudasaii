"""Backtest rejoué hors ligne : bougies fabriquées, IA factice, aucun réseau."""
import asyncio
from datetime import datetime, timedelta

from bot.backtest import Msg, build_report, replay
from bot.config import Config
from bot.models import Action, Bar, ParsedMessage, Side, SymbolSpec, TpChange

T0 = datetime(2026, 11, 10, 10, 0)
SPEC = SymbolSpec(0.01, 100, 0.01, 2, 0.01)


class FakeAI:
    def __init__(self, table):
        self.table = table

    async def parse_message(self, text, reply_to_text, open_trades):
        return self.table.get(text, ParsedMessage(action=Action.IGNORE, symbol_is_gold=True, confidence=1))

    async def analyze(self, signal, bid, ask, bars):
        raise AssertionError("analyse désactivée dans ce test")


def m1_bars(closes, start=T0):
    bars, prev = [], closes[0]
    for i, c in enumerate(closes):
        bars.append(Bar(start + timedelta(minutes=i), prev, max(prev, c) + 0.1, min(prev, c) - 0.1, c))
        prev = c
    return bars


def setup(closes):
    m1 = m1_bars(closes)
    bars = {"M1": m1, "M5": m1[::5], "M15": m1[::15], "H1": m1[::60], "H4": m1[::240]}
    cfg = Config.model_validate({"telegram": {"source_chats": [1]}, "ai": {"analyst_mode": "off"}})
    return cfg, bars, m1


SELL = ParsedMessage(action=Action.NEW_SIGNAL, symbol_is_gold=True, side=Side.SELL, entry_low=4083,
                     entry_high=4085, entry_is_market=True, stop_loss=4087, take_profits=[4078, 4070, 4060],
                     confidence=0.95)


def test_replay_sell_hits_tps_with_tp_change(tmp_path):
    # Prix : 4084 pendant 5 min, puis baisse régulière jusqu'à 4066 (TP1 4078, puis TP2 modifié à 4074)
    closes = [4084.0] * 5 + [4084 - 0.5 * i for i in range(1, 37)] + [4066.0] * 20
    cfg, bars, m1 = setup(closes)
    ai = FakeAI({
        "GOLD SELL NOW": SELL,
        "Modifiez le TP2 à 4074": ParsedMessage(action=Action.MODIFY_TP, symbol_is_gold=True, confidence=0.9,
                                                tp_changes=[TpChange(index=2, price=4074)]),
    })
    msgs = [Msg(1, T0 + timedelta(minutes=2, seconds=10), "GOLD SELL NOW"),
            Msg(2, T0 + timedelta(minutes=12), "TP 1 HIT XAUUSD +100 pips"),
            Msg(3, T0 + timedelta(minutes=13), "Modifiez le TP2 à 4074")]
    res = asyncio.run(replay(cfg, msgs, bars, SPEC, 100, ai, T0, m1[-1].time + timedelta(minutes=1),
                             10_000, db_path=tmp_path / "bt.sqlite"))
    sig = res.engine.store.db.execute("SELECT * FROM signals").fetchone()
    assert sig["status"] == "closed"
    assert sig["tps_reached"] >= 2
    assert res.broker.balance() > 10_000            # trade gagnant
    assert any("TP2 → 4074" in n for j in res.journal for n in j["notes"])
    report = build_report(res, cfg, use_analyst=False, ai_calls=None)
    assert "Trades pris | 1" in report and "P&L total" in report


def test_replay_skip_next_and_stop_loss(tmp_path):
    # Consigne « ne prenez pas le prochain trade », puis 2 signaux : le 1er sauté, le 2e touché au SL
    closes = [4084.0] * 30 + [4084 + 0.5 * i for i in range(1, 12)] + [4090.0] * 10
    cfg, bars, m1 = setup(closes)
    ai = FakeAI({"Ne prenez pas le prochain trade": ParsedMessage(action=Action.SKIP_NEXT, symbol_is_gold=True,
                                                                   confidence=0.95),
                 "SELL 1": SELL, "SELL 2": SELL})
    msgs = [Msg(1, T0 + timedelta(minutes=1), "Ne prenez pas le prochain trade"),
            Msg(2, T0 + timedelta(minutes=3), "SELL 1"),
            Msg(3, T0 + timedelta(minutes=20), "SELL 2")]
    res = asyncio.run(replay(cfg, msgs, bars, SPEC, 100, ai, T0, m1[-1].time + timedelta(minutes=1),
                             10_000, db_path=tmp_path / "bt.sqlite"))
    rows = res.engine.store.db.execute("SELECT status FROM signals ORDER BY id").fetchall()
    assert [r["status"] for r in rows] == ["rejected", "closed"]
    assert res.broker.balance() < 10_000            # SL touché
    assert 10_000 - res.broker.balance() <= 101     # mais jamais plus de ~1 % de risque
    assert "sauté" in build_report(res, cfg, use_analyst=False, ai_calls=None)


def test_rates_never_show_the_future(tmp_path):
    from bot.backtest import BacktestBroker

    _, bars, m1 = setup([4084.0 + i for i in range(120)])
    b = BacktestBroker(bars, SPEC, 100, 10_000)
    b.now = T0 + timedelta(minutes=30, seconds=20)
    assert all(x.time + timedelta(minutes=5) <= b.now for x in b.rates("M5", 250))
    assert b.rates("M5", 250)[-1].time == T0 + timedelta(minutes=25)

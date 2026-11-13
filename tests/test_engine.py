"""Scénario complet avec un broker simulé et une IA factice (aucun appel réseau)."""
import asyncio

import pytest

from bot.broker import PaperBroker
from bot.config import Config
from bot.engine import Engine
from bot.models import Action, AnalystVerdict, Decision, ParsedMessage, Side
from bot.store import Store


class FakeAI:
    def __init__(self):
        self.next: dict[str, ParsedMessage] = {}
        self.verdict = AnalystVerdict(decision=Decision.APPROVE, risk_multiplier=1.0, confidence=0.8,
                                      summary="Tendance H1/H4 haussière, entrée sur support.")

    async def parse_message(self, text, reply_to_text, open_trades):
        return self.next.get(text, ParsedMessage(action=Action.IGNORE, symbol_is_gold=True, confidence=1))

    async def analyze(self, signal, bid, ask, bars):
        return self.verdict


def make(tmp_path, **cfg_over):
    cfg = Config.model_validate({"dry_run": False, "telegram": {"source_chats": [1]}, **cfg_over})
    broker = PaperBroker(bid=2350.0, spread=0.25, balance=10_000)
    ai = FakeAI()
    notes: list[str] = []

    async def notify(t):
        notes.append(t)

    eng = Engine(cfg, broker, Store(tmp_path / "t.sqlite"), ai, notify)
    return eng, broker, ai, notes


SIGNAL = ParsedMessage(action=Action.NEW_SIGNAL, symbol_is_gold=True, side=Side.BUY, entry_low=2349,
                       entry_high=2350, stop_loss=2340, take_profits=[2355, 2360, 2370], confidence=0.95)


def run(coro):
    return asyncio.run(coro)


def test_full_trade_lifecycle(tmp_path):
    eng, broker, ai, notes = make(tmp_path)
    ai.next["BUY GOLD"] = SIGNAL
    run(eng.handle_message(1, 10, "BUY GOLD"))
    pos = broker.positions()
    assert len(pos) == 3, notes
    assert {p.tp for p in pos} == {2355, 2360, 2370}
    assert all(p.sl == 2340 for p in pos)

    broker.set_price(2355.1)        # TP1 touché
    msgs = eng.manage_once()
    assert len(broker.positions()) == 2
    assert all(p.sl == pytest.approx(2350.55) for p in broker.positions())  # entrée 2350.25 + 0.30
    assert any("TP1" in m for m in msgs)

    broker.set_price(2360.2)        # TP2 touché -> SL sur TP1
    eng.manage_once()
    assert [p.sl for p in broker.positions()] == [2355]

    broker.set_price(2354.9)        # retour : stoppé en gain sur TP1
    msgs = eng.manage_once()
    assert broker.positions() == []
    assert any("terminé" in m for m in msgs)
    assert broker.balance() > 10_000


def test_analyst_reject_blocks(tmp_path):
    eng, broker, ai, notes = make(tmp_path)
    ai.next["BUY GOLD"] = SIGNAL
    ai.verdict = AnalystVerdict(decision=Decision.REJECT, risk_multiplier=0, confidence=0.9,
                                summary="Contre-tendance forte, résistance H4 juste au-dessus.")
    run(eng.handle_message(1, 10, "BUY GOLD"))
    assert broker.positions() == []
    assert "refusé" in notes[-1]


def test_advisory_mode_does_not_block(tmp_path):
    eng, broker, ai, notes = make(tmp_path, ai={"analyst_mode": "advisory"})
    ai.next["BUY GOLD"] = SIGNAL
    ai.verdict = AnalystVerdict(decision=Decision.REJECT, risk_multiplier=0, confidence=0.9, summary="Bof.")
    run(eng.handle_message(1, 10, "BUY GOLD"))
    assert len(broker.positions()) == 3


def test_group_commands_be_and_close(tmp_path):
    eng, broker, ai, notes = make(tmp_path)
    ai.next["BUY GOLD"] = SIGNAL
    ai.next["SL to BE"] = ParsedMessage(action=Action.MOVE_SL_BE, symbol_is_gold=True, confidence=0.9)
    ai.next["close all"] = ParsedMessage(action=Action.CLOSE_ALL, symbol_is_gold=True, confidence=0.9)
    run(eng.handle_message(1, 10, "BUY GOLD"))
    broker.set_price(2353)
    run(eng.handle_message(1, 11, "SL to BE", reply_to=10))
    assert all(p.sl == pytest.approx(2350.55) for p in broker.positions())
    run(eng.handle_message(1, 12, "close all"))
    assert broker.positions() == []


def test_edited_signal_updates_sl(tmp_path):
    eng, broker, ai, notes = make(tmp_path)
    ai.next["BUY GOLD"] = SIGNAL
    run(eng.handle_message(1, 10, "BUY GOLD"))
    ai.next["BUY GOLD edit"] = SIGNAL.model_copy(update={"stop_loss": 2343})
    run(eng.handle_message(1, 10, "BUY GOLD edit", edited=True))
    assert all(p.sl == 2343 for p in broker.positions())


def test_duplicate_and_ambiguous(tmp_path):
    eng, broker, ai, notes = make(tmp_path)
    ai.next["BUY GOLD"] = SIGNAL
    ai.next["buy again"] = SIGNAL
    ai.next["maybe buy?"] = SIGNAL.model_copy(update={"confidence": 0.4})
    run(eng.handle_message(1, 10, "BUY GOLD"))
    run(eng.handle_message(1, 11, "buy again"))
    run(eng.handle_message(1, 12, "maybe buy?"))
    assert len(broker.positions()) == 3
    assert any("doublon" in n for n in notes)
    assert any("ambigu" in n for n in notes)


def test_paused_and_dry_run(tmp_path):
    eng, broker, ai, notes = make(tmp_path)
    ai.next["BUY GOLD"] = SIGNAL
    eng.paused = True
    run(eng.handle_message(1, 10, "BUY GOLD"))
    assert broker.positions() == [] and "pause" in notes[-1]

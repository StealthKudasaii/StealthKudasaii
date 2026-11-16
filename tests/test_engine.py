"""Scénario complet avec un broker simulé et une IA factice (aucun appel réseau)."""
import asyncio

import pytest

from bot.broker import PaperBroker
from bot.config import Config
from bot.engine import Engine
from bot.models import Action, AnalystVerdict, Decision, ParsedMessage, Side, TpChange
from bot.store import Store, row_tps


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


# --- Consignes réelles du groupe (format ITSNKR) -------------------------------------------

def test_modify_tp2_only(tmp_path):
    """« Modifiez le TP2 à 2365 » : seul le TP2 change, TP1 et TP3 restent."""
    eng, broker, ai, notes = make(tmp_path)
    ai.next["BUY GOLD"] = SIGNAL
    ai.next["Modifiez le TP2"] = ParsedMessage(action=Action.MODIFY_TP, symbol_is_gold=True, confidence=0.9,
                                               tp_changes=[TpChange(index=2, price=2365)])
    run(eng.handle_message(1, 10, "BUY GOLD"))
    run(eng.handle_message(1, 11, "Modifiez le TP2"))
    assert sorted(p.tp for p in broker.positions()) == [2355, 2365, 2370]
    assert row_tps(eng.store.open_signals()[0]) == [2355, 2365, 2370]


def test_modify_tp2_after_tp1_hit(tmp_path):
    """Cas réel : TP1 touché, puis « Modifiez le TP2 » -> la part TP2 encore ouverte est modifiée."""
    eng, broker, ai, notes = make(tmp_path)
    ai.next["BUY GOLD"] = SIGNAL
    ai.next["Modifiez le TP2"] = ParsedMessage(action=Action.MODIFY_TP, symbol_is_gold=True, confidence=0.9,
                                               tp_changes=[TpChange(index=2, price=2365)])
    run(eng.handle_message(1, 10, "BUY GOLD"))
    broker.set_price(2355.1)
    eng.manage_once()
    run(eng.handle_message(1, 11, "Modifiez le TP2"))
    assert sorted(p.tp for p in broker.positions()) == [2365, 2370]


def test_tp_number_out_of_range_changes_nothing(tmp_path):
    eng, broker, ai, notes = make(tmp_path)
    ai.next["BUY GOLD"] = SIGNAL
    ai.next["TP5"] = ParsedMessage(action=Action.MODIFY_TP, symbol_is_gold=True, confidence=0.9,
                                   tp_changes=[TpChange(index=5, price=2400)])
    run(eng.handle_message(1, 10, "BUY GOLD"))
    run(eng.handle_message(1, 11, "TP5"))
    assert sorted(p.tp for p in broker.positions()) == [2355, 2360, 2370]
    assert "Rien changé" in notes[-1]


def test_close_half_and_breakeven_in_one_message(tmp_path):
    """« +40 pips en cours coupez la moitié et BE » : les DEUX consignes sont appliquées."""
    eng, broker, ai, notes = make(tmp_path)
    ai.next["BUY GOLD"] = SIGNAL
    ai.next["coupez la moitié et BE"] = ParsedMessage(
        action=Action.CLOSE_PARTIAL, extra_actions=[Action.MOVE_SL_BE], close_fraction=0.5,
        symbol_is_gold=True, confidence=0.9)
    run(eng.handle_message(1, 10, "BUY GOLD"))
    before = sum(p.volume for p in broker.positions())
    broker.set_price(2353)
    run(eng.handle_message(1, 11, "coupez la moitié et BE"))
    after = sum(p.volume for p in broker.positions())
    assert after == pytest.approx(before / 2, abs=0.011)
    assert all(p.sl == pytest.approx(2350.55) for p in broker.positions())


def test_skip_next_trade(tmp_path):
    """« Ne prenez pas le prochain trade » : le signal suivant est sauté, celui d'après est pris."""
    eng, broker, ai, notes = make(tmp_path)
    ai.next["Ne prenez pas le prochain trade"] = ParsedMessage(action=Action.SKIP_NEXT, symbol_is_gold=True,
                                                               confidence=0.95)
    ai.next["BUY GOLD"] = SIGNAL
    ai.next["BUY GOLD 2"] = SIGNAL
    run(eng.handle_message(1, 9, "Ne prenez pas le prochain trade"))
    run(eng.handle_message(1, 10, "BUY GOLD"))
    assert broker.positions() == []
    assert "sauté" in notes[-1]
    run(eng.handle_message(1, 11, "BUY GOLD 2"))
    assert len(broker.positions()) == 3


def test_typo_tp1_signal_rejected(tmp_path):
    """BUY 2349-2350, SL 2340, TP1 2450 (au lieu de 2355) : faute de frappe probable -> pas pris."""
    eng, broker, ai, notes = make(tmp_path)
    ai.next["BUY typo"] = SIGNAL.model_copy(update={"take_profits": [2450, 2455, 2460]})
    run(eng.handle_message(1, 10, "BUY typo"))
    assert broker.positions() == []
    assert "TP1 suspect" in notes[-1]


def test_forwarded_filter():
    from bot.config import TelegramCfg
    from bot.engine import message_filter

    off = TelegramCfg(source_chats=[1])
    assert message_filter(off, None) == (True, True)
    scalp = TelegramCfg(source_chats=[1], forwarded_from=["SCALPING"], commands_from_everyone=False)
    assert message_filter(scalp, "ITSNKR SCALPING 💸") == (True, True)
    assert message_filter(scalp, None) == (False, False)
    assert message_filter(scalp, "Julie") == (False, False)
    assert message_filter(scalp.model_copy(update={"commands_from_everyone": True}), None) == (False, True)


def test_signal_blocked_but_command_allowed(tmp_path):
    eng, broker, ai, notes = make(tmp_path)
    ai.next["BUY GOLD"] = SIGNAL
    ai.next["BUY again"] = SIGNAL
    ai.next["close all"] = ParsedMessage(action=Action.CLOSE_ALL, symbol_is_gold=True, confidence=0.9)
    run(eng.handle_message(1, 10, "BUY GOLD"))
    run(eng.handle_message(1, 11, "BUY again", allow_signal=False, allow_command=True))
    assert len(broker.positions()) == 3
    run(eng.handle_message(1, 12, "close all", allow_signal=False, allow_command=True))
    assert broker.positions() == []


def test_main_group_filter():
    from bot.config import TelegramCfg
    from bot.engine import main_sl_limit, message_filter

    tg = TelegramCfg(source_chats=[1], forwarded_from=["SCALPING"], main_signals=True, main_max_sl=5)
    assert message_filter(tg, None) == (True, True)
    assert main_sl_limit(tg, "ITSNKR SCALPING 💸") is None
    assert main_sl_limit(tg, None) == 5
    assert main_sl_limit(TelegramCfg(source_chats=[1]), None) is None


def test_main_group_sl_too_wide_skipped(tmp_path):
    eng, broker, ai, notes = make(tmp_path, management={"max_tps": 1})
    ai.next["BUY GOLD"] = SIGNAL  # SL 10 $ sous l'entrée haute
    ai.next["BUY tight"] = SIGNAL.model_copy(update={"stop_loss": 2346})  # SL 4 $
    run(eng.handle_message(1, 10, "BUY GOLD", max_sl=5))
    assert broker.positions() == [] and "max 5 $" in notes[-1]
    run(eng.handle_message(1, 11, "BUY tight", max_sl=5))
    pos = broker.positions()
    assert pos and all(p.tp == 2355 for p in pos)  # max_tps 1 : tout vise le TP1

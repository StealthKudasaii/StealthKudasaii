"""python -m bot.demo : ouvre le site avec un broker SIMULÉ et de faux trades, pour le découvrir
sans MT5 ni Telegram. Puis va sur http://127.0.0.1:8080 (mot de passe : demo1234)."""
from __future__ import annotations

import asyncio
import logging
import random
import tempfile
from datetime import timedelta
from pathlib import Path

from .broker import PaperBroker
from .config import Config
from .engine import Engine
from .models import Action, AnalystVerdict, Decision, ParsedMessage, Side
from .panel import LOG_BUFFER, create_app, serve
from .store import Store


class DemoAI:
    def __init__(self):
        self.next: dict[str, ParsedMessage] = {}

    async def parse_message(self, text, reply_to_text, open_trades):
        return self.next.get(text, ParsedMessage(action=Action.IGNORE, symbol_is_gold=True, confidence=1))

    async def analyze(self, signal, bid, ask, bars):
        r = random.random()
        if r < 0.15:
            return AnalystVerdict(decision=Decision.REJECT, risk_multiplier=0, confidence=0.8,
                                  summary="Contre-tendance H4 et résistance majeure juste au-dessus de l'entrée.")
        if r < 0.35:
            return AnalystVerdict(decision=Decision.REDUCE, risk_multiplier=0.5, confidence=0.6,
                                  summary="Tendance H1 dans le sens du signal mais RSI M15 déjà élevé.")
        return AnalystVerdict(decision=Decision.APPROVE, risk_multiplier=1, confidence=0.75,
                              summary="H4 et H1 haussiers, entrée sur un support M15, SL sous le dernier creux.")


async def build(tmp: Path) -> Engine:
    cfg = Config.model_validate({"dry_run": False, "telegram": {"source_chats": [1]},
                                 "risk": {"max_trades_per_day": 50, "max_open_signals": 5,
                                          "duplicate_window_minutes": 0, "max_daily_loss_pct": 20}})
    broker = PaperBroker(bid=2650.0, spread=0.25, balance=10_000)
    ai = DemoAI()
    eng = Engine(cfg, broker, Store(tmp / "demo.sqlite"), ai)
    random.seed(7)
    msg = 100
    # 14 trades passés
    for day in range(14):
        broker.now = broker.now - timedelta(days=14 - day) if day == 0 else broker.now + timedelta(days=1)
        side = random.choice([Side.BUY, Side.SELL])
        price = broker.bid
        s = 1 if side == Side.BUY else -1
        text = f"GOLD {side.value} NOW {price:.0f}\nSL {price - s * 8:.0f}\nTP {price + s * 5:.0f} / {price + s * 10:.0f} / {price + s * 18:.0f}"
        ai.next[text] = ParsedMessage(action=Action.NEW_SIGNAL, symbol_is_gold=True, side=side, entry_low=price,
                                      entry_high=price, stop_loss=price - s * 8,
                                      take_profits=[price + s * 5, price + s * 10, price + s * 18], confidence=0.95)
        msg += 1
        await eng.handle_message(1, msg, text)
        outcome = random.random()
        path = [price + s * 5.2, price + s * 10.3, price + s * 6] if outcome < 0.3 else \
               [price + s * 5.3, price + s * 0.1] if outcome < 0.55 else [price - s * 8.2]
        for p in path:
            broker.set_price(round(p, 2))
            eng.manage_once()
        broker.set_price(round(broker.bid + random.uniform(-6, 6), 2))
        eng.manage_once()
    # 2 trades en cours
    for side, off in ((Side.BUY, 0), (Side.SELL, 0)):
        price = broker.bid
        s = 1 if side == Side.BUY else -1
        text = f"XAUUSD {side.value} {price:.0f} SL {price - s * 9:.0f} TP {price + s * 4:.0f}-{price + s * 9:.0f}-{price + s * 15:.0f}"
        ai.next[text] = ParsedMessage(action=Action.NEW_SIGNAL, symbol_is_gold=True, side=side, entry_low=price,
                                      entry_high=price, stop_loss=price - s * 9,
                                      take_profits=[price + s * 4, price + s * 9, price + s * 15], confidence=0.95)
        msg += 1
        await eng.handle_message(1, msg, text)
        eng.cfg.risk.duplicate_window_minutes = 0
    broker.set_price(broker.bid + 1.3)
    eng.manage_once()
    return eng


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger().addHandler(LOG_BUFFER)
    tmp = Path(tempfile.mkdtemp())
    eng = await build(tmp)
    app = create_app(eng, "demo1234", overrides_path=tmp / "ov.yaml")
    print("\n  Démo : http://127.0.0.1:8080   (mot de passe : demo1234)\n")
    await serve(app, "127.0.0.1", 8080)


if __name__ == "__main__":
    asyncio.run(main())

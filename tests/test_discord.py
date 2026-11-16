"""Bot Discord : moteur (événements, validations, prise forcée), cartes, et boutons avec une interaction simulée."""
import asyncio
from types import SimpleNamespace

import discord
import pytest

from bot import views
from bot.discord_bot import embeds as E
from bot.discord_bot.client import GoldDiscordBot
from bot.models import AnalystVerdict, Decision
from tests.test_engine import SIGNAL, make


def run(coro):
    return asyncio.run(coro)


def engine_with_events(tmp_path, **cfg):
    eng, broker, ai, notes = make(tmp_path, **cfg)
    events = []

    async def listener(kind, data):
        events.append((kind, data))

    eng.listeners.append(listener)
    ai.next["BUY GOLD"] = SIGNAL
    return eng, broker, ai, notes, events


# ----------------------------------------------------------------- moteur
def test_events_full_lifecycle(tmp_path):
    eng, broker, ai, notes, events = engine_with_events(tmp_path)
    run(eng.handle_message(1, 10, "BUY GOLD"))
    broker.set_price(2355.1)
    eng.manage_once()
    run(eng.flush_events())
    broker.set_price(2340)
    eng.manage_once()
    run(eng.flush_events())
    kinds = [k for k, _ in events]
    assert kinds[:2] == ["message", "trade_opened"]
    assert "tp_hit" in kinds and "sl_moved" in kinds and kinds[-1] == "trade_closed"
    closed = events[-1][1]
    assert closed["sid"] == 1 and closed["pnl"] is not None


def test_approval_doubts_half(tmp_path):
    eng, broker, ai, notes, events = engine_with_events(tmp_path)
    ai.verdict = AnalystVerdict(decision=Decision.REDUCE, risk_multiplier=0.5, confidence=0.6, summary="Mitigé.")
    asked = []

    async def approver(req):
        asked.append(req)
        assert eng._lock.locked() is False  # la gestion continue pendant l'attente
        return 0.5

    eng.approver = approver
    run(eng.handle_message(1, 10, "BUY GOLD"))
    assert len(asked) == 1 and asked[0]["preview"]["volume"] > 0
    assert sum(p.volume for p in broker.positions()) == pytest.approx(0.04)  # moitié de 0.09 arrondi


def test_approval_refuse_and_take_anyway(tmp_path):
    eng, broker, ai, notes, events = engine_with_events(tmp_path)
    ai.verdict = AnalystVerdict(decision=Decision.REJECT, risk_multiplier=0, confidence=0.9, summary="Non.")

    async def approver(req):
        return 0.0

    eng.approver = approver
    run(eng.handle_message(1, 10, "BUY GOLD"))
    assert broker.positions() == []
    rej = [d for k, d in events if k == "signal_rejected"][0]
    assert "toi" in rej["reason"]
    sid = run(eng.take_rejected(rej["sid"], 1.0, by="test"))
    assert sid == rej["sid"] and len(broker.positions()) == 3
    assert eng.store.signal(sid)["status"] == "open"
    with pytest.raises(ValueError):
        run(eng.take_rejected(rej["sid"]))


def test_approval_not_asked_when_ai_approves(tmp_path):
    eng, broker, ai, notes, events = engine_with_events(tmp_path)
    called = []

    async def approver(req):
        called.append(1)
        return 0.0

    eng.approver = approver
    run(eng.handle_message(1, 10, "BUY GOLD"))
    assert called == [] and len(broker.positions()) == 3


def test_approval_always_and_timeout_skip(tmp_path):
    eng, broker, ai, notes, events = engine_with_events(
        tmp_path, discord={"approval_mode": "always", "approval_on_timeout": "skip"})

    async def approver(req):
        return None  # pas de réponse

    eng.approver = approver
    run(eng.handle_message(1, 10, "BUY GOLD"))
    assert broker.positions() == []


# ----------------------------------------------------------------- cartes
def test_embeds_build(tmp_path):
    eng, broker, ai, notes, events = engine_with_events(tmp_path)
    run(eng.handle_message(1, 10, "BUY GOLD"))
    broker.set_price(2356)
    eng.manage_once()

    async def build():
        s = await views.status_data(eng)
        trades = await views.trades_data(eng)
        dash = E.dashboard_embed(s, trades)
        card = E.trade_embed(trades[0])
        E.trade_view(trades[0]), E.dashboard_view(s["paused"])
        st = await views.stats_data(eng)
        E.stats_embed(st, "Stats")
        from bot.panel import current_settings
        E.settings_embed(current_settings(eng)), E.settings_view(current_settings(eng))
        return dash, card

    dash, card = run(build())
    assert "Trade" in card.title and "✅ TP1" in card.fields[3].value
    assert "🛡" in card.fields[1].value  # SL remonté au BE
    assert len(dash) < 6000 and len(card) < 6000


def test_approval_and_rejected_embeds():
    req = {"side": "SELL", "entry_low": 2350, "entry_high": 2352, "sl": 2360, "tps": [2345, 2340], "text": "SELL GOLD",
           "auto_multiplier": 0.0, "note": "", "on_timeout": "auto", "timeout": 120,
           "verdict": {"decision": "REJECT", "risk_multiplier": 0, "confidence": 0.8, "summary": "Contre-tendance.",
                       "warnings": ["RSI bas"]},
           "preview": {"order_type": "market", "entry": 2350, "volume": 0.05, "risk": 50.0, "legs": [], "notes": []}}
    from datetime import datetime
    e = E.approval_embed(req, datetime.now())
    assert "refuser" in e.description and "REJECT" in e.fields[0].name
    r = E.rejected_embed({**req, "reason": "spread trop large"})
    assert "spread" in r.description


# ----------------------------------------------------------------- boutons
class FakeResponse:
    def __init__(self):
        self.sent, self.done, self.modal, self.edited = [], False, None, None

    def is_done(self):
        return self.done

    async def send_message(self, content=None, **kw):
        self.sent.append(content)
        self.done = True

    async def defer(self, **kw):
        self.done = True

    async def edit_message(self, **kw):
        self.edited = kw
        self.done = True

    async def send_modal(self, modal):
        self.modal = modal
        self.done = True


class FakeFollowup:
    def __init__(self):
        self.sent = []

    async def send(self, content=None, **kw):
        self.sent.append(content)


def fake_interaction(custom_id, values=None, message=None):
    user = SimpleNamespace(display_name="William", mention="@William", id=1,
                           guild_permissions=SimpleNamespace(administrator=True))
    return SimpleNamespace(user=user, data={"custom_id": custom_id, "values": values or []},
                           response=FakeResponse(), followup=FakeFollowup(), message=message, guild=None)


@pytest.fixture()
def discord_bot(tmp_path):
    eng, broker, ai, notes, events = engine_with_events(tmp_path)

    async def make_bot():
        return GoldDiscordBot(eng, state_path=tmp_path / "d.json", overrides_path=tmp_path / "ov.yaml")

    bot = asyncio.run(make_bot())
    return bot, eng, broker


def test_buttons_trade_actions(discord_bot):
    bot, eng, broker = discord_bot

    async def scenario():
        await eng.handle_message(1, 10, "BUY GOLD")
        broker.set_price(2353)
        it = fake_interaction("trade:be:1")
        await bot.handle_component(it, "trade:be:1")
        assert "break-even" in it.followup.sent[0]
        assert all(p.sl == pytest.approx(2350.55) for p in broker.positions())
        it = fake_interaction("trade:half:1")
        await bot.handle_component(it, "trade:half:1")
        assert sum(p.volume for p in broker.positions()) == pytest.approx(0.05)
        it = fake_interaction("trade:edit:1")
        await bot.handle_component(it, "trade:edit:1")
        assert it.response.modal is not None
        it = fake_interaction("trade:closeyes:1")
        await bot.handle_component(it, "trade:closeyes:1")
        assert broker.positions() == []

    run(scenario())


def test_buttons_control_and_settings(discord_bot):
    bot, eng, broker = discord_bot

    async def scenario():
        await bot.handle_component(fake_interaction("ctl:pause"), "ctl:pause")
        assert eng.paused
        await bot.handle_component(fake_interaction("ctl:resume"), "ctl:resume")
        assert not eng.paused
        await bot.handle_component(fake_interaction("ctl:skip"), "ctl:skip")
        assert eng.skip_next == 1
        await bot.handle_component(fake_interaction("set:approval", ["always"]), "set:approval")
        assert eng.cfg.discord.approval_mode == "always"
        await bot.handle_component(fake_interaction("set:risk:+"), "set:risk:+")
        assert eng.cfg.risk.risk_per_trade_pct == pytest.approx(1.25)
        await bot.handle_component(fake_interaction("set:analyst", ["advisory"]), "set:analyst")
        assert eng.cfg.ai.analyst_mode == "advisory"

    run(scenario())


def test_approval_button_resolves_future(discord_bot):
    bot, eng, broker = discord_bot

    async def scenario():
        fut = asyncio.get_running_loop().create_future()
        bot.pending["abc"] = fut
        msg = SimpleNamespace(embeds=[discord.Embed(title="x")])
        it = fake_interaction("approve:abc:0.5", message=msg)
        await bot.handle_component(it, "approve:abc:0.5")
        assert fut.result() == 0.5 and it.response.edited is not None
        it = fake_interaction("approve:abc:1", message=msg)
        await bot.handle_component(it, "approve:abc:1")
        assert "expirée" in it.response.sent[0]

    run(scenario())


def test_events_ignored_before_setup(discord_bot):
    bot, eng, broker = discord_bot
    run(bot.on_engine_event("trade_opened", {"sid": 1}))  # pas connecté, pas de salons : ne plante pas

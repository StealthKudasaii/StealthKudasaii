import asyncio

import pytest
from fastapi.testclient import TestClient

from bot.panel import create_app
from tests.test_engine import SIGNAL, make

H = {"X-Panel": "1"}


@pytest.fixture()
def setup(tmp_path):
    eng, broker, ai, notes = make(tmp_path)
    ai.next["BUY GOLD"] = SIGNAL
    asyncio.run(eng.handle_message(1, 10, "BUY GOLD"))
    app = create_app(eng, "motdepasse123", overrides_path=tmp_path / "ov.yaml")
    return TestClient(app), eng, broker, tmp_path


def login(c):
    assert c.post("/api/login", json={"password": "motdepasse123"}).status_code == 200


def test_requires_login(setup):
    c, *_ = setup
    assert c.get("/api/status").status_code == 401
    assert c.post("/api/login", json={"password": "faux"}).status_code == 401
    assert c.get("/").status_code == 200  # la page de connexion s'affiche


def test_short_password_refused(tmp_path):
    eng, *_ = make(tmp_path)
    with pytest.raises(SystemExit):
        create_app(eng, "court")


def test_dashboard_data(setup):
    c, eng, broker, _ = setup
    login(c)
    s = c.get("/api/status").json()
    assert s["balance"] == 10_000 and s["trades_today"] == 1 and s["open_risk"] > 0
    trades = c.get("/api/trades").json()
    assert len(trades) == 1 and len(trades[0]["positions"]) == 3
    assert trades[0]["message"] == "BUY GOLD"


def test_post_needs_csrf_header(setup):
    c, eng, *_ = setup
    login(c)
    assert c.post("/api/pause").status_code == 403
    assert c.post("/api/pause", headers=H).status_code == 200 and eng.paused


def test_be_close_and_stats(setup):
    c, eng, broker, _ = setup
    login(c)
    broker.set_price(2353)
    assert c.post("/api/trades/1/be", headers=H).status_code == 200
    assert all(p.sl == pytest.approx(2350.55) for p in broker.positions())
    assert c.post("/api/trades/1/close", headers=H).status_code == 200
    assert broker.positions() == []
    hist = c.get("/api/history").json()
    assert hist[0]["status"] == "closed" and hist[0]["pnl"] > 0
    st = c.get("/api/stats").json()
    assert st["closed"] == 1 and st["wins"] == 1 and st["winrate"] == 100.0
    assert c.post("/api/trades/1/close", headers=H).status_code == 404


def test_settings_validation_and_save(setup):
    c, eng, broker, tmp = setup
    login(c)
    r = c.post("/api/settings", headers=H, json={"risk": {"risk_per_trade_pct": 0.5}})
    assert r.status_code == 200 and eng.cfg.risk.risk_per_trade_pct == 0.5
    assert (tmp / "ov.yaml").exists()
    assert c.post("/api/settings", headers=H, json={"risk": {"risk_per_trade_pct": 50}}).status_code == 400
    assert c.post("/api/settings", headers=H, json={"telegram": {"source_chats": [2]}}).status_code == 400
    assert c.post("/api/settings", headers=H, json={"risk": {"magic": 1}}).status_code == 400

"""Le site de contrôle du bot (panel web), servi par le bot lui-même.

Ouvre http://127.0.0.1:8080 sur le VPS (ou via Tailscale depuis ton téléphone, voir README).
Mot de passe : PANEL_PASSWORD dans .env.
"""
from __future__ import annotations

import asyncio
import collections
import hmac
import logging
import secrets
import time
from pathlib import Path
from typing import Any

import yaml
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, ValidationError

from .config import OVERRIDES_PATH, AICfg, DiscordCfg, ManagementCfg, RiskCfg
from . import views
from .engine import Engine

log = logging.getLogger(__name__)
WEB = Path(__file__).parent / "web"
SESSION_COOKIE = "goldbot_session"
SESSION_DAYS = 7

# Réglages modifiables depuis le site (le reste se change dans config.yaml + redémarrage).
EDITABLE: dict[str, tuple[type[BaseModel], set[str]]] = {
    "risk": (RiskCfg, {"risk_per_trade_pct", "max_daily_loss_pct", "max_open_signals", "max_trades_per_day",
                       "max_spread", "max_entry_drift", "far_entry_action", "min_sl_distance", "max_sl_distance",
                       "fixed_lot"}),
    "management": (ManagementCfg, {"tp_split", "breakeven_after_tp", "breakeven_buffer", "trail_to_previous_tp"}),
    "ai": (AICfg, {"analyst_mode", "on_analyst_error"}),
    "discord": (DiscordCfg, {"approval_mode", "approval_timeout_seconds", "approval_on_timeout"}),
}


def current_settings(engine: Engine) -> dict[str, dict[str, Any]]:
    return {sec: {k: getattr(getattr(engine.cfg, sec), k) for k in sorted(keys)}
            for sec, (_, keys) in EDITABLE.items()}


def apply_settings(engine: Engine, body: dict[str, dict[str, Any]], overrides_path: Path = OVERRIDES_PATH) -> dict:
    """Valide et applique des réglages (site ou Discord), puis les enregistre. ValueError si invalide."""
    new_sections = {}
    for sec, values in body.items():
        if sec not in EDITABLE:
            raise ValueError(f"section inconnue : {sec}")
        model, keys = EDITABLE[sec]
        unknown = set(values) - keys
        if unknown:
            raise ValueError(f"réglage non modifiable : {', '.join(sorted(unknown))}")
        merged = getattr(engine.cfg, sec).model_dump() | values
        try:
            new_sections[sec] = model.model_validate(merged)
        except ValidationError as e:
            raise ValueError("valeur invalide : " + "; ".join(
                f"{'.'.join(map(str, err['loc']))} {err['msg']}" for err in e.errors()))
    if "management" in new_sections:
        split = new_sections["management"].tp_split
        if not split or any(x <= 0 for x in split):
            raise ValueError("la répartition des TP doit contenir des nombres positifs")
    for sec, model in new_sections.items():
        setattr(engine.cfg, sec, model)
    overrides_path.parent.mkdir(parents=True, exist_ok=True)
    with open(overrides_path, "w", encoding="utf-8") as f:
        yaml.safe_dump(current_settings(engine), f, allow_unicode=True, sort_keys=False)
    log.info("Réglages modifiés %s", body)
    return current_settings(engine)


class Login(BaseModel):
    password: str


class LogBuffer(logging.Handler):
    """Garde les dernières lignes de log en mémoire pour les afficher sur le site."""

    def __init__(self, size: int = 300):
        super().__init__()
        self.lines: collections.deque[str] = collections.deque(maxlen=size)
        self.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%d/%m %H:%M:%S"))

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self.lines.append(self.format(record))
        except Exception:
            pass


LOG_BUFFER = LogBuffer()


def create_app(engine: Engine, password: str, overrides_path: Path = OVERRIDES_PATH) -> FastAPI:
    if len(password) < 8:
        raise SystemExit("PANEL_PASSWORD doit faire au moins 8 caractères (dans .env).")

    app = FastAPI(title="Bot or", docs_url=None, redoc_url=None, openapi_url=None)
    sessions: dict[str, float] = {}
    failures: list[float] = []

    # -------------------------------------------------------------- sécurité
    def require_session(request: Request) -> None:
        token = request.cookies.get(SESSION_COOKIE, "")
        expiry = sessions.get(token)
        if not expiry or expiry < time.time():
            sessions.pop(token, None)
            raise HTTPException(401, "non connecté")
        if request.method == "POST" and request.headers.get("x-panel") != "1":
            raise HTTPException(403, "requête refusée")  # bloque les formulaires d'autres sites (CSRF)

    auth = [Depends(require_session)]

    @app.post("/api/login")
    async def login(body: Login, response: Response, request: Request):
        now = time.time()
        failures[:] = [t for t in failures if now - t < 600]
        if len(failures) >= 10:
            raise HTTPException(429, "Trop d'essais. Réessaie dans 10 minutes.")
        if not hmac.compare_digest(body.password.encode(), password.encode()):
            failures.append(now)
            log.warning("Panel : mauvais mot de passe depuis %s", request.client.host if request.client else "?")
            await asyncio.sleep(1)  # ralentit les essais sans bloquer le trading
            raise HTTPException(401, "Mot de passe incorrect")
        token = secrets.token_urlsafe(32)
        sessions[token] = now + SESSION_DAYS * 86400
        response.set_cookie(SESSION_COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True,
                            samesite="strict", secure=request.url.scheme == "https")
        log.info("Panel : connexion réussie")
        return {"ok": True}

    @app.post("/api/logout", dependencies=auth)
    async def logout(request: Request, response: Response):
        sessions.pop(request.cookies.get(SESSION_COOKIE, ""), None)
        response.delete_cookie(SESSION_COOKIE)
        return {"ok": True}

    # ------------------------------------------------------------- lecture
    @app.get("/api/status", dependencies=auth)
    async def status():
        return await views.status_data(engine)

    @app.get("/api/trades", dependencies=auth)
    async def trades():
        return await views.trades_data(engine)

    @app.get("/api/history", dependencies=auth)
    async def history(limit: int = 100):
        return views.history_data(engine, limit)

    @app.get("/api/stats", dependencies=auth)
    async def stats():
        return await views.stats_data(engine)

    @app.get("/api/logs", dependencies=auth)
    async def logs():
        return list(LOG_BUFFER.lines)[-200:]

    # ------------------------------------------------------------- actions
    @app.post("/api/pause", dependencies=auth)
    async def pause():
        await engine.set_paused(True, by="site")
        return {"ok": True}

    @app.post("/api/resume", dependencies=auth)
    async def resume():
        await engine.set_paused(False, by="site")
        return {"ok": True}

    @app.post("/api/closeall", dependencies=auth)
    async def closeall():
        await engine.close_everything(reason="fermé depuis le site")
        return {"ok": True}

    def open_row(sid: int):
        row = engine.store.signal(sid)
        if row is None or row["status"] != "open":
            raise HTTPException(404, "trade introuvable ou déjà fermé")
        return row

    @app.post("/api/trades/{sid}/close", dependencies=auth)
    async def close_trade(sid: int):
        async with engine._lock:
            await engine.close_signal(open_row(sid), reason="fermé depuis le site")
        return {"ok": True}

    @app.post("/api/trades/{sid}/be", dependencies=auth)
    async def be_trade(sid: int):
        async with engine._lock:
            ok = await engine.move_be(open_row(sid), reason="depuis le site")
        if not ok:
            raise HTTPException(400, "BE impossible maintenant (prix trop proche de l'entrée ?)")
        return {"ok": True}

    # ------------------------------------------------------------ réglages
    @app.get("/api/settings", dependencies=auth)
    async def get_settings():
        return current_settings(engine)

    @app.post("/api/settings", dependencies=auth)
    async def save_settings(body: dict[str, dict[str, Any]]):
        try:
            result = apply_settings(engine, body, overrides_path)
        except ValueError as e:
            raise HTTPException(400, str(e))
        engine.emit("settings", by="site", changes=body)
        await engine.notify("⚙️ Réglages modifiés depuis le site.")
        return result

    # ------------------------------------------------------------- pages
    @app.get("/")
    async def index():
        return FileResponse(WEB / "index.html", headers={"Cache-Control": "no-store"})

    return app


async def serve(app: FastAPI, host: str, port: int) -> None:
    import uvicorn

    server = uvicorn.Server(uvicorn.Config(app, host=host, port=port, log_level="warning", access_log=False))
    log.info("Site du bot : http://%s:%s", "127.0.0.1" if host in ("0.0.0.0", "127.0.0.1") else host, port)
    await server.serve()

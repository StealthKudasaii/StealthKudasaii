"""Chargement de config.yaml + .env."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Literal, Union

import yaml
from pydantic import BaseModel, Field, field_validator


class TelegramCfg(BaseModel):
    source_chats: list[Union[int, str]]
    allowed_senders: list[int] = Field(default_factory=list)
    notify_chat: Union[int, str] = "me"
    # Ne prendre que les signaux TRANSFÉRÉS depuis ces canaux (bout du nom, ex. "SCALPING"). Vide = tous les signaux.
    forwarded_from: list[str] = Field(default_factory=list)
    # Avec forwarded_from : suivre quand même les consignes (BE, close...) écrites directement dans le groupe ?
    commands_from_everyone: bool = True
    # Avec forwarded_from : prendre AUSSI les signaux écrits directement dans le groupe (« groupe principal ») ?
    main_signals: bool = False
    # ... seulement si leur SL est à X $ maximum de l'entrée (0 = pas de limite)
    main_max_sl: float = 0.0


class MT5Cfg(BaseModel):
    symbol: str = "XAUUSD"
    magic: int = 770077
    deviation_points: int = 30


class AICfg(BaseModel):
    parser_model: str = "claude-haiku-5-5"
    analyst_model: str = "claude-opus-5-5"
    analyst_effort: Literal["low", "medium", "high", "xhigh", "max"] = "medium"
    analyst_mode: Literal["filter", "advisory", "off"] = "filter"
    on_analyst_error: Literal["approve", "reject"] = "approve"
    on_error_risk_multiplier: float = 0.5


class RiskCfg(BaseModel):
    risk_per_trade_pct: float = 1.0
    fixed_lot: float = 0.0  # > 0 : lot total fixe par signal (réparti entre les TP), remplace risk_per_trade_pct
    max_daily_loss_pct: float = 3.0
    max_open_signals: int = 2
    max_trades_per_day: int = 6
    max_spread: float = 0.60
    min_sl_distance: float = 1.5
    max_sl_distance: float = 25.0
    max_tp1_r: float = 6.0  # TP1 plus loin que X fois le risque = faute de frappe probable -> refus (0 = pas de contrôle)
    max_entry_drift: float = 2.0
    far_entry_action: Literal["limit", "skip"] = "limit"
    limit_expiry_minutes: int = 120
    duplicate_window_minutes: int = 10
    no_trade_windows: list[tuple[str, str]] = Field(default_factory=list)

    @field_validator("risk_per_trade_pct")
    @classmethod
    def _cap_risk(cls, v: float) -> float:
        if not 0 < v <= 5:
            raise ValueError("risk_per_trade_pct doit être entre 0 et 5 %")
        return v


class ManagementCfg(BaseModel):
    tp_split: list[float] = Field(default_factory=lambda: [0.5, 0.3, 0.2])
    breakeven_after_tp: int = 1
    breakeven_buffer: float = 0.30
    trail_to_previous_tp: bool = True
    default_tp_r: list[float] = Field(default_factory=lambda: [1.0, 2.0, 3.0])
    check_interval_seconds: float = 2.0
    # Suivre les consignes de gestion du groupe ? (false = le bot gère seul avec ses propres règles)
    follow_group_be: bool = True       # « SL BE », « sécurisez »
    follow_group_closes: bool = True   # « close all », « coupez la moitié »
    max_tps: int = 0                   # 1 = toute la position vise le TP1 ; 0 = tous les TP du signal


class Config(BaseModel):
    dry_run: bool = True
    telegram: TelegramCfg
    mt5: MT5Cfg = Field(default_factory=MT5Cfg)
    ai: AICfg = Field(default_factory=AICfg)
    risk: RiskCfg = Field(default_factory=RiskCfg)
    management: ManagementCfg = Field(default_factory=ManagementCfg)


def load_config(path: str | Path = "config.yaml") -> Config:
    try:
        from dotenv import load_dotenv

        load_dotenv()
    except ImportError:
        pass
    with open(path, encoding="utf-8") as f:
        return Config.model_validate(yaml.safe_load(f))


def env(name: str, required: bool = True) -> str:
    value = os.environ.get(name, "").strip()
    if required and not value:
        raise SystemExit(f"Variable manquante dans .env : {name}")
    return value

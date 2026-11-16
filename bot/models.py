"""Types partagés par tout le bot."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class Side(str, Enum):
    BUY = "BUY"
    SELL = "SELL"


class Action(str, Enum):
    """Ce que le message du groupe demande de faire."""

    NEW_SIGNAL = "NEW_SIGNAL"      # nouveau trade
    MOVE_SL_BE = "MOVE_SL_BE"      # passer au break-even
    MODIFY_SL = "MODIFY_SL"        # nouveau SL
    MODIFY_TP = "MODIFY_TP"        # nouveaux TP
    CLOSE_ALL = "CLOSE_ALL"        # fermer tout le trade
    CLOSE_PARTIAL = "CLOSE_PARTIAL"  # prendre une partie des gains
    CANCEL = "CANCEL"              # annuler un signal pas encore déclenché
    SKIP_NEXT = "SKIP_NEXT"        # "ne prenez pas le prochain trade"
    IGNORE = "IGNORE"              # bavardage, résultat, pub...


class TpChange(BaseModel):
    """Un TP précis à changer : "Modifiez le TP2 à 4085" -> index=2, price=4085."""

    index: int = Field(description="Numéro du TP (1 = TP1, 2 = TP2...).")
    price: float


class ParsedMessage(BaseModel):
    """Sortie structurée de l'IA qui lit les messages Telegram."""

    action: Action
    symbol_is_gold: bool = Field(description="True si le message concerne l'or (XAUUSD, GOLD).")
    side: Optional[Side] = None
    entry_low: Optional[float] = Field(None, description="Bas de la zone d'entrée (ou prix unique).")
    entry_high: Optional[float] = Field(None, description="Haut de la zone d'entrée (ou prix unique).")
    entry_is_market: bool = Field(False, description="True si 'buy now', 'sell now', 'au marché'.")
    stop_loss: Optional[float] = None
    take_profits: list[float] = Field(default_factory=list)
    close_fraction: Optional[float] = Field(
        None, description="Pour CLOSE_PARTIAL : fraction à fermer (0.5 = moitié)."
    )
    tp_changes: list[TpChange] = Field(
        default_factory=list,
        description="Pour MODIFY_TP : chaque TP modifié avec son numéro. 'Modifiez le TP2 à 4085' -> "
                    "[{index: 2, price: 4085}]. 'Le TP c'est 3900' sans numéro -> index 1.",
    )
    extra_actions: list[Action] = Field(
        default_factory=list,
        description="Autres consignes du MÊME message, en plus de `action`, dans l'ordre. "
                    "'Coupez la moitié et mettez BE' -> action CLOSE_PARTIAL, extra_actions [MOVE_SL_BE].",
    )
    skip_count: Optional[int] = Field(
        None, description="Pour SKIP_NEXT : nombre de prochains signaux à ne pas prendre (1 par défaut)."
    )
    confidence: float = Field(description="0 à 1 : certitude que l'interprétation est correcte.")
    notes: str = Field("", description="Courte explication, en français.")


class Decision(str, Enum):
    APPROVE = "APPROVE"
    REDUCE = "REDUCE"
    REJECT = "REJECT"


class AnalystVerdict(BaseModel):
    """Sortie structurée de l'IA qui analyse le graphique."""

    decision: Decision
    risk_multiplier: float = Field(description="1.0 = taille normale, 0.5 = moitié, 0 = ne pas prendre.")
    confidence: float = Field(description="0 à 1.")
    summary: str = Field(description="2-3 phrases en français, pour la notification.")
    reasons: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


@dataclass
class Signal:
    """Un signal validé, prêt à passer dans le moteur de risque."""

    side: Side
    entry_low: float
    entry_high: float
    stop_loss: float
    take_profits: list[float]
    entry_is_market: bool = True
    source_msg_id: int = 0
    received_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc).replace(tzinfo=None))
    id: int = 0

    @property
    def entry_ref(self) -> float:
        """Prix d'entrée de référence : le côté le moins favorable de la zone."""
        return self.entry_high if self.side == Side.BUY else self.entry_low

    def sl_distance(self, entry: Optional[float] = None) -> float:
        return abs((entry if entry is not None else self.entry_ref) - self.stop_loss)


@dataclass
class SymbolSpec:
    volume_min: float
    volume_max: float
    volume_step: float
    digits: int
    point: float
    stops_level_points: int = 0


@dataclass
class Position:
    ticket: int
    side: Side
    volume: float
    open_price: float
    sl: float
    tp: float
    comment: str
    profit: float = 0.0


@dataclass
class PendingOrder:
    ticket: int
    side: Side
    volume: float
    price: float
    sl: float
    tp: float
    comment: str


@dataclass
class Bar:
    time: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


@dataclass
class OrderResult:
    ok: bool
    ticket: int = 0
    price: float = 0.0
    message: str = ""

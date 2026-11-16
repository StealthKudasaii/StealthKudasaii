"""Mémoire du bot Discord : salons créés par /setup, messages à mettre à jour, cartes des trades."""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional

CHANNELS = {
    # clé : (nom du salon, sujet)
    "dashboard": ("📊・tableau-de-bord", "État du bot en direct + boutons Pause / Tout fermer"),
    "approvals": ("✋・validations", "Le bot te demande ton avis sur certains signaux"),
    "trades": ("💹・trades-en-cours", "Une carte par trade ouvert, mise à jour en direct"),
    "signals": ("📡・signaux", "Tous les messages du groupe Telegram et ce que le bot en fait"),
    "history": ("📜・historique", "Résultat de chaque trade terminé"),
    "stats": ("📈・stats", "Récap quotidien et statistiques"),
    "settings": ("⚙️・réglages", "Réglages du bot, modifiables en direct"),
    "alerts": ("🚨・alertes", "Erreurs, limites atteintes, problèmes à regarder"),
    "journal": ("🧾・journal", "Toutes les notifications du bot, dans l'ordre"),
}


@dataclass
class DiscordState:
    guild_id: Optional[int] = None
    category_id: Optional[int] = None
    role_id: Optional[int] = None
    channels: dict[str, int] = field(default_factory=dict)
    dashboard_msg: Optional[int] = None
    settings_msg: Optional[int] = None
    cards: dict[str, int] = field(default_factory=dict)  # id du trade -> id du message Discord
    last_recap: str = ""

    @classmethod
    def load(cls, path: Path) -> "DiscordState":
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})
            except (ValueError, TypeError):
                pass
        return cls()

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(asdict(self), indent=2), encoding="utf-8")
        tmp.replace(path)

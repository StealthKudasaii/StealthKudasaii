"""Les deux usages de Claude : lire les messages, et analyser le graphique."""
from __future__ import annotations

import json
import logging
from typing import Optional, Type, TypeVar

import anthropic
from pydantic import BaseModel

from .indicators import compact_candles, summarize_timeframe
from .models import AnalystVerdict, Bar, MarketView, ParsedMessage, Signal

log = logging.getLogger(__name__)
T = TypeVar("T", bound=BaseModel)

# Modèles qui acceptent le repli automatique côté serveur si une requête est refusée.
_FALLBACK_MODELS = {"claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-fable-5-2"}

PARSER_SYSTEM = """Tu lis les messages d'un groupe Telegram de signaux de trading sur l'OR (XAUUSD / GOLD).
Ton travail : dire exactement ce que le message demande, sans rien inventer.

Actions possibles :
- NEW_SIGNAL : un nouveau trade (BUY/SELL, entrée ou zone, SL, TP). "Buy now" / "sell now" = entry_is_market true.
- MOVE_SL_BE : "SL to BE", "break even", "sécurisez", "SL à l'entrée".
- MODIFY_SL : nouveau prix de SL précis.
- MODIFY_TP : nouveaux TP. Remplis `tp_changes` avec le NUMÉRO de chaque TP modifié
  ("Modifiez le TP2 à 4085" -> [{index: 2, price: 4085}] ; "LE TP C'EST 3900" sans numéro -> index 1).
  N'utilise `take_profits` que si le message redonne la liste complète des TP.
- CLOSE_ALL : "close", "fermez tout", "exit now", "close all", "close fully now".
- CLOSE_PARTIAL : "prenez des gains", "close half", "coupez la moitié" (close_fraction = 0.5 par défaut).
- CANCEL : "cancel", "annulez", signal pas déclenché à oublier.
- SKIP_NEXT : "ne prenez pas le prochain trade" (skip_count = nombre de signaux à sauter, 1 par défaut).
- IGNORE : résultats ("TP1 hit +50 pips"), bavardage, analyses sans ordre, pubs, autres actifs.

Règles :
- Plusieurs consignes dans le même message ("coupez la moitié et mettez BE") : la première dans `action`,
  les suivantes dans `extra_actions`, dans l'ordre (ici CLOSE_PARTIAL puis [MOVE_SL_BE]).
- "+40 pips en cours" seul, sans consigne = IGNORE. "+40 pips en cours sécurisez" = MOVE_SL_BE.
- Un TP incohérent avec le reste du signal (ex. BUY à 3896, SL 3888, TP1 3990 : probablement 3900)
  est sûrement une faute de frappe : recopie le chiffre tel quel mais baisse `confidence` sous 0.7.
- "TP1 hit" ou "TP2 done" seul = IGNORE (le bot gère déjà ses TP), sauf s'il y a une consigne en plus.
- Une zone "2345-2350" : entry_low=2345, entry_high=2350. Un prix unique : les deux identiques.
- Si l'entrée est "now"/"maintenant" sans prix, laisse entry_low/high à null et entry_is_market=true.
- Si le message parle d'un autre actif que l'or, symbol_is_gold=false et action IGNORE.
- Au moindre doute sur un chiffre (SL, entrée), baisse `confidence`. Ne devine jamais un SL.
- Le message auquel celui-ci répond (s'il existe) et les trades en cours te sont donnés en contexte."""

ANALYST_SYSTEM = """Tu es un trader professionnel spécialisé sur l'or (XAUUSD), en intraday et swing.
Un groupe de signaux auquel l'utilisateur fait confiance vient d'envoyer un signal. Ton rôle n'est PAS
d'inventer un autre trade : c'est de vérifier si le contexte du marché confirme le signal, maintenant.

Tu reçois : le signal, le prix actuel, et pour M5/M15/H1/H4 des indicateurs calculés (EMA, RSI, ATR,
structure, points hauts/bas) plus les dernières bougies M15 en [open, high, low, close].

Évalue :
- La tendance multi-timeframe va-t-elle dans le sens du signal (H4/H1 surtout) ?
- L'entrée est-elle juste sous une résistance (pour un buy) ou juste au-dessus d'un support (pour un sell) ?
- Le SL est-il cohérent avec l'ATR et les niveaux (pas posé au milieu du bruit, pas absurde) ?
- Le RSI est-il en zone extrême contre le trade ? Le mouvement est-il déjà très étendu ?
- Le ratio gain/risque jusqu'au TP1 et au dernier TP.

Décision :
- APPROVE (risk_multiplier 1.0) : rien de bloquant.
- REDUCE (0.25 à 0.75) : signal jouable mais contexte mitigé.
- REJECT (0) : seulement si le contexte contredit clairement le signal (contre-tendance forte sur
  plusieurs timeframes ET niveau majeur juste devant, SL incohérent...). Le groupe est fiable :
  ne rejette pas par excès de prudence.
Réponds en français, de façon concise et concrète (cite les niveaux)."""


MARKET_SYSTEM = """Tu es un trader professionnel spécialisé sur l'or (XAUUSD).
On te donne le prix actuel et, pour M5/M15/H1/H4, des indicateurs calculés (EMA, RSI, ATR, structure,
points hauts/bas) plus les dernières bougies M15 en [open, high, low, close].
Fais une lecture claire et honnête du marché : biais, niveaux clés, scénario probable, ce qui l'invaliderait.
Pas de certitude inventée : si c'est un range sans direction, dis NEUTRAL. Réponds en français, cite les niveaux."""


class AI:
    def __init__(self, parser_model: str, analyst_model: str, analyst_effort: str):
        self.client = anthropic.AsyncAnthropic(max_retries=3, timeout=90)
        self.parser_model = parser_model
        self.analyst_model = analyst_model
        self.analyst_effort = analyst_effort

    async def _ask(self, model: str, system: str, user: str, schema: Type[T],
                   effort: Optional[str] = None, max_tokens: int = 4000) -> Optional[T]:
        kwargs: dict = {}
        betas: list[str] = []
        if model in _FALLBACK_MODELS:
            betas.append("server-side-fallback-2026-07-01")
            kwargs["fallbacks"] = "default"
        if effort:
            kwargs["output_config"] = {"effort": effort}
        if betas:
            kwargs["betas"] = betas
        resp = await self.client.beta.messages.parse(
            model=model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
            output_format=schema,
            **kwargs,
        )
        if resp.stop_reason == "refusal":
            log.warning("L'IA a refusé de répondre (%s)", getattr(resp.stop_details, "category", None))
            return None
        if resp.stop_reason == "max_tokens":
            log.warning("Réponse de l'IA coupée (max_tokens)")
            return None
        return resp.parsed_output

    async def parse_message(self, text: str, reply_to_text: Optional[str], open_trades: str) -> Optional[ParsedMessage]:
        user = (
            f"Message à analyser :\n<<<\n{text}\n>>>\n\n"
            f"Message auquel il répond : {reply_to_text!r}\n\n"
            f"Trades actuellement ouverts par le bot :\n{open_trades or 'aucun'}"
        )
        return await self._ask(self.parser_model, PARSER_SYSTEM, user, ParsedMessage, max_tokens=2000)

    async def analyze(self, signal: Signal, bid: float, ask: float, bars: dict[str, list[Bar]]) -> Optional[AnalystVerdict]:
        payload = {
            "signal": {
                "side": signal.side.value,
                "entry_zone": [signal.entry_low, signal.entry_high],
                "stop_loss": signal.stop_loss,
                "take_profits": signal.take_profits,
            },
            "price_now": {"bid": bid, "ask": ask},
            "timeframes": [summarize_timeframe(tf, b) for tf, b in bars.items()],
            "last_m15_candles_ohlc": compact_candles(bars.get("M15", []), 40),
        }
        user = "Données du marché au moment du signal :\n" + json.dumps(payload, ensure_ascii=False)
        return await self._ask(self.analyst_model, ANALYST_SYSTEM, user, AnalystVerdict,
                               effort=self.analyst_effort, max_tokens=16000)

    async def market_view(self, bid: float, ask: float, bars: dict[str, list[Bar]]) -> Optional[MarketView]:
        payload = {
            "price_now": {"bid": bid, "ask": ask},
            "timeframes": [summarize_timeframe(tf, b) for tf, b in bars.items()],
            "last_m15_candles_ohlc": compact_candles(bars.get("M15", []), 40),
        }
        user = "Données du marché maintenant :\n" + json.dumps(payload, ensure_ascii=False)
        return await self._ask(self.analyst_model, MARKET_SYSTEM, user, MarketView,
                               effort=self.analyst_effort, max_tokens=16000)

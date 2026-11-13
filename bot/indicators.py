"""Indicateurs techniques calculés en Python pur, envoyés à l'IA sous forme de chiffres.

Donner des chiffres exacts à l'IA est plus fiable que de lui faire "lire" une image.
"""
from __future__ import annotations

from typing import Optional

from .models import Bar


def ema(values: list[float], period: int) -> list[float]:
    if not values:
        return []
    k = 2 / (period + 1)
    out = [values[0]]
    for v in values[1:]:
        out.append(v * k + out[-1] * (1 - k))
    return out


def rsi(closes: list[float], period: int = 14) -> Optional[float]:
    if len(closes) <= period:
        return None
    gains, losses = 0.0, 0.0
    for i in range(1, period + 1):
        d = closes[i] - closes[i - 1]
        gains += max(d, 0)
        losses += max(-d, 0)
    avg_g, avg_l = gains / period, losses / period
    for i in range(period + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        avg_g = (avg_g * (period - 1) + max(d, 0)) / period
        avg_l = (avg_l * (period - 1) + max(-d, 0)) / period
    if avg_l == 0:
        return 100.0
    return 100 - 100 / (1 + avg_g / avg_l)


def atr(bars: list[Bar], period: int = 14) -> Optional[float]:
    if len(bars) <= period:
        return None
    trs = [
        max(b.high - b.low, abs(b.high - p.close), abs(b.low - p.close))
        for p, b in zip(bars, bars[1:])
    ]
    a = sum(trs[:period]) / period
    for tr in trs[period:]:
        a = (a * (period - 1) + tr) / period
    return a


def swings(bars: list[Bar], left: int = 3, right: int = 3) -> tuple[list[float], list[float]]:
    """Points hauts et bas (fractales) : les niveaux que le marché a respectés."""
    highs, lows = [], []
    for i in range(left, len(bars) - right):
        window = bars[i - left: i + right + 1]
        if bars[i].high == max(b.high for b in window):
            highs.append(bars[i].high)
        if bars[i].low == min(b.low for b in window):
            lows.append(bars[i].low)
    return highs, lows


def structure(highs: list[float], lows: list[float]) -> str:
    if len(highs) < 2 or len(lows) < 2:
        return "indéterminée"
    hh, hl = highs[-1] > highs[-2], lows[-1] > lows[-2]
    if hh and hl:
        return "haussière (plus hauts et plus bas croissants)"
    if not hh and not hl:
        return "baissière (plus hauts et plus bas décroissants)"
    return "en range / transition"


def summarize_timeframe(name: str, bars: list[Bar]) -> dict:
    if len(bars) < 30:
        return {"timeframe": name, "error": "pas assez de bougies"}
    closes = [b.close for b in bars]
    e20, e50, e200 = ema(closes, 20)[-1], ema(closes, 50)[-1], ema(closes, 200)[-1]
    highs, lows = swings(bars)
    last = closes[-1]
    return {
        "timeframe": name,
        "last_close": round(last, 2),
        "ema20": round(e20, 2),
        "ema50": round(e50, 2),
        "ema200": round(e200, 2) if len(bars) >= 200 else None,
        "price_vs_ema": ("au-dessus" if last > e50 else "en dessous") + " de l'EMA50",
        "rsi14": round(rsi(closes) or 0, 1),
        "atr14": round(atr(bars) or 0, 2),
        "structure": structure(highs, lows),
        "recent_swing_highs": [round(h, 2) for h in highs[-4:]],
        "recent_swing_lows": [round(l, 2) for l in lows[-4:]],
        "range_high_50": round(max(b.high for b in bars[-50:]), 2),
        "range_low_50": round(min(b.low for b in bars[-50:]), 2),
    }


def compact_candles(bars: list[Bar], n: int = 40) -> list[list[float]]:
    """Dernières bougies en [open, high, low, close] pour que l'IA voie la forme du mouvement."""
    return [[round(b.open, 2), round(b.high, 2), round(b.low, 2), round(b.close, 2)] for b in bars[-n:]]

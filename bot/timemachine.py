"""« Time Machine » pour l'or, adaptée du skill day-trader-skill (trader-timemachine).

Pour un signal (entrée, SL, TP1) à l'heure t : rejoue N fois les prochaines heures en tirant au hasard des
bougies M5 PASSÉES (même moment de la journée ± 2 bougies, 20 derniers jours), mises à l'échelle du prix
actuel. Bougie par bougie : SL d'abord, puis TP (une bougie qui touche les deux compte comme SL).
Donne la part des rejeux qui touchent le TP1 avant le SL, et l'« avance » sur le seuil de rentabilité
1 / (1 + R). Aucune donnée future n'est utilisée.
"""
from __future__ import annotations

import random
from bisect import bisect_left
from datetime import datetime, timedelta

SLOTS = 288  # bougies M5 par jour


def _slot(t: datetime) -> int:
    return (t.hour * 60 + t.minute) // 5


class TimeMachine:
    def __init__(self, m5_bars, lookback_days: int = 20, window: int = 2):
        self.times = [b.time for b in m5_bars]
        self.ratios = []
        for i, b in enumerate(m5_bars):
            pc = m5_bars[i - 1].close if i else b.open
            self.ratios.append((b.high / pc, b.low / pc, b.close / pc))
        self.slots = [_slot(t) for t in self.times]
        self.lookback = timedelta(days=lookback_days)
        self.window = window

    def odds(self, t: datetime, side: str, entry: float, sl: float, tp: float,
             n: int = 2000, horizon: int = 96, seed: int = 19) -> dict | None:
        lo, hi = bisect_left(self.times, t - self.lookback), bisect_left(self.times, t)
        pools: dict[int, list] = {}
        for i in range(lo + 1, hi):
            pools.setdefault(self.slots[i], []).append(self.ratios[i])
        if hi - lo < 288 * 2:  # moins de 2 jours d'historique : pas fiable
            return None
        start = _slot(t)
        steps = []
        for k in range(horizon):
            s = (start + k) % SLOTS
            pool = [r for d in range(-self.window, self.window + 1) for r in pools.get((s + d) % SLOTS, [])]
            if pool:
                steps.append(pool)
        if not steps:
            return None
        rng = random.Random(seed)
        buy = side == "BUY"
        win = loss = 0
        for _ in range(n):
            px = entry
            for pool in steps:
                h, l, c = rng.choice(pool)
                hi_, lo_ = px * h, px * l
                if (lo_ <= sl) if buy else (hi_ >= sl):
                    loss += 1
                    break
                if (hi_ >= tp) if buy else (lo_ <= tp):
                    win += 1
                    break
                px *= c
        hit = win + loss
        r = abs(tp - entry) / abs(entry - sl) if entry != sl else 0
        p = win / hit if hit else 0.5
        return {"p": round(p, 3), "edge": round(p - 1 / (1 + r), 3) if r else 0.0,
                "neither": round(1 - hit / n, 3)}

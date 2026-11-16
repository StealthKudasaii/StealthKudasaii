"""Moteur de risque : des règles fixes, en code, que l'IA ne peut pas contourner.

Tout ici est pur (pas de réseau) pour être testable.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, time, timedelta
from typing import Callable, Optional

from .broker import round_volume
from .config import ManagementCfg, RiskCfg
from .models import Side, Signal, SymbolSpec


class Rejected(Exception):
    """Le signal ne passe pas les règles. Le message dit pourquoi, en clair."""


@dataclass
class Leg:
    volume: float
    tp: float


@dataclass
class TradePlan:
    side: Side
    order_type: str            # "market" ou "limit"
    entry: float               # prix d'exécution attendu
    sl: float
    legs: list[Leg]
    risk_money: float
    notes: list[str] = field(default_factory=list)

    @property
    def total_volume(self) -> float:
        return round(sum(l.volume for l in self.legs), 8)


@dataclass
class AccountState:
    bid: float
    ask: float
    balance: float
    server_time: datetime
    realized_today: float          # P&L réalisé aujourd'hui par le bot (négatif = perte)
    open_risk_money: float         # ce qu'on perdrait si tous les SL ouverts étaient touchés
    open_signals: int
    trades_today: int
    recent_signals: list[tuple[datetime, Side]] = field(default_factory=list)


def normalize_tps(signal: Signal, entry: float, mgmt: ManagementCfg) -> list[float]:
    """TP du bon côté, du plus proche au plus lointain. Sans TP : multiples du risque."""
    if signal.side == Side.BUY:
        tps = sorted(tp for tp in signal.take_profits if tp > entry)
    else:
        tps = sorted((tp for tp in signal.take_profits if tp < entry), reverse=True)
    if tps:
        return tps[:mgmt.max_tps] if mgmt.max_tps > 0 else tps
    r = abs(entry - signal.stop_loss)
    sign = 1 if signal.side == Side.BUY else -1
    return [round(entry + sign * r * m, 2) for m in mgmt.default_tp_r]


def in_no_trade_window(now: datetime, windows: list[tuple[str, str]]) -> bool:
    t = now.time()
    for start_s, end_s in windows:
        start, end = time.fromisoformat(start_s), time.fromisoformat(end_s)
        if start <= end:
            if start <= t < end:
                return True
        elif t >= start or t < end:  # fenêtre qui passe minuit
            return True
    return False


def split_volume(total: float, n_tps: int, weights: list[float], spec: SymbolSpec) -> list[float]:
    """Répartit le lot total entre les TP. Chaque part >= lot minimum, sinon on regroupe."""
    w = list(weights[:n_tps])
    while len(w) < n_tps:
        w.append(w[-1] if w else 1.0)
    s = sum(w)
    w = [x / s for x in w]
    # On travaille en "pas" de lot (0.01) pour éviter les erreurs d'arrondi.
    units = int(round(round_volume(total, spec) / spec.volume_step))
    min_units = max(1, int(round(spec.volume_min / spec.volume_step)))
    k = max(1, min(n_tps, units // min_units))  # pas assez de volume : on garde les TP les plus proches
    w = [x / sum(w[:k]) for x in w[:k]]
    parts = [min_units] * k
    for _ in range(units - min_units * k):  # le reste va, pas à pas, à la part la plus en retard sur son poids
        i = max(range(k), key=lambda j: (w[j] * units - parts[j], -j))
        parts[i] += 1
    return [round(p * spec.volume_step, 8) for p in parts]


def plan_trade(
    signal: Signal,
    state: AccountState,
    spec: SymbolSpec,
    loss_per_lot: Callable[[Side, float, float], float],
    risk: RiskCfg,
    mgmt: ManagementCfg,
    risk_multiplier: float = 1.0,
) -> TradePlan:
    side = signal.side
    sl = signal.stop_loss
    notes: list[str] = []

    # 1. SL obligatoire et du bon côté
    if not sl:
        raise Rejected("pas de stop loss dans le signal")
    if (side == Side.BUY and sl >= signal.entry_low) or (side == Side.SELL and sl <= signal.entry_high):
        raise Rejected(f"SL {sl} du mauvais côté de l'entrée")

    # 2. Horaires et spread
    if in_no_trade_window(state.server_time, risk.no_trade_windows):
        raise Rejected(f"heure interdite ({state.server_time:%H:%M} serveur)")
    spread = state.ask - state.bid
    if spread > risk.max_spread:
        raise Rejected(f"spread trop large ({spread:.2f} $ > {risk.max_spread} $)")

    # 3. Doublon (le même signal repris ou édité)
    window = timedelta(minutes=risk.duplicate_window_minutes)
    if any(s == side and state.server_time - t < window for t, s in state.recent_signals):
        raise Rejected("doublon : un signal dans le même sens vient déjà d'être pris")

    # 4. Limites du jour
    if state.open_signals >= risk.max_open_signals:
        raise Rejected(f"déjà {state.open_signals} signaux ouverts (max {risk.max_open_signals})")
    if state.trades_today >= risk.max_trades_per_day:
        raise Rejected(f"déjà {state.trades_today} trades aujourd'hui (max {risk.max_trades_per_day})")

    # 5. Où en est le prix par rapport au signal ?
    market = state.ask if side == Side.BUY else state.bid
    sign = 1 if side == Side.BUY else -1
    if (market - sl) * sign <= 0:
        raise Rejected(f"le prix ({market}) a déjà dépassé le SL")
    drift = (market - signal.entry_ref) * sign  # > 0 = prix moins bon que le signal
    raw_tps = normalize_tps(signal, signal.entry_ref, mgmt)
    ref_risk = abs(signal.entry_ref - sl)
    if signal.take_profits and risk.max_tp1_r > 0 and ref_risk > 0:
        tp1_r = abs(raw_tps[0] - signal.entry_ref) / ref_risk
        if tp1_r > risk.max_tp1_r:
            raise Rejected(f"TP1 suspect ({raw_tps[0]}, soit {tp1_r:.1f}R pour un SL à {ref_risk:.2f} $) : "
                           f"faute de frappe probable, signal non pris")
    if (market - raw_tps[0]) * sign >= 0:
        raise Rejected(f"trop tard : le prix ({market}) a déjà atteint le TP1 ({raw_tps[0]})")

    if drift <= risk.max_entry_drift:
        order_type, entry = "market", market
        if drift > 0:
            notes.append(f"entrée {drift:.2f} $ moins bonne que le signal")
    elif risk.far_entry_action == "limit":
        order_type, entry = "limit", signal.entry_ref
        notes.append(f"prix trop loin ({drift:.2f} $) : ordre limite à {entry}")
    else:
        raise Rejected(f"prix trop loin de l'entrée ({drift:.2f} $ > {risk.max_entry_drift} $)")

    # 6. Distance du SL raisonnable
    dist = abs(entry - sl)
    if dist < risk.min_sl_distance:
        raise Rejected(f"SL trop serré ({dist:.2f} $ < {risk.min_sl_distance} $)")
    if dist > risk.max_sl_distance:
        raise Rejected(f"SL trop large ({dist:.2f} $ > {risk.max_sl_distance} $)")

    tps = normalize_tps(signal, entry, mgmt)

    # 7. Combien risquer
    risk_multiplier = max(0.0, min(1.0, risk_multiplier))
    daily_limit = state.balance * risk.max_daily_loss_pct / 100
    used = max(0.0, -state.realized_today) + state.open_risk_money
    remaining = daily_limit - used
    per_lot = loss_per_lot(side, entry, sl)
    if per_lot <= 0:
        raise Rejected("calcul de la perte par lot impossible")

    if risk.fixed_lot > 0:
        # 8a. Lot fixe choisi par l'utilisateur : même taille à chaque trade, l'IA peut seulement refuser.
        if risk_multiplier <= 0:
            raise Rejected("risque nul (multiplicateur 0)")
        if daily_limit > 0 and remaining <= 0:
            raise Rejected(f"limite de perte du jour atteinte ({used:.2f} / {daily_limit:.2f})")
        total = max(spec.volume_min, round_volume(risk.fixed_lot, spec))
        trade_risk = total * per_lot
        notes.append(f"lot fixe {total} : {trade_risk:.2f} perdus si SL touché "
                     f"({100 * trade_risk / state.balance:.1f} % du solde)")
    else:
        # 8b. Taille calculée pour risquer risk_per_trade_pct du solde
        normal_risk = state.balance * risk.risk_per_trade_pct / 100
        wanted = normal_risk * risk_multiplier
        if daily_limit <= 0:  # max_daily_loss_pct = 0 : pas de limite du jour
            remaining = wanted
        elif remaining < 0.25 * normal_risk:
            raise Rejected(f"limite de perte du jour atteinte ({used:.2f} / {daily_limit:.2f})")
        risk_money = min(wanted, remaining)
        if risk_money < wanted:
            notes.append(f"taille réduite pour rester sous la limite du jour ({remaining:.2f} restants)")
        if risk_money <= 0:
            raise Rejected("risque nul (multiplicateur 0)")
        total = round_volume(risk_money / per_lot, spec)
        if total < spec.volume_min:
            raise Rejected(
                f"compte trop petit : le lot minimum ({spec.volume_min}) risquerait "
                f"{spec.volume_min * per_lot:.2f} au lieu de {risk_money:.2f}"
            )

    parts = split_volume(total, len(tps), mgmt.tp_split, spec)
    legs = [Leg(v, tp) for v, tp in zip(parts, tps)]
    if len(legs) < len(tps):
        notes.append(f"lot trop petit pour {len(tps)} TP : {len(legs)} part(s) seulement")

    actual_risk = sum(l.volume for l in legs) * per_lot
    return TradePlan(side, order_type, round(entry, spec.digits), sl, legs, round(actual_risk, 2), notes)


def protective_sl(
    side: Side,
    open_price: float,
    tps: list[float],
    tps_reached: int,
    current_sl: float,
    mgmt: ManagementCfg,
) -> Optional[float]:
    """Nouveau SL après qu'un ou plusieurs TP ont été atteints, ou None si rien à changer.

    - TP{breakeven_after_tp} atteint -> SL à l'entrée (+ petite marge)
    - avec trail_to_previous_tp : TP2 atteint -> SL sur TP1, TP3 -> SL sur TP2...
    Le SL ne recule jamais.
    """
    if tps_reached < mgmt.breakeven_after_tp or tps_reached <= 0:
        return None
    sign = 1 if side == Side.BUY else -1
    target = open_price + sign * mgmt.breakeven_buffer
    if mgmt.trail_to_previous_tp and tps_reached >= 2:
        target = tps[min(tps_reached, len(tps)) - 2]
    target = round(target, 2)
    if current_sl and (target - current_sl) * sign <= 0.009:
        return None  # le SL actuel protège déjà autant ou plus
    return target

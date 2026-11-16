"""Accès au broker.

- `MT5Broker`   : le vrai MetaTrader 5 (Windows uniquement, lib officielle MetaTrader5).
- `PaperBroker` : un broker simulé en mémoire, pour les tests et pour essayer sans MT5.

Le reste du bot ne parle qu'à l'interface `Broker`, jamais directement à MT5.
"""
from __future__ import annotations

import logging
import math
import threading
from datetime import datetime, timedelta, timezone
from typing import Optional, Protocol

from .models import Bar, OrderResult, PendingOrder, Position, Side, SymbolSpec

log = logging.getLogger(__name__)

TIMEFRAMES = ("M5", "M15", "H1", "H4")


class Broker(Protocol):
    def spec(self) -> SymbolSpec: ...
    def tick(self) -> tuple[float, float]: ...  # (bid, ask)
    def balance(self) -> float: ...
    def server_time(self) -> datetime: ...
    def loss_per_lot(self, side: Side, entry: float, sl: float) -> float: ...
    def rates(self, timeframe: str, count: int) -> list[Bar]: ...
    def market_order(self, side: Side, volume: float, sl: float, tp: float, comment: str) -> OrderResult: ...
    def limit_order(self, side: Side, price: float, volume: float, sl: float, tp: float,
                    comment: str, expiry_minutes: int) -> OrderResult: ...
    def positions(self) -> list[Position]: ...
    def pending_orders(self) -> list[PendingOrder]: ...
    def modify_position(self, ticket: int, sl: float, tp: float) -> OrderResult: ...
    def modify_order(self, ticket: int, price: float, sl: float, tp: float) -> OrderResult: ...
    def close_position(self, ticket: int, volume: Optional[float] = None) -> OrderResult: ...
    def cancel_order(self, ticket: int) -> OrderResult: ...
    def realized_pnl_since(self, since: datetime) -> float: ...
    def signal_pnl(self, comment_prefix: str, since: datetime) -> float: ...


def round_volume(volume: float, spec: SymbolSpec) -> float:
    """Arrondit un lot VERS LE BAS au pas du broker (on ne risque jamais plus que prévu)."""
    steps = math.floor(volume / spec.volume_step + 1e-9)
    v = round(steps * spec.volume_step, 8)
    return min(v, spec.volume_max)


# ---------------------------------------------------------------------------
# MetaTrader 5
# ---------------------------------------------------------------------------
class MT5Broker:
    """Wrapper autour de la lib officielle `MetaTrader5` (pip install MetaTrader5)."""

    def __init__(self, symbol: str, magic: int, deviation: int, dry_run: bool,
                 login: str = "", password: str = "", server: str = "", path: str = ""):
        import MetaTrader5 as mt5  # import ici : la lib n'existe que sous Windows

        self.mt5 = mt5
        self.symbol = symbol
        self.magic = magic
        self.deviation = deviation
        self.dry_run = dry_run
        self._lock = threading.Lock()  # la lib MT5 n'est pas thread-safe

        kwargs = {}
        if path:
            kwargs["path"] = path
        if login:
            kwargs.update(login=int(login), password=password, server=server)
        if not mt5.initialize(**kwargs):
            raise SystemExit(f"Impossible de se connecter à MT5 : {mt5.last_error()}")
        if not mt5.symbol_select(symbol, True):
            raise SystemExit(f"Symbole introuvable chez ce broker : {symbol}. Vérifie mt5.symbol dans config.yaml")
        acc = mt5.account_info()
        mode = {0: "DÉMO", 1: "CONCOURS", 2: "RÉEL"}.get(acc.trade_mode, "?")
        log.info("MT5 connecté : compte %s (%s), solde %.2f %s", acc.login, mode, acc.balance, acc.currency)
        self.account_mode = mode

    # -- lecture -------------------------------------------------------------
    def spec(self) -> SymbolSpec:
        with self._lock:
            s = self.mt5.symbol_info(self.symbol)
        return SymbolSpec(s.volume_min, s.volume_max, s.volume_step, s.digits, s.point, s.trade_stops_level)

    def tick(self) -> tuple[float, float]:
        with self._lock:
            t = self.mt5.symbol_info_tick(self.symbol)
        return t.bid, t.ask

    def balance(self) -> float:
        with self._lock:
            return self.mt5.account_info().balance

    def server_time(self) -> datetime:
        with self._lock:
            t = self.mt5.symbol_info_tick(self.symbol)
        # MT5 renvoie l'heure du serveur sous forme de timestamp "naïf"
        return datetime.fromtimestamp(t.time, tz=timezone.utc).replace(tzinfo=None)

    def loss_per_lot(self, side: Side, entry: float, sl: float) -> float:
        order_type = self.mt5.ORDER_TYPE_BUY if side == Side.BUY else self.mt5.ORDER_TYPE_SELL
        with self._lock:
            pnl = self.mt5.order_calc_profit(order_type, self.symbol, 1.0, entry, sl)
        if pnl is None:
            raise RuntimeError(f"order_calc_profit a échoué : {self.mt5.last_error()}")
        return abs(pnl)

    def rates(self, timeframe: str, count: int) -> list[Bar]:
        tf = getattr(self.mt5, f"TIMEFRAME_{timeframe}")
        with self._lock:
            raw = self.mt5.copy_rates_from_pos(self.symbol, tf, 0, count)
        if raw is None:
            return []
        return [
            Bar(datetime.fromtimestamp(int(r["time"]), tz=timezone.utc).replace(tzinfo=None),
                float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"]), float(r["tick_volume"]))
            for r in raw
        ]

    def positions(self) -> list[Position]:
        with self._lock:
            raw = self.mt5.positions_get(symbol=self.symbol) or ()
        return [
            Position(p.ticket, Side.BUY if p.type == self.mt5.POSITION_TYPE_BUY else Side.SELL,
                     p.volume, p.price_open, p.sl, p.tp, p.comment, p.profit)
            for p in raw if p.magic == self.magic
        ]

    def pending_orders(self) -> list[PendingOrder]:
        with self._lock:
            raw = self.mt5.orders_get(symbol=self.symbol) or ()
        buy_types = {self.mt5.ORDER_TYPE_BUY_LIMIT, self.mt5.ORDER_TYPE_BUY_STOP}
        return [
            PendingOrder(o.ticket, Side.BUY if o.type in buy_types else Side.SELL,
                         o.volume_current, o.price_open, o.sl, o.tp, o.comment)
            for o in raw if o.magic == self.magic
        ]

    def realized_pnl_since(self, since: datetime) -> float:
        with self._lock:
            deals = self.mt5.history_deals_get(since, datetime.now() + timedelta(days=1)) or ()
        return sum(d.profit + d.commission + d.swap + getattr(d, "fee", 0.0)
                   for d in deals if d.magic == self.magic and d.symbol == self.symbol)

    def signal_pnl(self, comment_prefix: str, since: datetime) -> float:
        """P&L réalisé d'un signal : toutes les positions dont l'ordre d'ouverture porte son commentaire."""
        with self._lock:
            deals = self.mt5.history_deals_get(since, datetime.now() + timedelta(days=1)) or ()
        mine = [d for d in deals if d.magic == self.magic and d.symbol == self.symbol]
        positions = {d.position_id for d in mine if d.comment.startswith(comment_prefix)}
        return sum(d.profit + d.commission + d.swap + getattr(d, "fee", 0.0)
                   for d in mine if d.position_id in positions)

    # -- écriture ------------------------------------------------------------
    def _filling(self) -> int:
        with self._lock:
            mode = self.mt5.symbol_info(self.symbol).filling_mode
        if mode & 1:
            return self.mt5.ORDER_FILLING_FOK
        if mode & 2:
            return self.mt5.ORDER_FILLING_IOC
        return self.mt5.ORDER_FILLING_RETURN

    def _send(self, request: dict) -> OrderResult:
        if self.dry_run:
            log.info("[DRY RUN] ordre NON envoyé : %s", request)
            return OrderResult(True, 0, request.get("price", 0.0), "dry run")
        with self._lock:
            res = self.mt5.order_send(request)
        if res is None:
            return OrderResult(False, message=f"order_send a renvoyé None : {self.mt5.last_error()}")
        ok = res.retcode in (self.mt5.TRADE_RETCODE_DONE, self.mt5.TRADE_RETCODE_PLACED,
                             self.mt5.TRADE_RETCODE_DONE_PARTIAL)
        return OrderResult(ok, res.order or res.deal, res.price, f"{res.retcode} {res.comment}")

    def market_order(self, side: Side, volume: float, sl: float, tp: float, comment: str) -> OrderResult:
        bid, ask = self.tick()
        return self._send({
            "action": self.mt5.TRADE_ACTION_DEAL, "symbol": self.symbol, "volume": volume,
            "type": self.mt5.ORDER_TYPE_BUY if side == Side.BUY else self.mt5.ORDER_TYPE_SELL,
            "price": ask if side == Side.BUY else bid, "sl": sl, "tp": tp,
            "deviation": self.deviation, "magic": self.magic, "comment": comment[:31],
            "type_time": self.mt5.ORDER_TIME_GTC, "type_filling": self._filling(),
        })

    def limit_order(self, side: Side, price: float, volume: float, sl: float, tp: float,
                    comment: str, expiry_minutes: int) -> OrderResult:
        expiration = int((self.server_time() + timedelta(minutes=expiry_minutes))
                         .replace(tzinfo=timezone.utc).timestamp())
        return self._send({
            "action": self.mt5.TRADE_ACTION_PENDING, "symbol": self.symbol, "volume": volume,
            "type": self.mt5.ORDER_TYPE_BUY_LIMIT if side == Side.BUY else self.mt5.ORDER_TYPE_SELL_LIMIT,
            "price": price, "sl": sl, "tp": tp, "magic": self.magic, "comment": comment[:31],
            "type_time": self.mt5.ORDER_TIME_SPECIFIED, "expiration": expiration,
            "type_filling": self.mt5.ORDER_FILLING_RETURN,
        })

    def modify_position(self, ticket: int, sl: float, tp: float) -> OrderResult:
        return self._send({"action": self.mt5.TRADE_ACTION_SLTP, "symbol": self.symbol,
                           "position": ticket, "sl": sl, "tp": tp, "magic": self.magic})

    def modify_order(self, ticket: int, price: float, sl: float, tp: float) -> OrderResult:
        return self._send({"action": self.mt5.TRADE_ACTION_MODIFY, "order": ticket,
                           "price": price, "sl": sl, "tp": tp})

    def close_position(self, ticket: int, volume: Optional[float] = None) -> OrderResult:
        pos = next((p for p in self.positions() if p.ticket == ticket), None)
        if pos is None:
            return OrderResult(False, message=f"position {ticket} introuvable")
        bid, ask = self.tick()
        return self._send({
            "action": self.mt5.TRADE_ACTION_DEAL, "symbol": self.symbol, "position": ticket,
            "volume": volume or pos.volume,
            "type": self.mt5.ORDER_TYPE_SELL if pos.side == Side.BUY else self.mt5.ORDER_TYPE_BUY,
            "price": bid if pos.side == Side.BUY else ask, "deviation": self.deviation,
            "magic": self.magic, "comment": "close", "type_filling": self._filling(),
        })

    def cancel_order(self, ticket: int) -> OrderResult:
        return self._send({"action": self.mt5.TRADE_ACTION_REMOVE, "order": ticket})


# ---------------------------------------------------------------------------
# Broker simulé
# ---------------------------------------------------------------------------
class PaperBroker:
    """Broker en mémoire. L'or : 1 lot = 100 onces, donc 1 $ de mouvement = 100 $ par lot."""

    def __init__(self, bid: float = 2350.0, spread: float = 0.25, balance: float = 10_000.0,
                 contract_size: float = 100.0):
        self.bid = bid
        self.spread = spread
        self._balance = balance
        self.contract_size = contract_size
        self._positions: dict[int, Position] = {}
        self._orders: dict[int, PendingOrder] = {}
        self._next = 1000
        self.realized: list[tuple[datetime, float, str]] = []
        self.now = datetime(2026, 11, 13, 12, 0)
        self.bars: dict[str, list[Bar]] = {}

    # -- simulation --------------------------------------------------------
    def set_price(self, bid: float) -> None:
        """Bouge le prix et déclenche SL/TP/limites comme le ferait le broker."""
        self.bid = bid
        ask = bid + self.spread
        for o in list(self._orders.values()):
            if (o.side == Side.BUY and ask <= o.price) or (o.side == Side.SELL and bid >= o.price):
                del self._orders[o.ticket]
                self._positions[o.ticket] = Position(o.ticket, o.side, o.volume, o.price, o.sl, o.tp, o.comment)
        for p in list(self._positions.values()):
            if p.side == Side.BUY:
                if p.sl and bid <= p.sl:
                    self._close(p, p.sl)
                elif p.tp and bid >= p.tp:
                    self._close(p, p.tp)
            else:
                if p.sl and ask >= p.sl:
                    self._close(p, p.sl)
                elif p.tp and ask <= p.tp:
                    self._close(p, p.tp)

    def _close(self, p: Position, price: float, volume: Optional[float] = None) -> float:
        vol = volume or p.volume
        sign = 1 if p.side == Side.BUY else -1
        pnl = (price - p.open_price) * sign * vol * self.contract_size
        self._balance += pnl
        self.realized.append((self.now, pnl, p.comment))
        if vol >= p.volume - 1e-9:
            del self._positions[p.ticket]
        else:
            p.volume = round(p.volume - vol, 8)
        return pnl

    def _ticket(self) -> int:
        self._next += 1
        return self._next

    # -- interface Broker ----------------------------------------------------
    def spec(self) -> SymbolSpec:
        return SymbolSpec(0.01, 100.0, 0.01, 2, 0.01)

    def tick(self) -> tuple[float, float]:
        return self.bid, round(self.bid + self.spread, 2)

    def balance(self) -> float:
        return self._balance

    def server_time(self) -> datetime:
        return self.now

    def loss_per_lot(self, side: Side, entry: float, sl: float) -> float:
        return abs(entry - sl) * self.contract_size

    def rates(self, timeframe: str, count: int) -> list[Bar]:
        return self.bars.get(timeframe, [])[-count:]

    def market_order(self, side: Side, volume: float, sl: float, tp: float, comment: str) -> OrderResult:
        bid, ask = self.tick()
        price = ask if side == Side.BUY else bid
        t = self._ticket()
        self._positions[t] = Position(t, side, volume, price, sl, tp, comment[:31])
        return OrderResult(True, t, price, "filled")

    def limit_order(self, side: Side, price: float, volume: float, sl: float, tp: float,
                    comment: str, expiry_minutes: int) -> OrderResult:
        t = self._ticket()
        self._orders[t] = PendingOrder(t, side, volume, price, sl, tp, comment[:31])
        return OrderResult(True, t, price, "placed")

    def positions(self) -> list[Position]:
        for p in self._positions.values():  # P&L flottant au prix actuel
            exit_price = self.bid if p.side == Side.BUY else self.bid + self.spread
            sign = 1 if p.side == Side.BUY else -1
            p.profit = round((exit_price - p.open_price) * sign * p.volume * self.contract_size, 2)
        return list(self._positions.values())

    def pending_orders(self) -> list[PendingOrder]:
        return list(self._orders.values())

    def modify_position(self, ticket: int, sl: float, tp: float) -> OrderResult:
        p = self._positions.get(ticket)
        if not p:
            return OrderResult(False, message="introuvable")
        p.sl, p.tp = sl, tp
        return OrderResult(True, ticket)

    def modify_order(self, ticket: int, price: float, sl: float, tp: float) -> OrderResult:
        o = self._orders.get(ticket)
        if not o:
            return OrderResult(False, message="introuvable")
        o.price, o.sl, o.tp = price, sl, tp
        return OrderResult(True, ticket)

    def close_position(self, ticket: int, volume: Optional[float] = None) -> OrderResult:
        p = self._positions.get(ticket)
        if not p:
            return OrderResult(False, message="introuvable")
        price = self.bid if p.side == Side.BUY else self.bid + self.spread
        self._close(p, price, volume)
        return OrderResult(True, ticket, price)

    def cancel_order(self, ticket: int) -> OrderResult:
        return OrderResult(self._orders.pop(ticket, None) is not None, ticket)

    def realized_pnl_since(self, since: datetime) -> float:
        return sum(pnl for t, pnl, _ in self.realized if t >= since)

    def signal_pnl(self, comment_prefix: str, since: datetime) -> float:
        return sum(pnl for t, pnl, c in self.realized if t >= since and c.startswith(comment_prefix))

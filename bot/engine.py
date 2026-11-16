"""Le cerveau : reçoit un message, décide, exécute, puis gère les positions (BE, trailing)."""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import asdict
from datetime import datetime, timedelta
from typing import Awaitable, Callable, Optional

from .broker import TIMEFRAMES, Broker, round_volume
from .config import Config
from .models import Action, AnalystVerdict, Decision, ParsedMessage, Position, Side, Signal
from .risk import AccountState, Rejected, plan_trade, protective_sl
from .store import Store, row_side, row_tps

log = logging.getLogger(__name__)
Notify = Callable[[str], Awaitable[None]]
# Écouteur d'événements (Discord...) : reçoit (type, données). Voir Engine.emit pour la liste des types.
Listener = Callable[[str, dict], Awaitable[None]]
# Validation manuelle d'un signal : reçoit la demande, renvoie un multiplicateur de risque
# (1 = prendre, 0.5 = moitié, 0 = refuser) ou None (= laisser la décision automatique).
Approver = Callable[[dict], Awaitable[Optional[float]]]


def leg_comment(sid: int, n: int) -> str:
    return f"GB{sid}T{n}"


def leg_index(comment: str, sid: int) -> Optional[int]:
    prefix = f"GB{sid}T"
    if comment.startswith(prefix) and comment[len(prefix):].isdigit():
        return int(comment[len(prefix):])
    return None


def message_filter(tg, fwd_name: Optional[str]) -> tuple[bool, bool]:
    """(signal autorisé, consignes autorisées) selon telegram.forwarded_from."""
    if not tg.forwarded_from:
        return True, True
    if fwd_name and any(s.lower() in fwd_name.lower() for s in tg.forwarded_from):
        return True, True
    return tg.main_signals, tg.commands_from_everyone


def main_sl_limit(tg, fwd_name: Optional[str]) -> Optional[float]:
    """SL max (en $) pour un signal du groupe principal (pas transféré depuis forwarded_from), sinon None."""
    if not tg.forwarded_from or not tg.main_signals or tg.main_max_sl <= 0:
        return None
    if fwd_name and any(s.lower() in fwd_name.lower() for s in tg.forwarded_from):
        return None
    return tg.main_max_sl


class Engine:
    def __init__(self, cfg: Config, broker: Broker, store: Store, ai=None, notify: Optional[Notify] = None):
        self.cfg = cfg
        self.broker = broker
        self.store = store
        self.ai = ai
        self._notify = notify
        self.paused = False
        self.skip_next = 0  # "ne prenez pas le prochain trade" : nb de signaux à sauter
        self._lock = asyncio.Lock()  # un seul ordre/une seule modif à la fois
        self.listeners: list[Listener] = []
        self.approver: Optional[Approver] = None
        self.notify_enabled = True  # False = plus de notifs texte Telegram (Discord prend le relais)
        self._events: list[tuple[str, dict]] = []

    # ------------------------------------------------------------ événements
    def emit(self, kind: str, **data) -> None:
        """Met un événement en file (appelable depuis un thread). Types :
        message, signal_ignored, signal_rejected, trade_opened, trade_failed, tp_hit, sl_moved,
        tp_changed, partial_close, trade_closed, paused, resumed, skip_next, settings, alert."""
        self._events.append((kind, data))

    async def flush_events(self) -> None:
        while self._events:
            kind, data = self._events.pop(0)
            for listener in list(self.listeners):
                try:
                    await listener(kind, data)
                except Exception:
                    log.exception("écouteur d'événement en erreur (%s)", kind)

    async def set_paused(self, paused: bool, by: str = "") -> None:
        self.paused = paused
        self.emit("paused" if paused else "resumed", by=by)
        await self.notify(("⏸ Pause : plus de nouveaux trades." if paused else "▶️ Le bot reprend les signaux.")
                          + (f" ({by})" if by else ""))

    async def notify(self, text: str) -> None:
        await self.flush_events()
        log.info("NOTIF: %s", text.replace("\n", " | "))
        if not self.notify_enabled:
            return
        if self._notify:
            try:
                await self._notify(text)
            except Exception:  # une notif ratée ne doit jamais casser le trading
                log.exception("notification impossible")

    async def call(self, fn, *args):
        """Les appels MT5 sont bloquants : on les fait dans un thread."""
        return await asyncio.to_thread(fn, *args)

    # ------------------------------------------------------------------ état
    def day_start(self) -> datetime:
        return self.broker.server_time().replace(hour=0, minute=0, second=0, microsecond=0)

    def legs(self, sid: int) -> tuple[list[tuple[int, Position]], list]:
        pos = [(i, p) for p in self.broker.positions() if (i := leg_index(p.comment, sid)) is not None]
        orders = [(i, o) for o in self.broker.pending_orders() if (i := leg_index(o.comment, sid)) is not None]
        return sorted(pos, key=lambda x: x[0]), sorted(orders, key=lambda x: x[0])

    def open_risk_money(self) -> float:
        total = 0.0
        items = [(p.side, p.open_price, p.sl, p.volume) for p in self.broker.positions()]
        items += [(o.side, o.price, o.sl, o.volume) for o in self.broker.pending_orders()]
        for side, price, sl, vol in items:
            sign = 1 if side == Side.BUY else -1
            if sl and (price - sl) * sign > 0:
                total += self.broker.loss_per_lot(side, price, sl) * vol
        return total

    def account_state(self) -> AccountState:
        bid, ask = self.broker.tick()
        start = self.day_start()
        executed = self.store.executed_since(start)
        recent = [(datetime.fromisoformat(r["server_time"]), Side(r["side"])) for r in executed]
        return AccountState(
            bid=bid, ask=ask, balance=self.broker.balance(), server_time=self.broker.server_time(),
            realized_today=self.broker.realized_pnl_since(start),
            open_risk_money=self.open_risk_money(),
            open_signals=len(self.store.open_signals()),
            trades_today=len(executed),
            recent_signals=recent,
        )

    def open_trades_summary(self) -> str:
        lines = []
        for r in self.store.open_signals():
            lines.append(f"#{r['id']} {r['side']} entrée {r['entry']} SL {r['sl']} TP {row_tps(r)} "
                         f"(message {r['msg_id']})")
        return "\n".join(lines)

    # ------------------------------------------------------------ messages
    async def handle_message(self, chat_id: int, msg_id: int, text: str,
                             reply_to: Optional[int] = None, edited: bool = False,
                             allow_signal: bool = True, allow_command: bool = True,
                             max_sl: Optional[float] = None) -> None:
        if not text or not text.strip() or not (allow_signal or allow_command):
            return
        reply_text = self.store.message_text(chat_id, reply_to) if reply_to else None
        try:
            parsed = await self.ai.parse_message(text, reply_text, self.open_trades_summary())
        except Exception as e:
            log.exception("lecture du message impossible")
            await self.notify(f"⚠️ Impossible de lire un message (erreur IA : {e}).\n« {text[:200]} »")
            return
        self.store.save_message(chat_id, msg_id, text, parsed.model_dump(mode="json") if parsed else None)
        self.emit("message", msg_id=msg_id, text=text, edited=edited,
                  action=parsed.action.value if parsed else None,
                  is_gold=parsed.symbol_is_gold if parsed else None,
                  notes=parsed.notes if parsed else "", confidence=parsed.confidence if parsed else None)
        if parsed is None or parsed.action == Action.IGNORE or not parsed.symbol_is_gold:
            return
        is_signal = parsed.action == Action.NEW_SIGNAL
        if (is_signal and not allow_signal) or (not is_signal and not allow_command):
            log.info("Message %s ignoré (filtre messages transférés)", msg_id)
            return
        log.info("Message %s interprété : %s", msg_id, parsed.model_dump(mode="json"))

        async with self._lock:
            existing = self.store.signal_by_msg(msg_id)
            if edited and existing is not None and parsed.action == Action.NEW_SIGNAL:
                # Signal modifié après coup par l'admin : on met à jour SL/TP du trade déjà ouvert.
                if existing["status"] == "open":
                    await self.apply_edit(existing, parsed)
                return
            if parsed.action == Action.NEW_SIGNAL:
                if existing is not None:
                    return  # déjà traité
                await self.on_new_signal(parsed, msg_id, text, max_sl)
            else:
                await self.on_command(parsed, reply_to, text)
        await self.flush_events()

    # -------------------------------------------------------- nouveau signal
    def build_signal(self, p: ParsedMessage, msg_id: int) -> Signal:
        if p.side is None or p.stop_loss is None:
            raise Rejected("signal incomplet (sens ou SL manquant)")
        lo, hi = p.entry_low, p.entry_high
        if lo is None and hi is None:
            bid, ask = self.broker.tick()
            lo = hi = ask if p.side == Side.BUY else bid
        lo = lo if lo is not None else hi
        hi = hi if hi is not None else lo
        lo, hi = min(lo, hi), max(lo, hi)
        return Signal(p.side, lo, hi, p.stop_loss, list(p.take_profits), p.entry_is_market, msg_id)

    async def get_verdict(self, signal: Signal) -> tuple[float, Optional[AnalystVerdict], str]:
        ai_cfg = self.cfg.ai
        if ai_cfg.analyst_mode == "off" or self.ai is None:
            return 1.0, None, ""
        try:
            bars = {tf: await self.call(self.broker.rates, tf, 250) for tf in TIMEFRAMES}
            bid, ask = await self.call(self.broker.tick)
            verdict = await self.ai.analyze(signal, bid, ask, bars)
            if verdict is None:
                raise RuntimeError("pas de réponse exploitable")
        except Exception as e:
            log.exception("analyse impossible")
            if ai_cfg.on_analyst_error == "reject":
                return 0.0, None, f"analyse IA indisponible ({e}) → signal non pris"
            return ai_cfg.on_error_risk_multiplier, None, f"analyse IA indisponible ({e}) → risque réduit"
        if ai_cfg.analyst_mode == "advisory":
            return 1.0, verdict, ""
        mult = 0.0 if verdict.decision == Decision.REJECT else verdict.risk_multiplier
        if verdict.decision == Decision.APPROVE:
            mult = max(mult, 1.0)
        return max(0.0, min(1.0, mult)), verdict, ""

    async def on_new_signal(self, parsed: ParsedMessage, msg_id: int, text: str,
                            max_sl: Optional[float] = None) -> None:
        if parsed.confidence < 0.7:
            self.emit("signal_ignored", msg_id=msg_id, text=text, reason=f"signal ambigu ({parsed.confidence:.0%})")
            await self.notify(f"🤔 Signal ambigu, PAS pris (certitude {parsed.confidence:.0%}) : {parsed.notes}\n« {text[:300]} »")
            return
        try:
            signal = self.build_signal(parsed, msg_id)
        except Rejected as e:
            self.emit("signal_ignored", msg_id=msg_id, text=text, reason=str(e))
            await self.notify(f"⛔ Signal ignoré : {e}\n« {text[:300]} »")
            return
        if max_sl is not None:
            entry = signal.entry_high if signal.side == Side.BUY else signal.entry_low
            dist = abs(entry - signal.stop_loss)
            if dist > max_sl:
                self.emit("signal_ignored", msg_id=msg_id, text=text,
                          reason=f"groupe principal : SL à {dist:.2f} $ (max {max_sl:g} $)")
                await self.notify(f"⛔ Signal du groupe principal ignoré : SL à {dist:.2f} $ de l'entrée "
                                  f"(max {max_sl:g} $).\n« {text[:300]} »")
                return
        head = (f"{'🟢 BUY' if signal.side == Side.BUY else '🔴 SELL'} GOLD "
                f"{signal.entry_low}-{signal.entry_high} SL {signal.stop_loss} TP {signal.take_profits}")
        server_time = await self.call(self.broker.server_time)

        if self.paused:
            self._reject(signal, server_time, "bot en pause", text)
            await self.notify(f"⏸ Bot en pause, signal non pris.\n{head}")
            return

        if self.skip_next > 0:
            self.skip_next -= 1
            self._reject(signal, server_time, "consigne : ne pas prendre le prochain trade", text)
            reste = f" ({self.skip_next} encore à sauter)" if self.skip_next else ""
            await self.notify(f"⏭ Signal sauté (consigne « ne prenez pas le prochain trade »){reste}.\n{head}")
            return

        mult, verdict, note = await self.get_verdict(signal)
        verdict_txt = ""
        if verdict:
            verdict_txt = f"\n🧠 IA : {verdict.decision.value} (x{verdict.risk_multiplier:.2f}) — {verdict.summary}"
            if verdict.warnings:
                verdict_txt += "\n⚠️ " + " / ".join(verdict.warnings)
        if note:
            verdict_txt += f"\n⚠️ {note}"

        vdump = verdict.model_dump(mode="json") if verdict else None
        decided_by = ""
        if self.approver is not None and self.needs_approval(verdict, note):
            override = await self.ask_approval(signal, text, mult, verdict, note)
            if override is not None:
                mult, decided_by = override, "toi (Discord)"
                verdict_txt += f"\n✋ Décision manuelle : {'refusé' if mult <= 0 else f'pris x{mult:g}'}"

        if mult <= 0:
            reason = "refusé par toi (Discord)" if decided_by else (note or "refusé par l'analyse IA")
            self._reject(signal, server_time, reason, text, vdump)
            await self.notify(f"⛔ Signal {'refusé' if decided_by else 'refusé par l analyse'}.\n{head}{verdict_txt}")
            return

        await self.execute_signal(signal, mult, server_time, head, verdict_txt, vdump, text)

    def _reject(self, signal: Signal, server_time: datetime, reason: str, text: str = "",
                verdict: Optional[dict] = None) -> int:
        sid = self.store.add_signal(signal, "rejected", server_time, verdict=verdict, reason=reason)
        self.emit("signal_rejected", sid=sid, reason=reason, text=text, verdict=verdict, **self._signal_info(signal))
        return sid

    @staticmethod
    def _signal_info(signal: Signal) -> dict:
        return {"side": signal.side.value, "entry_low": signal.entry_low, "entry_high": signal.entry_high,
                "sl": signal.stop_loss, "tps": list(signal.take_profits)}

    # ------------------------------------------------------ validation manuelle
    def needs_approval(self, verdict: Optional[AnalystVerdict], note: str) -> bool:
        mode = self.cfg.discord.approval_mode
        if mode == "always":
            return True
        if mode == "doubts":
            return bool(note) or (verdict is not None and verdict.decision != Decision.APPROVE)
        return False

    async def ask_approval(self, signal: Signal, text: str, mult: float,
                           verdict: Optional[AnalystVerdict], note: str) -> Optional[float]:
        """Demande ton avis (Discord) sans bloquer la gestion des trades ouverts pendant l'attente."""
        preview = None
        try:
            state = await self.call(self.account_state)
            spec = await self.call(self.broker.spec)
            plan = plan_trade(signal, state, spec, self.broker.loss_per_lot, self.cfg.risk, self.cfg.management,
                              mult if mult > 0 else 1.0)
            preview = {"order_type": plan.order_type, "entry": plan.entry, "volume": plan.total_volume,
                       "risk": plan.risk_money, "legs": [asdict(l) for l in plan.legs], "notes": plan.notes}
        except Rejected as e:
            log.info("Pas de validation demandée : le signal serait refusé de toute façon (%s)", e)
            return None
        request = {**self._signal_info(signal), "text": text, "auto_multiplier": mult, "note": note,
                   "verdict": verdict.model_dump(mode="json") if verdict else None, "preview": preview,
                   "timeout": self.cfg.discord.approval_timeout_seconds,
                   "on_timeout": self.cfg.discord.approval_on_timeout}
        await self.flush_events()
        locked = self._lock.locked()
        if locked:
            self._lock.release()  # la boucle de gestion (BE, TP...) continue pendant que tu réfléchis
        try:
            answer = await asyncio.wait_for(self.approver(request), timeout=request["timeout"] + 5)
        except Exception:
            log.exception("validation Discord impossible")
            answer = None
        finally:
            if locked:
                await self._lock.acquire()
        if answer is None:  # pas de réponse à temps
            if request["on_timeout"] == "take":
                return max(mult, 1.0) if mult > 0 else 1.0
            if request["on_timeout"] == "skip":
                return 0.0
            return None  # "auto" : décision de l'IA
        return max(0.0, min(1.0, answer))

    # ------------------------------------------------------------- exécution
    async def execute_signal(self, signal: Signal, mult: float, server_time: datetime, head: str,
                             verdict_txt: str = "", vdump: Optional[dict] = None, text: str = "",
                             existing_sid: Optional[int] = None) -> Optional[int]:
        try:
            state = await self.call(self.account_state)
            spec = await self.call(self.broker.spec)
            plan = plan_trade(signal, state, spec, self.broker.loss_per_lot, self.cfg.risk, self.cfg.management, mult)
        except Rejected as e:
            if existing_sid:
                self.store.update_signal(existing_sid, reason=f"toujours refusé : {e}")
                self.emit("alert", text=f"#{existing_sid} toujours impossible à prendre : {e}")
            else:
                self._reject(signal, server_time, str(e), text, vdump)
            await self.notify(f"⛔ Signal non pris : {e}\n{head}{verdict_txt}")
            return None

        status = "dry_run" if self.cfg.dry_run else "open"
        if existing_sid:
            sid = existing_sid
            self.store.update_signal(sid, status=status, entry=plan.entry, legs=len(plan.legs), reason="",
                                     plan=json.dumps(asdict(plan), ensure_ascii=False),
                                     server_time=server_time.isoformat(timespec="seconds"))
        else:
            sid = self.store.add_signal(signal, status, server_time, entry=plan.entry, plan=asdict(plan),
                                        verdict=vdump, legs=len(plan.legs))
        self.store.update_signal(sid, tps=[l.tp for l in plan.legs])

        results = []
        for n, leg in enumerate(plan.legs, start=1):
            if plan.order_type == "market":
                r = await self.call(self.broker.market_order, plan.side, leg.volume, plan.sl, leg.tp, leg_comment(sid, n))
            else:
                r = await self.call(self.broker.limit_order, plan.side, plan.entry, leg.volume, plan.sl, leg.tp,
                                    leg_comment(sid, n), self.cfg.risk.limit_expiry_minutes)
            results.append(r)
            self.store.log(sid, "order", f"leg {n} {leg.volume} TP {leg.tp}: ok={r.ok} {r.message}")

        ok = [r for r in results if r.ok]
        if not ok:
            self.store.update_signal(sid, status="failed", reason=results[0].message)
            self.emit("trade_failed", sid=sid, reason=results[0].message, **self._signal_info(signal))
            await self.notify(f"❌ Ordres REFUSÉS par le broker : {results[0].message}\n{head}")
            return None
        legs_txt = "\n".join(f"  • {l.volume} lot → TP{n} {l.tp}" for n, l in enumerate(plan.legs, 1))
        prefix = "🧪 [DRY RUN, rien envoyé] " if self.cfg.dry_run else "✅ "
        msg = (f"{prefix}Trade #{sid} {plan.side.value} {plan.total_volume} lot "
               f"({'marché' if plan.order_type == 'market' else 'limite'} {plan.entry}), SL {plan.sl}\n"
               f"{legs_txt}\n💰 Risque : {plan.risk_money:.2f} si SL touché")
        if plan.notes:
            msg += "\nℹ️ " + " / ".join(plan.notes)
        if len(ok) < len(results):
            msg += f"\n⚠️ {len(results) - len(ok)} ordre(s) refusé(s) : " + "; ".join(r.message for r in results if not r.ok)
        self.emit("trade_opened", sid=sid, dry_run=self.cfg.dry_run, order_type=plan.order_type, entry=plan.entry,
                  sl=plan.sl, volume=plan.total_volume, risk=plan.risk_money, notes=plan.notes,
                  legs=[asdict(l) for l in plan.legs], verdict=vdump, text=text,
                  refused=[r.message for r in results if not r.ok], side=signal.side.value,
                  signal=self._signal_info(signal))
        await self.notify(msg + verdict_txt)
        return sid

    async def take_rejected(self, sid: int, mult: float = 1.0, by: str = "Discord") -> Optional[int]:
        """« Prendre quand même » un signal refusé (pause, IA, toi...). Les règles de risque s'appliquent toujours."""
        async with self._lock:
            row = self.store.signal(sid)
            if row is None or row["status"] != "rejected":
                raise ValueError("ce signal n'est pas (ou plus) en attente de décision")
            signal = Signal(Side(row["side"]), row["entry_low"], row["entry_high"], row["sl"], row_tps(row),
                            True, row["msg_id"])
            head = (f"{'🟢 BUY' if signal.side == Side.BUY else '🔴 SELL'} GOLD "
                    f"{signal.entry_low}-{signal.entry_high} SL {signal.stop_loss} TP {signal.take_profits}")
            server_time = await self.call(self.broker.server_time)
            result = await self.execute_signal(signal, mult, server_time, head, f"\n✋ Pris quand même ({by})",
                                               existing_sid=sid)
        await self.flush_events()
        return result

    # -------------------------------------------------------- commandes
    def target_signal(self, reply_to: Optional[int]):
        if reply_to:
            row = self.store.signal_by_msg(reply_to)
            if row is not None and row["status"] == "open":
                return row
        opened = self.store.open_signals()
        return opened[-1] if opened else None

    async def apply_edit(self, row, p: ParsedMessage) -> None:
        sid = row["id"]
        if p.stop_loss and p.stop_loss != row["sl"]:
            await self.set_sl(row, p.stop_loss, reason="signal modifié par l'admin")
        if p.take_profits and p.take_profits != row_tps(row):
            await self.set_tps(row, p.take_profits)
        self.store.log(sid, "edit", p.model_dump_json())

    async def on_command(self, p: ParsedMessage, reply_to: Optional[int], text: str) -> None:
        if p.confidence < 0.6:
            await self.notify(f"🤔 Consigne ambiguë, rien fait ({p.notes}) :\n« {text[:300]} »")
            return
        actions = [p.action]
        for a in p.extra_actions:  # "coupez la moitié ET mettez BE" : plusieurs consignes, dans l'ordre
            if a not in actions and a not in (Action.NEW_SIGNAL, Action.IGNORE):
                actions.append(a)
        for action in actions:
            if action == Action.SKIP_NEXT:
                n = self.skip_next = max(1, p.skip_count or 1)
                self.emit("skip_next", count=n, by="groupe")
                await self.notify("⏭ OK : le prochain signal ne sera pas pris." if n == 1
                                  else f"⏭ OK : les {n} prochains signaux ne seront pas pris.")
                continue
            row = self.target_signal(reply_to)
            if row is None:
                log.info("Consigne %s mais aucun trade ouvert", action)
                continue
            await self.apply_command(action, p, row)
            if action == Action.CLOSE_ALL:
                break  # plus rien à gérer après une fermeture complète

    async def apply_command(self, action: Action, p: ParsedMessage, row) -> None:
        mgmt = self.cfg.management
        ignored = ((action == Action.MOVE_SL_BE and not mgmt.follow_group_be)
                   or (action in (Action.CLOSE_ALL, Action.CLOSE_PARTIAL) and not mgmt.follow_group_closes))
        if ignored:
            log.info("Consigne %s ignorée (réglage)", action)
            return
        sid = row["id"]
        if action == Action.MOVE_SL_BE:
            await self.move_be(row, reason="consigne du groupe : BE")
        elif action == Action.MODIFY_SL and p.stop_loss:
            await self.set_sl(row, p.stop_loss, reason="consigne du groupe")
        elif action == Action.MODIFY_TP and p.tp_changes:
            await self.set_tp_levels(row, {c.index: c.price for c in p.tp_changes})
        elif action == Action.MODIFY_TP and p.take_profits:
            await self.set_tps(row, p.take_profits)
        elif action == Action.CLOSE_ALL:
            await self.close_signal(row, reason="consigne du groupe")
        elif action == Action.CLOSE_PARTIAL:
            await self.close_partial(row, p.close_fraction or 0.5)
        elif action == Action.CANCEL:
            _, orders = await self.call(self.legs, sid)
            for _, o in orders:
                await self.call(self.broker.cancel_order, o.ticket)
            positions, _ = await self.call(self.legs, sid)
            if not positions:
                await self.call(self.finalize, row, "annulé par le groupe")
            await self.notify(f"🗑 #{sid} : {len(orders)} ordre(s) en attente annulé(s)"
                              + (" — des positions déjà ouvertes restent gérées." if positions else "."))

    async def set_sl(self, row, sl: float, reason: str) -> bool:
        sid, side = row["id"], row_side(row)
        bid, ask = await self.call(self.broker.tick)
        sign = 1 if side == Side.BUY else -1
        price = bid if side == Side.BUY else ask
        if (price - sl) * sign <= 0:
            await self.notify(f"⚠️ #{sid} : SL {sl} impossible (le prix {price} est déjà au-delà). Rien changé.")
            return False
        positions, orders = await self.call(self.legs, sid)
        for _, p in positions:
            await self.call(self.broker.modify_position, p.ticket, sl, p.tp)
        for _, o in orders:
            await self.call(self.broker.modify_order, o.ticket, o.price, sl, o.tp)
        self.store.update_signal(sid, sl=sl)
        self.emit("sl_moved", sid=sid, sl=sl, reason=reason)
        await self.notify(f"🛡 #{sid} : SL déplacé à {sl} ({reason}).")
        return True

    async def set_tps(self, row, tps: list[float]) -> None:
        sid = row["id"]
        positions, orders = await self.call(self.legs, sid)
        for i, p in positions:
            if i - 1 < len(tps):
                await self.call(self.broker.modify_position, p.ticket, p.sl, tps[i - 1])
        for i, o in orders:
            if i - 1 < len(tps):
                await self.call(self.broker.modify_order, o.ticket, o.price, o.sl, tps[i - 1])
        self.store.update_signal(sid, tps=tps)
        self.emit("tp_changed", sid=sid, tps=tps)
        await self.notify(f"🎯 #{sid} : TP mis à jour {tps}.")

    def finalize(self, row, reason: str = "") -> float:
        """Marque un signal terminé et enregistre son P&L réalisé (lu dans l'historique du broker)."""
        sid = row["id"]
        since = datetime.fromisoformat(row["server_time"]) - timedelta(days=1)
        try:
            pnl = round(self.broker.signal_pnl(f"GB{sid}T", since), 2)
        except Exception:
            log.exception("P&L du signal #%s illisible", sid)
            pnl = None
        fields = dict(status="closed", closed_at=self.broker.server_time().isoformat(timespec="seconds"), pnl=pnl)
        if reason:
            fields["reason"] = reason
        self.store.update_signal(sid, **fields)
        self.emit("trade_closed", sid=sid, pnl=pnl, reason=reason or row["reason"] or "",
                  tps_reached=row["tps_reached"], side=row["side"], entry=row["entry"])
        return pnl or 0.0

    async def move_be(self, row, reason: str) -> bool:
        positions, _ = await self.call(self.legs, row["id"])
        if not positions:
            await self.notify(f"ℹ️ BE demandé sur #{row['id']} mais pas de position ouverte.")
            return False
        sign = 1 if row_side(row) == Side.BUY else -1
        be = round(positions[0][1].open_price + sign * self.cfg.management.breakeven_buffer, 2)
        return await self.set_sl(row, be, reason=reason)

    async def set_tp_levels(self, row, changes: dict[int, float]) -> None:
        """Change seulement les TP désignés par leur numéro ("TP2 à 4085"), sans toucher aux autres."""
        sid = row["id"]
        tps = row_tps(row)
        valid = {i: price for i, price in changes.items() if 1 <= i <= len(tps)}
        ignored = sorted(set(changes) - set(valid))
        if not valid:
            await self.notify(f"ℹ️ #{sid} : TP{', TP'.join(map(str, ignored))} demandé, mais ce trade n'a que "
                              f"{len(tps)} TP. Rien changé.")
            return
        positions, orders = await self.call(self.legs, sid)
        for i, p in positions:
            if i in valid:
                await self.call(self.broker.modify_position, p.ticket, p.sl, valid[i])
        for i, o in orders:
            if i in valid:
                await self.call(self.broker.modify_order, o.ticket, o.price, o.sl, valid[i])
        for i, price in valid.items():
            tps[i - 1] = price
        self.store.update_signal(sid, tps=tps)
        self.emit("tp_changed", sid=sid, tps=tps)
        changed = ", ".join(f"TP{i} → {price}" for i, price in sorted(valid.items()))
        msg = f"🎯 #{sid} : {changed}."
        if ignored:
            msg += f" (TP{', TP'.join(map(str, ignored))} ignoré : ce trade n'a que {len(tps)} TP)"
        await self.notify(msg)

    async def close_signal(self, row, reason: str) -> None:
        sid = row["id"]
        positions, orders = await self.call(self.legs, sid)
        for _, o in orders:
            await self.call(self.broker.cancel_order, o.ticket)
        for _, p in positions:
            await self.call(self.broker.close_position, p.ticket)
        pnl = await self.call(self.finalize, row, reason)
        await self.notify(f"🚪 #{sid} fermé ({reason}). Résultat : {pnl:+.2f}")

    async def close_partial(self, row, fraction: float) -> None:
        sid = row["id"]
        positions, _ = await self.call(self.legs, sid)
        if not positions:
            return
        spec = await self.call(self.broker.spec)
        total = sum(p.volume for _, p in positions)
        to_close = round_volume(total * max(0.0, min(1.0, fraction)), spec)
        closed = 0.0
        for _, p in positions:  # on ferme d'abord les parts aux TP les plus proches
            if closed >= to_close - 1e-9:
                break
            vol = min(p.volume, round_volume(to_close - closed, spec))
            if vol < spec.volume_min:
                break
            r = await self.call(self.broker.close_position, p.ticket, vol)
            if r.ok:
                closed = round(closed + vol, 8)
        self.emit("partial_close", sid=sid, closed=closed, total=total, fraction=fraction)
        await self.notify(f"✂️ #{sid} : {closed} lot fermé sur {total} (consigne : {fraction:.0%}).")

    async def close_everything(self, reason: str = "commande /closeall") -> int:
        async with self._lock:
            rows = self.store.open_signals()
            for row in rows:
                await self.close_signal(row, reason=reason)
        await self.flush_events()
        return len(rows)

    # -------------------------------------------------- gestion continue
    def manage_once(self) -> list[str]:
        """Un passage de gestion : BE / trailing / trades terminés. Renvoie les notifications."""
        out: list[str] = []
        mgmt = self.cfg.management
        positions_all = self.broker.positions()
        orders_all = self.broker.pending_orders()
        bid, ask = self.broker.tick()
        spec = self.broker.spec()
        min_gap = spec.stops_level_points * spec.point

        for row in self.store.open_signals():
            sid, side, tps = row["id"], row_side(row), row_tps(row)
            positions = sorted(((i, p) for p in positions_all if (i := leg_index(p.comment, sid))),
                               key=lambda x: x[0])
            orders = [(i, o) for o in orders_all if (i := leg_index(o.comment, sid))]
            if not positions and not orders:
                if row["tps_reached"] > 0:
                    why = f"TP{row['tps_reached']} atteint"
                else:
                    why = "SL touché, fermé à la main, ou ordre limite expiré"
                pnl = self.finalize(row, why)
                out.append(f"🏁 Trade #{sid} terminé ({why}). Résultat : {pnl:+.2f}")
                continue
            if not positions:
                continue  # ordres limites pas encore déclenchés

            sign = 1 if side == Side.BUY else -1
            price = bid if side == Side.BUY else ask
            present = {i for i, _ in positions} | {i for i, _ in orders}
            missing = set(range(1, row["legs"] + 1)) - present
            reached_closed = max(missing) if missing else 0
            reached_price = sum(1 for tp in tps if (price - tp) * sign >= 0)
            reached = max(row["tps_reached"], reached_closed, reached_price)
            if reached > row["tps_reached"]:
                self.store.update_signal(sid, tps_reached=reached)
                self.emit("tp_hit", sid=sid, n=reached, price=price)
                out.append(f"🎯 #{sid} : TP{reached} atteint.")

            moved_to = None
            for _, p in positions:
                new_sl = protective_sl(side, p.open_price, tps, reached, p.sl, mgmt)
                if new_sl is None:
                    continue
                if (price - new_sl) * sign <= min_gap:  # trop près du prix pour le broker
                    continue
                r = self.broker.modify_position(p.ticket, new_sl, p.tp)
                if r.ok:
                    moved_to = new_sl
                else:
                    log.warning("modif SL #%s refusée : %s", p.ticket, r.message)
            if moved_to is not None:
                label = "break-even" if reached < 2 or not mgmt.trail_to_previous_tp else f"TP{reached - 1}"
                self.store.update_signal(sid, sl=moved_to)
                self.emit("sl_moved", sid=sid, sl=moved_to, reason=label)
                out.append(f"🛡 #{sid} : SL remonté à {moved_to} ({label}), le reste du trade est protégé.")
        return out

    async def manage_loop(self) -> None:
        while True:
            try:
                async with self._lock:
                    msgs = await self.call(self.manage_once)
                for m in msgs:
                    await self.notify(m)
                await self.flush_events()
            except Exception:
                log.exception("erreur dans la boucle de gestion")
            await asyncio.sleep(self.cfg.management.check_interval_seconds)

    async def status_text(self) -> str:
        state = await self.call(self.account_state)
        lines = [
            f"{'⏸ EN PAUSE' if self.paused else '▶️ actif'}{' — DRY RUN' if self.cfg.dry_run else ''}",
            f"Solde {state.balance:.2f} | P&L du jour {state.realized_today:+.2f} | risque ouvert {state.open_risk_money:.2f}",
            f"Trades aujourd'hui : {state.trades_today}/{self.cfg.risk.max_trades_per_day}",
        ]
        summary = self.open_trades_summary()
        lines.append(summary or "Aucun trade ouvert.")
        return "\n".join(lines)

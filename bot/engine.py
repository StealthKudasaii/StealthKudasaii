"""Le cerveau : reçoit un message, décide, exécute, puis gère les positions (BE, trailing)."""
from __future__ import annotations

import asyncio
import logging
from dataclasses import asdict
from datetime import datetime
from typing import Awaitable, Callable, Optional

from .broker import TIMEFRAMES, Broker, round_volume
from .config import Config
from .models import Action, AnalystVerdict, Decision, ParsedMessage, Position, Side, Signal
from .risk import AccountState, Rejected, plan_trade, protective_sl
from .store import Store, row_side, row_tps

log = logging.getLogger(__name__)
Notify = Callable[[str], Awaitable[None]]


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

    async def notify(self, text: str) -> None:
        log.info("NOTIF: %s", text.replace("\n", " | "))
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
            await self.notify(f"🤔 Signal ambigu, PAS pris (certitude {parsed.confidence:.0%}) : {parsed.notes}\n« {text[:300]} »")
            return
        try:
            signal = self.build_signal(parsed, msg_id)
        except Rejected as e:
            await self.notify(f"⛔ Signal ignoré : {e}\n« {text[:300]} »")
            return
        if max_sl is not None:
            entry = signal.entry_high if signal.side == Side.BUY else signal.entry_low
            dist = abs(entry - signal.stop_loss)
            if dist > max_sl:
                await self.notify(f"⛔ Signal du groupe principal ignoré : SL à {dist:.2f} $ de l'entrée "
                                  f"(max {max_sl:g} $).\n« {text[:300]} »")
                return
        head = (f"{'🟢 BUY' if signal.side == Side.BUY else '🔴 SELL'} GOLD "
                f"{signal.entry_low}-{signal.entry_high} SL {signal.stop_loss} TP {signal.take_profits}")
        server_time = await self.call(self.broker.server_time)

        if self.paused:
            self.store.add_signal(signal, "rejected", server_time)
            await self.notify(f"⏸ Bot en pause, signal non pris.\n{head}")
            return

        if self.skip_next > 0:
            self.skip_next -= 1
            self.store.add_signal(signal, "rejected", server_time)
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

        if mult <= 0:
            self.store.add_signal(signal, "rejected", server_time,
                                  verdict=verdict.model_dump(mode="json") if verdict else None)
            await self.notify(f"⛔ Signal refusé par l'analyse.\n{head}{verdict_txt}")
            return

        try:
            state = await self.call(self.account_state)
            spec = await self.call(self.broker.spec)
            plan = plan_trade(signal, state, spec, self.broker.loss_per_lot, self.cfg.risk, self.cfg.management, mult)
        except Rejected as e:
            self.store.add_signal(signal, "rejected", server_time,
                                  verdict=verdict.model_dump(mode="json") if verdict else None)
            await self.notify(f"⛔ Signal non pris : {e}\n{head}{verdict_txt}")
            return

        status = "dry_run" if self.cfg.dry_run else "open"
        sid = self.store.add_signal(signal, status, server_time, entry=plan.entry, plan=asdict(plan),
                                    verdict=verdict.model_dump(mode="json") if verdict else None,
                                    legs=len(plan.legs))
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
            self.store.update_signal(sid, status="failed")
            await self.notify(f"❌ Ordres REFUSÉS par le broker : {results[0].message}\n{head}")
            return
        legs_txt = "\n".join(f"  • {l.volume} lot → TP{n} {l.tp}" for n, l in enumerate(plan.legs, 1))
        prefix = "🧪 [DRY RUN, rien envoyé] " if self.cfg.dry_run else "✅ "
        msg = (f"{prefix}Trade #{sid} {plan.side.value} {plan.total_volume} lot "
               f"({'marché' if plan.order_type == 'market' else 'limite'} {plan.entry}), SL {plan.sl}\n"
               f"{legs_txt}\n💰 Risque : {plan.risk_money:.2f} si SL touché")
        if plan.notes:
            msg += "\nℹ️ " + " / ".join(plan.notes)
        if len(ok) < len(results):
            msg += f"\n⚠️ {len(results) - len(ok)} ordre(s) refusé(s) : " + "; ".join(r.message for r in results if not r.ok)
        await self.notify(msg + verdict_txt)

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
        side = row_side(row)
        if action == Action.MOVE_SL_BE:
            positions, _ = await self.call(self.legs, sid)
            if not positions:
                await self.notify(f"ℹ️ BE demandé sur #{sid} mais pas de position ouverte.")
                return
            sign = 1 if side == Side.BUY else -1
            be = round(positions[0][1].open_price + sign * self.cfg.management.breakeven_buffer, 2)
            await self.set_sl(row, be, reason="consigne du groupe : BE")
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
                self.store.update_signal(sid, status="closed")
            await self.notify(f"🗑 #{sid} : {len(orders)} ordre(s) en attente annulé(s)"
                              + (" — des positions déjà ouvertes restent gérées." if positions else "."))

    async def set_sl(self, row, sl: float, reason: str) -> None:
        sid, side = row["id"], row_side(row)
        bid, ask = await self.call(self.broker.tick)
        sign = 1 if side == Side.BUY else -1
        price = bid if side == Side.BUY else ask
        if (price - sl) * sign <= 0:
            await self.notify(f"⚠️ #{sid} : SL {sl} impossible (le prix {price} est déjà au-delà). Rien changé.")
            return
        positions, orders = await self.call(self.legs, sid)
        for _, p in positions:
            await self.call(self.broker.modify_position, p.ticket, sl, p.tp)
        for _, o in orders:
            await self.call(self.broker.modify_order, o.ticket, o.price, sl, o.tp)
        self.store.update_signal(sid, sl=sl)
        await self.notify(f"🛡 #{sid} : SL déplacé à {sl} ({reason}).")

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
        await self.notify(f"🎯 #{sid} : TP mis à jour {tps}.")

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
        pnl = 0.0
        for _, p in positions:
            pnl += p.profit
            await self.call(self.broker.close_position, p.ticket)
        self.store.update_signal(sid, status="closed")
        await self.notify(f"🚪 #{sid} fermé ({reason}). P&L flottant au moment de la fermeture ≈ {pnl:.2f}")

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
        await self.notify(f"✂️ #{sid} : {closed} lot fermé sur {total} (consigne : {fraction:.0%}).")

    async def close_everything(self) -> None:
        async with self._lock:
            for row in self.store.open_signals():
                await self.close_signal(row, reason="commande /closeall")

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
                self.store.update_signal(sid, status="closed")
                if row["tps_reached"] > 0:
                    out.append(f"🏁 Trade #{sid} terminé (TP{row['tps_reached']} atteint).")
                else:
                    out.append(f"🏁 Trade #{sid} terminé (SL touché, fermé, ou ordre limite expiré).")
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
                out.append(f"🛡 #{sid} : SL remonté à {moved_to} ({label}), le reste du trade est protégé.")
        return out

    async def manage_loop(self) -> None:
        while True:
            try:
                async with self._lock:
                    msgs = await self.call(self.manage_once)
                for m in msgs:
                    await self.notify(m)
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

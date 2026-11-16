"""Backtest : rejoue les N derniers jours du groupe Telegram sur les vrais prix de ton broker.

    python -m bot.backtest --days 5                 # avec l'analyse IA (Opus) de chaque signal
    python -m bot.backtest --days 5 --no-analyst    # sans le filtre IA (quasi gratuit)

Ferme le bot avant (la session Telegram ne peut servir qu'à un programme à la fois) et laisse MT5 ouvert.

Ce que ça fait :
  1. récupère les messages du groupe (Telegram) et les bougies de l'or (MT5) sur la période ;
  2. rejoue chaque message à son heure : Claude le lit, analyse le graphique TEL QU'IL ÉTAIT à ce moment,
     le moteur de risque décide, et le broker simulé exécute ;
  3. fait avancer le prix minute par minute (TP, SL, BE, trailing, consignes du groupe) ;
  4. écrit un rapport dans data/backtest/.

Les réponses de Claude sont mises en cache : relancer avec d'autres réglages (config.yaml) ne coûte rien
de plus, tant que les messages sont les mêmes. --refresh force le re-téléchargement des données.
"""
from __future__ import annotations

import argparse
import asyncio
import bisect
import hashlib
import json
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from .broker import TIMEFRAMES, PaperBroker
from .config import Config, env, load_config
from .engine import Engine, leg_index, main_sl_limit, message_filter
from .models import Action, Bar, OrderResult, Position, SymbolSpec
from .store import Store, row_tps

log = logging.getLogger("backtest")
OUT = Path("data/backtest")
TF_MINUTES = {"M1": 1, "M5": 5, "M15": 15, "H1": 60, "H4": 240}
# Historique à charger AVANT la période pour que les indicateurs (EMA 200...) aient assez de bougies.
LOOKBACK_DAYS = {"M1": 1, "M5": 3, "M15": 6, "H1": 18, "H4": 75}


# ---------------------------------------------------------------------------
# Données
# ---------------------------------------------------------------------------
@dataclass
class Msg:
    id: int
    time: datetime          # heure du SERVEUR MT5 (même horloge que les bougies)
    text: str
    reply_to: Optional[int] = None
    edited: bool = False
    fwd_from: Optional[str] = None


def _bar_to_list(b: Bar) -> list:
    return [b.time.isoformat(), b.open, b.high, b.low, b.close, b.volume]


def _bar_from_list(x: list) -> Bar:
    return Bar(datetime.fromisoformat(x[0]), x[1], x[2], x[3], x[4], x[5])


async def fetch_messages(cfg: Config, start_utc: datetime) -> list[dict]:
    from telethon import TelegramClient

    allowed = set(cfg.telegram.allowed_senders)
    out: list[dict] = []
    client = TelegramClient("data/telegram", int(env("TELEGRAM_API_ID")), env("TELEGRAM_API_HASH"))
    try:
        await client.connect()
    except Exception as e:
        if "locked" in str(e).lower():
            raise SystemExit("La session Telegram est occupée : ferme la fenêtre du bot, puis relance le backtest.")
        raise
    try:
        if not await client.is_user_authorized():
            raise SystemExit("Pas connecté à Telegram : lance d'abord `python -m bot.list_chats`.")
        for chat in cfg.telegram.source_chats:
            entity = await client.get_entity(chat)
            async for m in client.iter_messages(entity):
                date = m.date.astimezone(timezone.utc).replace(tzinfo=None)
                if date < start_utc:
                    break
                if not m.message or (allowed and m.sender_id not in allowed):
                    continue
                fwd = m.fwd_from
                fwd_name = None
                if fwd is not None:
                    chat_obj = getattr(m.forward, "chat", None) if m.forward else None
                    fwd_name = getattr(chat_obj, "title", None) or fwd.from_name or "inconnu"
                out.append({
                    "id": m.id, "date_utc": date.isoformat(), "text": m.message,
                    "reply_to": m.reply_to.reply_to_msg_id if m.reply_to else None,
                    "edited": m.edit_date is not None,
                    "forwarded": fwd is not None,
                    "fwd_from": fwd_name,
                    "fwd_chat_id": getattr(fwd.from_id, "channel_id", None) if fwd is not None and fwd.from_id else None,
                })
    finally:
        await client.disconnect()
    out.sort(key=lambda d: d["date_utc"])
    return out


def fetch_market(cfg: Config, start_srv: datetime, end_srv: datetime) -> dict:
    """Bougies M1..H4 + caractéristiques du symbole + décalage horaire du serveur MT5."""
    from .broker import MT5Broker

    broker = MT5Broker(cfg.mt5.symbol, cfg.mt5.magic, cfg.mt5.deviation_points, dry_run=True,
                       login=env("MT5_LOGIN", False), password=env("MT5_PASSWORD", False),
                       server=env("MT5_SERVER", False), path=env("MT5_PATH", False))
    mt5 = broker.mt5
    info = mt5.symbol_info(cfg.mt5.symbol)
    bars: dict[str, list] = {}
    spreads: dict[str, float] = {}
    for tf in ("M1", *TIMEFRAMES):
        frm = (start_srv - timedelta(days=LOOKBACK_DAYS[tf])).replace(tzinfo=timezone.utc)
        to = (end_srv + timedelta(days=1)).replace(tzinfo=timezone.utc)
        # Par tranches de 10 jours : MT5 refuse les très grandes demandes (« Invalid params »)
        raw, a = [], frm
        while a < to:
            b = min(a + timedelta(days=10), to)
            part = mt5.copy_rates_range(cfg.mt5.symbol, getattr(mt5, f"TIMEFRAME_{tf}"), a, b)
            if part is not None:
                raw.extend(r for r in part if not raw or int(r["time"]) > int(raw[-1]["time"]))
            a = b
        if len(raw) == 0:
            raise SystemExit(f"MT5 n'a pas renvoyé de bougies {tf} ({mt5.last_error()}). "
                             f"Ouvre le graphique {cfg.mt5.symbol} en {tf} dans MT5 pour charger l'historique.")
        rows = []
        for r in raw:
            t = datetime.fromtimestamp(int(r["time"]), tz=timezone.utc).replace(tzinfo=None)
            rows.append(_bar_to_list(Bar(t, float(r["open"]), float(r["high"]), float(r["low"]),
                                         float(r["close"]), float(r["tick_volume"]))))
            if tf == "M1":
                spreads[rows[-1][0]] = float(r["spread"]) * info.point
        bars[tf] = rows
    mt5.shutdown()
    return {
        "symbol": cfg.mt5.symbol,
        "spec": [info.volume_min, info.volume_max, info.volume_step, info.digits, info.point,
                 info.trade_stops_level],
        "contract_size": info.trade_contract_size,
        "bars": bars, "m1_spread": spreads,
    }


def detect_server_offset(cfg: Config) -> int:
    """Décalage (heures) entre l'heure du serveur MT5 et l'heure UTC."""
    import MetaTrader5 as mt5

    path = env("MT5_PATH", False)
    if not (mt5.initialize(path=path) if path else mt5.initialize()):
        raise SystemExit(f"Impossible de se connecter à MT5 : {mt5.last_error()}")
    mt5.symbol_select(cfg.mt5.symbol, True)
    tick = mt5.symbol_info_tick(cfg.mt5.symbol)
    mt5.shutdown()
    diff = tick.time - time.time()
    hours = round(diff / 3600)
    if abs(diff - hours * 3600) > 600:
        log.warning("Le dernier prix MT5 date un peu (marché fermé ?) : décalage horaire estimé à %+d h. "
                    "Corrige avec --offset si besoin.", hours)
    return hours


# ---------------------------------------------------------------------------
# Broker de backtest : PaperBroker + horloge, spread réel, expiration des limites, P&L par trade
# ---------------------------------------------------------------------------
class BacktestBroker(PaperBroker):
    def __init__(self, bars: dict[str, list[Bar]], spec: SymbolSpec, contract_size: float, balance: float):
        super().__init__(bid=bars["M1"][0].open, spread=0.3, balance=balance, contract_size=contract_size)
        self._spec = spec
        self.all_bars = bars
        self._ends = {tf: [b.time + timedelta(minutes=TF_MINUTES[tf]) for b in bs] for tf, bs in bars.items()}
        self.expiry: dict[int, datetime] = {}
        self.pnl_by_comment: dict[str, float] = {}
        self.equity_curve: list[tuple[datetime, float]] = []
        self.closes: list[tuple] = []     # (heure, comment, prix, volume, pnl)
        self.sl_moves: list[tuple] = []   # (heure, comment, sl, tp)
        self.fills: list[tuple] = []      # (heure, comment, prix d'entrée)

    def spec(self) -> SymbolSpec:
        return self._spec

    def rates(self, timeframe: str, count: int) -> list[Bar]:
        """Seulement les bougies TERMINÉES à l'instant simulé : pas de triche avec le futur."""
        n = bisect.bisect_right(self._ends[timeframe], self.now)
        return self.all_bars[timeframe][max(0, n - count):n]

    def tick(self) -> tuple[float, float]:
        return round(self.bid, 2), round(self.bid + self.spread, 2)

    def limit_order(self, side, price, volume, sl, tp, comment, expiry_minutes) -> OrderResult:
        r = super().limit_order(side, price, volume, sl, tp, comment, expiry_minutes)
        self.expiry[r.ticket] = self.now + timedelta(minutes=expiry_minutes)
        return r

    def expire_orders(self) -> None:
        for t, exp in list(self.expiry.items()):
            if self.now >= exp:
                self._orders.pop(t, None)
                del self.expiry[t]

    def _close(self, p: Position, price: float, volume: Optional[float] = None) -> float:
        vol = volume or p.volume
        pnl = super()._close(p, price, volume)
        self.pnl_by_comment[p.comment] = self.pnl_by_comment.get(p.comment, 0.0) + pnl
        self.equity_curve.append((self.now, self._balance))
        self.closes.append((self.now, p.comment, price, vol, pnl))
        return pnl

    def modify_position(self, ticket: int, sl: float, tp: float) -> OrderResult:
        p = self._positions.get(ticket)
        r = super().modify_position(ticket, sl, tp)
        if p is not None and r.ok:
            self.sl_moves.append((self.now, p.comment, sl, tp))
        return r

    def market_order(self, side, volume, sl, tp, comment) -> OrderResult:
        r = super().market_order(side, volume, sl, tp, comment)
        self.fills.append((self.now, comment, r.price))
        return r

    def set_price(self, bid: float) -> None:
        before = set(self._orders)
        super().set_price(bid)
        for t in before - set(self._orders):  # ordre limite déclenché
            if t in self._positions:
                p = self._positions[t]
                self.fills.append((self.now, p.comment, p.open_price))


# ---------------------------------------------------------------------------
# IA avec cache (relancer avec d'autres réglages ne repaie pas les appels)
# ---------------------------------------------------------------------------
class CachedAI:
    def __init__(self, ai, cache_path: Path, use_analyst: bool):
        self.ai = ai
        self.path = cache_path
        self.use_analyst = use_analyst
        self.cache: dict = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
        self.calls = {"parser": 0, "analyst": 0, "cached": 0}
        self.now: Optional[datetime] = None

    def _save(self) -> None:
        self.path.write_text(json.dumps(self.cache, ensure_ascii=False, indent=1), encoding="utf-8")

    @staticmethod
    def _key(*parts) -> str:
        return hashlib.sha1(json.dumps(parts, ensure_ascii=False, default=str).encode()).hexdigest()

    async def parse_message(self, text, reply_to_text, open_trades):
        from .models import ParsedMessage

        k = "p:" + self._key(text, reply_to_text)
        if k in self.cache:
            self.calls["cached"] += 1
            return ParsedMessage.model_validate(self.cache[k]) if self.cache[k] else None
        r = await self.ai.parse_message(text, reply_to_text, open_trades)
        self.calls["parser"] += 1
        self.cache[k] = r.model_dump(mode="json") if r else None
        self._save()
        return r

    async def analyze(self, signal, bid, ask, bars):
        from .models import AnalystVerdict

        k = "a:" + self._key(self.now, signal.side.value, signal.entry_low, signal.entry_high,
                             signal.stop_loss, signal.take_profits)
        if k in self.cache:
            self.calls["cached"] += 1
            return AnalystVerdict.model_validate(self.cache[k]) if self.cache[k] else None
        r = await self.ai.analyze(signal, bid, ask, bars)
        self.calls["analyst"] += 1
        self.cache[k] = r.model_dump(mode="json") if r else None
        self._save()
        return r


# ---------------------------------------------------------------------------
# Rejeu
# ---------------------------------------------------------------------------
@dataclass
class Result:
    engine: Engine
    broker: BacktestBroker
    journal: list[dict] = field(default_factory=list)   # un élément par message
    management: list[tuple[datetime, str]] = field(default_factory=list)
    start: Optional[datetime] = None
    end: Optional[datetime] = None
    balance0: float = 0.0


def price_path(b: Bar) -> list[float]:
    """Chemin plausible du prix dans une bougie M1 : ouverture, extrême contraire, extrême, clôture."""
    if b.close >= b.open:
        return [b.open, b.low, b.high, b.close]
    return [b.open, b.high, b.low, b.close]


async def replay(cfg: Config, messages: list[Msg], bars: dict[str, list[Bar]], spec: SymbolSpec,
                 contract_size: float, ai, start: datetime, end: datetime, balance: float,
                 m1_spread: Optional[dict[datetime, float]] = None, db_path: Path = OUT / "run.sqlite",
                 signal_ids: Optional[set] = None) -> Result:
    cfg = cfg.model_copy(update={"dry_run": False})  # le broker est simulé : on "exécute" pour de vrai
    if db_path.exists():
        db_path.unlink()
    broker = BacktestBroker(bars, spec, contract_size, balance)
    current: list[str] = []

    async def notify(text: str) -> None:
        current.append(text)

    engine = Engine(cfg, broker, Store(db_path), ai, notify)
    res = Result(engine, broker, start=start, end=end, balance0=balance)
    m1 = [b for b in bars["M1"] if start <= b.time < end]
    if not m1:
        raise SystemExit("Aucune bougie M1 sur la période (marché fermé ?).")
    msgs = sorted((m for m in messages if start <= m.time < end), key=lambda m: m.time)
    mi = 0
    last_close = m1[0].open

    for bar in m1:
        # 1. Messages arrivés avant cette bougie : traités au dernier prix connu
        while mi < len(msgs) and msgs[mi].time < bar.time:
            m = msgs[mi]
            mi += 1
            broker.now = m.time
            broker.set_price(last_close)
            if hasattr(ai, "now"):
                ai.now = m.time
            current.clear()
            allow_signal, allow_command = message_filter(cfg.telegram, m.fwd_from)
            if signal_ids is not None:  # liste explicite des signaux à prendre (stratégies)
                allow_signal, allow_command = m.id in signal_ids, True
            await engine.handle_message(1, m.id, m.text, m.reply_to, False, allow_signal, allow_command,
                                            main_sl_limit(cfg.telegram, m.fwd_from))
            row = engine.store.db.execute("SELECT parsed FROM messages WHERE msg_id=?", (m.id,)).fetchone()
            parsed = json.loads(row["parsed"]) if row and row["parsed"] else None
            res.journal.append({"msg": m, "parsed": parsed, "notes": list(current), "price": last_close})

        # 2. Le prix avance dans la bougie : SL/TP/limites, puis gestion BE/trailing
        if m1_spread:
            broker.spread = max(0.05, m1_spread.get(bar.time, broker.spread))
        for k, p in enumerate(price_path(bar)):
            broker.now = bar.time + timedelta(seconds=15 * k)
            broker.expire_orders()
            broker.set_price(p)
            if broker._positions or broker._orders or engine.store.open_signals():
                for note in engine.manage_once():
                    res.management.append((broker.now, note))
        last_close = bar.close

    # Fin de période : on ferme ce qui reste au dernier prix
    broker.now = m1[-1].time + timedelta(minutes=1)
    current.clear()
    for row in engine.store.open_signals():
        await engine.close_signal(row, reason="fin du backtest")
    for note in current:
        res.management.append((broker.now, note))
    return res


# ---------------------------------------------------------------------------
# Rapport
# ---------------------------------------------------------------------------
def signal_pnl(res: Result, sid: int) -> float:
    return sum(v for c, v in res.broker.pnl_by_comment.items() if leg_index(c, sid) is not None)


def build_report(res: Result, cfg: Config, use_analyst: bool, ai_calls: Optional[dict]) -> str:
    db = res.engine.store.db
    signals = db.execute("SELECT * FROM signals ORDER BY id").fetchall()
    taken = [s for s in signals if s["status"] in ("open", "closed")]
    rejected = [s for s in signals if s["status"] == "rejected"]
    pnls = {s["id"]: signal_pnl(res, s["id"]) for s in taken}
    wins = [v for v in pnls.values() if v > 0.01]
    losses = [v for v in pnls.values() if v < -0.01]
    total = sum(pnls.values())
    final = res.broker.balance()

    peak, max_dd = res.balance0, 0.0
    for _, eq in res.broker.equity_curve:
        peak = max(peak, eq)
        max_dd = max(max_dd, peak - eq)

    actions: dict[str, int] = {}
    for j in res.journal:
        a = j["parsed"]["action"] if j["parsed"] else "ERREUR"
        actions[a] = actions.get(a, 0) + 1

    reasons: dict[str, int] = {}
    for j in res.journal:
        if j["parsed"] and j["parsed"]["action"] == Action.NEW_SIGNAL.value:
            for n in j["notes"]:
                if n.startswith(("⛔", "🤔", "⏭", "⏸")):
                    key = n.split("\n")[0][:90]
                    reasons[key] = reasons.get(key, 0) + 1

    L: list[str] = []
    L.append(f"# Backtest du bot or — {res.start:%d/%m %H:%M} → {res.end:%d/%m %H:%M} (heure serveur MT5)\n")
    sizing = (f"lot fixe {cfg.risk.fixed_lot} par signal" if cfg.risk.fixed_lot > 0
              else f"risque {cfg.risk.risk_per_trade_pct} % par trade")
    L.append(f"Filtre IA (Opus) : **{'activé (' + cfg.ai.analyst_mode + ')' if use_analyst else 'désactivé'}** · "
             f"{sizing} · solde de départ {res.balance0:,.2f} $\n")
    L.append("## Résumé\n")
    L.append("| | |\n|---|---|")
    L.append(f"| Messages lus | {len(res.journal)} |")
    L.append(f"| Signaux détectés | {actions.get('NEW_SIGNAL', 0)} |")
    L.append(f"| Trades pris | {len(taken)} |")
    L.append(f"| Signaux non pris | {max(0, actions.get('NEW_SIGNAL', 0) - len(taken))} |")
    L.append(f"| Gagnants / perdants / nuls | {len(wins)} / {len(losses)} / {len(taken) - len(wins) - len(losses)} |")
    if taken:
        L.append(f"| Taux de réussite | {100 * len(wins) / len(taken):.0f} % |")
    L.append(f"| **P&L total** | **{total:+,.2f} $ ({100 * total / res.balance0:+.2f} %)** |")
    L.append(f"| Solde final | {final:,.2f} $ |")
    L.append(f"| Pire baisse depuis un sommet | {max_dd:,.2f} $ ({100 * max_dd / res.balance0:.2f} %) |")
    if wins:
        L.append(f"| Gain moyen | {sum(wins) / len(wins):+,.2f} $ |")
    if losses:
        L.append(f"| Perte moyenne | {sum(losses) / len(losses):+,.2f} $ |")
    if ai_calls:
        cost = ai_calls["parser"] * 0.002 + ai_calls["analyst"] * 0.08
        L.append(f"| Appels IA | {ai_calls['parser']} lectures, {ai_calls['analyst']} analyses, "
                 f"{ai_calls['cached']} en cache (≈ {cost:.2f} $) |")
    L.append("")
    L.append("Consignes reconnues dans les messages : " +
             ", ".join(f"{k} {v}" for k, v in sorted(actions.items(), key=lambda x: -x[1])) + "\n")
    if reasons:
        L.append("## Pourquoi des signaux n'ont pas été pris\n")
        for k, v in sorted(reasons.items(), key=lambda x: -x[1]):
            L.append(f"- {v} × {k}")
        L.append("")

    L.append("## Trades\n")
    L.append("| # | Heure | Sens | Entrée | SL | TP | IA | TP atteint | P&L |")
    L.append("|---|---|---|---|---|---|---|---|---|")
    for s in taken:
        verdict = json.loads(s["verdict"]) if s["verdict"] else None
        v = f"{verdict['decision']} x{verdict['risk_multiplier']:.2f}" if verdict else "—"
        L.append(f"| {s['id']} | {s['server_time'][5:16].replace('T', ' ')} | {s['side']} | {s['entry']} | "
                 f"{s['sl']} | {', '.join(map(str, row_tps(s)))} | {v} | {s['tps_reached']} | "
                 f"{pnls[s['id']]:+,.2f} $ |")
    L.append("")

    L.append("## Journal complet\n")
    L.append("Chaque message du groupe, ce que le bot en a compris, et ce qu'il a fait.\n")
    events = sorted(
        [(j["msg"].time, 0, j) for j in res.journal] + [(t, 1, n) for t, n in res.management],
        key=lambda x: (x[0], x[1]),
    )
    for t, kind, item in events:
        if kind == 1:
            L.append(f"- `{t:%d/%m %H:%M}` ⚙️ {item.replace(chr(10), ' · ')}")
            continue
        j = item
        p = j["parsed"]
        what = p["action"] if p else "illisible"
        if p and p.get("extra_actions"):
            what += " + " + " + ".join(p["extra_actions"])
        text = j["msg"].text.strip().replace("\n", " ⏎ ")
        if len(text) > 160:
            text = text[:160] + "…"
        L.append(f"- `{t:%d/%m %H:%M}` 💬 « {text} » → **{what}**"
                 + (f" (certitude {p['confidence']:.0%})" if p and what != "IGNORE" else "")
                 + f" · prix {j['price']:.2f}")
        for n in j["notes"]:
            L.append(f"    - {n.replace(chr(10), ' · ')}")
    L.append("")
    L.append("## Limites de cette simulation\n")
    L.append("- Seule la version finale des messages est connue (pas les éditions successives), et les messages "
             "supprimés par l'admin n'apparaissent pas.")
    L.append("- Photos et vocaux ignorés. Un message est traité au prix de clôture de la minute où il arrive.")
    L.append("- Le spread vient des bougies M1 du broker (souvent le minimum de la minute). Pas de glissement "
             "simulé : la réalité sera un peu moins bonne.")
    L.append("- Dans une même minute, l'ordre haut/bas est deviné à partir de la couleur de la bougie.")
    return "\n".join(L)


def chart_data(res: Result, cfg: Config, use_analyst: bool) -> dict:
    """Tout ce qu'il faut à la page graphique : prix, trades (lots, sorties, SL), refus, courbe du solde."""
    db = res.engine.store.db
    b = res.broker

    def iso(t: datetime) -> str:
        return t.isoformat(timespec="seconds")

    m1 = [x for x in b.all_bars["M1"] if res.start <= x.time < res.end]
    t0 = m1[0].time
    price = [[int((x.time - t0).total_seconds() // 60), round(x.close, 2)] for x in m1]

    msg_text = {j["msg"].id: j["msg"].text for j in res.journal}
    trades, taken_msgs = [], set()
    for s in db.execute("SELECT * FROM signals WHERE status IN ('open','closed') ORDER BY id"):
        sid = s["id"]
        taken_msgs.add(s["msg_id"])
        plan = json.loads(s["plan"])
        verdict = json.loads(s["verdict"]) if s["verdict"] else None
        fills = [(t, p) for t, c, p in b.fills if leg_index(c, sid) is not None]
        exits = [{"t": iso(t), "leg": leg_index(c, sid), "price": round(p, 2), "vol": v, "pnl": round(pnl, 2)}
                 for t, c, p, v, pnl in b.closes if leg_index(c, sid) is not None]
        moves, seen = [], set()
        for t, c, sl, _ in b.sl_moves:
            if leg_index(c, sid) is not None and (iso(t), sl) not in seen:
                seen.add((iso(t), sl))
                moves.append({"t": iso(t), "sl": sl})
        trades.append({
            "id": sid, "side": s["side"], "t": s["server_time"],
            "fill_t": iso(min(fills)[0]) if fills else None,
            "entry": plan["entry"], "type": plan["order_type"], "sl": plan["sl"],
            "legs": [{"vol": l["volume"], "tp": l["tp"]} for l in plan["legs"]],
            "lot": round(sum(l["volume"] for l in plan["legs"]), 2), "risk": plan["risk_money"],
            "verdict": f"{verdict['decision']} ×{verdict['risk_multiplier']:.2f}" if verdict else None,
            "verdict_txt": verdict["summary"] if verdict else None,
            "exits": exits, "sl_moves": moves, "tps_reached": s["tps_reached"],
            "pnl": round(signal_pnl(res, sid), 2), "msg": msg_text.get(s["msg_id"], "")[:300],
        })

    refused = []
    for j in res.journal:
        p = j["parsed"]
        if not p or p["action"] != Action.NEW_SIGNAL.value or j["msg"].id in taken_msgs:
            continue
        reason = next((n.split("\n")[0] for n in j["notes"] if n.startswith(("⛔", "🤔", "⏭", "⏸"))), "non pris")
        refused.append({"t": iso(j["msg"].time), "side": p.get("side"), "price": j["price"],
                        "reason": reason, "msg": j["msg"].text[:300]})

    equity = [[iso(res.start), res.balance0]] + [[iso(t), round(v, 2)] for t, v in b.equity_curve]
    pnls = [t["pnl"] for t in trades]
    peak, max_dd = res.balance0, 0.0
    for _, eq in equity:
        peak = max(peak, eq)
        max_dd = max(max_dd, peak - eq)
    return {
        "title": f"Backtest {'avec' if use_analyst else 'sans'} filtre IA",
        "start": iso(res.start), "end": iso(res.end), "t0": iso(t0), "price": price,
        "trades": trades, "refused": refused, "equity": equity,
        "stats": {"balance0": res.balance0, "final": round(b.balance(), 2), "pnl": round(sum(pnls), 2),
                  "n": len(trades), "wins": sum(1 for v in pnls if v > 0.01),
                  "losses": sum(1 for v in pnls if v < -0.01), "max_dd": round(max_dd, 2),
                  "risk_pct": cfg.risk.risk_per_trade_pct, "fixed_lot": cfg.risk.fixed_lot, "signals": len(trades) + len(refused)},
    }


def build_chart(res: Result, cfg: Config, use_analyst: bool) -> str:
    template = (Path(__file__).parent / "chart_template.html").read_text(encoding="utf-8")
    data = json.dumps(chart_data(res, cfg, use_analyst), ensure_ascii=False).replace("</", "<\\/")
    return template.replace("/*__DATA__*/null", data)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
async def main_async(args) -> None:
    cfg = load_config(args.config)
    OUT.mkdir(parents=True, exist_ok=True)
    offset = args.offset if args.offset is not None else detect_server_offset(cfg)
    end_utc = datetime.now(timezone.utc).replace(tzinfo=None, second=0, microsecond=0)
    start_utc = end_utc - timedelta(days=args.days)
    start_srv, end_srv = start_utc + timedelta(hours=offset), end_utc + timedelta(hours=offset)
    print(f"Période : {start_srv:%d/%m %H:%M} → {end_srv:%d/%m %H:%M} (heure serveur, UTC{offset:+d})")

    msg_file, mkt_file = OUT / f"messages_{args.days}j.json", OUT / f"marche_{args.days}j.json"
    if args.refresh or not msg_file.exists():
        print("Téléchargement des messages Telegram…")
        msg_file.write_text(json.dumps(await fetch_messages(cfg, start_utc), ensure_ascii=False, indent=1),
                            encoding="utf-8")
    if args.refresh or not mkt_file.exists():
        print("Téléchargement des bougies MT5…")
        mkt_file.write_text(json.dumps(fetch_market(cfg, start_srv, end_srv)), encoding="utf-8")

    raw_msgs = json.loads(msg_file.read_text(encoding="utf-8"))
    market = json.loads(mkt_file.read_text(encoding="utf-8"))
    messages = [Msg(d["id"], datetime.fromisoformat(d["date_utc"]) + timedelta(hours=offset), d["text"],
                    d["reply_to"], d["edited"], d.get("fwd_from")) for d in raw_msgs]
    bars = {tf: [_bar_from_list(x) for x in rows] for tf, rows in market["bars"].items()}
    spreads = {datetime.fromisoformat(k): v for k, v in market["m1_spread"].items()}
    spec = SymbolSpec(*market["spec"])
    print(f"{len(messages)} messages, {len(bars['M1'])} bougies M1.")

    use_analyst = not args.no_analyst and cfg.ai.analyst_mode != "off"
    if not use_analyst:
        cfg = cfg.model_copy(update={"ai": cfg.ai.model_copy(update={"analyst_mode": "off"})})
    from .ai import AI

    env("ANTHROPIC_API_KEY")
    ai = CachedAI(AI(cfg.ai.parser_model, cfg.ai.analyst_model, cfg.ai.analyst_effort),
                  OUT / "cache_ia.json", use_analyst)
    print("Rejeu en cours (Claude lit chaque message, ça peut prendre quelques minutes)…")
    res = await replay(cfg, messages, bars, spec, market["contract_size"], ai, start_srv, end_srv,
                       args.balance, spreads)

    report = build_report(res, cfg, use_analyst, ai.calls)
    name = f"rapport_{args.days}j_{'ia' if use_analyst else 'sans_ia'}_{datetime.now():%Y%m%d_%H%M}.md"
    (OUT / name).write_text(report, encoding="utf-8")
    chart = OUT / name.replace("rapport_", "graphique_").replace(".md", ".html")
    chart.write_text(build_chart(res, cfg, use_analyst), encoding="utf-8")
    summary = report.split("## Trades")[0]
    print("\n" + summary)
    print(f"Rapport complet : {OUT / name}")
    print(f"Graphique (ouvre-le dans ton navigateur) : {chart}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Backtest du bot or sur les derniers jours du groupe")
    parser.add_argument("--days", type=int, default=5)
    parser.add_argument("--balance", type=float, default=10_000, help="solde de départ simulé (en $)")
    parser.add_argument("--no-analyst", action="store_true", help="sans le filtre IA Opus (quasi gratuit)")
    parser.add_argument("--refresh", action="store_true", help="re-télécharger messages et bougies")
    parser.add_argument("--offset", type=int, default=None, help="décalage heure serveur MT5 - UTC, en heures")
    parser.add_argument("--config", default="config.yaml")
    args = parser.parse_args()
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    from dotenv import load_dotenv

    load_dotenv()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()

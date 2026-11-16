"""Construction des messages Discord (embeds + boutons). Fonctions pures : faciles à tester."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

import discord

GOLD = 0xE3B341
GREEN = 0x3FB950
RED = 0xF85149
GREY = 0x8B949E
BLUE = 0x58A6FF
ORANGE = 0xF0883E


def money(v: Optional[float]) -> str:
    if v is None:
        return "–"
    return f"{v:+,.2f}".replace(",", " ")


def num(v: Optional[float], d: int = 2) -> str:
    if v is None:
        return "–"
    return f"{v:,.{d}f}".replace(",", " ")


def side_icon(side: str) -> str:
    return "🟢 BUY" if side == "BUY" else "🔴 SELL"


def gauge(used: float, limit: float, width: int = 10) -> str:
    if limit <= 0:
        return "désactivée"
    ratio = max(0.0, min(1.0, used / limit))
    filled = round(ratio * width)
    return "▰" * filled + "▱" * (width - filled) + f" {ratio:.0%}"


def short(text: Optional[str], n: int = 300) -> str:
    text = (text or "").strip()
    return text if len(text) <= n else text[: n - 1] + "…"


def quote(text: Optional[str], n: int = 600) -> str:
    t = short(text, n)
    return "\n".join("> " + line for line in t.splitlines()) if t else "> (vide)"


def ts(dt: Optional[datetime] = None, style: str = "R") -> str:
    """Horodatage Discord (s'affiche dans le fuseau de chacun : « il y a 3 min »...)."""
    return f"<t:{int((dt or datetime.now()).timestamp())}:{style}>"


def button(label: str, custom_id: str, style=discord.ButtonStyle.secondary, emoji: Optional[str] = None,
           disabled: bool = False) -> discord.ui.Button:
    return discord.ui.Button(label=label, custom_id=custom_id, style=style, emoji=emoji, disabled=disabled)


def view_of(*items: discord.ui.Item) -> discord.ui.View:
    v = discord.ui.View(timeout=None)
    for it in items:
        v.add_item(it)
    return v


# ------------------------------------------------------------------ tableau de bord
def dashboard_embed(s: dict, trades: list[dict]) -> discord.Embed:
    if s["paused"]:
        state, color = "⏸ **EN PAUSE** — aucun nouveau trade", GOLD
    else:
        state, color = "● **ACTIF** — suit les signaux du groupe", GREEN
    mode = "🧪 DRY RUN (aucun ordre envoyé)" if s["dry_run"] else f"Compte **{s['account_mode']}**"
    e = discord.Embed(title="📊 Tableau de bord — Bot Or", description=f"{state}\n{mode}", color=color)
    e.add_field(name="💰 Solde", value=f"**{num(s['balance'])}**\nflottant {money(s['floating'])}")
    e.add_field(name="📅 P&L du jour", value=f"**{money(s['realized_today'])}**\n{s['trades_today']}/{s['max_trades_per_day']} trades")
    e.add_field(name="🛡 Risque ouvert", value=f"**{num(s['open_risk'])}**\nsi tous les SL sont touchés")
    e.add_field(name="🚦 Limite de perte du jour",
                value=f"{gauge(s['daily_loss_used'], s['daily_loss_limit'])}\n{num(s['daily_loss_used'])} / {num(s['daily_loss_limit'])}",
                inline=False)
    sizing = f"lot fixe {s['fixed_lot']:g}" if s.get("fixed_lot") else f"{s['risk_pct']:g} % par trade"
    approval = {"off": "jamais", "doubts": "quand l'IA doute", "always": "à chaque signal"}[s["approval_mode"]]
    ia = {"filter": "filtre", "advisory": "avis seulement", "off": "désactivée"}[s["analyst_mode"]]
    e.add_field(name="⚙️ Réglages", value=f"Taille : {sizing}\nIA : {ia}\nTon avis : {approval}")
    e.add_field(name=f"📈 {s['symbol']}", value=f"{num(s['bid'])} / {num(s['ask'])}\nheure serveur {s['server_time']}")
    if s.get("skip_next"):
        e.add_field(name="⏭ À sauter", value=f"{s['skip_next']} prochain(s) signal(aux)")
    if trades:
        lines = [f"{side_icon(t['side'])} **#{t['id']}** {num(t['volume'])} lot · entrée {num(t['entry'])} · "
                 f"SL {num(t['positions'][0]['sl'] if t['positions'] else t['sl'])} · "
                 f"TP{t['tps_reached']}/{len(t['tps'])} · **{money(t['floating'])}**" for t in trades]
        e.add_field(name=f"💹 Trades en cours ({len(trades)})", value="\n".join(lines)[:1024], inline=False)
    else:
        e.add_field(name="💹 Trades en cours", value="Aucun. Le bot attend un signal du groupe.", inline=False)
    e.set_footer(text="Mis à jour automatiquement")
    e.timestamp = datetime.now()
    return e


def dashboard_view(paused: bool) -> discord.ui.View:
    return view_of(
        button("Reprendre" if paused else "Pause", "ctl:resume" if paused else "ctl:pause",
               discord.ButtonStyle.success if paused else discord.ButtonStyle.secondary, "▶️" if paused else "⏸"),
        button("Sauter le prochain signal", "ctl:skip", emoji="⏭"),
        button("Tout fermer", "ctl:closeall", discord.ButtonStyle.danger, "🚪"),
        button("Stats", "ctl:stats", emoji="📈"),
        button("Actualiser", "ctl:refresh", emoji="🔄"),
    )


# ------------------------------------------------------------------ trades
def trade_embed(t: dict) -> discord.Embed:
    color = GREEN if t["floating"] > 0 else RED if t["floating"] < 0 else GOLD
    pending = bool(t["orders"]) and not t["positions"]
    title = f"{side_icon(t['side'])} — Trade #{t['id']} · {num(t['volume'])} lot"
    desc = "⏳ **Ordre limite en attente** de déclenchement" if pending else f"P&L flottant : **{money(t['floating'])}**"
    e = discord.Embed(title=title, description=desc, color=color)
    cur_sl = t["positions"][0]["sl"] if t["positions"] else (t["orders"][0]["sl"] if t["orders"] else t["sl"])
    entry = t["entry"]
    sl_label = num(cur_sl)
    if cur_sl and entry and t["original_sl"] and abs(cur_sl - t["original_sl"]) > 0.01:
        protected = (cur_sl >= entry) if t["side"] == "BUY" else (cur_sl <= entry)
        sl_label += " 🛡 (protégé)" if protected else f" (était {num(t['original_sl'])})"
    e.add_field(name="Entrée", value=num(entry))
    e.add_field(name="Stop loss", value=sl_label)
    e.add_field(name="Risque initial", value=num(t["risk"]) if t["risk"] is not None else "–")
    tp_lines = []
    open_legs = {p["leg"]: p for p in t["positions"]} | {o["leg"]: o for o in t["orders"]}
    for i, tp in enumerate(t["tps"], start=1):
        leg = open_legs.get(i)
        if i <= t["tps_reached"]:
            tp_lines.append(f"✅ TP{i} **{num(tp)}** — atteint")
        elif leg:
            pnl = f" · {money(leg['profit'])}" if "profit" in leg else ""
            tp_lines.append(f"🎯 TP{i} **{num(tp)}** — {num(leg['volume'])} lot{pnl}")
        else:
            tp_lines.append(f"▫️ TP{i} {num(tp)}")
    e.add_field(name="Objectifs", value="\n".join(tp_lines) or "–", inline=False)
    if t.get("verdict"):
        v = t["verdict"]
        e.add_field(name=f"🧠 IA : {v['decision']}", value=short(v.get("summary"), 300), inline=False)
    if t.get("message"):
        e.add_field(name="Message du groupe", value=quote(t["message"], 300), inline=False)
    try:
        e.set_footer(text=f"Ouvert le {datetime.fromisoformat(t['created']):%d/%m à %H:%M} (heure serveur)")
    except (TypeError, ValueError):
        pass
    return e


def trade_view(t: dict) -> discord.ui.View:
    sid = t["id"]
    has_pos = bool(t["positions"])
    return view_of(
        button("SL au BE", f"trade:be:{sid}", emoji="🛡", disabled=not has_pos),
        button("Fermer 50 %", f"trade:half:{sid}", emoji="✂️", disabled=not has_pos),
        button("Modifier SL/TP", f"trade:edit:{sid}", emoji="✏️"),
        button("Fermer", f"trade:close:{sid}", discord.ButtonStyle.danger, "🚪"),
    )


def closed_embed(data: dict, history_row: Optional[dict]) -> discord.Embed:
    pnl = data.get("pnl")
    color = GREEN if (pnl or 0) > 0 else RED if (pnl or 0) < 0 else GREY
    icon = "🏆" if (pnl or 0) > 0 else "💥" if (pnl or 0) < 0 else "➖"
    e = discord.Embed(title=f"{icon} Trade #{data['sid']} terminé — {money(pnl)}",
                      description=f"{side_icon(data.get('side', ''))} · {data.get('reason') or ''}", color=color)
    if history_row:
        e.add_field(name="Entrée", value=num(history_row.get("entry")))
        e.add_field(name="SL d'origine", value=num(history_row.get("sl")))
        e.add_field(name="TP atteints", value=f"{history_row.get('tps_reached', 0)}/{len(history_row.get('tps') or [])}")
        if history_row.get("message"):
            e.add_field(name="Signal", value=quote(history_row["message"], 300), inline=False)
    e.timestamp = datetime.now()
    return e


# ------------------------------------------------------------------ signaux
ACTION_LABELS = {
    "NEW_SIGNAL": "📥 Nouveau signal", "MOVE_SL_BE": "🛡 SL au break-even", "MODIFY_SL": "✏️ Nouveau SL",
    "MODIFY_TP": "🎯 Nouveaux TP", "CLOSE_ALL": "🚪 Tout fermer", "CLOSE_PARTIAL": "✂️ Fermeture partielle",
    "CANCEL": "🗑 Annulation", "SKIP_NEXT": "⏭ Ne pas prendre le prochain", "IGNORE": "💬 Rien à faire",
}


def message_embed(d: dict) -> discord.Embed:
    action = d.get("action")
    label = ACTION_LABELS.get(action or "", "❓ Pas compris")
    color = BLUE if action == "NEW_SIGNAL" else GREY if action in (None, "IGNORE") else GOLD
    e = discord.Embed(description=quote(d.get("text"), 1500), color=color)
    e.set_author(name=f"Telegram{' (modifié)' if d.get('edited') else ''} · {label}")
    if d.get("notes") and action not in (None, "IGNORE"):
        e.set_footer(text=f"🤖 {short(d['notes'], 200)}")
    return e


def rejected_embed(d: dict, title: str = "⛔ Signal non pris") -> discord.Embed:
    zone = num(d["entry_low"]) if d["entry_low"] == d["entry_high"] else f"{num(d['entry_low'])} – {num(d['entry_high'])}"
    e = discord.Embed(title=f"{title} — {side_icon(d['side'])} {zone}",
                      description=f"**Raison :** {d.get('reason', '')}", color=RED)
    e.add_field(name="SL", value=num(d["sl"]))
    e.add_field(name="TP", value=" / ".join(num(x) for x in d.get("tps") or []) or "–")
    v = d.get("verdict")
    if v:
        e.add_field(name=f"🧠 IA : {v.get('decision')}", value=short(v.get("summary"), 400), inline=False)
    return e


def rejected_view(sid: int) -> discord.ui.View:
    return view_of(
        button("Prendre quand même", f"take:{sid}:1", discord.ButtonStyle.success, "✅"),
        button("Prendre la moitié", f"take:{sid}:0.5", emoji="🌓"),
    )


def ignored_embed(d: dict) -> discord.Embed:
    e = discord.Embed(title="🤔 Message ignoré", description=f"**Raison :** {d.get('reason')}", color=ORANGE)
    if d.get("text"):
        e.add_field(name="Message", value=quote(d["text"], 400), inline=False)
    return e


def opened_embed(d: dict) -> discord.Embed:
    e = discord.Embed(
        title=f"{'🧪 [DRY RUN] ' if d.get('dry_run') else '✅ '}Trade #{d['sid']} ouvert — {side_icon(d['side'])}",
        description=(f"{num(d['volume'])} lot · {'marché' if d['order_type'] == 'market' else 'ordre limite'} "
                     f"{num(d['entry'])} · SL {num(d['sl'])} · risque **{num(d['risk'])}**"),
        color=GREEN)
    if d.get("notes"):
        e.add_field(name="ℹ️", value=short(" / ".join(d["notes"]), 500), inline=False)
    if d.get("refused"):
        e.add_field(name="⚠️ Ordres refusés", value=short("; ".join(d["refused"]), 500), inline=False)
    return e


# ------------------------------------------------------------------ validations
def approval_embed(req: dict, deadline: datetime) -> discord.Embed:
    zone = num(req["entry_low"]) if req["entry_low"] == req["entry_high"] else f"{num(req['entry_low'])} – {num(req['entry_high'])}"
    v = req.get("verdict")
    auto = req["auto_multiplier"]
    auto_txt = "refuser" if auto <= 0 else ("prendre" if auto >= 1 else f"prendre x{auto:g}")
    e = discord.Embed(title=f"✋ Ton avis ? {side_icon(req['side'])} GOLD {zone}",
                      description=(f"SL **{num(req['sl'])}** · TP {' / '.join(num(x) for x in req['tps']) or '–'}\n"
                                   f"Décision automatique : **{auto_txt}**"),
                      color=GOLD)
    if v:
        txt = short(v.get("summary"), 700)
        if v.get("warnings"):
            txt += "\n⚠️ " + short(" / ".join(v["warnings"]), 300)
        e.add_field(name=f"🧠 IA : {v.get('decision')} (x{v.get('risk_multiplier', 0):g}, confiance {v.get('confidence', 0):.0%})",
                    value=txt, inline=False)
    if req.get("note"):
        e.add_field(name="⚠️", value=short(req["note"], 300), inline=False)
    p = req.get("preview")
    if p:
        e.add_field(name="Si tu prends (taille normale)",
                    value=f"{num(p['volume'])} lot · {'marché' if p['order_type'] == 'market' else 'limite'} {num(p['entry'])} · "
                          f"risque {num(p['risk'])}", inline=False)
    timeout_txt = {"auto": "décision automatique", "take": "on prend", "skip": "on ne prend pas"}[req["on_timeout"]]
    e.add_field(name="⏱", value=f"Sans réponse {ts(deadline)} : {timeout_txt}", inline=False)
    if req.get("text"):
        e.add_field(name="Message du groupe", value=quote(req["text"], 400), inline=False)
    return e


def approval_view(rid: str, disabled: bool = False) -> discord.ui.View:
    return view_of(
        button("Prendre", f"approve:{rid}:1", discord.ButtonStyle.success, "✅", disabled),
        button("Moitié", f"approve:{rid}:0.5", discord.ButtonStyle.primary, "🌓", disabled),
        button("Refuser", f"approve:{rid}:0", discord.ButtonStyle.danger, "❌", disabled),
    )


# ------------------------------------------------------------------ stats
def stats_embed(st: dict, title: str) -> discord.Embed:
    color = GREEN if st["total"] > 0 else RED if st["total"] < 0 else GREY
    e = discord.Embed(title=title, color=color)
    e.add_field(name="💰 Gain total", value=f"**{money(st['total'])}**\n{st['closed']} trades fermés")
    e.add_field(name="🎯 Réussite", value=(f"**{st['winrate']:g} %**" if st["winrate"] is not None else "–")
                + f"\n{st['wins']} ✅ · {st['losses']} ❌")
    e.add_field(name="⚖️ Facteur de profit", value=(f"**{st['profit_factor']:g}**" if st["profit_factor"] else "–")
                + "\n> 1 = rentable")
    e.add_field(name="Gain moyen / perte moyenne", value=f"{money(st['avg_win'])} / {money(st['avg_loss'])}")
    e.add_field(name="Meilleur / pire", value=f"{money(st['best'])} / {money(st['worst'])}")
    streak = st.get("current_streak", 0)
    e.add_field(name="🔥 Série", value=(f"{streak} gagnant(s) d'affilée" if streak > 0 else
                                        f"{-streak} perdant(s) d'affilée" if streak < 0 else "–")
                + f"\nrecord : {st.get('best_win_streak', 0)}")
    e.add_field(name="📅 Périodes", value=f"24 h {money(st['today'])} · 7 j {money(st['week'])} · 30 j {money(st['month'])}",
                inline=False)
    sig = f"{st['signals_total']} reçus · {st['signals_taken']} pris · {st['signals_rejected']} non pris"
    if st.get("reject_reasons"):
        sig += "\n" + "\n".join(f"• {r} ({n})" for r, n in st["reject_reasons"])
    e.add_field(name="📡 Signaux", value=short(sig, 1000), inline=False)
    e.timestamp = datetime.now()
    return e


def market_embed(view, bid: float, ask: float) -> discord.Embed:
    color = {"BULLISH": GREEN, "BEARISH": RED}.get(view.bias.value, GREY)
    label = {"BULLISH": "📈 Haussier", "BEARISH": "📉 Baissier", "NEUTRAL": "↔️ Neutre"}[view.bias.value]
    e = discord.Embed(title=f"🧠 Analyse de l'or — {label} (confiance {view.confidence:.0%})",
                      description=view.summary, color=color)
    if view.timeframes:
        e.add_field(name="Timeframes", value=short("\n".join(view.timeframes), 1000), inline=False)
    e.add_field(name="Supports", value=" · ".join(num(x) for x in view.supports[:4]) or "–")
    e.add_field(name="Résistances", value=" · ".join(num(x) for x in view.resistances[:4]) or "–")
    e.add_field(name="Prix", value=f"{num(bid)} / {num(ask)}")
    if view.scenario:
        e.add_field(name="Scénario probable", value=short(view.scenario, 1000), inline=False)
    if view.risks:
        e.add_field(name="Ce qui l'invaliderait", value=short("\n".join(f"• {r}" for r in view.risks), 1000), inline=False)
    e.set_footer(text="Lecture de marché, pas un conseil financier.")
    return e


def indicators_embed(summaries: list[dict], bid: float, ask: float) -> discord.Embed:
    e = discord.Embed(title=f"📈 Or — {num(bid)} / {num(ask)}", color=GOLD)
    for s in summaries:
        if s.get("error"):
            e.add_field(name=s["timeframe"], value=s["error"])
            continue
        trend = "🟢" if "haussière" in s["structure"] else "🔴" if "baissière" in s["structure"] else "⚪"
        e.add_field(name=f"{trend} {s['timeframe']}",
                    value=(f"{s['price_vs_ema']}\nRSI {s['rsi14']} · ATR {s['atr14']}\n{s['structure']}\n"
                           f"range 50 : {num(s['range_low_50'])} – {num(s['range_high_50'])}"))
    e.set_footer(text="Indicateurs calculés sur les bougies de ton broker (gratuit, sans IA).")
    return e


def settings_embed(cfg: dict) -> discord.Embed:
    r, m, a, d = cfg["risk"], cfg["management"], cfg["ai"], cfg["discord"]
    e = discord.Embed(title="⚙️ Réglages du bot", color=BLUE,
                      description="Change-les avec les menus ci-dessous, ou `/regler`. Effet immédiat.")
    sizing = f"lot fixe **{r['fixed_lot']:g}**" if r.get("fixed_lot") else f"**{r['risk_per_trade_pct']:g} %** du solde"
    e.add_field(name="💰 Taille", value=f"{sizing}\nperte max/jour **{r['max_daily_loss_pct']:g} %**")
    e.add_field(name="🚦 Limites", value=f"{r['max_trades_per_day']} trades/jour\n{r['max_open_signals']} ouverts max")
    e.add_field(name="📏 Filtres", value=f"spread ≤ {r['max_spread']:g} $\nSL {r['min_sl_distance']:g}–{r['max_sl_distance']:g} $")
    split = " / ".join(f"{x * 100:.0f}" for x in m["tp_split"])
    e.add_field(name="🎯 Gestion", value=f"TP : {split} %\nBE après TP{m['breakeven_after_tp']}\n"
                                        f"trailing : {'oui' if m['trail_to_previous_tp'] else 'non'}")
    e.add_field(name="🧠 IA", value={"filter": "filtre (peut refuser/réduire)", "advisory": "avis seulement",
                                     "off": "désactivée"}[a["analyst_mode"]])
    e.add_field(name="✋ Ton avis", value={"off": "jamais", "doubts": "quand l'IA doute", "always": "à chaque signal"}[d["approval_mode"]]
                + f"\n{d['approval_timeout_seconds']} s pour répondre")
    return e


def settings_view(cfg: dict) -> discord.ui.View:
    d, a = cfg["discord"], cfg["ai"]
    approval = discord.ui.Select(custom_id="set:approval", placeholder="Quand te demander ton avis ?", options=[
        discord.SelectOption(label="Quand l'IA doute", value="doubts", emoji="🤔", default=d["approval_mode"] == "doubts"),
        discord.SelectOption(label="À chaque signal", value="always", emoji="✋", default=d["approval_mode"] == "always"),
        discord.SelectOption(label="Jamais (100 % auto)", value="off", emoji="🤖", default=d["approval_mode"] == "off"),
    ])
    ia = discord.ui.Select(custom_id="set:analyst", placeholder="Rôle de l'IA d'analyse", options=[
        discord.SelectOption(label="Filtre : peut refuser ou réduire", value="filter", emoji="🛡", default=a["analyst_mode"] == "filter"),
        discord.SelectOption(label="Avis seulement", value="advisory", emoji="💬", default=a["analyst_mode"] == "advisory"),
        discord.SelectOption(label="Désactivée", value="off", emoji="⛔", default=a["analyst_mode"] == "off"),
    ])
    return view_of(approval, ia,
                   button("Risque −", "set:risk:-", emoji="➖"),
                   button("Risque +", "set:risk:+", emoji="➕"),
                   button("Tout modifier…", "set:modal", discord.ButtonStyle.primary, "✏️"))

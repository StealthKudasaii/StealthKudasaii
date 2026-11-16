"""Le bot Discord : tout voir et tout piloter depuis un serveur Discord.

- /setup crée en une commande la catégorie, les salons, le rôle et les panneaux.
- Chaque trade a sa carte mise à jour en direct, avec des boutons (BE, fermer 50 %, modifier, fermer).
- Les signaux douteux te sont soumis (Prendre / Moitié / Refuser), les refusés peuvent être pris quand même.
- Tableau de bord en direct, réglages en menus, stats + courbe, récap quotidien, alertes, journal.
"""
from __future__ import annotations

import asyncio
import io
import logging
import secrets
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Optional

import discord
from discord import app_commands

from .. import views
from ..broker import TIMEFRAMES
from ..config import OVERRIDES_PATH
from ..engine import Engine
from ..indicators import summarize_timeframe
from ..panel import apply_settings, current_settings
from . import embeds as E
from .charts import equity_png
from .state import CHANNELS, DiscordState

log = logging.getLogger(__name__)

BOT_PERMISSIONS = discord.Permissions(
    view_channel=True, send_messages=True, embed_links=True, attach_files=True, read_message_history=True,
    manage_messages=True, manage_channels=True, manage_roles=True, mention_everyone=False,
)


def parse_price(text: str) -> Optional[float]:
    text = (text or "").strip().replace(",", ".").replace(" ", "")
    if not text:
        return None
    return float(text)


class GoldDiscordBot(discord.Client):
    def __init__(self, engine: Engine, state_path: Path = Path("data/discord.json"),
                 overrides_path: Path = OVERRIDES_PATH):
        super().__init__(intents=discord.Intents.default())
        self.engine = engine
        self.state_path = state_path
        self.overrides_path = overrides_path
        self.state = DiscordState.load(state_path)
        self.tree = app_commands.CommandTree(self)
        self.pending: dict[str, asyncio.Future] = {}
        self._hashes: dict[str, int] = {}
        self._loops_started = False
        self._register_commands()
        engine.listeners.append(self.on_engine_event)
        engine.approver = self.approve

    @property
    def cfg(self):
        return self.engine.cfg.discord

    # ================================================================ outils
    def save(self) -> None:
        self.state.save(self.state_path)

    def channel(self, key: str) -> Optional[discord.TextChannel]:
        cid = self.state.channels.get(key)
        ch = self.get_channel(cid) if cid else None
        return ch if isinstance(ch, discord.TextChannel) else None

    def role_mention(self) -> str:
        return f"<@&{self.state.role_id}>" if self.state.role_id else ""

    async def send(self, key: str, **kwargs) -> Optional[discord.Message]:
        ch = self.channel(key)
        if ch is None:
            return None
        try:
            return await ch.send(**kwargs)
        except discord.HTTPException:
            log.exception("Discord : envoi impossible dans %s", key)
            return None

    async def journal(self, text: str) -> None:
        if self.is_ready():
            await self.send("journal", content=text[:1990], allowed_mentions=discord.AllowedMentions.none())

    def allowed(self, interaction: discord.Interaction) -> bool:
        user = interaction.user
        if interaction.guild is None or not isinstance(user, discord.Member):
            return False
        if interaction.guild.owner_id == user.id or user.guild_permissions.administrator:
            return True
        return any(r.id == self.state.role_id or r.name == self.cfg.role_name for r in user.roles)

    async def deny(self, interaction: discord.Interaction) -> None:
        msg = f"⛔ Réservé au rôle **{self.cfg.role_name}** et aux admins."
        if interaction.response.is_done():
            await interaction.followup.send(msg, ephemeral=True)
        else:
            await interaction.response.send_message(msg, ephemeral=True)

    async def locked(self, fn, *args):
        """Les actions sur les trades passent par le même verrou que le moteur (jamais deux ordres en même temps)."""
        async with self.engine._lock:
            result = await fn(*args)
        await self.engine.flush_events()
        return result

    def open_row(self, sid: int):
        row = self.engine.store.signal(sid)
        if row is None or row["status"] != "open":
            raise ValueError(f"le trade #{sid} n'est pas (ou plus) ouvert")
        return row

    @staticmethod
    def _hash(embed: discord.Embed, extra: Any = None) -> int:
        d = embed.to_dict()
        d.pop("timestamp", None)
        return hash((repr(sorted(d.items(), key=lambda kv: kv[0])), repr(extra)))

    # ============================================================ démarrage
    async def on_ready(self) -> None:
        log.info("Discord connecté en tant que %s", self.user)
        url = discord.utils.oauth_url(self.user.id, permissions=BOT_PERMISSIONS,
                                      scopes=("bot", "applications.commands"))
        Path("data").mkdir(exist_ok=True)
        Path("data/discord_invite.txt").write_text(url, encoding="utf-8")
        if not self.guilds:
            log.warning("Le bot Discord n'est sur aucun serveur. Invite-le avec ce lien : %s", url)
        for guild in self.guilds:
            await self.sync_commands(guild)
        if not self.state.channels:
            log.warning("Discord : tape /setup sur ton serveur pour créer les salons du bot.")
        if not self._loops_started:
            self._loops_started = True
            asyncio.create_task(self._refresh_loop())
            asyncio.create_task(self._recap_loop())

    async def on_guild_join(self, guild: discord.Guild) -> None:
        await self.sync_commands(guild)

    async def sync_commands(self, guild: discord.Guild) -> None:
        try:
            self.tree.copy_global_to(guild=guild)
            await self.tree.sync(guild=guild)
            log.info("Commandes Discord prêtes sur %s", guild.name)
        except discord.HTTPException:
            log.exception("Synchronisation des commandes impossible sur %s", guild.name)

    # ================================================================ /setup
    async def setup_server(self, guild: discord.Guild, member: Optional[discord.Member]) -> list[str]:
        done: list[str] = []
        role = guild.get_role(self.state.role_id or 0) or discord.utils.get(guild.roles, name=self.cfg.role_name)
        if role is None:
            role = await guild.create_role(name=self.cfg.role_name, colour=discord.Colour(E.GOLD), mentionable=True,
                                           reason="Bot Or : /setup")
            done.append(f"rôle {role.mention} créé")
        if member is not None and role not in member.roles:
            try:
                await member.add_roles(role, reason="Bot Or : /setup")
                done.append(f"rôle donné à {member.mention}")
            except discord.Forbidden:
                done.append("⚠️ impossible de te donner le rôle (monte le rôle du bot au-dessus dans les réglages du serveur)")

        overwrites = {
            guild.default_role: discord.PermissionOverwrite(view_channel=False),
            role: discord.PermissionOverwrite(view_channel=True, read_message_history=True, send_messages=False,
                                              use_application_commands=True, add_reactions=True),
            guild.me: discord.PermissionOverwrite(view_channel=True, send_messages=True, embed_links=True,
                                                  attach_files=True, manage_messages=True, read_message_history=True),
        }
        category = guild.get_channel(self.state.category_id or 0)
        if not isinstance(category, discord.CategoryChannel):
            category = discord.utils.get(guild.categories, name=self.cfg.category_name)
        if category is None:
            category = await guild.create_category(self.cfg.category_name, overwrites=overwrites, reason="Bot Or : /setup")
            done.append(f"catégorie **{category.name}** créée (privée)")
        else:
            await category.edit(overwrites=overwrites, reason="Bot Or : /setup")

        channels: dict[str, int] = {}
        created = 0
        for key, (name, topic) in CHANNELS.items():
            ch = guild.get_channel(self.state.channels.get(key, 0))
            if not isinstance(ch, discord.TextChannel):
                ch = discord.utils.get(category.text_channels, name=name)
            if ch is None:
                ch = await guild.create_text_channel(name, category=category, topic=topic, reason="Bot Or : /setup")
                created += 1
            channels[key] = ch.id
        if created:
            done.append(f"{created} salon(s) créé(s)")

        self.state.guild_id, self.state.category_id, self.state.role_id = guild.id, category.id, role.id
        self.state.channels = channels
        self.save()

        dash = self.channel("dashboard")
        if dash is not None and self.state.dashboard_msg is None:
            await dash.send(embed=self.help_embed())
        self.state.dashboard_msg = await self._ensure_message("dashboard", self.state.dashboard_msg, pin=True)
        self.state.settings_msg = await self._ensure_message("settings", self.state.settings_msg, pin=True)
        self.save()
        await self.refresh_dashboard(force=True)
        await self.refresh_settings(force=True)
        await self.refresh_cards(force=True)
        done.append("tableau de bord, réglages et cartes des trades en place")
        return done

    async def _ensure_message(self, key: str, msg_id: Optional[int], pin: bool = False) -> Optional[int]:
        ch = self.channel(key)
        if ch is None:
            return None
        if msg_id:
            try:
                await ch.fetch_message(msg_id)
                return msg_id
            except discord.HTTPException:
                pass
        msg = await ch.send(embed=discord.Embed(description="Chargement…", color=E.GREY))
        if pin:
            try:
                await msg.pin()
            except discord.HTTPException:
                pass
        return msg.id

    def help_embed(self) -> discord.Embed:
        e = discord.Embed(title="🟡 Bot Or — mode d'emploi", color=E.GOLD, description=(
            "Le bot copie les signaux du groupe Telegram sur MT5. Ici, tu vois **tout** et tu **pilotes** tout.\n\n"
            "**Salons**\n"
            "📊 tableau de bord · ✋ validations (ton avis) · 💹 trades en cours · 📡 signaux · 📜 historique · "
            "📈 stats · ⚙️ réglages · 🚨 alertes · 🧾 journal\n\n"
            "**Commandes**\n"
            "`/statut` `/pause` `/reprendre` `/fermer-tout` `/sauter`\n"
            "`/trades` `/fermer` `/be` `/sl` `/tp`\n"
            "`/risque` `/lot-fixe` `/validation` `/ia` `/regler`\n"
            "`/stats` `/historique` `/marche` `/analyse` `/aide`\n\n"
            "Les boutons sous chaque carte font la même chose en un clic."))
        e.set_footer(text="Seuls le rôle Trader Or et les admins peuvent piloter le bot.")
        return e

    # ======================================================= mises à jour
    async def refresh_dashboard(self, force: bool = False) -> None:
        ch = self.channel("dashboard")
        if ch is None or not self.state.dashboard_msg:
            return
        status = await views.status_data(self.engine)
        trades = await views.trades_data(self.engine)
        embed = E.dashboard_embed(status, trades)
        h = self._hash(embed, status["paused"])
        if not force and self._hashes.get("dashboard") == h:
            return
        try:
            msg = ch.get_partial_message(self.state.dashboard_msg)
            await msg.edit(embed=embed, view=E.dashboard_view(status["paused"]))
            self._hashes["dashboard"] = h
        except discord.NotFound:
            self.state.dashboard_msg = await self._ensure_message("dashboard", None, pin=True)
            self.save()
        except discord.HTTPException:
            log.exception("tableau de bord Discord")

    async def refresh_settings(self, force: bool = False) -> None:
        ch = self.channel("settings")
        if ch is None or not self.state.settings_msg:
            return
        cfg = current_settings(self.engine)
        embed = E.settings_embed(cfg)
        h = self._hash(embed)
        if not force and self._hashes.get("settings") == h:
            return
        try:
            await ch.get_partial_message(self.state.settings_msg).edit(embed=embed, view=E.settings_view(cfg))
            self._hashes["settings"] = h
        except discord.NotFound:
            self.state.settings_msg = await self._ensure_message("settings", None, pin=True)
            self.save()
        except discord.HTTPException:
            log.exception("panneau réglages Discord")

    async def upsert_card(self, t: dict, force: bool = False) -> None:
        ch = self.channel("trades")
        if ch is None:
            return
        key = str(t["id"])
        embed, view = E.trade_embed(t), E.trade_view(t)
        h = self._hash(embed, bool(t["positions"]))
        if not force and self._hashes.get("card" + key) == h and key in self.state.cards:
            return
        msg_id = self.state.cards.get(key)
        try:
            if msg_id:
                await ch.get_partial_message(msg_id).edit(embed=embed, view=view)
            else:
                msg = await ch.send(embed=embed, view=view)
                self.state.cards[key] = msg.id
                self.save()
            self._hashes["card" + key] = h
        except discord.NotFound:
            self.state.cards.pop(key, None)
            self.save()
        except discord.HTTPException:
            log.exception("carte du trade #%s", key)

    async def delete_card(self, sid: int) -> None:
        msg_id = self.state.cards.pop(str(sid), None)
        self._hashes.pop(f"card{sid}", None)
        self.save()
        ch = self.channel("trades")
        if ch is not None and msg_id:
            try:
                await ch.get_partial_message(msg_id).delete()
            except discord.HTTPException:
                pass

    async def refresh_cards(self, force: bool = False) -> None:
        trades = await views.trades_data(self.engine)
        open_ids = {str(t["id"]) for t in trades}
        for t in trades:
            await self.upsert_card(t, force)
        for key in list(self.state.cards):
            if key not in open_ids:
                await self.delete_card(int(key))

    async def refresh_card(self, sid: int) -> None:
        for t in await views.trades_data(self.engine):
            if t["id"] == sid:
                await self.upsert_card(t)
                return
        await self.delete_card(sid)

    async def _refresh_loop(self) -> None:
        while not self.is_closed():
            try:
                if self.state.channels:
                    await self.refresh_dashboard()
                    await self.refresh_cards()
            except Exception:
                log.exception("rafraîchissement Discord")
            await asyncio.sleep(max(10, self.cfg.dashboard_refresh_seconds))

    async def _recap_loop(self) -> None:
        while not self.is_closed():
            try:
                await self.maybe_daily_recap()
            except Exception:
                log.exception("récap quotidien Discord")
            await asyncio.sleep(60)

    async def maybe_daily_recap(self, now: Optional[datetime] = None) -> bool:
        at = self.cfg.daily_recap_time
        if not at or not self.channel("stats"):
            return False
        now = now or await self.engine.call(self.engine.broker.server_time)
        today = now.strftime("%Y-%m-%d")
        if self.state.last_recap == today or now.strftime("%H:%M") < at:
            return False
        self.state.last_recap = today
        self.save()
        await self.post_stats("stats", 1, f"📅 Récap du {now:%d/%m}")
        return True

    async def post_stats(self, key_or_interaction, days: Optional[int], title: str) -> None:
        st = await views.stats_data(self.engine, days)
        embed = E.stats_embed(st, title)
        everything = await views.stats_data(self.engine) if days is not None else st
        png = await asyncio.to_thread(equity_png, everything["equity"], "Courbe des gains (depuis le début)")
        kwargs: dict = {"embed": embed}
        if png:
            embed.set_image(url="attachment://courbe.png")
            kwargs["file"] = discord.File(io.BytesIO(png), filename="courbe.png")
        if isinstance(key_or_interaction, discord.Interaction):
            await key_or_interaction.followup.send(ephemeral=True, **kwargs)
        else:
            await self.send(key_or_interaction, **kwargs)

    # ===================================================== événements moteur
    async def on_engine_event(self, kind: str, d: dict) -> None:
        if not self.is_ready() or not self.state.channels:
            return
        if kind == "message":
            if self.cfg.mirror_all_messages or d.get("action") not in (None, "IGNORE"):
                if d.get("is_gold") is False and not self.cfg.mirror_all_messages:
                    return
                await self.send("signals", embed=E.message_embed(d))
        elif kind == "signal_ignored":
            await self.send("signals", embed=E.ignored_embed(d))
        elif kind == "signal_rejected":
            await self.send("signals", embed=E.rejected_embed(d), view=E.rejected_view(d["sid"]))
        elif kind == "trade_opened":
            await self.send("signals", embed=E.opened_embed(d))
            await self.refresh_card(d["sid"])
            await self.refresh_dashboard()
        elif kind == "trade_failed":
            await self.send("alerts", content=self.role_mention(), embed=discord.Embed(
                title=f"❌ Ordres refusés par le broker (signal #{d['sid']})", description=d.get("reason"), color=E.RED))
        elif kind in ("tp_hit", "sl_moved", "tp_changed", "partial_close"):
            await self.refresh_card(d["sid"])
            if kind == "tp_hit":
                await self.send("signals", embed=discord.Embed(
                    description=f"🎯 **Trade #{d['sid']} : TP{d['n']} atteint**", color=E.GREEN))
        elif kind == "trade_closed":
            await self.delete_card(d["sid"])
            row = next((h for h in views.history_data(self.engine, 50) if h["id"] == d["sid"]), None)
            await self.send("history", embed=E.closed_embed(d, row))
            await self.refresh_dashboard()
        elif kind in ("paused", "resumed", "skip_next"):
            await self.refresh_dashboard(force=True)
        elif kind == "settings":
            await self.refresh_settings(force=True)
            await self.refresh_dashboard(force=True)
        elif kind == "alert":
            await self.send("alerts", content=self.role_mention(),
                            embed=discord.Embed(description=f"🚨 {d.get('text')}", color=E.RED))

    # ===================================================== validations
    async def approve(self, req: dict) -> Optional[float]:
        if not self.is_ready() or self.channel("approvals") is None:
            return None
        rid = secrets.token_hex(4)
        deadline = datetime.now() + timedelta(seconds=req["timeout"])
        msg = await self.send("approvals", content=f"{self.role_mention()} un signal attend ton avis",
                              embed=E.approval_embed(req, deadline), view=E.approval_view(rid),
                              allowed_mentions=discord.AllowedMentions(roles=True))
        if msg is None:
            return None
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self.pending[rid] = fut
        try:
            return await asyncio.wait_for(fut, timeout=req["timeout"])
        except asyncio.TimeoutError:
            embed = E.approval_embed(req, deadline)
            embed.color = E.GREY
            embed.add_field(name="Résultat", value="⏱ Pas de réponse à temps : règle « sans réponse » appliquée.",
                            inline=False)
            try:
                await msg.edit(embed=embed, view=E.approval_view(rid, disabled=True))
            except discord.HTTPException:
                pass
            return None
        finally:
            self.pending.pop(rid, None)

    # ===================================================== boutons & menus
    async def on_interaction(self, interaction: discord.Interaction) -> None:
        if interaction.type != discord.InteractionType.component:
            return
        cid = (interaction.data or {}).get("custom_id", "")
        if not cid.split(":")[0] in ("ctl", "trade", "take", "approve", "set"):
            return
        if not self.allowed(interaction):
            await self.deny(interaction)
            return
        try:
            await self.handle_component(interaction, cid)
        except Exception as e:
            log.exception("bouton Discord %s", cid)
            msg = f"⚠️ {e}"
            if interaction.response.is_done():
                await interaction.followup.send(msg, ephemeral=True)
            else:
                await interaction.response.send_message(msg, ephemeral=True)

    async def handle_component(self, it: discord.Interaction, cid: str) -> None:
        parts = cid.split(":")
        kind, action = parts[0], parts[1] if len(parts) > 1 else ""
        eng = self.engine
        who = it.user.display_name

        if kind == "approve":
            rid, mult = action, float(parts[2])
            fut = self.pending.get(rid)
            if fut is None or fut.done():
                await it.response.send_message("Cette demande est expirée ou déjà traitée.", ephemeral=True)
                return
            fut.set_result(mult)
            embed = it.message.embeds[0] if it.message and it.message.embeds else discord.Embed()
            label = "❌ Refusé" if mult <= 0 else ("✅ Pris" if mult >= 1 else f"½ Pris à x{mult:g}")
            embed.color = E.GREEN if mult > 0 else E.RED
            embed.add_field(name="Décision", value=f"{label} par {it.user.mention}", inline=False)
            await it.response.edit_message(content=None, embed=embed, view=E.approval_view(rid, disabled=True))
            return

        if kind == "take":
            sid, mult = int(action), float(parts[2])
            await it.response.defer(ephemeral=True, thinking=True)
            result = await eng.take_rejected(sid, mult, by=who)
            if it.message is not None:
                try:
                    await it.message.edit(view=E.view_of(E.button(
                        "Pris" if result else "Toujours refusé", "noop", disabled=True)))
                except discord.HTTPException:
                    pass
            await it.followup.send(f"✅ Signal pris : trade #{result}." if result else
                                   "⛔ Toujours impossible (règles de risque) : regarde #journal.", ephemeral=True)
            return

        if kind == "ctl":
            if action == "pause":
                await eng.set_paused(True, by=f"Discord, {who}")
                await it.response.send_message("⏸ Pause : plus de nouveaux trades.", ephemeral=True)
            elif action == "resume":
                await eng.set_paused(False, by=f"Discord, {who}")
                await it.response.send_message("▶️ Le bot reprend les signaux.", ephemeral=True)
            elif action == "skip":
                eng.skip_next += 1
                eng.emit("skip_next", count=eng.skip_next, by=who)
                await eng.flush_events()
                await it.response.send_message(f"⏭ Le(s) {eng.skip_next} prochain(s) signal(aux) ne seront pas pris.",
                                               ephemeral=True)
            elif action == "closeall":
                await it.response.send_message(
                    "Fermer **tous** les trades du bot maintenant ?", ephemeral=True,
                    view=E.view_of(E.button("Oui, tout fermer", "ctl:closeall_yes", discord.ButtonStyle.danger, "🚪")))
            elif action == "closeall_yes":
                await it.response.defer(ephemeral=True, thinking=True)
                n = await eng.close_everything(reason=f"fermé depuis Discord ({who})")
                await it.followup.send(f"🚪 {n} trade(s) fermé(s).", ephemeral=True)
            elif action == "stats":
                await it.response.defer(ephemeral=True, thinking=True)
                await self.post_stats(it, None, "📈 Statistiques (depuis le début)")
            elif action == "refresh":
                await it.response.defer(ephemeral=True)
                await self.refresh_dashboard(force=True)
                await self.refresh_cards(force=True)
                await it.followup.send("🔄 Actualisé.", ephemeral=True)
            return

        if kind == "trade":
            sid = int(parts[2])
            if action == "edit":
                row = self.open_row(sid)
                await it.response.send_modal(EditTradeModal(self, sid, len(views.trade_data(eng, row, [], [])["tps"])))
                return
            if action == "close":
                self.open_row(sid)
                await it.response.send_message(
                    f"Fermer le trade **#{sid}** maintenant ?", ephemeral=True,
                    view=E.view_of(E.button("Oui, fermer", f"trade:closeyes:{sid}", discord.ButtonStyle.danger, "🚪")))
                return
            await it.response.defer(ephemeral=True, thinking=True)
            row = self.open_row(sid)
            if action == "be":
                ok = await self.locked(eng.move_be, row, f"Discord, {who}")
                await it.followup.send("🛡 SL au break-even." if ok else
                                       "⚠️ BE impossible pour l'instant (prix trop proche de l'entrée ?).", ephemeral=True)
            elif action == "half":
                await self.locked(eng.close_partial, row, 0.5)
                await it.followup.send(f"✂️ Moitié du trade #{sid} fermée.", ephemeral=True)
            elif action == "closeyes":
                await self.locked(eng.close_signal, row, f"fermé depuis Discord ({who})")
                await it.followup.send(f"🚪 Trade #{sid} fermé.", ephemeral=True)
            await self.refresh_card(sid)
            return

        if kind == "set":
            if action == "modal":
                await it.response.send_modal(SettingsModal(self))
                return
            if action in ("approval", "analyst"):
                value = (it.data or {}).get("values", [""])[0]
                body = {"discord": {"approval_mode": value}} if action == "approval" else {"ai": {"analyst_mode": value}}
            elif action == "risk":
                step = 1 if parts[2] == "+" else -1
                r = eng.cfg.risk
                if getattr(r, "fixed_lot", 0):
                    body = {"risk": {"fixed_lot": round(max(0.01, r.fixed_lot + 0.01 * step), 2)}}
                else:
                    body = {"risk": {"risk_per_trade_pct": round(min(5, max(0.25, r.risk_per_trade_pct + 0.25 * step)), 2)}}
            else:
                return
            await self.change_settings(it, body)

    async def change_settings(self, it: discord.Interaction, body: dict) -> None:
        try:
            apply_settings(self.engine, body, self.overrides_path)
        except ValueError as e:
            await it.response.send_message(f"⚠️ {e}", ephemeral=True)
            return
        self.engine.emit("settings", by=f"Discord, {it.user.display_name}", changes=body)
        await self.engine.notify(f"⚙️ Réglages modifiés depuis Discord par {it.user.display_name} : {body}")
        if it.response.is_done():
            await it.followup.send("✅ Réglage enregistré.", ephemeral=True)
        else:
            await it.response.send_message("✅ Réglage enregistré.", ephemeral=True)

    # ===================================================== commandes slash
    def _register_commands(self) -> None:
        tree, bot = self.tree, self

        async def guard(it: discord.Interaction) -> bool:
            if not bot.allowed(it):
                await bot.deny(it)
                return False
            return True

        async def trade_autocomplete(it: discord.Interaction, current: str) -> list[app_commands.Choice[int]]:
            out = []
            for r in bot.engine.store.open_signals():
                label = f"#{r['id']} {r['side']} entrée {r['entry']} SL {r['sl']}"
                if current in label:
                    out.append(app_commands.Choice(name=label[:100], value=r["id"]))
            return out[:25]

        @tree.command(name="setup", description="Crée en une commande les salons, le rôle et les panneaux du bot")
        @app_commands.guild_only()
        @app_commands.default_permissions(administrator=True)
        async def setup(it: discord.Interaction):
            if not it.user.guild_permissions.administrator:
                await it.response.send_message("⛔ Réservé aux admins du serveur.", ephemeral=True)
                return
            await it.response.defer(ephemeral=True, thinking=True)
            try:
                done = await bot.setup_server(it.guild, it.user if isinstance(it.user, discord.Member) else None)
            except discord.Forbidden:
                await it.followup.send("⛔ Il me manque des permissions (Gérer les salons / Gérer les rôles). "
                                       "Réinvite le bot avec le lien de data/discord_invite.txt.", ephemeral=True)
                return
            dash = bot.channel("dashboard")
            await it.followup.send("✅ **Serveur prêt !**\n" + "\n".join(f"• {x}" for x in done)
                                   + (f"\n\nVa voir {dash.mention}" if dash else ""), ephemeral=True)

        @tree.command(name="statut", description="État du bot, P&L du jour, trades en cours")
        async def statut(it: discord.Interaction):
            if not await guard(it):
                return
            s = await views.status_data(bot.engine)
            await it.response.send_message(embed=E.dashboard_embed(s, await views.trades_data(bot.engine)),
                                           view=E.dashboard_view(s["paused"]), ephemeral=True)

        @tree.command(name="pause", description="Ne plus prendre de nouveaux signaux (les trades ouverts restent gérés)")
        async def pause(it: discord.Interaction):
            if await guard(it):
                await bot.engine.set_paused(True, by=f"Discord, {it.user.display_name}")
                await it.response.send_message("⏸ Pause : plus de nouveaux trades.", ephemeral=True)

        @tree.command(name="reprendre", description="Reprendre les signaux")
        async def reprendre(it: discord.Interaction):
            if await guard(it):
                await bot.engine.set_paused(False, by=f"Discord, {it.user.display_name}")
                await it.response.send_message("▶️ Le bot reprend les signaux.", ephemeral=True)

        @tree.command(name="fermer-tout", description="Fermer tous les trades du bot (avec confirmation)")
        async def fermer_tout(it: discord.Interaction):
            if await guard(it):
                await it.response.send_message(
                    "Fermer **tous** les trades du bot maintenant ?", ephemeral=True,
                    view=E.view_of(E.button("Oui, tout fermer", "ctl:closeall_yes", discord.ButtonStyle.danger, "🚪")))

        @tree.command(name="sauter", description="Ne pas prendre le(s) prochain(s) signal(aux)")
        @app_commands.describe(nombre="Combien de signaux sauter (1 par défaut, 0 pour annuler)")
        async def sauter(it: discord.Interaction, nombre: app_commands.Range[int, 0, 20] = 1):
            if await guard(it):
                bot.engine.skip_next = nombre
                bot.engine.emit("skip_next", count=nombre, by=it.user.display_name)
                await bot.engine.flush_events()
                await it.response.send_message("⏭ Plus aucun signal à sauter." if nombre == 0 else
                                               f"⏭ Les {nombre} prochain(s) signal(aux) ne seront pas pris.", ephemeral=True)

        @tree.command(name="trades", description="Voir les trades en cours avec leurs boutons")
        async def trades(it: discord.Interaction):
            if not await guard(it):
                return
            data = await views.trades_data(bot.engine)
            if not data:
                await it.response.send_message("Aucun trade en cours.", ephemeral=True)
                return
            await it.response.send_message(embed=E.trade_embed(data[0]), view=E.trade_view(data[0]), ephemeral=True)
            for t in data[1:10]:
                await it.followup.send(embed=E.trade_embed(t), view=E.trade_view(t), ephemeral=True)

        @tree.command(name="fermer", description="Fermer un trade (en entier ou en partie)")
        @app_commands.describe(trade="Le trade", pourcentage="Part à fermer (100 = tout)")
        @app_commands.autocomplete(trade=trade_autocomplete)
        async def fermer(it: discord.Interaction, trade: int, pourcentage: app_commands.Range[int, 1, 100] = 100):
            if not await guard(it):
                return
            await it.response.defer(ephemeral=True, thinking=True)
            row = bot.open_row(trade)
            if pourcentage >= 100:
                await bot.locked(bot.engine.close_signal, row, f"fermé depuis Discord ({it.user.display_name})")
                await it.followup.send(f"🚪 Trade #{trade} fermé.", ephemeral=True)
            else:
                await bot.locked(bot.engine.close_partial, row, pourcentage / 100)
                await it.followup.send(f"✂️ {pourcentage} % du trade #{trade} fermé.", ephemeral=True)
            await bot.refresh_card(trade)

        @tree.command(name="be", description="Passer le SL d'un trade au break-even")
        @app_commands.autocomplete(trade=trade_autocomplete)
        async def be(it: discord.Interaction, trade: int):
            if not await guard(it):
                return
            await it.response.defer(ephemeral=True, thinking=True)
            ok = await bot.locked(bot.engine.move_be, bot.open_row(trade), f"Discord, {it.user.display_name}")
            await it.followup.send("🛡 SL au break-even." if ok else "⚠️ BE impossible pour l'instant.", ephemeral=True)

        @tree.command(name="sl", description="Changer le stop loss d'un trade")
        @app_commands.describe(trade="Le trade", prix="Nouveau SL (ex. 2345.50)")
        @app_commands.autocomplete(trade=trade_autocomplete)
        async def sl(it: discord.Interaction, trade: int, prix: float):
            if not await guard(it):
                return
            await it.response.defer(ephemeral=True, thinking=True)
            ok = await bot.locked(bot.engine.set_sl, bot.open_row(trade), prix, f"Discord, {it.user.display_name}")
            await it.followup.send(f"🛡 SL du trade #{trade} à {prix}." if ok else
                                   "⚠️ SL impossible (le prix est déjà au-delà).", ephemeral=True)

        @tree.command(name="tp", description="Changer un TP d'un trade")
        @app_commands.describe(trade="Le trade", numero="Numéro du TP (1, 2, 3...)", prix="Nouveau prix")
        @app_commands.autocomplete(trade=trade_autocomplete)
        async def tp(it: discord.Interaction, trade: int, numero: app_commands.Range[int, 1, 10], prix: float):
            if not await guard(it):
                return
            await it.response.defer(ephemeral=True, thinking=True)
            await bot.locked(bot.engine.set_tp_levels, bot.open_row(trade), {numero: prix})
            await it.followup.send(f"🎯 TP{numero} du trade #{trade} → {prix}.", ephemeral=True)

        @tree.command(name="risque", description="Risque par trade, en % du solde")
        @app_commands.describe(pourcentage="Ex. 0.5 pour 0,5 %")
        async def risque(it: discord.Interaction, pourcentage: app_commands.Range[float, 0.05, 5.0]):
            if await guard(it):
                await bot.change_settings(it, {"risk": {"risk_per_trade_pct": pourcentage, "fixed_lot": 0.0}})

        @tree.command(name="lot-fixe", description="Lot fixe par signal (0 = revenir au risque en %)")
        @app_commands.describe(lot="Lot total par signal, réparti entre les TP (ex. 0.03)")
        async def lot_fixe(it: discord.Interaction, lot: app_commands.Range[float, 0.0, 100.0]):
            if await guard(it):
                await bot.change_settings(it, {"risk": {"fixed_lot": lot}})

        @tree.command(name="validation", description="Quand le bot doit te demander ton avis")
        @app_commands.choices(mode=[
            app_commands.Choice(name="Quand l'IA doute", value="doubts"),
            app_commands.Choice(name="À chaque signal", value="always"),
            app_commands.Choice(name="Jamais (100 % automatique)", value="off"),
        ])
        async def validation(it: discord.Interaction, mode: app_commands.Choice[str]):
            if await guard(it):
                await bot.change_settings(it, {"discord": {"approval_mode": mode.value}})

        @tree.command(name="ia", description="Rôle de l'IA d'analyse des graphiques")
        @app_commands.choices(mode=[
            app_commands.Choice(name="Filtre : peut refuser ou réduire", value="filter"),
            app_commands.Choice(name="Avis seulement", value="advisory"),
            app_commands.Choice(name="Désactivée", value="off"),
        ])
        async def ia(it: discord.Interaction, mode: app_commands.Choice[str]):
            if await guard(it):
                await bot.change_settings(it, {"ai": {"analyst_mode": mode.value}})

        @tree.command(name="regler", description="Modifier les principaux réglages dans une fenêtre")
        async def regler(it: discord.Interaction):
            if await guard(it):
                await it.response.send_modal(SettingsModal(bot))

        @tree.command(name="stats", description="Statistiques et courbe des gains")
        @app_commands.choices(periode=[
            app_commands.Choice(name="Aujourd'hui", value="1"), app_commands.Choice(name="7 jours", value="7"),
            app_commands.Choice(name="30 jours", value="30"), app_commands.Choice(name="Depuis le début", value="all"),
        ])
        async def stats(it: discord.Interaction, periode: Optional[app_commands.Choice[str]] = None):
            if not await guard(it):
                return
            await it.response.defer(ephemeral=True, thinking=True)
            value = periode.value if periode else "all"
            days = None if value == "all" else int(value)
            await bot.post_stats(it, days, f"📈 Statistiques — {periode.name if periode else 'depuis le début'}")

        @tree.command(name="historique", description="Les derniers signaux et leur résultat")
        @app_commands.describe(nombre="Combien (max 25)")
        async def historique(it: discord.Interaction, nombre: app_commands.Range[int, 1, 25] = 10):
            if not await guard(it):
                return
            status_icon = {"open": "⏳", "closed": "🏁", "rejected": "⛔", "failed": "❌", "dry_run": "🧪"}
            lines = []
            for h in views.history_data(bot.engine, nombre):
                pnl = E.money(h["pnl"]) if h["pnl"] is not None else ""
                when = (h["created"] or "").replace("T", " ")[5:16]
                reason = f" — {E.short(h['reason'], 60)}" if h["status"] == "rejected" and h["reason"] else ""
                lines.append(f"{status_icon.get(h['status'], '•')} `#{h['id']}` {when} {E.side_icon(h['side'])} "
                             f"{E.num(h['entry'] or h['entry_zone'][0])} **{pnl}**{reason}")
            e = discord.Embed(title=f"📜 {len(lines)} derniers signaux", description="\n".join(lines)[:4000] or "Rien encore.",
                              color=E.BLUE)
            await it.response.send_message(embed=e, ephemeral=True)

        @tree.command(name="marche", description="Indicateurs de l'or sur M5/M15/H1/H4 (gratuit, sans IA)")
        async def marche(it: discord.Interaction):
            if not await guard(it):
                return
            await it.response.defer(ephemeral=True, thinking=True)
            eng = bot.engine
            bars = {tf: await eng.call(eng.broker.rates, tf, 250) for tf in TIMEFRAMES}
            bid, ask = await eng.call(eng.broker.tick)
            await it.followup.send(embed=E.indicators_embed([summarize_timeframe(tf, b) for tf, b in bars.items()],
                                                            bid, ask), ephemeral=True)

        @tree.command(name="analyse", description="Lecture du marché de l'or par Claude (≈ 0,05 $)")
        async def analyse(it: discord.Interaction):
            if not await guard(it):
                return
            eng = bot.engine
            if eng.ai is None or not hasattr(eng.ai, "market_view"):
                await it.response.send_message("L'IA n'est pas disponible.", ephemeral=True)
                return
            await it.response.defer(thinking=True)  # visible : tout le monde voit l'analyse
            bars = {tf: await eng.call(eng.broker.rates, tf, 250) for tf in TIMEFRAMES}
            bid, ask = await eng.call(eng.broker.tick)
            view = await eng.ai.market_view(bid, ask, bars)
            if view is None:
                await it.followup.send("⚠️ L'IA n'a pas pu répondre, réessaie dans un moment.")
                return
            await it.followup.send(embed=E.market_embed(view, bid, ask))

        @tree.command(name="aide", description="Mode d'emploi du bot")
        async def aide(it: discord.Interaction):
            await it.response.send_message(embed=bot.help_embed(), ephemeral=True)

        @tree.error
        async def on_error(it: discord.Interaction, error: app_commands.AppCommandError):
            original = getattr(error, "original", error)
            log.warning("commande Discord en erreur : %s", original)
            msg = f"⚠️ {original}"
            if it.response.is_done():
                await it.followup.send(msg, ephemeral=True)
            else:
                await it.response.send_message(msg, ephemeral=True)


# ===================================================================== fenêtres
class EditTradeModal(discord.ui.Modal):
    def __init__(self, bot: GoldDiscordBot, sid: int, n_tps: int):
        super().__init__(title=f"Modifier le trade #{sid}")
        self.bot, self.sid = bot, sid
        self.sl = discord.ui.TextInput(label="Nouveau SL (vide = inchangé)", required=False, max_length=12)
        self.add_item(self.sl)
        self.tps = []
        for i in range(1, min(n_tps, 4) + 1):
            field = discord.ui.TextInput(label=f"Nouveau TP{i} (vide = inchangé)", required=False, max_length=12)
            self.tps.append(field)
            self.add_item(field)

    async def on_submit(self, it: discord.Interaction) -> None:
        if not self.bot.allowed(it):
            await self.bot.deny(it)
            return
        await it.response.defer(ephemeral=True, thinking=True)
        try:
            sl = parse_price(self.sl.value)
            changes = {i: p for i, f in enumerate(self.tps, start=1) if (p := parse_price(f.value)) is not None}
        except ValueError:
            await it.followup.send("⚠️ Prix invalide (exemple : 2345.50).", ephemeral=True)
            return
        eng, done = self.bot.engine, []
        try:
            if sl is not None:
                ok = await self.bot.locked(eng.set_sl, self.bot.open_row(self.sid), sl, f"Discord, {it.user.display_name}")
                done.append(f"SL → {sl}" if ok else "SL refusé (prix déjà au-delà)")
            if changes:
                await self.bot.locked(eng.set_tp_levels, self.bot.open_row(self.sid), changes)
                done.append(", ".join(f"TP{i} → {p}" for i, p in changes.items()))
        except ValueError as e:
            await it.followup.send(f"⚠️ {e}", ephemeral=True)
            return
        await self.bot.refresh_card(self.sid)
        await it.followup.send("✏️ " + (" · ".join(done) or "Rien changé."), ephemeral=True)


class SettingsModal(discord.ui.Modal):
    def __init__(self, bot: GoldDiscordBot):
        super().__init__(title="Réglages du bot")
        self.bot = bot
        cfg = bot.engine.cfg
        self.risk = discord.ui.TextInput(label="Risque par trade (%)", default=f"{cfg.risk.risk_per_trade_pct:g}", max_length=6)
        self.lot = discord.ui.TextInput(label="Lot fixe (0 = utiliser le risque en %)",
                                        default=f"{getattr(cfg.risk, 'fixed_lot', 0):g}", max_length=6)
        self.daily = discord.ui.TextInput(label="Perte max par jour (%) (0 = pas de limite)",
                                          default=f"{cfg.risk.max_daily_loss_pct:g}", max_length=6)
        self.trades = discord.ui.TextInput(label="Trades max par jour", default=str(cfg.risk.max_trades_per_day), max_length=3)
        self.timeout = discord.ui.TextInput(label="Secondes pour répondre aux validations",
                                            default=str(cfg.discord.approval_timeout_seconds), max_length=4)
        for f in (self.risk, self.lot, self.daily, self.trades, self.timeout):
            self.add_item(f)

    async def on_submit(self, it: discord.Interaction) -> None:
        if not self.bot.allowed(it):
            await self.bot.deny(it)
            return
        try:
            body = {
                "risk": {"risk_per_trade_pct": float(self.risk.value.replace(",", ".")),
                         "fixed_lot": float(self.lot.value.replace(",", ".")),
                         "max_daily_loss_pct": float(self.daily.value.replace(",", ".")),
                         "max_trades_per_day": int(self.trades.value)},
                "discord": {"approval_timeout_seconds": int(self.timeout.value)},
            }
        except ValueError:
            await it.response.send_message("⚠️ Valeur invalide : mets des nombres.", ephemeral=True)
            return
        await self.bot.change_settings(it, body)

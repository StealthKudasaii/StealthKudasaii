"""Point d'entrée : python -m bot.main

Connecte Telegram (avec TON compte, pour pouvoir lire le groupe), MT5 et Claude, puis tourne en continu.

Commandes que tu peux envoyer dans tes « Messages enregistrés » Telegram :
  /status    état du bot, P&L du jour, trades ouverts
  /pause     ne prend plus de nouveaux signaux (les trades ouverts restent gérés)
  /resume    reprend
  /closeall  ferme tous les trades du bot
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from pathlib import Path

from .ai import AI
from .broker import MT5Broker
from .config import env, load_config
from .engine import Engine, main_sl_limit, message_filter
from .store import Store


def setup_logging() -> None:
    Path("logs").mkdir(exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=[logging.StreamHandler(sys.stdout), logging.FileHandler("logs/bot.log", encoding="utf-8")],
    )
    logging.getLogger("telethon").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)


async def run(config_path: str) -> None:
    from telethon import TelegramClient, events

    cfg = load_config(config_path)
    log = logging.getLogger("bot")

    broker = MT5Broker(
        symbol=cfg.mt5.symbol, magic=cfg.mt5.magic, deviation=cfg.mt5.deviation_points, dry_run=cfg.dry_run,
        login=env("MT5_LOGIN", False), password=env("MT5_PASSWORD", False),
        server=env("MT5_SERVER", False), path=env("MT5_PATH", False),
    )
    if broker.account_mode == "RÉEL" and not cfg.dry_run:
        log.warning("⚠️  COMPTE RÉEL : les ordres partent pour de vrai.")

    env("ANTHROPIC_API_KEY")
    ai = AI(cfg.ai.parser_model, cfg.ai.analyst_model, cfg.ai.analyst_effort)

    client = TelegramClient("data/telegram", int(env("TELEGRAM_API_ID")), env("TELEGRAM_API_HASH"))
    await client.start()  # 1er lancement : demande ton numéro et le code reçu sur Telegram
    me = await client.get_me()

    async def notify(text: str) -> None:
        await client.send_message(cfg.telegram.notify_chat, text)

    engine = Engine(cfg, broker, Store("data/bot.sqlite"), ai, notify)
    sources = [await client.get_peer_id(c) for c in cfg.telegram.source_chats]
    allowed = set(cfg.telegram.allowed_senders)

    async def on_group_message(event, edited: bool) -> None:
        msg = event.message
        if allowed and msg.sender_id not in allowed:
            return
        reply_to = msg.reply_to.reply_to_msg_id if msg.reply_to else None
        fwd_name = None
        if msg.fwd_from is not None:
            try:
                chat = await msg.forward.get_chat() if msg.forward else None
            except Exception:
                chat = None
            fwd_name = getattr(chat, "title", None) or msg.fwd_from.from_name
        allow_signal, allow_command = message_filter(cfg.telegram, fwd_name)
        await engine.handle_message(event.chat_id, msg.id, msg.message or "", reply_to, edited,
                                    allow_signal, allow_command, main_sl_limit(cfg.telegram, fwd_name))

    @client.on(events.NewMessage(chats=sources))
    async def _new(event):
        await on_group_message(event, edited=False)

    @client.on(events.MessageEdited(chats=sources))
    async def _edit(event):
        await on_group_message(event, edited=True)

    @client.on(events.NewMessage(chats=[me.id], outgoing=True, pattern=r"^/(status|pause|resume|closeall)\b"))
    async def _commands(event):
        cmd = event.pattern_match.group(1)
        if cmd == "pause":
            engine.paused = True
            await event.reply("⏸ Pause : plus de nouveaux trades. Les trades ouverts restent gérés.")
        elif cmd == "resume":
            engine.paused = False
            await event.reply("▶️ Le bot reprend les signaux.")
        elif cmd == "closeall":
            await engine.close_everything()
            await event.reply("🚪 Tous les trades du bot ont été fermés.")
        else:
            await event.reply(await engine.status_text())

    await notify(f"🤖 Bot or démarré ({'DRY RUN, aucun ordre envoyé' if cfg.dry_run else 'ORDRES ACTIFS'}, "
                 f"compte {broker.account_mode}).\n" + await engine.status_text())
    log.info("En écoute sur %s", sources)
    manager = asyncio.create_task(engine.manage_loop())
    try:
        await client.run_until_disconnected()
    finally:
        manager.cancel()


def main() -> None:
    parser = argparse.ArgumentParser(description="Bot de copy-trading or : Telegram → Claude → MT5")
    parser.add_argument("--config", default="config.yaml")
    args = parser.parse_args()
    setup_logging()
    Path("data").mkdir(exist_ok=True)
    asyncio.run(run(args.config))


if __name__ == "__main__":
    main()
